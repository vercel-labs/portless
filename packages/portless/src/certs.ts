import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as tls from "node:tls";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fixOwnership } from "./utils.js";

/** How long the CA certificate is valid (10 years, in days). */
const CA_VALIDITY_DAYS = 3650;

/** How long server certificates are valid (1 year, in days). */
const SERVER_VALIDITY_DAYS = 365;

/** Buffer (in ms) subtracted from expiry to trigger early regeneration. */
const EXPIRY_BUFFER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Common Name used for the portless local CA. */
const CA_COMMON_NAME = "portless Local CA";

/** openssl command timeout (ms). */
const OPENSSL_TIMEOUT_MS = 15_000;

/**
 * Timeout for non-interactive macOS `security` commands (verify-cert, etc.).
 * Needs generous headroom because the Keychain Services daemon (`securityd`)
 * can stall under load or after a macOS update.
 */
const MACOS_SECURITY_TIMEOUT_MS = 15_000;

/**
 * Timeout for macOS `security add-trusted-cert` (non-root).
 * This command triggers a system GUI authorization dialog (Touch ID or
 * password), so the user may need time to interact with it.
 */
const MACOS_SECURITY_AUTH_TIMEOUT_MS = 120_000;

/**
 * Timeout for macOS `security add-trusted-cert` as root.
 * The `-d` flag writes to the admin cert store without a GUI dialog,
 * but the keychain subsystem can still be slow.
 */
const MACOS_SECURITY_ROOT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

const CA_KEY_FILE = "ca-key.pem";
const CA_CERT_FILE = "ca.pem";
const SERVER_KEY_FILE = "server-key.pem";
const SERVER_CERT_FILE = "server.pem";
const CA_TRUST_MARKER = "ca.trusted";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function caFingerprint(stateDir: string): string | null {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  try {
    const pem = fs.readFileSync(caCertPath);
    return crypto.createHash("sha256").update(pem).digest("hex");
  } catch {
    return null;
  }
}

function readTrustMarker(stateDir: string): string | null {
  try {
    const value = fs.readFileSync(path.join(stateDir, CA_TRUST_MARKER), "utf-8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function writeTrustMarker(stateDir: string): void {
  const fp = caFingerprint(stateDir);
  if (fp) {
    fs.writeFileSync(path.join(stateDir, CA_TRUST_MARKER), fp + "\n");
    fixOwnership(path.join(stateDir, CA_TRUST_MARKER));
  }
}

function clearTrustMarker(stateDir: string): void {
  try {
    fs.unlinkSync(path.join(stateDir, CA_TRUST_MARKER));
  } catch {
    // Marker may not exist yet; ignore.
  }
}

// ---------------------------------------------------------------------------
// Windows OpenSSL configuration
// ---------------------------------------------------------------------------

/**
 * Some Windows OpenSSL builds (e.g. ShiningLight.OpenSSL.Dev) compile in a
 * bogus OPENSSLDIR such as `Z:/extlib/_5040__/ssl`, which causes every
 * `openssl req` invocation to fail with "Can't open openssl.cnf". We detect
 * the problem at startup and resolve it by finding the real openssl.cnf and
 * injecting OPENSSL_CONF into the child-process environment.
 */
let _opensslEnv: Record<string, string> | undefined;

function getOpensslEnv(): Record<string, string> | undefined {
  if (process.platform !== "win32") return undefined;
  if (_opensslEnv !== undefined) return _opensslEnv;

  // If the user already set OPENSSL_CONF, respect it.
  if (process.env.OPENSSL_CONF && fileExists(process.env.OPENSSL_CONF)) {
    _opensslEnv = {};
    return _opensslEnv;
  }

  const candidates = [
    // Git-for-Windows bundles OpenSSL here
    path.join("C:", "Program Files", "Git", "mingw64", "etc", "ssl", "openssl.cnf"),
    path.join("C:", "Program Files", "Git", "usr", "ssl", "openssl.cnf"),
    // Standalone OpenSSL installers
    path.join("C:", "Program Files", "OpenSSL-Win64", "bin", "cnf", "openssl.cnf"),
    path.join("C:", "Program Files", "OpenSSL-Win64", "openssl.cnf"),
    path.join("C:", "Program Files (x86)", "OpenSSL-Win32", "bin", "cnf", "openssl.cnf"),
    // Common winget/chocolatey install paths
    path.join("C:", "Program Files", "OpenSSL", "bin", "cnf", "openssl.cnf"),
  ];

  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      _opensslEnv = { OPENSSL_CONF: candidate };
      return _opensslEnv;
    }
  }

  _opensslEnv = {};
  return _opensslEnv;
}

function opensslErrorMessage(): string {
  if (process.platform === "win32") {
    return (
      "Make sure openssl is installed and working.\n" +
      "Install via: winget install -e --id ShiningLight.OpenSSL.Dev\n" +
      "If already installed, set OPENSSL_CONF to the path of your openssl.cnf file."
    );
  }
  return "Make sure openssl is installed (ships with macOS and most Linux distributions).";
}

/**
 * Check whether a PEM certificate file has expired or will expire soon.
 * Returns true if the cert is still valid, false if it needs regeneration.
 */
function isCertValid(certPath: string): boolean {
  try {
    const pem = fs.readFileSync(certPath, "utf-8");
    const cert = new crypto.X509Certificate(pem);
    const expiry = new Date(cert.validTo).getTime();
    return Date.now() + EXPIRY_BUFFER_MS < expiry;
  } catch {
    return false;
  }
}

/**
 * Check whether a certificate includes all expected SANs (*.local).
 * Returns false if the cert is missing SANs that were added in later versions,
 * triggering regeneration so existing users get .local coverage.
 */
function isCertSansComplete(certPath: string): boolean {
  try {
    const text = openssl(["x509", "-in", certPath, "-noout", "-text"]);
    return /DNS:\*\.local\b/.test(text);
  } catch {
    return false;
  }
}

/**
 * Check whether a certificate uses a strong signature algorithm.
 * Reject SHA-1 signatures to avoid OpenSSL "ca md too weak" failures.
 *
 * Uses openssl rather than X509Certificate.signatureAlgorithm because that
 * property was only added in Node.js 24.9.0 and is undefined on older releases.
 */
function isCertSignatureStrong(certPath: string): boolean {
  try {
    const text = openssl(["x509", "-in", certPath, "-noout", "-text"]);
    const match = text.match(/Signature Algorithm:\s*(\S+)/i);
    if (!match) return false;
    const algo = match[1].toLowerCase();
    // SHA-1 variants: sha1WithRSAEncryption, ecdsa-with-SHA1, etc.
    // SHA-256+ variants do not contain "sha1" as a substring.
    return !algo.includes("sha1");
  } catch {
    return false;
  }
}

/**
 * Run openssl and return stdout. Throws on non-zero exit.
 */
function openssl(args: string[], options?: { input?: string }): string {
  try {
    const extraEnv = getOpensslEnv();
    return execFileSync("openssl", args, {
      encoding: "utf-8",
      timeout: OPENSSL_TIMEOUT_MS,
      input: options?.input,
      stdio: ["pipe", "pipe", "pipe"],
      ...(extraEnv && Object.keys(extraEnv).length > 0
        ? { env: { ...process.env, ...extraEnv } }
        : {}),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`openssl failed: ${message}\n\n${opensslErrorMessage()}`);
  }
}

const execFileAsync = promisify(execFileCb);

/**
 * Run openssl asynchronously and return stdout. Throws on non-zero exit.
 * Used for on-demand cert generation in the SNI callback to avoid blocking
 * the event loop.
 */
async function opensslAsync(args: string[]): Promise<string> {
  try {
    const extraEnv = getOpensslEnv();
    const { stdout } = await execFileAsync("openssl", args, {
      encoding: "utf-8",
      timeout: OPENSSL_TIMEOUT_MS,
      ...(extraEnv && Object.keys(extraEnv).length > 0
        ? { env: { ...process.env, ...extraEnv } }
        : {}),
    });
    return stdout;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`openssl failed: ${message}\n\n${opensslErrorMessage()}`);
  }
}

// ---------------------------------------------------------------------------
// CA generation
// ---------------------------------------------------------------------------

/**
 * Generate a local CA certificate and private key.
 * The CA is self-signed and used to sign server certificates.
 */
function generateCA(stateDir: string): { certPath: string; keyPath: string } {
  const keyPath = path.join(stateDir, CA_KEY_FILE);
  const certPath = path.join(stateDir, CA_CERT_FILE);

  // Generate EC private key
  openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", keyPath]);

  // Generate self-signed CA certificate
  openssl([
    "req",
    "-new",
    "-x509",
    "-sha256",
    "-key",
    keyPath,
    "-out",
    certPath,
    "-days",
    CA_VALIDITY_DAYS.toString(),
    "-subj",
    `/CN=${CA_COMMON_NAME}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);

  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
  fixOwnership(keyPath, certPath);

  clearTrustMarker(stateDir);

  return { certPath, keyPath };
}

// ---------------------------------------------------------------------------
// Server certificate generation
// ---------------------------------------------------------------------------

/**
 * Generate a server certificate signed by the local CA.
 * Covers localhost, *.localhost, and *.local via Subject Alternative Names.
 */
function generateServerCert(stateDir: string): { certPath: string; keyPath: string } {
  const caKeyPath = path.join(stateDir, CA_KEY_FILE);
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  const serverKeyPath = path.join(stateDir, SERVER_KEY_FILE);
  const serverCertPath = path.join(stateDir, SERVER_CERT_FILE);
  const csrPath = path.join(stateDir, "server.csr");
  const extPath = path.join(stateDir, "server-ext.cnf");

  // Generate server private key
  openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", serverKeyPath]);

  // Generate CSR
  openssl(["req", "-new", "-key", serverKeyPath, "-out", csrPath, "-subj", "/CN=localhost"]);

  // Write extension config for SANs
  const sans = ["DNS:localhost", "DNS:*.localhost", "DNS:*.local"];
  fs.writeFileSync(
    extPath,
    [
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${sans.join(",")}`,
    ].join("\n") + "\n"
  );

  // Sign with CA
  // Use -CAserial with an explicit path instead of -CAcreateserial.
  // -CAcreateserial derives the .srl path by stripping the CA cert's file
  // extension, but some OpenSSL/LibreSSL versions use the *last dot in the
  // full path*, so a dot in $HOME (e.g. /Users/ashish.jaiswal) causes it
  // to write "/Users/ashish.srl" instead of the intended location.
  const srlPath = path.join(stateDir, "ca.srl");
  if (!fileExists(srlPath)) {
    fs.writeFileSync(
      srlPath,
      crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase() + "\n"
    );
  }
  openssl([
    "x509",
    "-req",
    "-sha256",
    "-in",
    csrPath,
    "-CA",
    caCertPath,
    "-CAkey",
    caKeyPath,
    "-CAserial",
    srlPath,
    "-out",
    serverCertPath,
    "-days",
    SERVER_VALIDITY_DAYS.toString(),
    "-extfile",
    extPath,
  ]);

  // Clean up temporary files (keep ca.srl for serial number tracking)
  for (const tmp of [csrPath, extPath]) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Non-fatal
    }
  }

  fs.chmodSync(serverKeyPath, 0o600);
  fs.chmodSync(serverCertPath, 0o644);
  fixOwnership(serverKeyPath, serverCertPath);

  return { certPath: serverCertPath, keyPath: serverKeyPath };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure both a CA and server certificate exist in the state directory.
 * Generates the CA if missing. Regenerates the server cert if expired.
 * Returns paths to the server cert and key.
 */
export function ensureCerts(stateDir: string): {
  certPath: string;
  keyPath: string;
  caPath: string;
  caGenerated: boolean;
} {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  const caKeyPath = path.join(stateDir, CA_KEY_FILE);
  const serverCertPath = path.join(stateDir, SERVER_CERT_FILE);
  const serverKeyPath = path.join(stateDir, SERVER_KEY_FILE);

  let caGenerated = false;
  const caMissing =
    !fileExists(caCertPath) ||
    !fileExists(caKeyPath) ||
    !isCertValid(caCertPath) ||
    !isCertSignatureStrong(caCertPath);

  if (caMissing) {
    generateCA(stateDir);
    caGenerated = true;
  }

  if (
    caGenerated ||
    !fileExists(serverCertPath) ||
    !fileExists(serverKeyPath) ||
    !isCertValid(serverCertPath) ||
    !isCertSignatureStrong(serverCertPath) ||
    !isCertSansComplete(serverCertPath)
  ) {
    generateServerCert(stateDir);
  }

  return {
    certPath: serverCertPath,
    keyPath: serverKeyPath,
    caPath: caCertPath,
    caGenerated,
  };
}

/**
 * Check if the portless CA is already installed in the system trust store.
 */
export function isCATrusted(stateDir: string): boolean {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) return false;

  // Fast path: if we previously trusted this exact CA, skip the OS check.
  const marker = readTrustMarker(stateDir);
  if (marker) {
    const fp = caFingerprint(stateDir);
    if (fp && marker === fp) return true;
  }

  if (process.platform === "darwin") {
    return isCATrustedMacOS(caCertPath);
  } else if (process.platform === "linux") {
    return isCATrustedLinux(stateDir);
  } else if (process.platform === "win32") {
    return isCATrustedWindows(caCertPath);
  }
  return false;
}

function isCATrustedWindows(caCertPath: string): boolean {
  try {
    const fingerprint = openssl(["x509", "-in", caCertPath, "-noout", "-fingerprint", "-sha1"])
      .trim()
      .replace(/^.*=/, "")
      .replace(/:/g, "")
      .toLowerCase();
    const result = execFileSync("certutil", ["-store", "-user", "Root"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.replace(/\s/g, "").toLowerCase().includes(fingerprint);
  } catch {
    return false;
  }
}

function isCATrustedMacOS(caCertPath: string): boolean {
  try {
    const isRoot = (process.getuid?.() ?? -1) === 0;
    const sudoUser = process.env.SUDO_USER;

    if (isRoot && sudoUser) {
      // When running as root via sudo, check trust from the *browser user's*
      // perspective. Root may have the CA in its own trust settings, but
      // Chrome runs as the real user and won't see those.
      execFileSync(
        "sudo",
        ["-u", sudoUser, "security", "verify-cert", "-c", caCertPath, "-L", "-p", "ssl"],
        {
          stdio: "pipe",
          timeout: MACOS_SECURITY_TIMEOUT_MS,
        }
      );
    } else {
      execFileSync("security", ["verify-cert", "-c", caCertPath, "-L", "-p", "ssl"], {
        stdio: "pipe",
        timeout: MACOS_SECURITY_TIMEOUT_MS,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the path to the current user's login keychain.
 */
function loginKeychainPath(): string {
  try {
    const result = execFileSync("security", ["default-keychain"], {
      encoding: "utf-8",
      timeout: MACOS_SECURITY_TIMEOUT_MS,
    }).trim();
    // Output is like:    "/Users/foo/Library/Keychains/login.keychain-db"
    const match = result.match(/"(.+)"/);
    if (match) return match[1];
  } catch {
    // Fall back to conventional path
  }
  const home = process.env.HOME || `/Users/${process.env.USER || "unknown"}`;
  return path.join(home, "Library", "Keychains", "login.keychain-db");
}

/**
 * Linux distro CA trust configuration.
 * Each entry maps a distro family to its CA certificate directory and update command.
 */
interface LinuxCATrustConfig {
  certDir: string;
  updateCommand: string;
}

const LINUX_CA_TRUST_CONFIGS: Record<string, LinuxCATrustConfig> = {
  debian: {
    certDir: "/usr/local/share/ca-certificates",
    updateCommand: "update-ca-certificates",
  },
  arch: {
    certDir: "/etc/ca-certificates/trust-source/anchors",
    updateCommand: "update-ca-trust",
  },
  fedora: {
    certDir: "/etc/pki/ca-trust/source/anchors",
    updateCommand: "update-ca-trust",
  },
  suse: {
    certDir: "/etc/pki/trust/anchors",
    updateCommand: "update-ca-certificates",
  },
};

/**
 * Detect the Linux distro family by reading /etc/os-release.
 * Returns the matching config key, or undefined if unrecognized.
 */
function detectLinuxDistro(): string | undefined {
  try {
    const osRelease = fs.readFileSync("/etc/os-release", "utf-8").toLowerCase();
    // ID_LIKE often lists parent distros (e.g., "ID_LIKE=arch" or "ID_LIKE=debian")
    if (osRelease.includes("arch")) return "arch";
    if (osRelease.includes("fedora") || osRelease.includes("rhel") || osRelease.includes("centos"))
      return "fedora";
    if (osRelease.includes("suse")) return "suse";
    if (osRelease.includes("debian") || osRelease.includes("ubuntu")) return "debian";
  } catch {
    // /etc/os-release missing
  }

  // Fallback: probe for known update commands
  for (const [distro, config] of Object.entries(LINUX_CA_TRUST_CONFIGS)) {
    try {
      execFileSync("which", [config.updateCommand], { stdio: "pipe", timeout: 5000 });
      if (fs.existsSync(path.dirname(config.certDir))) return distro;
    } catch {
      // Not found, try next
    }
  }

  return undefined;
}

/**
 * Get the CA trust config for the current Linux distro.
 * Falls back to Debian layout if detection fails.
 */
function getLinuxCATrustConfig(): LinuxCATrustConfig {
  const distro = detectLinuxDistro();
  return LINUX_CA_TRUST_CONFIGS[distro ?? "debian"];
}

/**
 * Check if the CA is trusted on Linux.
 * Supports Debian/Ubuntu, Arch, Fedora/RHEL, and openSUSE.
 */
function isCATrustedLinux(stateDir: string): boolean {
  const config = getLinuxCATrustConfig();
  const systemCertPath = path.join(config.certDir, "portless-ca.crt");
  if (!fileExists(systemCertPath)) return false;

  // Compare our CA with the installed one
  try {
    const ours = fs.readFileSync(path.join(stateDir, CA_CERT_FILE), "utf-8").trim();
    const installed = fs.readFileSync(systemCertPath, "utf-8").trim();
    return ours === installed;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Per-hostname certificate generation (SNI)
// ---------------------------------------------------------------------------

/** Directory within state dir where per-hostname certs are cached. */
const HOST_CERTS_DIR = "host-certs";

/**
 * Sanitize a hostname for use as a filename.
 * Replaces dots with underscores and removes non-alphanumeric chars (except - and _).
 */
function sanitizeHostForFilename(hostname: string): string {
  return hostname.replace(/\./g, "_").replace(/[^a-z0-9_-]/gi, "");
}

/**
 * Maximum length of the X.509 Common Name (CN) field, per RFC 5280 §4.1.2.6.
 * Modern TLS uses Subject Alternative Names (SAN) for hostname matching, so
 * truncating the CN is safe because SANs always take precedence.
 */
const MAX_CN_LENGTH = 64;

/**
 * Generate a certificate for a specific hostname, signed by the local CA.
 * Certs are cached on disk in the host-certs subdirectory.
 *
 * Uses async openssl calls to avoid blocking the event loop, since this
 * runs on demand inside the SNI callback during TLS handshakes.
 */
async function generateHostCertAsync(
  stateDir: string,
  hostname: string
): Promise<{ certPath: string; keyPath: string }> {
  const caKeyPath = path.join(stateDir, CA_KEY_FILE);
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  const hostDir = path.join(stateDir, HOST_CERTS_DIR);

  if (!fs.existsSync(hostDir)) {
    await fs.promises.mkdir(hostDir, { recursive: true, mode: 0o755 });
    fixOwnership(hostDir);
  }

  const safeName = sanitizeHostForFilename(hostname);
  const keyPath = path.join(hostDir, `${safeName}-key.pem`);
  const certPath = path.join(hostDir, `${safeName}.pem`);
  const csrPath = path.join(hostDir, `${safeName}.csr`);
  const extPath = path.join(hostDir, `${safeName}-ext.cnf`);

  // Generate key
  await opensslAsync(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", keyPath]);

  // The X.509 CN field has a 64-character limit (RFC 5280 §4.1.2.6).
  // Truncate when necessary. TLS validation uses SANs, not CN, so this is safe.
  const cn = hostname.length > MAX_CN_LENGTH ? hostname.slice(0, MAX_CN_LENGTH) : hostname;
  // Generate CSR
  await opensslAsync(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${cn}`]);

  // Build SAN list: include the exact hostname plus a wildcard at the same level
  // e.g., for "chat.json-render2.localhost" -> also add "*.json-render2.localhost"
  const sans = [`DNS:${hostname}`];
  const parts = hostname.split(".");
  if (parts.length >= 2) {
    // Add a wildcard for sibling subdomains at the same level
    sans.push(`DNS:*.${parts.slice(1).join(".")}`);
  }

  await fs.promises.writeFile(
    extPath,
    [
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      `subjectAltName=${sans.join(",")}`,
    ].join("\n") + "\n"
  );

  // Use -CAserial with an explicit path instead of -CAcreateserial to avoid
  // incorrect .srl path resolution when $HOME contains a dot (see #152).
  const srlPath = path.join(stateDir, "ca.srl");
  if (!fs.existsSync(srlPath)) {
    await fs.promises.writeFile(
      srlPath,
      crypto.randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase() + "\n"
    );
  }
  await opensslAsync([
    "x509",
    "-req",
    "-sha256",
    "-in",
    csrPath,
    "-CA",
    caCertPath,
    "-CAkey",
    caKeyPath,
    "-CAserial",
    srlPath,
    "-out",
    certPath,
    "-days",
    SERVER_VALIDITY_DAYS.toString(),
    "-extfile",
    extPath,
  ]);

  // Clean up temporary files (keep ca.srl for serial number tracking)
  for (const tmp of [csrPath, extPath]) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      // Non-fatal
    }
  }

  await fs.promises.chmod(keyPath, 0o600);
  await fs.promises.chmod(certPath, 0o644);
  fixOwnership(keyPath, certPath);

  return { certPath, keyPath };
}

/**
 * Create an SNI callback for the TLS server.
 *
 * Only `localhost` itself uses the default server cert. All subdomains
 * (e.g., `tools.localhost`, `chat.myapp.localhost`) get a per-hostname
 * certificate generated on demand and signed by the local CA.
 *
 * RFC 2606 §2 reserves `.localhost` as a top-level domain (TLD). Because
 * `localhost` is a TLD, `*.localhost` sits at the public-suffix boundary and
 * TLS implementations are not permitted to honour wildcard certificates there.
 * Each subdomain therefore requires a certificate with an exact SAN entry.
 *
 * Certificate generation is async to avoid blocking the event loop. A
 * pending-promise map deduplicates concurrent requests for the same hostname.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc2606#section-2
 */
export function createSNICallback(
  stateDir: string,
  defaultCert: Buffer,
  defaultKey: Buffer,
  tld = "localhost",
  caCert?: Buffer
): (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void {
  const cache = new Map<string, tls.SecureContext>();
  const pending = new Map<string, Promise<tls.SecureContext>>();

  // Pre-cache the default context for the bare TLD itself.
  // Include the CA certificate so clients receive the full chain.
  const defaultCtx = tls.createSecureContext({
    cert: caCert ? Buffer.concat([defaultCert, caCert]) : defaultCert,
    key: defaultKey,
  });

  return (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
    // The bare TLD (e.g. "localhost" or "test") uses the default cert.
    // All subdomains need a cert with an exact SAN entry.
    // For .localhost: RFC 2606 §2 designates it as a reserved TLD, so
    // "*.localhost" sits at the public-suffix boundary and TLS specs do
    // not permit wildcard certificates at that level.
    if (servername === tld) {
      cb(null, defaultCtx);
      return;
    }

    // Check memory cache
    if (cache.has(servername)) {
      cb(null, cache.get(servername));
      return;
    }

    // Check if a cert already exists on disk
    const safeName = sanitizeHostForFilename(servername);
    const hostDir = path.join(stateDir, HOST_CERTS_DIR);
    const certPath = path.join(hostDir, `${safeName}.pem`);
    const keyPath = path.join(hostDir, `${safeName}-key.pem`);

    // Try reading existing cert from disk (may fail if files are root-owned)
    if (
      fileExists(certPath) &&
      fileExists(keyPath) &&
      isCertValid(certPath) &&
      isCertSignatureStrong(certPath)
    ) {
      try {
        const hostCert = fs.readFileSync(certPath);
        const ctx = tls.createSecureContext({
          cert: caCert ? Buffer.concat([hostCert, caCert]) : hostCert,
          key: fs.readFileSync(keyPath),
        });
        cache.set(servername, ctx);
        cb(null, ctx);
        return;
      } catch {
        // Permission error reading cached cert; regenerate below
      }
    }

    // If a generation is already in flight for this hostname, wait for it
    if (pending.has(servername)) {
      pending
        .get(servername)!
        .then((ctx) => cb(null, ctx))
        .catch((err) => cb(err instanceof Error ? err : new Error(String(err))));
      return;
    }

    // Generate a new cert for this hostname asynchronously
    const promise = generateHostCertAsync(stateDir, servername).then(async (generated) => {
      const [hostCert, key] = await Promise.all([
        fs.promises.readFile(generated.certPath),
        fs.promises.readFile(generated.keyPath),
      ]);
      return tls.createSecureContext({
        cert: caCert ? Buffer.concat([hostCert, caCert]) : hostCert,
        key,
      });
    });

    pending.set(servername, promise);

    promise
      .then((ctx) => {
        cache.set(servername, ctx);
        pending.delete(servername);
        cb(null, ctx);
      })
      .catch((err) => {
        pending.delete(servername);
        cb(err instanceof Error ? err : new Error(String(err)));
      });
  };
}

/**
 * Add the portless CA to the system trust store.
 *
 * On macOS, adds to the login keychain (no sudo required; the OS shows a
 * GUI authorization prompt to confirm). On Linux, copies to the distro-specific
 * CA directory and runs the appropriate update command (requires sudo).
 *
 * Supported Linux distros: Debian/Ubuntu, Arch, Fedora/RHEL/CentOS, openSUSE.
 */
export function trustCA(stateDir: string): { trusted: boolean; error?: string } {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) {
    return {
      trusted: false,
      error: "CA certificate not found. Run portless trust to generate it.",
    };
  }

  try {
    if (process.platform === "darwin") {
      const isRoot = (process.getuid?.() ?? -1) === 0;
      if (isRoot) {
        execFileSync(
          "security",
          [
            "add-trusted-cert",
            "-d",
            "-r",
            "trustRoot",
            "-k",
            "/Library/Keychains/System.keychain",
            caCertPath,
          ],
          { stdio: "pipe", timeout: MACOS_SECURITY_ROOT_TIMEOUT_MS }
        );
      } else {
        const keychain = loginKeychainPath();
        execFileSync(
          "security",
          ["add-trusted-cert", "-r", "trustRoot", "-k", keychain, caCertPath],
          { stdio: "pipe", timeout: MACOS_SECURITY_AUTH_TIMEOUT_MS }
        );
      }
      writeTrustMarker(stateDir);
      return { trusted: true };
    } else if (process.platform === "linux") {
      const config = getLinuxCATrustConfig();
      if (!fs.existsSync(config.certDir)) {
        fs.mkdirSync(config.certDir, { recursive: true });
      }
      const dest = path.join(config.certDir, "portless-ca.crt");
      fs.copyFileSync(caCertPath, dest);
      execFileSync(config.updateCommand, [], { stdio: "pipe", timeout: 30_000 });
      writeTrustMarker(stateDir);
      return { trusted: true };
    } else if (process.platform === "win32") {
      execFileSync("certutil", ["-addstore", "-user", "Root", caCertPath], {
        stdio: "pipe",
        timeout: 30_000,
      });
      writeTrustMarker(stateDir);
      return { trusted: true };
    }
    return { trusted: false, error: `Unsupported platform: ${process.platform}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ETIMEDOUT")) {
      const hint =
        process.platform === "darwin"
          ? "The macOS security command timed out. This can happen when the " +
            "Keychain Services daemon is unresponsive or a system authorization " +
            "dialog was not dismissed in time. Try restarting Keychain Access " +
            "(or run: sudo killall securityd) and then: portless trust"
          : "The trust command timed out. Try: portless trust";
      return { trusted: false, error: hint };
    }
    if (
      message.includes("authorization") ||
      message.includes("permission") ||
      message.includes("EACCES")
    ) {
      return {
        trusted: false,
        error: "Permission denied. Try: portless trust",
      };
    }
    return { trusted: false, error: message };
  }
}

/**
 * Remove the portless CA from the system trust store (inverse of trustCA).
 * No-op when the CA is not trusted or ca.pem is missing in stateDir.
 */
export function untrustCA(stateDir: string): { removed: boolean; error?: string } {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) {
    clearTrustMarker(stateDir);
    return { removed: true };
  }

  if (!isCATrusted(stateDir)) {
    clearTrustMarker(stateDir);
    return { removed: true };
  }

  try {
    let result: { removed: boolean; error?: string };
    if (process.platform === "darwin") {
      result = untrustCAMacOS(caCertPath);
    } else if (process.platform === "linux") {
      result = untrustCALinux(stateDir);
    } else if (process.platform === "win32") {
      result = untrustCAWindows(caCertPath);
    } else {
      result = { removed: false, error: `Unsupported platform: ${process.platform}` };
    }
    if (result.removed) clearTrustMarker(stateDir);
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { removed: false, error: message };
  }
}

function untrustCAMacOS(caCertPath: string): { removed: boolean; error?: string } {
  const errors: string[] = [];

  const tryExec = (args: string[]): boolean => {
    try {
      execFileSync("security", args, { stdio: "pipe", timeout: MACOS_SECURITY_ROOT_TIMEOUT_MS });
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      return false;
    }
  };

  tryExec(["remove-trusted-cert", caCertPath]);

  // delete-certificate -c fails when multiple certs share the same CN
  // ("is ambiguous, matches more than one certificate"). Loop until all
  // matching certs are removed from each keychain.
  const keychains = [loginKeychainPath(), "/Library/Keychains/System.keychain"];
  for (const kc of keychains) {
    for (let i = 0; i < 20; i++) {
      if (!tryExec(["delete-certificate", "-c", CA_COMMON_NAME, kc])) break;
    }
  }

  return isCATrustedMacOSAfterAttempt(caCertPath)
    ? { removed: false, error: errors.join("; ") || "Could not remove CA from keychain (try sudo)" }
    : { removed: true };
}

/** Re-run verify-cert without throwing; returns true if still trusted for SSL. */
function isCATrustedMacOSAfterAttempt(caCertPath: string): boolean {
  try {
    const isRoot = (process.getuid?.() ?? -1) === 0;
    const sudoUser = process.env.SUDO_USER;
    if (isRoot && sudoUser) {
      execFileSync(
        "sudo",
        ["-u", sudoUser, "security", "verify-cert", "-c", caCertPath, "-L", "-p", "ssl"],
        { stdio: "pipe", timeout: MACOS_SECURITY_TIMEOUT_MS }
      );
    } else {
      execFileSync("security", ["verify-cert", "-c", caCertPath, "-L", "-p", "ssl"], {
        stdio: "pipe",
        timeout: MACOS_SECURITY_TIMEOUT_MS,
      });
    }
    return true;
  } catch {
    return false;
  }
}

function untrustCALinux(stateDir: string): { removed: boolean; error?: string } {
  const errors: string[] = [];
  let deletedAny = false;

  for (const config of Object.values(LINUX_CA_TRUST_CONFIGS)) {
    const dest = path.join(config.certDir, "portless-ca.crt");
    try {
      if (fileExists(dest)) {
        const ours = fs.readFileSync(path.join(stateDir, CA_CERT_FILE), "utf-8").trim();
        const installed = fs.readFileSync(dest, "utf-8").trim();
        if (ours === installed) {
          fs.unlinkSync(dest);
          deletedAny = true;
        }
      }
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (deletedAny) {
    try {
      const config = getLinuxCATrustConfig();
      execFileSync(config.updateCommand, [], { stdio: "pipe", timeout: 30_000 });
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (isCATrusted(stateDir)) {
    return {
      removed: false,
      error:
        errors.join("; ") ||
        "CA still trusted (remove portless-ca.crt and run the distro CA update command, often with sudo)",
    };
  }
  return { removed: true };
}

function untrustCAWindows(caCertPath: string): { removed: boolean; error?: string } {
  try {
    const fingerprint = openssl(["x509", "-in", caCertPath, "-noout", "-fingerprint", "-sha1"])
      .trim()
      .replace(/^.*=/, "")
      .replace(/:/g, "")
      .toLowerCase();

    const storeListing = execFileSync("certutil", ["-store", "-user", "Root"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const normalized = storeListing.replace(/\s/g, "").toLowerCase();
    if (!normalized.includes(fingerprint)) {
      return { removed: true };
    }

    execFileSync("certutil", ["-delstore", "-user", "Root", "portless Local CA"], {
      stdio: "pipe",
      timeout: 30_000,
    });

    if (isCATrustedWindows(caCertPath)) {
      return { removed: false, error: "certutil could not remove the portless CA from Root" };
    }
    return { removed: true };
  } catch (err: unknown) {
    return { removed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

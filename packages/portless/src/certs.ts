import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as tls from "node:tls";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  explainUnsafeStateDir,
  fixOwnership,
  isCleanableStateDir,
  resolveUserHome,
} from "./utils.js";
import {
  inspectWindowsCATrust,
  isWSL,
  trustWindowsCA,
  untrustWindowsCA,
  wslWindowsCAStoreOptions,
} from "./windows-ca.js";
import { getPlatformCapabilities } from "./capabilities.js";

/** How long the CA certificate is valid (10 years, in days). */
const CA_VALIDITY_DAYS = 3650;

/** How long server certificates are valid (1 year, in days). */
const SERVER_VALIDITY_DAYS = 365;

/** Buffer (in ms) subtracted from expiry to trigger early regeneration. */
const EXPIRY_BUFFER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Common Name used for the portless local CA. */
const CA_COMMON_NAME = "portless Local CA";

/** openssl command timeout (ms). Tests raise it on runners with slow process startup. */
const OPENSSL_TIMEOUT_MS = Number(process.env.PORTLESS_OPENSSL_TIMEOUT_MS) || 15_000;

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
const CA_TRUST_REFRESH_PENDING = "ca.trust-refresh-pending";
/** Directory within state dir where per-hostname certs are cached. */
const HOST_CERTS_DIR = "host-certs";

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

/**
 * Create or replace a state marker file without following a symlink at the
 * destination, using an exclusive no-follow temp file and atomic rename.
 */
function writeStateMarkerFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!isCleanableStateDir(dir)) {
    throw new Error(`Refusing to write marker in unsafe state directory: ${dir}`);
  }
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  const openFlags =
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_WRONLY |
    (fs.constants.O_NOFOLLOW ?? 0);
  try {
    const fd = fs.openSync(tempPath, openFlags, 0o644);
    try {
      fs.writeFileSync(fd, content, "utf-8");
    } finally {
      fs.closeSync(fd);
    }
    fixOwnership(tempPath);
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Temp file may not have been created; ignore.
    }
    throw err;
  }
}

function hasRegularTrustRefreshPending(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function clearTrustRefreshPending(stateDir: string): void {
  try {
    fs.unlinkSync(path.join(stateDir, CA_TRUST_REFRESH_PENDING));
  } catch {
    // A trust refresh may not be pending; ignore.
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
 * Check whether a certificate has a wildcard SAN directly under a bare TLD
 * (such as "*.localhost"). Apple platforms reject such certificates outright.
 */
function hasTldWildcardSan(certPath: string): boolean {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    return /DNS:\*\.[^.,\s]+(,|$)/.test(cert.subjectAltName ?? "");
  } catch {
    return true;
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
 * Check whether a certificate lists the same X.509v3 extension more than once.
 * RFC 5280 requires extensions to be unique, and macOS's Security framework
 * rejects every chain through a CA that violates this ("Unknown critical cert
 * extension") regardless of trust settings.
 *
 * Earlier portless releases could emit such a CA when the ambient openssl.cnf
 * set `x509_extensions = v3_ca` for `req` (see #429). An existing CA that trips
 * this check is regenerated so affected users recover on upgrade.
 *
 * Parses the `openssl x509 -text` output: inside the `X509v3 extensions:`
 * block each extension name sits on its own line at a fixed indent, optionally
 * followed by `critical`, while values are indented one level deeper.
 */
function hasDuplicateExtensions(certPath: string): boolean {
  try {
    const text = openssl(["x509", "-in", certPath, "-noout", "-text"]);
    const block = text.split(/^\s*X509v3 extensions:\s*$/m)[1];
    if (!block) return false;
    const body = block.split(/^\s*Signature Algorithm:/m)[0];
    const names = [...body.matchAll(/^ {12}(\S.*?):(?: critical)?\s*$/gm)].map((m) => m[1]);
    return new Set(names).size !== names.length;
  } catch {
    return false;
  }
}

/**
 * Start a command that creates a private key with a umask that hides the file
 * from other users from the moment it exists. Some openssl builds create key
 * files with the caller's umask, which is world-readable by default.
 */
function withPrivateFileMode<T>(start: () => T): T {
  const previous = process.umask(0o077);
  try {
    return start();
  } finally {
    process.umask(previous);
  }
}

function openssl(args: string[], options?: { input?: string }): string {
  try {
    const extraEnv = getOpensslEnv();
    return execFileSync("openssl", args, {
      encoding: "utf-8",
      timeout: OPENSSL_TIMEOUT_MS,
      input: options?.input,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(extraEnv && Object.keys(extraEnv).length > 0
        ? { env: { ...process.env, ...extraEnv } }
        : {}),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`openssl failed: ${message}\n\n${opensslErrorMessage()}`);
  }
}

const NOT_BEFORE_SKEW_MS = 5 * 60 * 1000;

let notBeforeSupported: boolean | undefined;

/** Whether `openssl x509 -req` accepts `-not_before` for the given `openssl version` output. */
export function opensslSupportsNotBefore(version: string): boolean {
  const match = /^OpenSSL (\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 3 || (major === 3 && minor >= 4);
}

/** `-not_before` args that backdate a signed cert, or none if unsupported. */
function backdatedNotBeforeArgs(): string[] {
  if (notBeforeSupported === undefined) {
    try {
      notBeforeSupported = opensslSupportsNotBefore(openssl(["version"]));
    } catch {
      notBeforeSupported = false;
    }
  }
  if (!notBeforeSupported) return [];
  const start = new Date(Date.now() - NOT_BEFORE_SKEW_MS).toISOString();
  return ["-not_before", start.replace(/[-:T]/g, "").slice(0, 14) + "Z"];
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
      windowsHide: true,
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

/** Async version of backdatedNotBeforeArgs. */
async function backdatedNotBeforeArgsAsync(): Promise<string[]> {
  if (notBeforeSupported === undefined) {
    try {
      notBeforeSupported = opensslSupportsNotBefore(await opensslAsync(["version"]));
    } catch {
      notBeforeSupported = false;
    }
  }
  return backdatedNotBeforeArgs();
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
  const reqConfigPath = path.join(stateDir, `ca-req-${process.pid}-${crypto.randomUUID()}.cnf`);

  // Generate EC private key
  withPrivateFileMode(() =>
    openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", keyPath])
  );

  // Generate self-signed CA certificate.
  //
  // `-config` is passed explicitly (a minimal config with no
  // `x509_extensions` default) instead of relying on the environment's
  // ambient openssl.cnf. Some openssl builds ship the stock upstream
  // template, which sets `x509_extensions = v3_ca` under `[ req ]`; combined
  // with `-addext basicConstraints=...` below that produces a certificate
  // with the Basic Constraints extension listed twice. That's invalid per
  // RFC 5280 (extensions must be unique) and macOS's Security framework
  // rejects the whole chain with "Unknown critical cert extension",
  // regardless of trust settings, so every *.localhost site looks
  // untrusted even after `portless trust` succeeds.
  //
  // The subject lives in the config rather than in `-subj`: LibreSSL (the
  // openssl shipped with macOS) refuses a `prompt = no` request whose
  // distinguished_name section is empty, even when `-subj` is given.
  fs.writeFileSync(
    reqConfigPath,
    [
      "[req]",
      "distinguished_name = req_distinguished_name",
      "prompt = no",
      "[req_distinguished_name]",
      `CN = ${CA_COMMON_NAME}`,
      "",
    ].join("\n")
  );
  try {
    openssl([
      "req",
      "-new",
      "-x509",
      "-sha256",
      "-key",
      keyPath,
      "-out",
      certPath,
      ...backdatedNotBeforeArgs(),
      "-days",
      CA_VALIDITY_DAYS.toString(),
      "-config",
      reqConfigPath,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-addext",
      "subjectKeyIdentifier=hash",
      "-addext",
      "authorityKeyIdentifier=keyid:always",
    ]);
  } finally {
    fs.rmSync(reqConfigPath, { force: true });
  }

  fs.chmodSync(keyPath, 0o600);
  fs.chmodSync(certPath, 0o644);
  fixOwnership(keyPath, certPath);

  clearTrustMarker(stateDir);

  // Per-hostname certificates issued by the previous CA no longer chain to
  // this one, and the SNI callback serves cached certs from disk without
  // checking their issuer, so drop them to be re-issued on demand.
  fs.rmSync(path.join(stateDir, HOST_CERTS_DIR), { recursive: true, force: true });

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
  withPrivateFileMode(() =>
    openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", serverKeyPath])
  );

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
    ...backdatedNotBeforeArgs(),
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
  fixOwnership(serverKeyPath, serverCertPath, srlPath);

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
    !isCertSignatureStrong(caCertPath) ||
    hasDuplicateExtensions(caCertPath);

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

export type SystemTrustStoreState = "trusted" | "untrusted" | "unavailable";

export type BrowserTrustStoreState = "trusted" | "untrusted" | "unavailable" | "not-applicable";

export type TrustStores = {
  system: SystemTrustStoreState;
  browser: BrowserTrustStoreState;
};

export type TrustInspectionState = "trusted" | "untrusted" | "unavailable";

export type TrustInspection = {
  state: TrustInspectionState;
  stores: TrustStores;
  hint?: string;
  error?: string;
};

export type EnsureTrustState = "trusted" | "installed" | "needs-elevation" | "unavailable";

export type EnsureTrustResult = {
  state: EnsureTrustState;
  stores: TrustStores;
  hint?: string;
  error?: string;
};

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
  const home = resolveUserHome();
  const sudoUser = process.env.SUDO_USER;
  if ((process.getuid?.() ?? -1) === 0 && sudoUser && sudoUser !== "root") {
    return path.join(home, "Library", "Keychains", "login.keychain-db");
  }
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
  return path.join(home, "Library", "Keychains", "login.keychain-db");
}

export interface LinuxCATrustConfig {
  certDir: string;
  updateCommand: string;
  bundlePaths?: string[];
}

export interface LinuxCATrustOptions {
  activeConfig?: LinuxCATrustConfig;
  runUpdate?: (command: string) => void;
  envPath?: string;
  osRelease?: string;
}

export interface LinuxCATrustRemovalOptions extends LinuxCATrustOptions {
  configs?: LinuxCATrustConfig[];
}

const LINUX_CA_TRUST_CONFIGS: Record<string, LinuxCATrustConfig> = {
  debian: {
    certDir: "/usr/local/share/ca-certificates",
    updateCommand: "update-ca-certificates",
    bundlePaths: ["/etc/ssl/certs/ca-certificates.crt"],
  },
  arch: {
    certDir: "/etc/ca-certificates/trust-source/anchors",
    updateCommand: "update-ca-trust",
    bundlePaths: [
      "/etc/ca-certificates/extracted/tls-ca-bundle.pem",
      "/etc/ssl/certs/ca-certificates.crt",
    ],
  },
  fedora: {
    certDir: "/etc/pki/ca-trust/source/anchors",
    updateCommand: "update-ca-trust",
    bundlePaths: [
      "/etc/pki/tls/certs/ca-bundle.crt",
      "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    ],
  },
  suse: {
    certDir: "/etc/pki/trust/anchors",
    updateCommand: "update-ca-certificates",
    bundlePaths: ["/var/lib/ca-certificates/ca-bundle.pem", "/etc/ssl/certs/ca-certificates.crt"],
  },
};

const LINUX_FALLBACK_BUNDLE_PATHS = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-bundle.crt",
];

function osReleaseValue(osRelease: string, field: string): string {
  const match = new RegExp(`^${field}=(.*)$`, "m").exec(osRelease);
  if (!match) return "";
  return match[1]
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

/**
 * Detect the Linux distro family from /etc/os-release or the provided content.
 * Returns a config key, "nixos", or undefined when the distro is unrecognized.
 */
function detectLinuxDistro(osRelease?: string): string | undefined {
  let content = osRelease;
  if (content === undefined) {
    try {
      content = fs.readFileSync("/etc/os-release", "utf-8");
    } catch {
      content = "";
    }
  }

  const ids = `${osReleaseValue(content, "ID")} ${osReleaseValue(content, "ID_LIKE")}`;
  if (ids.includes("nixos")) return "nixos";
  if (ids.includes("arch")) return "arch";
  if (ids.includes("fedora") || ids.includes("rhel") || ids.includes("centos")) return "fedora";
  if (ids.includes("suse")) return "suse";
  if (ids.includes("debian") || ids.includes("ubuntu")) return "debian";

  for (const [distro, config] of Object.entries(LINUX_CA_TRUST_CONFIGS)) {
    if (resolveExecutable(config.updateCommand) && fs.existsSync(path.dirname(config.certDir))) {
      return distro;
    }
  }

  return undefined;
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a command against PATH, also probing sbin when /usr/bin is present. */
function resolveExecutable(command: string, envPath?: string): string | null {
  if (path.isAbsolute(command)) {
    return isExecutableFile(command) ? command : null;
  }
  const dirs = (envPath ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [...dirs];
  if (dirs.includes("/usr/bin")) {
    candidates.push("/usr/sbin", "/sbin");
  }
  for (const dir of candidates) {
    const candidate = path.join(dir, command);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Get the CA trust config for the current Linux distro.
 * Falls back to Debian layout if detection fails.
 */
function getLinuxCATrustConfig(osRelease?: string): LinuxCATrustConfig {
  const distro = detectLinuxDistro(osRelease);
  return (distro ? LINUX_CA_TRUST_CONFIGS[distro] : undefined) ?? LINUX_CA_TRUST_CONFIGS.debian;
}

/**
 * Verify the CA against the distro's compiled trust bundle with openssl.
 * A copied anchor alone does not prove the bundle was refreshed.
 */
function verifyLinuxTrustBundle(caCertPath: string, config: LinuxCATrustConfig): boolean {
  const bundlePath = (config.bundlePaths ?? LINUX_FALLBACK_BUNDLE_PATHS).find(fileExists);
  if (!bundlePath) return false;
  try {
    openssl(["verify", "-no-CApath", "-CAfile", bundlePath, caCertPath]);
    return true;
  } catch {
    return false;
  }
}

/** Check whether the Linux system trust bundle trusts the CA. */
function isCATrustedLinux(
  stateDir: string,
  config: LinuxCATrustConfig = getLinuxCATrustConfig()
): boolean {
  if (isCATrustRefreshPending(stateDir)) return false;
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) return false;
  return verifyLinuxTrustBundle(caCertPath, config);
}

function linuxTrustSourceMatches(config: LinuxCATrustConfig, caCertPath: string): boolean {
  const dest = path.join(config.certDir, "portless-ca.crt");
  try {
    if (!fileExists(dest)) return false;
    return fs.readFileSync(dest, "utf-8").trim() === fs.readFileSync(caCertPath, "utf-8").trim();
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function linuxNSSDatabase(): string | undefined {
  const home = resolveUserHome();
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim();
  const candidates = [
    path.join(home, ".pki", "nssdb"),
    ...(xdgDataHome ? [path.join(xdgDataHome, "pki", "nssdb")] : []),
    path.join(home, ".local", "share", "pki", "nssdb"),
  ];
  return candidates.find(isDirectory);
}

function nssInstallHint(database?: string): string {
  const where = database ? ` in ${database}` : "";
  return `Chrome/Chromium reads NSS trust from a user database${where} and needs certutil to update it. Install libnss3-tools (Debian/Ubuntu), nss-tools (Fedora/RHEL), nss (Arch), or mozilla-nss-tools (openSUSE).`;
}

function nssNickname(caCertPath: string): string {
  const certificate = new crypto.X509Certificate(fs.readFileSync(caCertPath));
  return `${CA_COMMON_NAME} ${certificate.fingerprint256.replace(/:/g, "")}`;
}

type LinuxNSSIdentity = {
  uid: number;
  gid: number;
  user?: string;
};

function parsePositiveId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function lookupPasswdIdentity(username: string): LinuxNSSIdentity | null {
  try {
    const passwd = fs.readFileSync("/etc/passwd", "utf-8");
    for (const line of passwd.split("\n")) {
      const fields = line.split(":");
      if (fields[0] !== username) continue;
      const uid = parsePositiveId(fields[2]);
      const gid = parsePositiveId(fields[3]);
      if (uid !== null && gid !== null) {
        return { uid, gid, user: username };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveLinuxNSSIdentity(): LinuxNSSIdentity | null {
  const sudoUid = parsePositiveId(process.env.SUDO_UID);
  const sudoGid = parsePositiveId(process.env.SUDO_GID);
  const sudoUser = process.env.SUDO_USER;
  if (sudoUid !== null && sudoGid !== null) {
    return {
      uid: sudoUid,
      gid: sudoGid,
      ...(sudoUser && sudoUser !== "root" ? { user: sudoUser } : {}),
    };
  }
  if (sudoUser && sudoUser !== "root") {
    return lookupPasswdIdentity(sudoUser);
  }
  return null;
}

function resolveRootNSSDrop(database: string): LinuxNSSIdentity {
  const identity = resolveLinuxNSSIdentity();
  if (!identity) {
    throw new Error(
      `Refusing to access Chrome/Chromium NSS database (${database}) as root without a non-root user identity.`
    );
  }
  const stat = fs.statSync(database);
  if (stat.uid !== identity.uid) {
    throw new Error(
      `Refusing to access Chrome/Chromium NSS database (${database}) owned by UID ${stat.uid} as UID ${identity.uid}.`
    );
  }
  return identity;
}

function nssCertutil(
  database: string,
  args: string[],
  input?: string,
  certutilPath = "certutil"
): string {
  const options = { encoding: "utf-8" as const, stdio: "pipe" as const, timeout: 15_000, input };
  if (process.getuid?.() === 0) {
    const identity = resolveRootNSSDrop(database);
    const sudoArgs = identity.user
      ? ["-u", identity.user, "--", certutilPath, "-d", `sql:${database}`, ...args]
      : [
          "-u",
          `#${identity.uid}`,
          "-g",
          `#${identity.gid}`,
          "--",
          certutilPath,
          "-d",
          `sql:${database}`,
          ...args,
        ];
    return execFileSync("sudo", sudoArgs, options);
  }
  return execFileSync(certutilPath, ["-d", `sql:${database}`, ...args], options);
}

const NSS_TRUST_LINE = /^(.*?)\s+([^\s,]*,[^\s,]*,[^\s,]*)$/;

function nssTrustFlagsForNickname(listing: string, nickname: string): string | undefined {
  for (const line of listing.split(/\r?\n/)) {
    const match = NSS_TRUST_LINE.exec(line.trim());
    if (match?.[1].trim() === nickname) return match[2];
  }
  return undefined;
}

type NSSAccess =
  | { status: "not-applicable" }
  | { status: "unavailable"; reason: string; hint: string }
  | { status: "ready"; database: string; certutilPath: string };

function resolveNSSAccess(envPath?: string): NSSAccess {
  const database = linuxNSSDatabase();
  if (!database) return { status: "not-applicable" };
  if (process.getuid?.() === 0) {
    try {
      resolveRootNSSDrop(database);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        status: "unavailable",
        reason,
        hint: `${reason} Run portless trust as your regular user.`,
      };
    }
  }
  const certutilPath = resolveExecutable("certutil", envPath);
  if (!certutilPath) {
    const hint = nssInstallHint(database);
    return { status: "unavailable", reason: hint, hint };
  }
  return { status: "ready", database, certutilPath };
}

/** Inspect whether Chrome/Chromium trusts the CA through its user NSS database. */
function inspectLinuxNSSStore(
  caCertPath: string,
  envPath?: string
): { state: BrowserTrustStoreState; hint?: string } {
  const access = resolveNSSAccess(envPath);
  if (access.status === "not-applicable") return { state: "not-applicable" };
  if (access.status === "unavailable") return { state: "unavailable", hint: access.hint };

  try {
    const nickname = nssNickname(caCertPath);
    const listing = nssCertutil(access.database, ["-L"], undefined, access.certutilPath);
    const flags = nssTrustFlagsForNickname(listing, nickname);
    if (!flags?.split(",")[0].includes("C")) {
      return { state: "untrusted", hint: "Run: portless trust" };
    }
    const pem = nssCertutil(
      access.database,
      ["-L", "-n", nickname, "-a"],
      undefined,
      access.certutilPath
    );
    const expected = new crypto.X509Certificate(fs.readFileSync(caCertPath)).fingerprint256;
    if (new crypto.X509Certificate(pem).fingerprint256 === expected) {
      return { state: "trusted" };
    }
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      state: "unavailable",
      hint: `Could not read the Chrome/Chromium NSS database: ${detail}. Run: portless trust`,
    };
  }
  return { state: "untrusted", hint: "Run: portless trust" };
}

function installLinuxNSSStore(
  caCertPath: string,
  envPath?: string
): { state: BrowserTrustStoreState; error?: string } {
  const access = resolveNSSAccess(envPath);
  if (access.status === "not-applicable") return { state: "not-applicable" };
  if (access.status === "unavailable") return { state: "unavailable", error: access.reason };
  try {
    nssCertutil(
      access.database,
      ["-A", "-n", nssNickname(caCertPath), "-t", "C,,"],
      fs.readFileSync(caCertPath, "utf-8"),
      access.certutilPath
    );
  } catch (error: unknown) {
    return {
      state: "untrusted",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return inspectLinuxNSSStore(caCertPath, envPath);
}

const PORTLESS_NSS_NICKNAME = new RegExp(`^${CA_COMMON_NAME} [0-9A-Fa-f]{64}$`);

function removeLinuxNSSStore(caCertPath: string): { removed: boolean; error?: string } {
  const access = resolveNSSAccess();
  if (access.status === "not-applicable") return { removed: true };
  if (access.status === "unavailable") return { removed: false, error: access.reason };
  try {
    const currentNickname = nssNickname(caCertPath);
    const listing = nssCertutil(access.database, ["-L"], undefined, access.certutilPath);
    const nicknames = new Set<string>();
    for (const line of listing.split(/\r?\n/)) {
      const match = NSS_TRUST_LINE.exec(line.trim());
      const name = match?.[1].trim();
      if (name && (name === currentNickname || PORTLESS_NSS_NICKNAME.test(name))) {
        nicknames.add(name);
      }
    }
    for (const nickname of nicknames) {
      nssCertutil(access.database, ["-D", "-n", nickname], undefined, access.certutilPath);
    }
    return { removed: true };
  } catch (error: unknown) {
    return { removed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function trustCALinux(
  stateDir: string,
  config: LinuxCATrustConfig,
  updateCommand: string,
  runUpdate: (command: string) => void
): void {
  if (isCATrustedLinux(stateDir, config)) return;

  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  const dest = path.join(config.certDir, "portless-ca.crt");
  const pendingPath = path.join(stateDir, CA_TRUST_REFRESH_PENDING);
  const wasPending = hasRegularTrustRefreshPending(pendingPath);

  if (!fs.existsSync(config.certDir)) {
    fs.mkdirSync(config.certDir, { recursive: true });
  }
  if (!wasPending) writeStateMarkerFile(pendingPath, "1\n");
  try {
    fs.copyFileSync(caCertPath, dest);
  } catch (error: unknown) {
    if (!wasPending) clearTrustRefreshPending(stateDir);
    throw error;
  }

  runUpdate(updateCommand);
  if (!verifyLinuxTrustBundle(caCertPath, config)) {
    throw new Error(
      `After running ${updateCommand}, the compiled CA bundle does not trust the portless CA. Run: sudo portless trust`
    );
  }
  clearTrustRefreshPending(stateDir);
}

// ---------------------------------------------------------------------------
// Per-hostname certificate generation (SNI)
// ---------------------------------------------------------------------------

/**
 * Longest suffix appended to a sanitized host when composing a cert cache
 * filename (`-key.pem` and `-ext.cnf` are both 8 bytes). The sanitized base
 * must leave room for it under the filesystem's per-component limit.
 */
const CERT_FILENAME_SUFFIX_LEN = "-key.pem".length;

/**
 * Conservative per-component filename limit. Most POSIX filesystems cap
 * NAME_MAX at 255 bytes; the sanitized base is bounded so the longest
 * composed filename (`${base}-key.pem`) never exceeds it.
 */
const MAX_FILENAME_BASE = 255 - CERT_FILENAME_SUFFIX_LEN;

/**
 * Sanitize a hostname for use as a filename.
 * Replaces dots with underscores and removes non-alphanumeric chars (except - and _).
 *
 * Multi-segment TLDs allow hostnames up to the 253-char DNS limit, whose
 * composed cert filenames would exceed NAME_MAX and fail generation with
 * ENAMETOOLONG. When the sanitized base would overflow, its readable prefix is
 * truncated and a hash of the full hostname is appended, keeping the mapping
 * deterministic (same host -> same file, so the cache still hits) and
 * collision-resistant (distinct hosts -> distinct files).
 */
export function sanitizeHostForFilename(hostname: string): string {
  const safe = hostname.replace(/\./g, "_").replace(/[^a-z0-9_-]/gi, "");
  if (safe.length <= MAX_FILENAME_BASE) {
    return safe;
  }
  const hash = crypto.createHash("sha256").update(hostname).digest("hex").slice(0, 16);
  const prefix = safe.slice(0, MAX_FILENAME_BASE - hash.length - 1);
  return `${prefix}_${hash}`;
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
  await withPrivateFileMode(() =>
    opensslAsync(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", keyPath])
  );

  // The X.509 CN field has a 64-character limit (RFC 5280 §4.1.2.6).
  // Truncate when necessary. TLS validation uses SANs, not CN, so this is safe.
  const cn = hostname.length > MAX_CN_LENGTH ? hostname.slice(0, MAX_CN_LENGTH) : hostname;
  // Generate CSR
  await opensslAsync(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${cn}`]);

  const sans = [`DNS:${hostname}`];
  const parts = hostname.split(".");
  if (parts.length >= 3) {
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
    ...(await backdatedNotBeforeArgsAsync()),
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
  fixOwnership(keyPath, certPath, srlPath);

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
  tlds: string | readonly string[] = "localhost",
  caCert?: Buffer
): (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void {
  const cache = new Map<string, tls.SecureContext>();
  const pending = new Map<string, Promise<tls.SecureContext>>();
  const configuredTlds = Array.isArray(tlds) ? tlds : [tlds];

  // Pre-cache the default context for the built-in localhost certificate.
  // Include the CA certificate so clients receive the full chain.
  const defaultCtx = tls.createSecureContext({
    cert: caCert ? Buffer.concat([defaultCert, caCert]) : defaultCert,
    key: defaultKey,
  });

  return (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
    // The bare localhost name uses the default cert.
    // All subdomains need a cert with an exact SAN entry.
    // For .localhost: RFC 2606 §2 designates it as a reserved TLD, so
    // "*.localhost" sits at the public-suffix boundary and TLS specs do
    // not permit wildcard certificates at that level.
    if (servername === "localhost") {
      cb(null, defaultCtx);
      return;
    }

    const name = servername.toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(name) || !configuredTlds.some((tld) => name.endsWith(`.${tld}`))) {
      cb(new Error(`Refusing certificate for ${servername}: not under a configured TLD`));
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
      isCertSignatureStrong(certPath) &&
      !hasTldWildcardSan(certPath)
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

function trustStateFromStores(stores: TrustStores): TrustInspectionState {
  if (stores.system === "unavailable" || stores.browser === "unavailable") return "unavailable";
  if (stores.browser === "untrusted") return "untrusted";
  return stores.system;
}

function trustErrorDetail(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
  if (stderr) {
    const text = stderr.toString().trim();
    if (text) return text;
  }
  return err instanceof Error ? err.message : String(err);
}

function addCATrustedMacOS(caCertPath: string): void {
  const isRoot = (process.getuid?.() ?? -1) === 0;
  if (isRoot) {
    execFileSync(
      "security",
      [
        "add-trusted-cert",
        "-d",
        "-r",
        "trustRoot",
        "-p",
        "ssl",
        "-k",
        "/Library/Keychains/System.keychain",
        caCertPath,
      ],
      { stdio: "pipe", timeout: MACOS_SECURITY_ROOT_TIMEOUT_MS }
    );
    return;
  }
  const keychain = loginKeychainPath();
  execFileSync(
    "security",
    ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-k", keychain, caCertPath],
    { stdio: "pipe", timeout: MACOS_SECURITY_AUTH_TIMEOUT_MS }
  );
}

function unsupportedTrustResult(): {
  state: "unavailable";
  stores: TrustStores;
  error: string;
  hint?: string;
} {
  const { trust } = getPlatformCapabilities();
  return {
    state: "unavailable",
    stores: { system: "unavailable", browser: "not-applicable" },
    error: trust.supported ? `Unsupported platform: ${process.platform}` : trust.reason,
    ...(!trust.supported ? { hint: trust.hint } : {}),
  };
}

/**
 * Inspect the OS and browser trust stores for the portless CA.
 *
 * On Linux the system store is the compiled CA bundle, and Chrome/Chromium
 * uses a separate user NSS database.
 */
export function inspectTrust(
  stateDir: string,
  options?: { linux?: LinuxCATrustOptions }
): TrustInspection {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) {
    return {
      state: "untrusted",
      stores: { system: "untrusted", browser: "not-applicable" },
      error: "CA certificate not found. Run portless trust to generate it.",
      hint: "Run: portless trust",
    };
  }

  if (process.platform === "darwin") {
    const trusted = isCATrustedMacOS(caCertPath);
    return {
      state: trusted ? "trusted" : "untrusted",
      stores: { system: trusted ? "trusted" : "untrusted", browser: "not-applicable" },
      ...(trusted ? {} : { hint: "Run: portless trust" }),
    };
  }

  if (process.platform === "linux") {
    const linux = options?.linux;
    const config = linux?.activeConfig ?? getLinuxCATrustConfig(linux?.osRelease);
    const browser = inspectLinuxNSSStore(caCertPath, linux?.envPath);

    if (!isCATrustedLinux(stateDir, config)) {
      const nixos = detectLinuxDistro(linux?.osRelease) === "nixos";
      const updateTool = linux?.runUpdate
        ? config.updateCommand
        : resolveExecutable(config.updateCommand, linux?.envPath);
      if (!updateTool) {
        const hint = nixos
          ? `NixOS manages system certificates declaratively and does not provide update-ca-certificates. Add \`security.pki.certificateFiles = [ "${caCertPath}" ];\` to your NixOS configuration and rebuild, or run portless with --no-tls.`
          : `Install your distribution's CA certificates package so ${config.updateCommand} is available (or on NixOS, add "${caCertPath}" to security.pki.certificateFiles), or run portless with --no-tls.`;
        return {
          state: "unavailable",
          stores: { system: "unavailable", browser: browser.state },
          error: nixos
            ? `NixOS does not provide ${config.updateCommand} to refresh the system trust store.`
            : `Trust store update tool "${config.updateCommand}" was not found.`,
          hint,
        };
      }
      return {
        state: "untrusted",
        stores: { system: "untrusted", browser: browser.state },
        hint: "Run: portless trust",
      };
    }

    if (isWSL()) {
      let windows: ReturnType<typeof inspectWindowsCATrust>;
      try {
        windows = inspectWindowsCATrust(caCertPath, wslWindowsCAStoreOptions());
      } catch (error: unknown) {
        windows = {
          state: "unavailable",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (windows.state !== "trusted") {
        return {
          state: windows.state,
          stores: { system: windows.state, browser: browser.state },
          ...(windows.error ? { error: windows.error } : {}),
          hint:
            windows.state === "unavailable"
              ? "Ensure wslpath and Windows certutil.exe are available from WSL, then run: portless trust"
              : "Run: portless trust",
        };
      }
    }

    return {
      state: trustStateFromStores({ system: "trusted", browser: browser.state }),
      stores: { system: "trusted", browser: browser.state },
      ...(browser.hint ? { hint: browser.hint } : {}),
    };
  }

  if (process.platform === "win32") {
    const windows = inspectWindowsCATrust(caCertPath);
    return {
      state: windows.state,
      stores: { system: windows.state, browser: "not-applicable" },
      ...(windows.error ? { error: windows.error } : {}),
      ...(windows.state === "trusted" ? {} : { hint: "Run: portless trust" }),
    };
  }

  return unsupportedTrustResult();
}

/**
 * Install the portless CA into the trust stores that need it.
 *
 * Reports `needs-elevation` when the OS refused the change for the current
 * user, so the caller can suggest running with sudo.
 */
export function ensureTrust(
  configuredStateDir: string,
  options?: { linux?: LinuxCATrustOptions }
): EnsureTrustResult {
  if (!fileExists(path.join(configuredStateDir, CA_CERT_FILE))) {
    return {
      state: "unavailable",
      stores: { system: "unavailable", browser: "not-applicable" },
      error: "CA certificate not found. Run portless trust to generate it.",
      hint: "Run: portless trust",
    };
  }
  const unsafe = explainUnsafeStateDir(configuredStateDir);
  if (unsafe) {
    return {
      state: "unavailable",
      stores: { system: "untrusted", browser: "not-applicable" },
      error: `Refusing to trust the CA in ${configuredStateDir}: ${unsafe}`,
    };
  }

  const stateDir = fs.realpathSync(configuredStateDir);
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  const initial = inspectTrust(stateDir, options);
  if (initial.state === "trusted") {
    return { state: "trusted", stores: initial.stores };
  }
  if (initial.stores.system === "unavailable") {
    return {
      state: "unavailable",
      stores: initial.stores,
      ...(initial.error ? { error: initial.error } : {}),
      ...(initial.hint ? { hint: initial.hint } : {}),
    };
  }

  const linux = options?.linux;
  let stores = { ...initial.stores };
  let hint: string | undefined;
  let installed = false;

  if (stores.system === "untrusted") {
    try {
      if (process.platform === "darwin") {
        addCATrustedMacOS(caCertPath);
        if (!isCATrustedMacOS(caCertPath)) {
          return {
            state: "unavailable",
            stores: { ...stores, system: "untrusted" },
            error:
              "The macOS security command finished but the CA is still not trusted. Run: sudo portless trust",
          };
        }
      } else if (process.platform === "linux") {
        const config = linux?.activeConfig ?? getLinuxCATrustConfig(linux?.osRelease);
        const resolvedCommand = linux?.runUpdate
          ? null
          : resolveExecutable(config.updateCommand, linux?.envPath);
        const updateCommand = resolvedCommand ?? config.updateCommand;
        const runUpdate =
          linux?.runUpdate ??
          ((command: string) => {
            execFileSync(command, [], { stdio: "pipe", timeout: 30_000 });
          });
        trustCALinux(stateDir, config, updateCommand, runUpdate);
        if (isWSL()) {
          const windowsOptions = wslWindowsCAStoreOptions();
          trustWindowsCA(caCertPath, windowsOptions);
          const windows = inspectWindowsCATrust(caCertPath, windowsOptions);
          if (windows.state !== "trusted") {
            throw new Error(
              windows.error ?? "certutil did not add the portless CA to the Windows Root store"
            );
          }
        }
      } else if (process.platform === "win32") {
        trustWindowsCA(caCertPath);
        const windows = inspectWindowsCATrust(caCertPath);
        if (windows.state !== "trusted") {
          throw new Error(
            windows.error ?? "certutil did not add the portless CA to the Windows Root store"
          );
        }
      } else {
        return unsupportedTrustResult();
      }
      stores = { ...stores, system: "trusted" };
      installed = true;
    } catch (err: unknown) {
      const detail = trustErrorDetail(err);
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const timedOut = code === "ETIMEDOUT" || detail.includes("ETIMEDOUT");
      const denied =
        code === "EACCES" ||
        code === "EPERM" ||
        /permission denied|eacces|authorization|not permitted/i.test(detail);

      if (timedOut) {
        return {
          state: "unavailable",
          stores: { ...stores, system: "untrusted" },
          error: detail,
          hint:
            process.platform === "darwin"
              ? "The macOS security command timed out. Restart Keychain Access (or run: sudo killall securityd), then run: portless trust"
              : "The trust command timed out. Try: portless trust",
        };
      }
      if (denied && process.platform !== "win32" && (process.getuid?.() ?? -1) !== 0) {
        return {
          state: "needs-elevation",
          stores,
          error: detail,
          hint: "Run: sudo portless trust",
        };
      }
      return {
        state: "unavailable",
        stores: { ...stores, system: "untrusted" },
        error: detail,
      };
    }
  }

  if (process.platform === "linux" && stores.system === "trusted") {
    const browser = inspectLinuxNSSStore(caCertPath, linux?.envPath);
    if (browser.state === "untrusted") {
      const result = installLinuxNSSStore(caCertPath, linux?.envPath);
      if (result.state === "trusted") {
        stores = { ...stores, browser: "trusted" };
        installed = true;
      } else {
        stores = { ...stores, browser: "untrusted" };
        hint = `Chrome/Chromium NSS trust update failed (${result.error ?? "certutil failed"}). Fix the NSS database error and run: portless trust`;
      }
    } else if (browser.state === "unavailable") {
      stores = { ...stores, browser: "unavailable" };
      hint = browser.hint ?? nssInstallHint();
    } else {
      stores = { ...stores, browser: browser.state };
    }
  }

  return { state: installed ? "installed" : "trusted", stores, ...(hint ? { hint } : {}) };
}

/** Whether a previous CA removal still needs the distro trust cache refresh. */
export function isCATrustRefreshPending(stateDir: string): boolean {
  return hasRegularTrustRefreshPending(path.join(stateDir, CA_TRUST_REFRESH_PENDING));
}

/**
 * Remove the portless CA from the system trust store (inverse of trustCA).
 * No-op when the CA is not trusted or ca.pem is missing in stateDir.
 */
export function untrustCA(stateDir: string): { removed: boolean; error?: string } {
  let canonicalStateDir = stateDir;
  try {
    canonicalStateDir = fs.realpathSync(stateDir);
  } catch {
    canonicalStateDir = stateDir;
  }
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) {
    clearTrustMarker(canonicalStateDir);
    if (canonicalStateDir !== stateDir) clearTrustMarker(stateDir);
    return { removed: true };
  }

  const runningInWSL = isWSL();
  try {
    let result: { removed: boolean; error?: string };
    if (process.platform === "darwin") {
      result = untrustCAMacOS(caCertPath);
    } else if (process.platform === "linux") {
      result = runningInWSL ? untrustCAWSL(stateDir, caCertPath) : untrustCALinux(stateDir);
      const nss = removeLinuxNSSStore(caCertPath);
      if (!nss.removed) {
        const combined = [result.error, nss.error].filter(Boolean).join("; ");
        result = {
          removed: false,
          error: combined || "Could not remove the portless CA from the Chrome NSS store",
        };
      }
    } else if (process.platform === "win32") {
      result = untrustWindowsCA(caCertPath);
    } else {
      result = { removed: false, error: `Unsupported platform: ${process.platform}` };
    }
    if (result.removed) {
      clearTrustMarker(canonicalStateDir);
      if (canonicalStateDir !== stateDir) clearTrustMarker(stateDir);
    }
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

  return isCATrustedMacOS(caCertPath)
    ? { removed: false, error: errors.join("; ") || "Could not remove CA from keychain (try sudo)" }
    : { removed: true };
}

export function untrustCALinux(
  stateDir: string,
  options: LinuxCATrustRemovalOptions = {}
): { removed: boolean; error?: string } {
  if (!isCleanableStateDir(stateDir)) {
    return {
      removed: false,
      error: `Refusing to untrust CA from unsafe state directory: ${stateDir}`,
    };
  }
  const errors: string[] = [];
  const pendingRefreshPath = path.join(stateDir, CA_TRUST_REFRESH_PENDING);
  let refreshNeeded = hasRegularTrustRefreshPending(pendingRefreshPath);
  const configs = options.configs ?? Object.values(LINUX_CA_TRUST_CONFIGS);
  const activeConfig = options.activeConfig ?? getLinuxCATrustConfig(options.osRelease);
  const runUpdate =
    options.runUpdate ??
    ((command: string) => {
      execFileSync(command, [], { stdio: "pipe", timeout: 30_000 });
    });

  for (const config of configs) {
    const dest = path.join(config.certDir, "portless-ca.crt");
    try {
      if (fileExists(dest)) {
        const caCertPath = path.join(stateDir, CA_CERT_FILE);
        const caStat = fs.lstatSync(caCertPath);
        if (!caStat.isFile() || caStat.isSymbolicLink()) {
          throw new Error(`Refusing symlinked CA certificate: ${caCertPath}`);
        }
        const ours = fs.readFileSync(caCertPath, "utf-8").trim();
        const installed = fs.readFileSync(dest, "utf-8").trim();
        if (ours === installed) {
          if (!refreshNeeded) {
            writeStateMarkerFile(pendingRefreshPath, "1\n");
            refreshNeeded = true;
          }
          fs.unlinkSync(dest);
        }
      }
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  const bundleTrustedBefore =
    fileExists(caCertPath) && verifyLinuxTrustBundle(caCertPath, activeConfig);
  if (bundleTrustedBefore && !refreshNeeded) {
    try {
      writeStateMarkerFile(pendingRefreshPath, "1\n");
      refreshNeeded = true;
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (refreshNeeded) {
    try {
      runUpdate(activeConfig.updateCommand);
    } catch (err: unknown) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  const bundleStillTrusted =
    fileExists(caCertPath) && verifyLinuxTrustBundle(caCertPath, activeConfig);
  const sourceStillInstalled = configs.some((config) =>
    linuxTrustSourceMatches(config, caCertPath)
  );

  if (errors.length > 0 || bundleStillTrusted || sourceStillInstalled) {
    return {
      removed: false,
      error:
        errors.join("; ") ||
        "CA still trusted (remove portless-ca.crt and run the distro CA update command, often with sudo)",
    };
  }

  clearTrustRefreshPending(stateDir);
  return { removed: true };
}

function untrustCAWSL(stateDir: string, caCertPath: string): { removed: boolean; error?: string } {
  const linuxResult = untrustCALinux(stateDir);
  let windowsResult: { removed: boolean; error?: string };

  try {
    windowsResult = untrustWindowsCA(caCertPath, wslWindowsCAStoreOptions());
  } catch (err: unknown) {
    windowsResult = {
      removed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (linuxResult.removed && windowsResult.removed) return { removed: true };

  const errors = [linuxResult.error, windowsResult.error].filter(Boolean);
  return {
    removed: false,
    error: errors.join("; ") || "Could not remove the portless CA from every WSL trust store",
  };
}

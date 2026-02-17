import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as tls from "node:tls";
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";

/** How long the CA certificate is valid (10 years, in days). */
const CA_VALIDITY_DAYS = 3650;

/**
 * When running under sudo, fix file ownership so the real user can
 * read/write the file later without sudo. No-op when not running as root.
 */
function fixOwnership(...paths: string[]): void {
  const uid = process.env.SUDO_UID;
  const gid = process.env.SUDO_GID;
  if (!uid || process.getuid?.() !== 0) return;
  for (const p of paths) {
    try {
      fs.chownSync(p, parseInt(uid, 10), parseInt(gid || uid, 10));
    } catch {
      // Best-effort
    }
  }
}

/** How long server certificates are valid (1 year, in days). */
const SERVER_VALIDITY_DAYS = 365;

/** Buffer (in ms) subtracted from expiry to trigger early regeneration. */
const EXPIRY_BUFFER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Common Name used for the portless local CA. */
const CA_COMMON_NAME = "portless Local CA";

/** openssl command timeout (ms). */
const OPENSSL_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

const CA_KEY_FILE = "ca-key.pem";
const CA_CERT_FILE = "ca.pem";
const SERVER_KEY_FILE = "server-key.pem";
const SERVER_CERT_FILE = "server.pem";

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
 * Run openssl and return stdout. Throws on non-zero exit.
 */
function openssl(args: string[], options?: { input?: string }): string {
  try {
    return execFileSync("openssl", args, {
      encoding: "utf-8",
      timeout: OPENSSL_TIMEOUT_MS,
      input: options?.input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `openssl failed: ${message}\n\nMake sure openssl is installed (ships with macOS and most Linux distributions).`
    );
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
    const { stdout } = await execFileAsync("openssl", args, {
      encoding: "utf-8",
      timeout: OPENSSL_TIMEOUT_MS,
    });
    return stdout;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `openssl failed: ${message}\n\nMake sure openssl is installed (ships with macOS and most Linux distributions).`
    );
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

  return { certPath, keyPath };
}

// ---------------------------------------------------------------------------
// Server certificate generation
// ---------------------------------------------------------------------------

/**
 * Generate a server certificate signed by the local CA.
 * Covers localhost and *.localhost via Subject Alternative Names.
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
  fs.writeFileSync(
    extPath,
    [
      "authorityKeyIdentifier=keyid,issuer",
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost,DNS:*.localhost",
    ].join("\n") + "\n"
  );

  // Sign with CA
  openssl([
    "x509",
    "-req",
    "-in",
    csrPath,
    "-CA",
    caCertPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
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

  let caGenerated = false;

  // Ensure CA exists
  if (!fileExists(caCertPath) || !fileExists(caKeyPath) || !isCertValid(caCertPath)) {
    generateCA(stateDir);
    caGenerated = true;
  }

  // Ensure server cert exists and is valid
  if (caGenerated || !fileExists(serverCertPath) || !isCertValid(serverCertPath)) {
    generateServerCert(stateDir);
  }

  return {
    certPath: serverCertPath,
    keyPath: path.join(stateDir, SERVER_KEY_FILE),
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

  if (process.platform === "darwin") {
    return isCATrustedMacOS(caCertPath);
  } else if (process.platform === "linux") {
    return isCATrustedLinux(stateDir);
  }
  return false;
}

function isCATrustedMacOS(caCertPath: string): boolean {
  try {
    // Extract the SHA-1 fingerprint of our CA
    const fingerprint = openssl(["x509", "-in", caCertPath, "-noout", "-fingerprint", "-sha1"])
      .trim()
      .replace(/^.*=/, "")
      .replace(/:/g, "")
      .toLowerCase();

    // Check the login keychain first, then the system keychain
    for (const keychain of [loginKeychainPath(), "/Library/Keychains/System.keychain"]) {
      try {
        const result = execFileSync("security", ["find-certificate", "-a", "-Z", keychain], {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (result.toLowerCase().includes(fingerprint)) return true;
      } catch {
        // Not found in this keychain, try next
      }
    }
    return false;
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
      timeout: 5000,
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
 * Check if the CA is trusted on Linux.
 * Uses the Debian/Ubuntu path (/usr/local/share/ca-certificates/).
 * Fedora/RHEL use /etc/pki/ca-trust/source/anchors/ which is not supported yet.
 */
function isCATrustedLinux(stateDir: string): boolean {
  const systemCertPath = `/usr/local/share/ca-certificates/portless-ca.crt`;
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

  // Generate CSR
  await opensslAsync(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${hostname}`]);

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

  await opensslAsync([
    "x509",
    "-req",
    "-in",
    csrPath,
    "-CA",
    caCertPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
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
 * Check if a hostname matches `*.localhost` (single-level subdomain).
 * These are covered by the default server cert's wildcard SAN.
 */
function isSimpleLocalhostSubdomain(hostname: string): boolean {
  const parts = hostname.split(".");
  // "foo.localhost" => ["foo", "localhost"] => 2 parts
  return parts.length === 2 && parts[1] === "localhost";
}

/**
 * Create an SNI callback for the TLS server.
 *
 * For simple hostnames matching `*.localhost`, uses the default server cert.
 * For deeper subdomains (e.g., `chat.myapp.localhost`), generates a
 * per-hostname certificate on demand, signed by the local CA, and caches it.
 *
 * Certificate generation is async to avoid blocking the event loop. A
 * pending-promise map deduplicates concurrent requests for the same hostname.
 */
export function createSNICallback(
  stateDir: string,
  defaultCert: Buffer,
  defaultKey: Buffer
): (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => void {
  const cache = new Map<string, tls.SecureContext>();
  const pending = new Map<string, Promise<tls.SecureContext>>();

  // Pre-cache the default context for simple subdomains
  const defaultCtx = tls.createSecureContext({ cert: defaultCert, key: defaultKey });

  return (servername: string, cb: (err: Error | null, ctx?: tls.SecureContext) => void) => {
    // Simple subdomains (foo.localhost) and "localhost" itself are covered by the default cert
    if (servername === "localhost" || isSimpleLocalhostSubdomain(servername)) {
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
    if (fileExists(certPath) && fileExists(keyPath) && isCertValid(certPath)) {
      try {
        const ctx = tls.createSecureContext({
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(keyPath),
        });
        cache.set(servername, ctx);
        cb(null, ctx);
        return;
      } catch {
        // Permission error reading cached cert -- regenerate below
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
      const [cert, key] = await Promise.all([
        fs.promises.readFile(generated.certPath),
        fs.promises.readFile(generated.keyPath),
      ]);
      return tls.createSecureContext({ cert, key });
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
 * On macOS, adds to the login keychain (no sudo required -- the OS shows a
 * GUI authorization prompt to confirm). On Linux, copies to
 * /usr/local/share/ca-certificates and runs update-ca-certificates (requires
 * sudo).
 */
export function trustCA(stateDir: string): { trusted: boolean; error?: string } {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) {
    return { trusted: false, error: "CA certificate not found. Run with --https first." };
  }

  try {
    if (process.platform === "darwin") {
      const keychain = loginKeychainPath();
      execFileSync(
        "security",
        ["add-trusted-cert", "-r", "trustRoot", "-k", keychain, caCertPath],
        { stdio: "pipe", timeout: 30_000 }
      );
      return { trusted: true };
    } else if (process.platform === "linux") {
      const dest = "/usr/local/share/ca-certificates/portless-ca.crt";
      fs.copyFileSync(caCertPath, dest);
      execFileSync("update-ca-certificates", [], { stdio: "pipe", timeout: 30_000 });
      return { trusted: true };
    }
    return { trusted: false, error: `Unsupported platform: ${process.platform}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes("authorization") ||
      message.includes("permission") ||
      message.includes("EACCES")
    ) {
      return {
        trusted: false,
        error: "Permission denied. Try: sudo portless trust",
      };
    }
    return { trusted: false, error: message };
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync, execFileSync } from "node:child_process";

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

  // Clean up temporary files
  for (const tmp of [csrPath, extPath, path.join(stateDir, "ca.srl")]) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Non-fatal
    }
  }

  fs.chmodSync(serverKeyPath, 0o600);
  fs.chmodSync(serverCertPath, 0o644);

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
      .replace(/:/g, "");

    // Check if a cert with this fingerprint exists in the system keychain
    const result = execSync(
      `security find-certificate -a -Z /Library/Keychains/System.keychain 2>/dev/null | grep -i "${fingerprint}"`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    return result.length > 0;
  } catch {
    return false;
  }
}

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

/**
 * Add the portless CA to the system trust store.
 * Returns whether the operation succeeded. May require sudo.
 */
export function trustCA(stateDir: string): { trusted: boolean; error?: string } {
  const caCertPath = path.join(stateDir, CA_CERT_FILE);
  if (!fileExists(caCertPath)) {
    return { trusted: false, error: "CA certificate not found. Run with --https first." };
  }

  try {
    if (process.platform === "darwin") {
      execSync(
        `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${caCertPath}"`,
        { stdio: "pipe", timeout: 30_000 }
      );
      return { trusted: true };
    } else if (process.platform === "linux") {
      const dest = "/usr/local/share/ca-certificates/portless-ca.crt";
      fs.copyFileSync(caCertPath, dest);
      execSync("update-ca-certificates", { stdio: "pipe", timeout: 30_000 });
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

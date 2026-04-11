import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as tls from "node:tls";
import { execFileSync } from "node:child_process";
import { fixOwnership } from "./utils.js";

/** How long the CA certificate is valid (10 years, in days). */
const CA_VALIDITY_DAYS = 3650;

/** How long server certificates are valid (1 year, in days). */
const SERVER_VALIDITY_DAYS = 365;

/** Buffer (in ms) subtracted from expiry to trigger early regeneration. */
const EXPIRY_BUFFER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Common Name used for the portless local CA. */
const CA_COMMON_NAME = "portless Local CA";

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
 * Check whether a certificate includes all expected SANs (*.local).
 * Returns false if the cert is missing SANs that were added in later versions,
 * triggering regeneration so existing users get .local coverage.
 */
function isCertSansComplete(certPath: string): boolean {
  try {
    const pem = fs.readFileSync(certPath, "utf-8");
    const cert = new crypto.X509Certificate(pem);
    // Use word boundary to match "DNS:*.local" exactly, not "DNS:*.localhost"
    return /DNS:\*\.local\b/.test(cert.subjectAltName ?? "");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// DER helpers for pure-JS X.509 certificate generation
// ---------------------------------------------------------------------------

/** Encode a DER length field. */
function derLen(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  if (n < 0x100) return new Uint8Array([0x81, n]);
  return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff]);
}

/** Concatenate Uint8Arrays. */
function cat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** Wrap content in a DER TLV. */
function derTag(tag: number, content: Uint8Array): Uint8Array {
  const l = derLen(content.length);
  const out = new Uint8Array(1 + l.length + content.length);
  out[0] = tag;
  out.set(l, 1);
  out.set(content, 1 + l.length);
  return out;
}

const derSeq = (...items: Uint8Array[]) => derTag(0x30, cat(...items));
const derSet = (...items: Uint8Array[]) => derTag(0x31, cat(...items));
const derCtx = (n: number, content: Uint8Array) => derTag(0xa0 | n, content);
const derOcts = (b: Uint8Array) => derTag(0x04, b);
const derBool = (v: boolean) => new Uint8Array([0x01, 0x01, v ? 0xff : 0x00]);

function derInt(bytes: Uint8Array): Uint8Array {
  const b = bytes[0] & 0x80 ? cat(new Uint8Array([0]), bytes) : bytes;
  return derTag(0x02, b);
}

function derOid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    const chunk: number[] = [];
    chunk.unshift(n & 0x7f);
    n >>= 7;
    while (n > 0) {
      chunk.unshift((n & 0x7f) | 0x80);
      n >>= 7;
    }
    bytes.push(...chunk);
  }
  return derTag(0x06, new Uint8Array(bytes));
}

function derUtf8(s: string): Uint8Array {
  return derTag(0x0c, Buffer.from(s, "utf-8"));
}

function derBitStr(bytes: Uint8Array, unusedBits = 0): Uint8Array {
  return derTag(0x03, cat(new Uint8Array([unusedBits]), bytes));
}

function derTime(d: Date): Uint8Array {
  const p = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const s = `${p(y % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  // UTCTime for years 1950-2049, GeneralizedTime otherwise
  return y < 2050
    ? derTag(0x17, Buffer.from(s, "ascii"))
    : derTag(0x18, Buffer.from(`20${s}`, "ascii"));
}

/** Encode an X.509 Name with a single commonName attribute. */
function derName(cn: string): Uint8Array {
  return derSeq(derSet(derSeq(derOid("2.5.4.3"), derUtf8(cn))));
}

/** Encode a GeneralName dNSName. */
function derDnsName(hostname: string): Uint8Array {
  return derTag(0x82, Buffer.from(hostname, "ascii")); // [2] IMPLICIT IA5String
}

/**
 * Encode a KeyUsage BIT STRING per RFC 5280.
 * Bit positions: 0=digitalSignature, 2=keyEncipherment, 5=keyCertSign, 6=cRLSign
 */
function derKeyUsage(usages: number[]): Uint8Array {
  const maxBit = Math.max(...usages);
  const numBytes = Math.ceil((maxBit + 1) / 8);
  const data = new Uint8Array(numBytes);
  for (const b of usages) {
    data[Math.floor(b / 8)] |= 0x80 >> (b % 8);
  }
  return derBitStr(data, numBytes * 8 - maxBit - 1);
}

/** Encode an X.509v3 Extension. */
function derExt(oid: string, critical: boolean, valueBytes: Uint8Array): Uint8Array {
  return derSeq(derOid(oid), ...(critical ? [derBool(true)] : []), derOcts(valueBytes));
}

// OIDs used in certificate generation
const CERT_OIDS = {
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
  subjectKeyId: "2.5.29.14",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  authKeyId: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

/** SHA-1 of a SubjectPublicKeyInfo DER buffer, used as the subjectKeyIdentifier. */
function spkiKeyId(spkiDer: Buffer): Uint8Array {
  return new Uint8Array(crypto.createHash("sha1").update(spkiDer).digest());
}

/** Generate a random positive 8-byte serial number. */
function randomSerial(): Buffer {
  const s = crypto.randomBytes(8);
  s[0] &= 0x7f; // ensure top bit is 0 (positive integer)
  return s;
}

/** Convert a DER buffer to a PEM string. */
function derToPem(der: Buffer, type: string): string {
  const b64 = der.toString("base64");
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`;
}

/**
 * Build and sign an X.509v3 DER certificate.
 * Both the subject public key and the signer key are pure Node.js KeyObjects.
 */
function buildCertDer(opts: {
  subject: string;
  issuer: string;
  serial: Buffer;
  notBefore: Date;
  notAfter: Date;
  subjectSpki: Buffer;
  extensions: Uint8Array[];
  signerKey: crypto.KeyObject;
}): Buffer {
  const { subject, issuer, serial, notBefore, notAfter, subjectSpki, extensions, signerKey } = opts;

  const tbs = derSeq(
    derCtx(0, derInt(new Uint8Array([2]))), // version v3
    derInt(serial),
    derSeq(derOid(CERT_OIDS.ecdsaWithSHA256)), // signature algorithm
    derName(issuer),
    derSeq(derTime(notBefore), derTime(notAfter)), // validity
    derName(subject),
    subjectSpki, // SubjectPublicKeyInfo (already DER-encoded)
    derCtx(3, derSeq(...extensions)) // extensions
  );

  const sign = crypto.createSign("SHA256");
  sign.update(tbs);
  const sigDer = sign.sign(signerKey);

  return Buffer.from(
    derSeq(tbs, derSeq(derOid(CERT_OIDS.ecdsaWithSHA256)), derBitStr(new Uint8Array(sigDer)))
  );
}

// ---------------------------------------------------------------------------
// Signature-algorithm check (no subprocess needed)
// ---------------------------------------------------------------------------

/**
 * Parse the signature algorithm OID from a DER-encoded certificate buffer.
 * The OID appears as the second SEQUENCE inside the outer Certificate SEQUENCE
 * (after TBSCertificate).
 */
function certSigAlgOid(der: Buffer): string | null {
  try {
    let pos = 0;
    // Read a DER length field; return { length, next } where next is the offset after the length.
    const readLen = (p: number) => {
      const first = der[p];
      if (first < 0x80) return { length: first, next: p + 1 };
      const n = first & 0x7f;
      let len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | der[p + 1 + i];
      return { length: len, next: p + 1 + n };
    };
    // Skip a complete DER TLV; return offset of the next item.
    const skipItem = (p: number) => {
      const { length, next } = readLen(p + 1);
      return next + length;
    };
    if (der[pos++] !== 0x30) return null; // outer SEQUENCE
    pos = readLen(pos).next;
    pos = skipItem(pos); // skip TBSCertificate
    if (der[pos++] !== 0x30) return null; // AlgorithmIdentifier
    pos = readLen(pos).next;
    if (der[pos++] !== 0x06) return null; // OID tag
    const { length: oidLen, next: oidStart } = readLen(pos);
    const oidBytes = der.subarray(oidStart, oidStart + oidLen);
    const parts: number[] = [Math.floor(oidBytes[0] / 40), oidBytes[0] % 40];
    let cur = 0;
    for (let i = 1; i < oidBytes.length; i++) {
      cur = (cur << 7) | (oidBytes[i] & 0x7f);
      if (!(oidBytes[i] & 0x80)) {
        parts.push(cur);
        cur = 0;
      }
    }
    return parts.join(".");
  } catch {
    return null;
  }
}

/**
 * Check whether a certificate uses a strong signature algorithm (SHA-256+).
 * Rejects SHA-1 signatures without spawning any external process.
 */
function isCertSignatureStrong(certPath: string): boolean {
  try {
    const pem = fs.readFileSync(certPath, "utf-8");
    const cert = new crypto.X509Certificate(pem);
    const oid = certSigAlgOid(Buffer.from(cert.raw));
    // SHA-1 OIDs: ecdsa-with-SHA1 (1.2.840.10045.4.3.1),
    //             sha1WithRSAEncryption (1.2.840.113549.1.1.5),
    //             id-dsa-with-sha1 (1.2.840.10040.4.3)
    const sha1Oids = ["1.2.840.10045.4.3.1", "1.2.840.113549.1.1.5", "1.2.840.10040.4.3"];
    return oid !== null && !sha1Oids.includes(oid);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// CA generation
// ---------------------------------------------------------------------------

/**
 * Generate a local CA certificate and private key using Node.js built-in crypto.
 * No external processes are spawned.
 */
function generateCA(stateDir: string): { certPath: string; keyPath: string } {
  const keyPath = path.join(stateDir, CA_KEY_FILE);
  const certPath = path.join(stateDir, CA_CERT_FILE);

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const ski = spkiKeyId(spkiDer);

  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + CA_VALIDITY_DAYS * 86_400_000);

  const certDer = buildCertDer({
    subject: CA_COMMON_NAME,
    issuer: CA_COMMON_NAME,
    serial: randomSerial(),
    notBefore,
    notAfter,
    subjectSpki: spkiDer,
    extensions: [
      derExt(CERT_OIDS.subjectKeyId, false, derOcts(ski)),
      derExt(CERT_OIDS.basicConstraints, true, derSeq(derBool(true))),
      derExt(CERT_OIDS.keyUsage, true, derKeyUsage([5, 6])), // keyCertSign, cRLSign
    ],
    signerKey: privateKey,
  });

  fs.writeFileSync(keyPath, privateKey.export({ type: "sec1", format: "pem" }) as string, {
    mode: 0o600,
  });
  fs.writeFileSync(certPath, derToPem(certDer, "CERTIFICATE"), { mode: 0o644 });
  fixOwnership(keyPath, certPath);

  return { certPath, keyPath };
}

// ---------------------------------------------------------------------------
// Server certificate generation
// ---------------------------------------------------------------------------

/**
 * Generate a server certificate signed by the local CA using Node.js built-in crypto.
 * Covers localhost, *.localhost, and *.local via Subject Alternative Names.
 * No external processes are spawned.
 */
function generateServerCert(stateDir: string): { certPath: string; keyPath: string } {
  const serverKeyPath = path.join(stateDir, SERVER_KEY_FILE);
  const serverCertPath = path.join(stateDir, SERVER_CERT_FILE);

  const caKeyPem = fs.readFileSync(path.join(stateDir, CA_KEY_FILE), "utf-8");
  const caCertPem = fs.readFileSync(path.join(stateDir, CA_CERT_FILE), "utf-8");
  const caPrivateKey = crypto.createPrivateKey(caKeyPem);
  const caCert = new crypto.X509Certificate(caCertPem);
  const caSpkiDer = Buffer.from(caCert.publicKey.export({ type: "spki", format: "der" }) as Buffer);

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const ski = spkiKeyId(spkiDer);

  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + SERVER_VALIDITY_DAYS * 86_400_000);

  const certDer = buildCertDer({
    subject: "localhost",
    issuer: CA_COMMON_NAME,
    serial: randomSerial(),
    notBefore,
    notAfter,
    subjectSpki: spkiDer,
    extensions: [
      derExt(CERT_OIDS.authKeyId, false, derSeq(derTag(0x80, spkiKeyId(caSpkiDer)))),
      derExt(CERT_OIDS.subjectKeyId, false, derOcts(ski)),
      derExt(CERT_OIDS.basicConstraints, true, derSeq()), // CA:FALSE (empty sequence)
      derExt(CERT_OIDS.keyUsage, true, derKeyUsage([0, 2])), // digitalSignature, keyEncipherment
      derExt(CERT_OIDS.extKeyUsage, false, derSeq(derOid(CERT_OIDS.serverAuth))),
      derExt(
        CERT_OIDS.subjectAltName,
        false,
        derSeq(derDnsName("localhost"), derDnsName("*.localhost"), derDnsName("*.local"))
      ),
    ],
    signerKey: caPrivateKey,
  });

  fs.writeFileSync(serverKeyPath, privateKey.export({ type: "sec1", format: "pem" }) as string, {
    mode: 0o600,
  });
  fs.writeFileSync(serverCertPath, derToPem(certDer, "CERTIFICATE"), { mode: 0o644 });
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

  // Ensure CA exists
  if (
    !fileExists(caCertPath) ||
    !fileExists(caKeyPath) ||
    !isCertValid(caCertPath) ||
    !isCertSignatureStrong(caCertPath)
  ) {
    generateCA(stateDir);
    caGenerated = true;
  }

  // Ensure server cert exists and is valid
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
  } else if (process.platform === "win32") {
    return isCATrustedWindows(caCertPath);
  }
  return false;
}

function isCATrustedWindows(caCertPath: string): boolean {
  try {
    const fingerprint = new crypto.X509Certificate(fs.readFileSync(caCertPath)).fingerprint
      .replace(/:/g, "")
      .toLowerCase();
    const result = execFileSync("certutil", ["-store", "-user", "Root"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
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
          timeout: 5000,
        }
      );
    } else {
      execFileSync("security", ["verify-cert", "-c", caCertPath, "-L", "-p", "ssl"], {
        stdio: "pipe",
        timeout: 5000,
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
 * Uses Node.js built-in crypto — no external processes are spawned, so no
 * console windows appear on Windows when a new domain is first accessed.
 */
async function generateHostCertAsync(
  stateDir: string,
  hostname: string
): Promise<{ certPath: string; keyPath: string }> {
  const hostDir = path.join(stateDir, HOST_CERTS_DIR);

  if (!fs.existsSync(hostDir)) {
    await fs.promises.mkdir(hostDir, { recursive: true, mode: 0o755 });
    fixOwnership(hostDir);
  }

  const safeName = sanitizeHostForFilename(hostname);
  const keyPath = path.join(hostDir, `${safeName}-key.pem`);
  const certPath = path.join(hostDir, `${safeName}.pem`);

  const caKeyPem = await fs.promises.readFile(path.join(stateDir, CA_KEY_FILE), "utf-8");
  const caCertPem = await fs.promises.readFile(path.join(stateDir, CA_CERT_FILE), "utf-8");
  const caPrivateKey = crypto.createPrivateKey(caKeyPem);
  const caCert = new crypto.X509Certificate(caCertPem);
  const caSpkiDer = Buffer.from(caCert.publicKey.export({ type: "spki", format: "der" }) as Buffer);

  // EC key generation is fast enough that the sync variant is fine here.
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const ski = spkiKeyId(spkiDer);

  // The X.509 CN field has a 64-character limit (RFC 5280 §4.1.2.6).
  const cn = hostname.length > MAX_CN_LENGTH ? hostname.slice(0, MAX_CN_LENGTH) : hostname;

  // Build SAN list: include the exact hostname plus a wildcard at the same level
  // e.g., for "chat.json-render2.localhost" -> also add "*.json-render2.localhost"
  const parts = hostname.split(".");
  const sanEntries: Uint8Array[] = [derDnsName(hostname)];
  if (parts.length >= 2) {
    sanEntries.push(derDnsName(`*.${parts.slice(1).join(".")}`));
  }

  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + SERVER_VALIDITY_DAYS * 86_400_000);

  const certDer = buildCertDer({
    subject: cn,
    issuer: CA_COMMON_NAME,
    serial: randomSerial(),
    notBefore,
    notAfter,
    subjectSpki: spkiDer,
    extensions: [
      derExt(CERT_OIDS.authKeyId, false, derSeq(derTag(0x80, spkiKeyId(caSpkiDer)))),
      derExt(CERT_OIDS.subjectKeyId, false, derOcts(ski)),
      derExt(CERT_OIDS.basicConstraints, true, derSeq()), // CA:FALSE
      derExt(CERT_OIDS.keyUsage, true, derKeyUsage([0, 2])), // digitalSignature, keyEncipherment
      derExt(CERT_OIDS.extKeyUsage, false, derSeq(derOid(CERT_OIDS.serverAuth))),
      derExt(CERT_OIDS.subjectAltName, false, derSeq(...sanEntries)),
    ],
    signerKey: caPrivateKey,
  });

  await fs.promises.writeFile(
    keyPath,
    privateKey.export({ type: "sec1", format: "pem" }) as string,
    { mode: 0o600 }
  );
  await fs.promises.writeFile(certPath, derToPem(certDer, "CERTIFICATE"), { mode: 0o644 });
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
          { stdio: "pipe", timeout: 30_000 }
        );
      } else {
        const keychain = loginKeychainPath();
        execFileSync(
          "security",
          ["add-trusted-cert", "-r", "trustRoot", "-k", keychain, caCertPath],
          { stdio: "pipe", timeout: 30_000 }
        );
      }
      return { trusted: true };
    } else if (process.platform === "linux") {
      const config = getLinuxCATrustConfig();
      if (!fs.existsSync(config.certDir)) {
        fs.mkdirSync(config.certDir, { recursive: true });
      }
      const dest = path.join(config.certDir, "portless-ca.crt");
      fs.copyFileSync(caCertPath, dest);
      execFileSync(config.updateCommand, [], { stdio: "pipe", timeout: 30_000 });
      return { trusted: true };
    } else if (process.platform === "win32") {
      execFileSync("certutil", ["-addstore", "-user", "Root", caCertPath], {
        stdio: "pipe",
        timeout: 30_000,
        windowsHide: true,
      });
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
    return { removed: true };
  }

  if (!isCATrusted(stateDir)) {
    return { removed: true };
  }

  try {
    if (process.platform === "darwin") {
      return untrustCAMacOS(caCertPath);
    }
    if (process.platform === "linux") {
      return untrustCALinux(stateDir);
    }
    if (process.platform === "win32") {
      return untrustCAWindows(caCertPath);
    }
    return { removed: false, error: `Unsupported platform: ${process.platform}` };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { removed: false, error: message };
  }
}

function untrustCAMacOS(caCertPath: string): { removed: boolean; error?: string } {
  const errors: string[] = [];

  const tryExec = (args: string[]) => {
    try {
      execFileSync("security", args, { stdio: "pipe", timeout: 30_000 });
      return true;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      return false;
    }
  };

  if (tryExec(["remove-trusted-cert", caCertPath])) {
    return isCATrustedMacOSAfterAttempt(caCertPath)
      ? { removed: false, error: errors.join("; ") || "Trust entry may still be present" }
      : { removed: true };
  }

  const login = loginKeychainPath();
  tryExec(["delete-certificate", "-c", CA_COMMON_NAME, login]);
  tryExec(["delete-certificate", "-c", CA_COMMON_NAME, "/Library/Keychains/System.keychain"]);

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
        { stdio: "pipe", timeout: 5000 }
      );
    } else {
      execFileSync("security", ["verify-cert", "-c", caCertPath, "-L", "-p", "ssl"], {
        stdio: "pipe",
        timeout: 5000,
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
    const fingerprint = new crypto.X509Certificate(fs.readFileSync(caCertPath)).fingerprint
      .replace(/:/g, "")
      .toLowerCase();

    const storeListing = execFileSync("certutil", ["-store", "-user", "Root"], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const normalized = storeListing.replace(/\s/g, "").toLowerCase();
    if (!normalized.includes(fingerprint)) {
      return { removed: true };
    }

    execFileSync("certutil", ["-delstore", "-user", "Root", "portless Local CA"], {
      stdio: "pipe",
      timeout: 30_000,
      windowsHide: true,
    });

    if (isCATrustedWindows(caCertPath)) {
      return { removed: false, error: "certutil could not remove the portless CA from Root" };
    }
    return { removed: true };
  } catch (err: unknown) {
    return { removed: false, error: err instanceof Error ? err.message : String(err) };
  }
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as tls from "node:tls";
import { createSNICallback, ensureCerts, isCATrusted, trustCA } from "./certs.js";

describe("ensureCerts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-certs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates CA and server certificates on first call", () => {
    const result = ensureCerts(tmpDir);

    expect(result.caGenerated).toBe(true);
    expect(fs.existsSync(result.certPath)).toBe(true);
    expect(fs.existsSync(result.keyPath)).toBe(true);
    expect(fs.existsSync(result.caPath)).toBe(true);
  });

  it("returns valid PEM certificates", () => {
    const result = ensureCerts(tmpDir);

    const certPem = fs.readFileSync(result.certPath, "utf-8");
    expect(certPem).toContain("-----BEGIN CERTIFICATE-----");

    const keyPem = fs.readFileSync(result.keyPath, "utf-8");
    expect(keyPem).toContain("-----BEGIN EC PRIVATE KEY-----");

    const caPem = fs.readFileSync(result.caPath, "utf-8");
    expect(caPem).toContain("-----BEGIN CERTIFICATE-----");
  });

  it("server cert is signed by the CA (different from CA cert)", () => {
    const result = ensureCerts(tmpDir);

    const serverCert = new crypto.X509Certificate(fs.readFileSync(result.certPath));
    const caCert = new crypto.X509Certificate(fs.readFileSync(result.caPath));

    // Server cert issuer should match CA subject
    expect(serverCert.issuer).toBe(caCert.subject);

    // Server cert should not be the same as CA cert
    expect(serverCert.fingerprint).not.toBe(caCert.fingerprint);
  });

  it("server cert covers localhost and *.localhost via SAN", () => {
    const result = ensureCerts(tmpDir);
    const cert = new crypto.X509Certificate(fs.readFileSync(result.certPath));

    expect(cert.subjectAltName).toContain("DNS:localhost");
    expect(cert.subjectAltName).toContain("DNS:*.localhost");
  });

  it("CA cert has CA:TRUE basic constraint", () => {
    const result = ensureCerts(tmpDir);
    const caCert = new crypto.X509Certificate(fs.readFileSync(result.caPath));

    // The CA cert should be marked as a CA
    expect(caCert.ca).toBe(true);
  });

  it("reuses existing certs on second call", () => {
    const first = ensureCerts(tmpDir);
    expect(first.caGenerated).toBe(true);

    const second = ensureCerts(tmpDir);
    expect(second.caGenerated).toBe(false);

    // Cert files should be the same
    const firstCert = fs.readFileSync(first.certPath, "utf-8");
    const secondCert = fs.readFileSync(second.certPath, "utf-8");
    expect(firstCert).toBe(secondCert);
  });

  it("regenerates server cert if it is deleted", () => {
    const first = ensureCerts(tmpDir);
    const firstCert = fs.readFileSync(first.certPath, "utf-8");

    // Delete the server cert but keep the CA
    fs.unlinkSync(first.certPath);

    const second = ensureCerts(tmpDir);
    expect(second.caGenerated).toBe(false); // CA still exists
    expect(fs.existsSync(second.certPath)).toBe(true);

    // New cert should be different (regenerated)
    const secondCert = fs.readFileSync(second.certPath, "utf-8");
    expect(secondCert).not.toBe(firstCert);
  });

  it("sets restrictive permissions on key files", () => {
    const result = ensureCerts(tmpDir);

    const caKeyPath = path.join(tmpDir, "ca-key.pem");
    const caKeyStat = fs.statSync(caKeyPath);
    expect(caKeyStat.mode & 0o777).toBe(0o600);

    const serverKeyStat = fs.statSync(result.keyPath);
    expect(serverKeyStat.mode & 0o777).toBe(0o600);
  });
});

describe("createSNICallback", () => {
  let tmpDir: string;
  let defaultCert: Buffer;
  let defaultKey: Buffer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-sni-test-"));
    const certs = ensureCerts(tmpDir);
    defaultCert = fs.readFileSync(certs.certPath);
    defaultKey = fs.readFileSync(certs.keyPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns default context for localhost", async () => {
    const sniCallback = createSNICallback(tmpDir, defaultCert, defaultKey);
    const ctx = await new Promise<tls.SecureContext | undefined>((resolve, reject) => {
      sniCallback("localhost", (err, ctx) => {
        if (err) reject(err);
        else resolve(ctx);
      });
    });

    expect(ctx).toBeDefined();
  });

  it("returns default context for simple *.localhost subdomains", async () => {
    const sniCallback = createSNICallback(tmpDir, defaultCert, defaultKey);
    const ctx = await new Promise<tls.SecureContext | undefined>((resolve, reject) => {
      sniCallback("myapp.localhost", (err, ctx) => {
        if (err) reject(err);
        else resolve(ctx);
      });
    });

    expect(ctx).toBeDefined();
  });

  it("generates per-hostname cert for deep subdomains", async () => {
    const sniCallback = createSNICallback(tmpDir, defaultCert, defaultKey);
    const ctx = await new Promise<tls.SecureContext | undefined>((resolve, reject) => {
      sniCallback("chat.myapp.localhost", (err, ctx) => {
        if (err) reject(err);
        else resolve(ctx);
      });
    });

    expect(ctx).toBeDefined();

    // Verify a cert file was created in the host-certs directory
    const hostCertPath = path.join(tmpDir, "host-certs", "chat_myapp_localhost.pem");
    expect(fs.existsSync(hostCertPath)).toBe(true);

    // Verify the generated cert covers the hostname
    const cert = new crypto.X509Certificate(fs.readFileSync(hostCertPath));
    expect(cert.subjectAltName).toContain("DNS:chat.myapp.localhost");
  });

  it("caches generated certs in memory on subsequent calls", async () => {
    const sniCallback = createSNICallback(tmpDir, defaultCert, defaultKey);

    const ctx1 = await new Promise<tls.SecureContext | undefined>((resolve, reject) => {
      sniCallback("deep.sub.localhost", (err, ctx) => {
        if (err) reject(err);
        else resolve(ctx);
      });
    });

    const ctx2 = await new Promise<tls.SecureContext | undefined>((resolve, reject) => {
      sniCallback("deep.sub.localhost", (err, ctx) => {
        if (err) reject(err);
        else resolve(ctx);
      });
    });

    // Same context object returned from cache
    expect(ctx1).toBe(ctx2);
  });

  it("returns error via callback when state dir is invalid", async () => {
    const badDir = path.join(tmpDir, "nonexistent");
    const sniCallback = createSNICallback(badDir, defaultCert, defaultKey);

    const error = await new Promise<Error | null>((resolve) => {
      sniCallback("deep.sub.localhost", (err) => {
        resolve(err);
      });
    });

    expect(error).toBeInstanceOf(Error);
  });
});

describe("isCATrusted", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-trust-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false when CA does not exist", () => {
    expect(isCATrusted(tmpDir)).toBe(false);
  });

  it("returns false for an empty directory", () => {
    expect(isCATrusted(path.join(tmpDir, "nonexistent"))).toBe(false);
  });
});

describe("trustCA", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-trust-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns error when CA cert is missing", () => {
    const result = trustCA(tmpDir);
    expect(result.trusted).toBe(false);
    expect(result.error).toContain("CA certificate not found");
  });
});

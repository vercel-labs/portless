import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { ensureCerts } from "./certs.js";

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

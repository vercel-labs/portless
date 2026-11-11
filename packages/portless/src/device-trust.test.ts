import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { encode, renderUnicodeCompact } from "uqr";
import { ensureCerts } from "./certs.js";
import {
  createDeviceTrustHandler,
  detectPlatform,
  mobileconfig,
  readDeviceCA,
  renderTerminalQr,
  type DeviceCA,
} from "./device-trust.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/131.0 Mobile";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const TOKEN = "test-token";

let stateDir: string;
let ca: DeviceCA;
let server: http.Server;
let origin: string;

beforeAll(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-device-"));
  ensureCerts(stateDir);
  ca = readDeviceCA(stateDir);
  server = http.createServer(createDeviceTrustHandler(ca, TOKEN));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("detectPlatform", () => {
  it.each([
    ["an iPhone", IPHONE, "ios"],
    ["an iPad", "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "ios"],
    ["an Android phone", ANDROID, "android"],
    ["a Mac", MAC, "other"],
    ["no user agent", undefined, "other"],
  ])("detects %s as %s", (_device, userAgent, platform) => {
    expect(detectPlatform(userAgent)).toBe(platform);
  });
});

describe("renderTerminalQr", () => {
  const url = "http://192.168.1.20:4321/token/";
  const size = encode(url, { border: 2 }).size;

  it("draws two module rows per line, one cell per module, black on white", () => {
    const lines = renderTerminalQr(url, true).split("\n");
    expect(lines).toHaveLength(Math.ceil(size / 2));
    for (const line of lines) {
      expect(stripVTControlCharacters(line)).toHaveLength(size);
      expect(line).not.toContain("\u2588");
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });

  it("falls back to plain half blocks without color", () => {
    expect(renderTerminalQr(url, false)).toBe(renderUnicodeCompact(url, { border: 2 }));
  });
});

describe("readDeviceCA", () => {
  it("reads the CA certificate and its fingerprint", () => {
    const cert = new X509Certificate(fs.readFileSync(path.join(stateDir, "ca.pem")));
    expect(ca.name).toBe("portless Local CA");
    expect(ca.fingerprint).toBe(cert.fingerprint256);
    expect(ca.der.equals(cert.raw)).toBe(true);
  });
});

describe("mobileconfig", () => {
  it("holds the CA as a root payload with UUIDs that stay the same", () => {
    const profile = mobileconfig(ca);
    expect(profile).toContain("<string>com.apple.security.root</string>");
    expect(profile).toContain(`<data>${ca.der.toString("base64")}</data>`);
    expect(mobileconfig(ca)).toBe(profile);
    const uuids = profile.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}/g);
    expect(new Set(uuids).size).toBe(2);
  });

  it("escapes the CA name", () => {
    expect(mobileconfig({ ...ca, name: "a <b> & c" })).toContain("a &lt;b&gt; &amp; c");
  });
});

describe("createDeviceTrustHandler", () => {
  it.each([
    ["an iPhone", IPHONE, "portless-ca.mobileconfig", "Certificate Trust Settings"],
    ["an Android phone", ANDROID, "portless-ca.crt", "CA certificate"],
    ["a Mac", MAC, "portless-ca.pem", "Always Trust"],
  ])("serves %s the steps for its platform", async (_device, userAgent, file, step) => {
    const res = await fetch(`${origin}/${TOKEN}/`, { headers: { "user-agent": userAgent } });
    const page = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page).toContain(`class="button" href="/${TOKEN}/${file}"`);
    expect(page).toContain(step);
    expect(page).toContain(ca.fingerprint.replaceAll(":", ":<wbr>"));
  });

  it.each([
    ["portless-ca.mobileconfig", "application/x-apple-aspen-config", null],
    ["portless-ca.crt", "application/x-x509-ca-cert", 'attachment; filename="portless-ca.crt"'],
    ["portless-ca.pem", "application/x-pem-file", 'attachment; filename="portless-ca.pem"'],
  ])("serves %s as %s", async (file, type, disposition) => {
    const res = await fetch(`${origin}/${TOKEN}/${file}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("content-disposition")).toBe(disposition);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the certificate, never the key", async () => {
    const der = Buffer.from(
      await (await fetch(`${origin}/${TOKEN}/portless-ca.crt`)).arrayBuffer()
    );
    expect(der.equals(ca.der)).toBe(true);
    const pem = await (await fetch(`${origin}/${TOKEN}/portless-ca.pem`)).text();
    expect(pem).toBe(ca.pem);
    expect(pem).not.toContain("PRIVATE KEY");
  });

  it.each([
    ["/", "GET", 404],
    ["/portless-ca.pem", "GET", 404],
    ["/wrong-token/portless-ca.pem", "GET", 404],
    [`/${TOKEN}/ca-key.pem`, "GET", 404],
    [`/${TOKEN}/`, "POST", 405],
  ])("answers %s %s with %i", async (pathname, method, status) => {
    expect((await fetch(`${origin}${pathname}`, { method })).status).toBe(status);
  });

  it("tells onServe which file it served", async () => {
    const served: string[] = [];
    const handler = createDeviceTrustHandler(ca, TOKEN, (file) => served.push(file));
    const local = http.createServer(handler);
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(local.address() as { port: number }).port}/${TOKEN}/`;
    await fetch(base);
    await fetch(`${base}portless-ca.crt`);
    await fetch(`${base}missing`);
    await new Promise((resolve) => local.close(resolve));
    expect(served).toEqual(["", "portless-ca.crt"]);
  });
});

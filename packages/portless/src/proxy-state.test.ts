import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_TLD, PORT_FILE, ProxyState, readProxyStateFile } from "./proxy-state.js";
import { fixOwnership } from "./utils.js";

vi.mock("./utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils.js")>();
  return { ...actual, fixOwnership: vi.fn(actual.fixOwnership) };
});

describe("ProxyState", () => {
  let dir: string;
  let state: ProxyState;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-proxy-state-"));
    state = new ProxyState(dir);
    vi.mocked(fixOwnership).mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hands all published state files back to the invoking user", () => {
    state.publishListener(1234, 443, "start-time");
    state.publish({
      tls: true,
      customCert: true,
      unprivileged: true,
      lanIp: "192.168.1.42",
      tlds: ["localhost", "test"],
    });
    const paths = vi.mocked(fixOwnership).mock.calls.flat();
    for (const name of [
      "proxy.pid",
      "proxy.port",
      "proxy.tls",
      "proxy.custom-cert",
      "proxy.unprivileged",
      "proxy.lan",
      "proxy.tld",
      "proxy.tlds",
    ]) {
      expect(
        paths.some((file) => file.startsWith(path.join(dir, `${name}.`)) && file.endsWith(".tmp"))
      ).toBe(true);
    }
    expect(paths).toContain(path.join(dir, "proxy.start.tmp"));
    expect(fs.readFileSync(path.join(dir, "proxy.start"), "utf-8")).toBe("start-time");
    state.reset();
    expect(fs.existsSync(path.join(dir, "proxy.start"))).toBe(false);
  });

  it("reads defaults from an empty directory", () => {
    expect(state.read()).toEqual({
      port: null,
      tls: false,
      customCert: false,
      unprivileged: false,
      lanIp: null,
      tlds: [DEFAULT_TLD],
    });
  });

  it("reads the port, and null when the port file is garbage", () => {
    fs.writeFileSync(path.join(dir, PORT_FILE), "1355");
    expect(state.read().port).toBe(1355);
    fs.writeFileSync(path.join(dir, PORT_FILE), "not-a-port");
    expect(state.read().port).toBeNull();
  });

  it("round-trips every published field", () => {
    fs.writeFileSync(path.join(dir, PORT_FILE), "443");
    state.publish({
      tls: true,
      customCert: true,
      unprivileged: true,
      lanIp: "192.168.1.42",
      tlds: ["localhost", "test"],
    });
    expect(state.read()).toEqual({
      port: 443,
      tls: true,
      customCert: true,
      unprivileged: true,
      lanIp: "192.168.1.42",
      tlds: ["localhost", "test"],
    });
  });

  it("stores a custom cert only alongside TLS", () => {
    state.publish({
      tls: false,
      customCert: true,
      unprivileged: false,
      lanIp: null,
      tlds: [DEFAULT_TLD],
    });
    expect(state.read().customCert).toBe(false);
  });

  it("writes the tld files for a custom list and drops them for the default", () => {
    state.publish({
      tls: false,
      customCert: false,
      unprivileged: false,
      lanIp: null,
      tlds: ["localhost", "test"],
    });
    expect(fs.readFileSync(path.join(dir, "proxy.tld"), "utf-8")).toBe("localhost");
    expect(fs.readFileSync(path.join(dir, "proxy.tlds"), "utf-8")).toBe("localhost\ntest\n");

    state.publish({
      tls: false,
      customCert: false,
      unprivileged: false,
      lanIp: null,
      tlds: [DEFAULT_TLD],
    });
    expect(fs.existsSync(path.join(dir, "proxy.tld"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "proxy.tlds"))).toBe(false);
    expect(state.read().tlds).toEqual([DEFAULT_TLD]);
  });

  it("falls back to the legacy proxy.tld file", () => {
    fs.writeFileSync(path.join(dir, "proxy.tld"), "local");
    expect(state.read()).toMatchObject({ tlds: ["local"], lanIp: null });
  });

  it("skips invalid persisted tld entries instead of dropping the list", () => {
    const sensitive = `private-${"a".repeat(70)}`;
    fs.writeFileSync(path.join(dir, "proxy.tlds"), JSON.stringify(["test", sensitive, "internal"]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(state.read().tlds).toEqual(["test", "internal"]);
      expect(warn).toHaveBeenCalledWith("Warning: ignoring invalid TLD entry in proxy.tlds");
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);
    } finally {
      warn.mockRestore();
    }
  });

  it("reads individual settings without parsing persisted TLDs", () => {
    fs.writeFileSync(path.join(dir, "proxy.tlds"), JSON.stringify(["invalid name"]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(state.readPort()).toBeNull();
      expect(state.readTls()).toBe(false);
      expect(state.readCustomCert()).toBe(false);
      expect(state.readUnprivileged()).toBe(false);
      expect(state.readLanIp()).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      expect(state.readTlds()).toEqual([DEFAULT_TLD]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("ignores symlinked proxy state files", () => {
    const target = path.join(dir, "private-data");
    fs.writeFileSync(target, "sensitive.example");
    for (const name of [
      "proxy.tlds",
      "proxy.tld",
      "proxy.lan",
      "proxy.tls",
      "proxy.custom-cert",
      "proxy.port",
      "proxy.unprivileged",
    ]) {
      fs.symlinkSync(target, path.join(dir, name));
    }
    expect(state.read()).toEqual({
      port: null,
      tls: false,
      customCert: false,
      unprivileged: false,
      lanIp: null,
      tlds: [DEFAULT_TLD],
    });
    expect(() => readProxyStateFile(path.join(dir, "proxy.port"))).toThrow(
      "Unsafe proxy state file"
    );
    expect(fs.readFileSync(target, "utf-8")).toBe("sensitive.example");
  });

  it.skipIf(process.platform === "win32")(
    "replaces planted state symlinks without modifying their target",
    () => {
      const target = path.join(dir, "private-data");
      fs.writeFileSync(target, "sensitive data");
      const files = [
        "proxy.pid",
        "proxy.port",
        "proxy.tls",
        "proxy.custom-cert",
        "proxy.unprivileged",
        "proxy.lan",
        "proxy.tld",
        "proxy.tlds",
      ];
      for (const name of files) fs.symlinkSync(target, path.join(dir, name));
      state.publishListener(1234, 443, "start-time");
      state.publish({
        tls: true,
        customCert: true,
        unprivileged: true,
        lanIp: "192.168.1.42",
        tlds: ["localhost", "test"],
      });
      expect(fs.readFileSync(target, "utf-8")).toBe("sensitive data");
      for (const name of files) expect(fs.lstatSync(path.join(dir, name)).isFile()).toBe(true);
      expect(state.read()).toEqual({
        port: 443,
        tls: true,
        customCert: true,
        unprivileged: true,
        lanIp: "192.168.1.42",
        tlds: ["localhost", "test"],
      });
    }
  );

  it("ignores oversized and non-regular state files", () => {
    fs.writeFileSync(path.join(dir, "proxy.tlds"), Buffer.alloc(64 * 1024 + 1, "a"));
    fs.mkdirSync(path.join(dir, "proxy.port"));
    fs.mkdirSync(path.join(dir, "proxy.tls"));
    expect(state.readTlds()).toEqual([DEFAULT_TLD]);
    expect(state.readPort()).toBeNull();
    expect(state.readTls()).toBe(false);
  });

  it("removes temporary state files after a failed replacement", () => {
    fs.mkdirSync(path.join(dir, "proxy.lan"));
    expect(() => state.setLanIp("10.0.0.5")).toThrow();
    expect(fs.readdirSync(dir)).toEqual(["proxy.lan"]);
  });

  it("writes and clears the LAN marker", () => {
    state.setLanIp("10.0.0.5");
    expect(fs.readFileSync(path.join(dir, "proxy.lan"), "utf-8")).toBe("10.0.0.5");
    state.setLanIp(null);
    expect(state.read().lanIp).toBeNull();
  });

  it("reset keeps the TLS marker only while unprivileged mode is remembered", () => {
    state.publish({
      tls: true,
      customCert: true,
      unprivileged: true,
      lanIp: "192.168.1.42",
      tlds: ["local"],
    });
    state.reset();
    expect(state.read()).toEqual({
      port: null,
      tls: true,
      customCert: false,
      unprivileged: true,
      lanIp: null,
      tlds: [DEFAULT_TLD],
    });
    expect(fs.existsSync(path.join(dir, "proxy.tld"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "proxy.tlds"))).toBe(false);

    state.publish({
      tls: true,
      customCert: false,
      unprivileged: false,
      lanIp: null,
      tlds: [DEFAULT_TLD],
    });
    state.reset();
    expect(state.read().tls).toBe(false);
  });
});

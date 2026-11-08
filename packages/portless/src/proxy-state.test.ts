import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_TLD, PORT_FILE, ProxyState } from "./proxy-state.js";

describe("ProxyState", () => {
  let dir: string;
  let state: ProxyState;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-proxy-state-"));
    state = new ProxyState(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
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
    fs.writeFileSync(
      path.join(dir, "proxy.tlds"),
      JSON.stringify(["test", "a".repeat(70), "internal"])
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(state.read().tlds).toEqual(["test", "internal"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
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

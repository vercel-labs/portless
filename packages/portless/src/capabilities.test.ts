import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_PLATFORMS, getPlatformCapabilities } from "./capabilities.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
) as { os?: string[] };

describe("platform capabilities", () => {
  it("matches the os field in package.json", () => {
    expect(packageJson.os).toEqual([...SUPPORTED_PLATFORMS]);
  });

  it("supports trust, LAN mDNS, and services on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const caps = getPlatformCapabilities(platform);
      expect(caps.platform).toBe(platform);
      expect(caps.supported).toBe(true);
      expect(caps.trust.supported).toBe(true);
      expect(caps.lanMdns.supported).toBe(true);
      expect(caps.service.supported).toBe(true);
    }
  });

  it("reports LAN mode as unsupported on Windows with tunnel alternatives (#391)", () => {
    const caps = getPlatformCapabilities("win32");
    expect(caps.supported).toBe(true);
    expect(caps.trust.supported).toBe(true);
    expect(caps.service.supported).toBe(true);
    expect(caps.lanMdns.supported).toBe(false);
    if (caps.lanMdns.supported) throw new Error("expected LAN mDNS to be unsupported on Windows");
    expect(caps.lanMdns.reason).toContain("Windows");
    expect(caps.lanMdns.hint).toContain("--tailscale");
    expect(caps.lanMdns.hint).toContain("--ngrok");
    expect(caps.lanMdns.hint).toContain("--cloudflare");
  });

  it("reports unsupported platforms with actionable trust hints (#103)", () => {
    for (const platform of ["freebsd", "sunos"] as const) {
      const caps = getPlatformCapabilities(platform);
      expect(caps.supported).toBe(false);
      expect(caps.trust.supported).toBe(false);
      expect(caps.lanMdns.supported).toBe(false);
      expect(caps.service.supported).toBe(false);
      if (caps.trust.supported) throw new Error("expected trust to be unsupported");
      expect(caps.trust.reason).toContain(platform);
      expect(caps.trust.hint).toContain("--no-tls");
      expect(caps.trust.hint).toContain("ca.pem");
    }
  });
});

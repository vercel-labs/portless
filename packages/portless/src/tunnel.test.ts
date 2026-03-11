import { describe, it, expect } from "vitest";
import { getTunnelProvider, TUNNEL_PROVIDERS } from "./tunnel.js";

describe("tunnel providers", () => {
  it("exposes ngrok and cloudflare as known providers", () => {
    expect(TUNNEL_PROVIDERS).toContain("ngrok");
    expect(TUNNEL_PROVIDERS).toContain("cloudflare");
  });

  it("returns ngrok provider by name", () => {
    const provider = getTunnelProvider("ngrok");
    expect(provider).toBeDefined();
    expect(provider!.name).toBe("ngrok");
  });

  it("returns cloudflare provider by name", () => {
    const provider = getTunnelProvider("cloudflare");
    expect(provider).toBeDefined();
    expect(provider!.name).toBe("cloudflare");
  });

  it("returns undefined for unknown provider", () => {
    expect(getTunnelProvider("localtunnel")).toBeUndefined();
    expect(getTunnelProvider("")).toBeUndefined();
  });

  describe("ngrok provider", () => {
    it("has isAvailable method", () => {
      const provider = getTunnelProvider("ngrok")!;
      expect(typeof provider.isAvailable).toBe("function");
      // isAvailable returns a boolean (may or may not be installed)
      const result = provider.isAvailable();
      expect(typeof result).toBe("boolean");
    });

    it("has start method", () => {
      const provider = getTunnelProvider("ngrok")!;
      expect(typeof provider.start).toBe("function");
    });
  });

  describe("cloudflare provider", () => {
    it("has isAvailable method", () => {
      const provider = getTunnelProvider("cloudflare")!;
      expect(typeof provider.isAvailable).toBe("function");
      const result = provider.isAvailable();
      expect(typeof result).toBe("boolean");
    });

    it("has start method", () => {
      const provider = getTunnelProvider("cloudflare")!;
      expect(typeof provider.start).toBe("function");
    });
  });
});

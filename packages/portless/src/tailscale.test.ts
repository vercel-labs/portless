import { describe, it, expect } from "vitest";
import {
  ensureTailscaleReady,
  findAvailableServePort,
  formatTailscaleUrl,
  getUsedServePorts,
  registerFunnel,
  registerServe,
  unregisterFunnel,
  unregisterServe,
  unregisterTailscale,
  type TailscaleCommandRunner,
} from "./tailscale.js";

interface MockResult {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

function createRunner(
  results: Record<string, MockResult>,
  calls: string[][] = []
): TailscaleCommandRunner {
  return (args: string[]) => {
    calls.push(args);
    const key = args.join(" ");
    const result = results[key];
    if (!result) {
      throw new Error(`Unexpected tailscale call: ${key}`);
    }
    return {
      status: result.status ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

describe("tailscale", () => {
  // -----------------------------------------------------------------------
  // ensureTailscaleReady
  // -----------------------------------------------------------------------

  describe("ensureTailscaleReady", () => {
    it("resolves base URL from Self.DNSName", () => {
      const runner = createRunner({
        version: { status: 0 },
        "status --json": {
          status: 0,
          stdout: JSON.stringify({
            Self: { DNSName: "devbox.example.ts.net." },
          }),
        },
      });
      const ready = ensureTailscaleReady(runner);
      expect(ready.dnsName).toBe("devbox.example.ts.net");
      expect(ready.baseUrl).toBe("https://devbox.example.ts.net");
    });

    it("falls back to HostName and MagicDNSSuffix", () => {
      const runner = createRunner({
        version: { status: 0 },
        "status --json": {
          status: 0,
          stdout: JSON.stringify({
            Self: { HostName: "devbox" },
            CurrentTailnet: { MagicDNSSuffix: "example.ts.net." },
          }),
        },
      });
      const ready = ensureTailscaleReady(runner);
      expect(ready.dnsName).toBe("devbox.example.ts.net");
    });

    it("throws when tailscale CLI is missing", () => {
      const enoent = Object.assign(new Error("spawn tailscale ENOENT"), {
        code: "ENOENT",
      });
      const runner = createRunner({
        version: { status: null, error: enoent },
      });
      expect(() => ensureTailscaleReady(runner)).toThrow("Tailscale CLI not found");
    });

    it("throws when tailscale is not connected", () => {
      const runner = createRunner({
        version: { status: 0 },
        "status --json": {
          status: 0,
          stdout: JSON.stringify({ Self: {} }),
        },
      });
      expect(() => ensureTailscaleReady(runner)).toThrow("Could not determine");
    });

    it("throws on version check failure", () => {
      const runner = createRunner({
        version: { status: 1, stderr: "not found" },
      });
      expect(() => ensureTailscaleReady(runner)).toThrow("Failed to check tailscale version");
    });

    it("throws on invalid status JSON", () => {
      const runner = createRunner({
        version: { status: 0 },
        "status --json": {
          status: 0,
          stdout: "not json",
        },
      });
      expect(() => ensureTailscaleReady(runner)).toThrow("Failed to parse");
    });
  });

  // -----------------------------------------------------------------------
  // getUsedServePorts
  // -----------------------------------------------------------------------

  describe("getUsedServePorts", () => {
    it("parses Web ports from serve status JSON", () => {
      const runner = createRunner({
        "serve status --json": {
          status: 0,
          stdout: JSON.stringify({
            Web: {
              "devbox.example.ts.net:443": { Handlers: {} },
              "devbox.example.ts.net:8443": { Handlers: {} },
            },
          }),
        },
      });
      const ports = getUsedServePorts(runner);
      expect(ports).toEqual(new Set([443, 8443]));
    });

    it("parses TCP ports", () => {
      const runner = createRunner({
        "serve status --json": {
          status: 0,
          stdout: JSON.stringify({
            TCP: { "22": { HTTPS: true }, "443": {} },
          }),
        },
      });
      const ports = getUsedServePorts(runner);
      expect(ports).toEqual(new Set([22, 443]));
    });

    it("returns empty set on command failure", () => {
      const runner = createRunner({
        "serve status --json": { status: 1, stderr: "error" },
      });
      const ports = getUsedServePorts(runner);
      expect(ports).toEqual(new Set());
    });

    it("returns empty set on invalid JSON", () => {
      const runner = createRunner({
        "serve status --json": { status: 0, stdout: "not json" },
      });
      const ports = getUsedServePorts(runner);
      expect(ports).toEqual(new Set());
    });

    it("returns empty set on empty config", () => {
      const runner = createRunner({
        "serve status --json": { status: 0, stdout: "{}" },
      });
      const ports = getUsedServePorts(runner);
      expect(ports).toEqual(new Set());
    });
  });

  // -----------------------------------------------------------------------
  // findAvailableServePort
  // -----------------------------------------------------------------------

  describe("findAvailableServePort", () => {
    it("returns 443 when nothing is in use", () => {
      expect(findAvailableServePort(new Set())).toBe(443);
    });

    it("returns 8443 when 443 is taken", () => {
      expect(findAvailableServePort(new Set([443]))).toBe(8443);
    });

    it("skips to 8444 when 443 and 8443 are taken", () => {
      expect(findAvailableServePort(new Set([443, 8443]))).toBe(8444);
    });

    it("goes beyond preferred list when all are taken", () => {
      const all = new Set([443, 8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450]);
      expect(findAvailableServePort(all)).toBe(8451);
    });

    it("returns 443 for funnel when nothing is in use", () => {
      expect(findAvailableServePort(new Set(), "funnel")).toBe(443);
    });

    it("returns 8443 for funnel when 443 is taken", () => {
      expect(findAvailableServePort(new Set([443]), "funnel")).toBe(8443);
    });

    it("returns 10000 for funnel when 443 and 8443 are taken", () => {
      expect(findAvailableServePort(new Set([443, 8443]), "funnel")).toBe(10000);
    });

    it("throws when all funnel ports are taken", () => {
      expect(() => findAvailableServePort(new Set([443, 8443, 10000]), "funnel")).toThrow(
        "All Tailscale Funnel ports are in use"
      );
    });
  });

  // -----------------------------------------------------------------------
  // registerServe / unregisterServe
  // -----------------------------------------------------------------------

  describe("registerServe", () => {
    it("calls tailscale serve with correct args", () => {
      const calls: string[][] = [];
      const runner = createRunner(
        {
          "serve --bg --yes --https=443 http://127.0.0.1:4123": { status: 0 },
        },
        calls
      );
      registerServe(4123, 443, { runner });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:4123"]);
    });

    it("uses custom HTTPS port", () => {
      const calls: string[][] = [];
      const runner = createRunner(
        {
          "serve --bg --yes --https=8443 http://127.0.0.1:4456": { status: 0 },
        },
        calls
      );
      registerServe(4456, 8443, { runner });
      expect(calls[0]).toContain("--https=8443");
    });

    it("throws on conflict", () => {
      const runner = createRunner({
        "serve --bg --yes --https=443 http://127.0.0.1:4123": {
          status: 1,
          stderr: "port already in use",
        },
      });
      expect(() => registerServe(4123, 443, { runner })).toThrow("already in use");
    });

    it("throws on ENOENT", () => {
      const enoent = Object.assign(new Error("spawn tailscale ENOENT"), {
        code: "ENOENT",
      });
      const runner = createRunner({
        "serve --bg --yes --https=443 http://127.0.0.1:4123": {
          status: null,
          error: enoent,
        },
      });
      expect(() => registerServe(4123, 443, { runner })).toThrow("Tailscale CLI not found");
    });

    it("throws generic error on non-conflict failure", () => {
      const runner = createRunner({
        "serve --bg --yes --https=443 http://127.0.0.1:4123": {
          status: 1,
          stderr: "some unknown problem",
        },
      });
      expect(() => registerServe(4123, 443, { runner })).toThrow("some unknown problem");
    });
  });

  describe("unregisterServe", () => {
    it("calls tailscale serve off with correct args", () => {
      const calls: string[][] = [];
      const runner = createRunner({ "serve --yes --https=443 off": { status: 0 } }, calls);
      unregisterServe(443, { runner });
      expect(calls[0]).toEqual(["serve", "--yes", "--https=443", "off"]);
    });

    it("ignores missing when requested", () => {
      const runner = createRunner({
        "serve --yes --https=443 off": {
          status: 1,
          stderr: "nothing to remove",
        },
      });
      expect(() => unregisterServe(443, { ignoreMissing: true, runner })).not.toThrow();
    });

    it("throws on unexpected failure", () => {
      const runner = createRunner({
        "serve --yes --https=443 off": {
          status: 1,
          stderr: "permission denied",
        },
      });
      expect(() => unregisterServe(443, { runner })).toThrow("permission denied");
    });

    it("silently returns on ENOENT", () => {
      const enoent = Object.assign(new Error("spawn tailscale ENOENT"), {
        code: "ENOENT",
      });
      const runner = createRunner({
        "serve --yes --https=443 off": { status: null, error: enoent },
      });
      expect(() => unregisterServe(443, { runner })).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // registerFunnel / unregisterFunnel
  // -----------------------------------------------------------------------

  describe("registerFunnel", () => {
    it("calls tailscale funnel with correct args", () => {
      const calls: string[][] = [];
      const runner = createRunner(
        {
          "funnel --bg --yes --https=443 http://127.0.0.1:4123": { status: 0 },
        },
        calls
      );
      registerFunnel(4123, 443, { runner });
      expect(calls[0]).toEqual(["funnel", "--bg", "--yes", "--https=443", "http://127.0.0.1:4123"]);
    });

    it("throws on conflict with funnel port info", () => {
      const runner = createRunner({
        "funnel --bg --yes --https=443 http://127.0.0.1:4123": {
          status: 1,
          stderr: "port already in use",
        },
      });
      expect(() => registerFunnel(4123, 443, { runner })).toThrow(
        "Tailscale Funnel supports ports 443, 8443, and 10000"
      );
    });
  });

  describe("unregisterFunnel", () => {
    it("calls tailscale funnel off with correct args", () => {
      const calls: string[][] = [];
      const runner = createRunner({ "funnel --yes --https=443 off": { status: 0 } }, calls);
      unregisterFunnel(443, { runner });
      expect(calls[0]).toEqual(["funnel", "--yes", "--https=443", "off"]);
    });

    it("ignores missing when requested", () => {
      const runner = createRunner({
        "funnel --yes --https=8443 off": {
          status: 1,
          stderr: "does not exist",
        },
      });
      expect(() => unregisterFunnel(8443, { ignoreMissing: true, runner })).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // unregisterTailscale
  // -----------------------------------------------------------------------

  describe("unregisterTailscale", () => {
    it("calls serve off for non-funnel route", () => {
      const calls: string[][] = [];
      const runner = createRunner({ "serve --yes --https=443 off": { status: 0 } }, calls);
      unregisterServe(443, { runner });
      expect(calls[0]).toEqual(["serve", "--yes", "--https=443", "off"]);
    });

    it("calls funnel off for funnel route", () => {
      const calls: string[][] = [];
      const runner = createRunner({ "funnel --yes --https=8443 off": { status: 0 } }, calls);
      unregisterFunnel(8443, { runner });
      expect(calls[0]).toEqual(["funnel", "--yes", "--https=8443", "off"]);
    });

    it("is a no-op when tailscaleHttpsPort is undefined", () => {
      expect(() => unregisterTailscale({})).not.toThrow();
    });

    it("is a no-op when tailscaleHttpsPort is missing", () => {
      expect(() => unregisterTailscale({ tailscaleFunnel: true })).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // formatTailscaleUrl
  // -----------------------------------------------------------------------

  describe("formatTailscaleUrl", () => {
    it("omits port for 443", () => {
      expect(formatTailscaleUrl("https://devbox.example.ts.net", 443)).toBe(
        "https://devbox.example.ts.net"
      );
    });

    it("includes non-default port", () => {
      expect(formatTailscaleUrl("https://devbox.example.ts.net", 8443)).toBe(
        "https://devbox.example.ts.net:8443"
      );
    });

    it("trims trailing slash from base URL", () => {
      expect(formatTailscaleUrl("https://devbox.example.ts.net/", 443)).toBe(
        "https://devbox.example.ts.net"
      );
    });
  });
});

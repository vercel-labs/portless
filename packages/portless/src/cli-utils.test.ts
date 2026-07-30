import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildProxyStartConfig,
  BLOCKED_PORTS,
  DEFAULT_TLD,
  FALLBACK_PROXY_PORT,
  INTERNAL_LAN_IP_FLAG,
  LEGACY_SYSTEM_STATE_DIR,
  PRIVILEGED_PORT_THRESHOLD,
  RISKY_TLDS,
  USER_STATE_DIR,
  discoverState,
  findFreePort,
  getDefaultPort,
  getDefaultTld,
  getDefaultTlds,
  getProtocolPort,
  getProxyBindTargets,
  getRiskyTldReason,
  isHttpsEnvDisabled,
  injectFrameworkFlags,
  isPortListening,
  isProxyRunning,
  triggerHostsSync,
  reportHostsSync,
  syncHostsWithWarning,
  listenOnProxyInterface,
  parsePidFromNetstat,
  parseTldList,
  readLanMarker,
  readPersistedProxyState,
  readTldFromDir,
  readTldsFromDir,
  resolveStateDir,
  validateTld,
  writeLanMarker,
  writeTldFile,
  writeTldsFile,
  writeTlsMarker,
} from "./cli-utils.js";

describe("proxy listener interface", () => {
  it("uses only IPv4 and IPv6 loopback outside LAN mode", () => {
    expect(getProxyBindTargets(false)).toEqual([
      { host: "127.0.0.1" },
      { host: "::1", ipv6Only: true },
    ]);
  });

  it("uses IPv4 and IPv6 unspecified addresses in LAN mode", () => {
    expect(getProxyBindTargets(true)).toEqual([
      { host: "0.0.0.0" },
      { host: "::", ipv6Only: true },
    ]);
  });

  it("binds IPv4 loopback outside LAN mode", async () => {
    const target = getProxyBindTargets(false)[0]!;

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      listenOnProxyInterface(server, 0, target, resolve);
    });

    try {
      const address = server.address();
      expect(address && typeof address !== "string" ? address.address : null).toBe("127.0.0.1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("binds IPv6 loopback outside LAN mode when available", async (ctx) => {
    const target = getProxyBindTargets(false)[1]!;

    const server = net.createServer();
    const ipv6Available = await new Promise<boolean>((resolve, reject) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") {
          resolve(false);
        } else {
          reject(err);
        }
      });
      listenOnProxyInterface(server, 0, target, () => resolve(true));
    });
    if (!ipv6Available) return ctx.skip();

    try {
      const address = server.address();
      expect(address && typeof address !== "string" ? address.address : null).toBe("::1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("binds the IPv4 unspecified address in LAN mode", async () => {
    const target = getProxyBindTargets(true)[0]!;

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      listenOnProxyInterface(server, 0, target, resolve);
    });

    try {
      const address = server.address();
      expect(address && typeof address !== "string" ? address.address : null).toBe("0.0.0.0");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("findFreePort", () => {
  it("returns a port in the default range", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThanOrEqual(4000);
    expect(port).toBeLessThanOrEqual(4999);
  });

  it("returns a port that is actually bindable", async () => {
    const port = await findFreePort();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(port, () => resolve());
      server.on("error", reject);
    });
    server.close();
  });

  it("respects custom port range", async () => {
    const port = await findFreePort(9000, 9010);
    expect(port).toBeGreaterThanOrEqual(9000);
    expect(port).toBeLessThanOrEqual(9010);
  });

  it("throws when no port is available in a tiny occupied range", async () => {
    // Occupy a single-port range
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(9999, () => resolve()));
    try {
      await expect(findFreePort(9999, 9999)).rejects.toThrow("No free port found");
    } finally {
      server.close();
    }
  });

  it("throws when minPort > maxPort", async () => {
    await expect(findFreePort(5000, 4000)).rejects.toThrow("minPort");
  });

  it("never returns a blocked port (WHATWG bad ports)", async () => {
    for (let i = 0; i < 20; i++) {
      const port = await findFreePort();
      expect(BLOCKED_PORTS.has(port)).toBe(false);
    }
  });

  it("skips a blocked port even when it is the only one in range", async () => {
    await expect(findFreePort(4045, 4045)).rejects.toThrow("No free port found");
  });
});

describe("isProxyRunning", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers.length = 0;
  });

  it("returns false when nothing is listening", async () => {
    const result = await isProxyRunning(19876);
    expect(result).toBe(false);
  });

  it("returns true when a portless proxy is listening", async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader("X-Portless", "1");
      res.end("ok");
    });
    servers.push(server);

    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") {
          resolve(addr.port);
        }
      });
    });

    const result = await isProxyRunning(port);
    expect(result).toBe(true);
  });

  it("returns false when a non-portless server is listening", async () => {
    const server = http.createServer((_req, res) => {
      res.end("not portless");
    });
    servers.push(server);

    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr !== "string") {
          resolve(addr.port);
        }
      });
    });

    const result = await isProxyRunning(port);
    expect(result).toBe(false);
  });
});

describe("isPortListening", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers.length = 0;
  });

  it("returns false when nothing is listening", async () => {
    expect(await isPortListening(19877)).toBe(false);
  });

  it("detects a server listening on IPv6 loopback only (issue #320)", async (ctx) => {
    const server = http.createServer((_req, res) => res.end("ok"));
    const ipv6Available = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(0, "::1", () => resolve(true));
    });
    if (!ipv6Available) return ctx.skip();
    servers.push(server);
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");

    expect(await isPortListening(addr.port)).toBe(true);
  });
});

describe("resolveStateDir", () => {
  it("returns user dir for all ports", () => {
    expect(resolveStateDir(80)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(443)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(1023)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(1024)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(8080)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(3000)).toBe(USER_STATE_DIR);
  });

  it.skipIf(process.platform === "win32")(
    "uses the invoking user's home when loaded under sudo",
    async () => {
      const originalHome = process.env.HOME;
      const originalSudoUser = process.env.SUDO_USER;
      const expectedHome = process.platform === "darwin" ? "/Users/alice" : "/home/alice";

      try {
        process.env.HOME = process.platform === "darwin" ? "/var/root" : "/root";
        process.env.SUDO_USER = "alice";
        vi.resetModules();

        const sudoModule = await import("./cli-utils.js");
        expect(sudoModule.USER_STATE_DIR).toBe(path.join(expectedHome, ".portless"));
        expect(sudoModule.resolveStateDir(443)).toBe(path.join(expectedHome, ".portless"));
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        if (originalSudoUser === undefined) delete process.env.SUDO_USER;
        else process.env.SUDO_USER = originalSudoUser;
        vi.resetModules();
      }
    }
  );
});

describe("constants", () => {
  it("FALLBACK_PROXY_PORT is 1355", () => {
    expect(FALLBACK_PROXY_PORT).toBe(1355);
  });

  it("PRIVILEGED_PORT_THRESHOLD is 1024", () => {
    expect(PRIVILEGED_PORT_THRESHOLD).toBe(1024);
  });

  it("LEGACY_SYSTEM_STATE_DIR is /tmp/portless on Unix, os.tmpdir() on Windows", () => {
    if (process.platform === "win32") {
      expect(LEGACY_SYSTEM_STATE_DIR).toBe(path.join(os.tmpdir(), "portless"));
    } else {
      expect(LEGACY_SYSTEM_STATE_DIR).toBe("/tmp/portless");
    }
  });

  it("USER_STATE_DIR is in home directory", () => {
    expect(USER_STATE_DIR).toBe(path.join(os.homedir(), ".portless"));
  });
});

describe("parsePidFromNetstat", () => {
  const SAMPLE_OUTPUT = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1104",
    "  TCP    0.0.0.0:1355           0.0.0.0:0              LISTENING       9876",
    "  TCP    0.0.0.0:5432           0.0.0.0:0              LISTENING       3200",
    "  TCP    [::]:1355              [::]:0                  LISTENING       9876",
    "  TCP    127.0.0.1:1355         127.0.0.1:52000        ESTABLISHED     9876",
    "  TCP    192.168.1.10:13550     10.0.0.1:443           ESTABLISHED     5500",
  ].join("\r\n");

  it("finds PID for a matching LISTENING port", () => {
    expect(parsePidFromNetstat(SAMPLE_OUTPUT, 1355)).toBe(9876);
  });

  it("returns null when port is not listening", () => {
    expect(parsePidFromNetstat(SAMPLE_OUTPUT, 9999)).toBeNull();
  });

  it("does not match ESTABLISHED connections", () => {
    expect(parsePidFromNetstat(SAMPLE_OUTPUT, 1355)).toBe(9876);
  });

  it("does not false-match on port prefix (13550 vs 1355)", () => {
    expect(parsePidFromNetstat(SAMPLE_OUTPUT, 13550)).toBeNull();
  });

  it("matches IPv6 addresses ([::]:port)", () => {
    const ipv6Only = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    [::]:1355              [::]:0                  LISTENING       4444",
    ].join("\r\n");
    expect(parsePidFromNetstat(ipv6Only, 1355)).toBe(4444);
  });

  it("matches 127.0.0.1 bound addresses", () => {
    const loopback = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       7777",
    ].join("\r\n");
    expect(parsePidFromNetstat(loopback, 8080)).toBe(7777);
  });

  it("returns null for empty output", () => {
    expect(parsePidFromNetstat("", 1355)).toBeNull();
  });

  it("handles Unix-style line endings", () => {
    const unixOutput = [
      "  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       1234",
    ].join("\n");
    expect(parsePidFromNetstat(unixOutput, 3000)).toBe(1234);
  });
});

describe("getProtocolPort", () => {
  it("returns 443 for TLS", () => {
    expect(getProtocolPort(true)).toBe(443);
  });

  it("returns 80 for plain HTTP", () => {
    expect(getProtocolPort(false)).toBe(80);
  });
});

describe("getDefaultPort", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.PORTLESS_PORT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PORTLESS_PORT;
    } else {
      process.env.PORTLESS_PORT = originalEnv;
    }
  });

  it("returns FALLBACK_PROXY_PORT when called without tls argument", () => {
    delete process.env.PORTLESS_PORT;
    expect(getDefaultPort()).toBe(FALLBACK_PROXY_PORT);
  });

  it("returns 443 when tls is true", () => {
    delete process.env.PORTLESS_PORT;
    expect(getDefaultPort(true)).toBe(443);
  });

  it("returns 80 when tls is false", () => {
    delete process.env.PORTLESS_PORT;
    expect(getDefaultPort(false)).toBe(80);
  });

  it("returns PORTLESS_PORT when set, regardless of tls argument", () => {
    process.env.PORTLESS_PORT = "8080";
    expect(getDefaultPort()).toBe(8080);
    expect(getDefaultPort(true)).toBe(8080);
    expect(getDefaultPort(false)).toBe(8080);
  });

  it("returns protocol default when PORTLESS_PORT is invalid", () => {
    process.env.PORTLESS_PORT = "not-a-number";
    expect(getDefaultPort()).toBe(FALLBACK_PROXY_PORT);
    expect(getDefaultPort(true)).toBe(443);
    expect(getDefaultPort(false)).toBe(80);
  });

  it("returns protocol default when PORTLESS_PORT is out of range", () => {
    process.env.PORTLESS_PORT = "0";
    expect(getDefaultPort(true)).toBe(443);

    process.env.PORTLESS_PORT = "70000";
    expect(getDefaultPort(false)).toBe(80);
  });

  it("returns FALLBACK_PROXY_PORT when PORTLESS_PORT is empty and tls is undefined", () => {
    process.env.PORTLESS_PORT = "";
    expect(getDefaultPort()).toBe(FALLBACK_PROXY_PORT);
  });
});

describe("isHttpsEnvDisabled", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.PORTLESS_HTTPS;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PORTLESS_HTTPS;
    } else {
      process.env.PORTLESS_HTTPS = originalEnv;
    }
  });

  it("returns true when PORTLESS_HTTPS is '0'", () => {
    process.env.PORTLESS_HTTPS = "0";
    expect(isHttpsEnvDisabled()).toBe(true);
  });

  it("returns true when PORTLESS_HTTPS is 'false'", () => {
    process.env.PORTLESS_HTTPS = "false";
    expect(isHttpsEnvDisabled()).toBe(true);
  });

  it("returns false when PORTLESS_HTTPS is '1'", () => {
    process.env.PORTLESS_HTTPS = "1";
    expect(isHttpsEnvDisabled()).toBe(false);
  });

  it("returns false when PORTLESS_HTTPS is unset", () => {
    delete process.env.PORTLESS_HTTPS;
    expect(isHttpsEnvDisabled()).toBe(false);
  });
});

describe("injectFrameworkFlags", () => {
  it("injects --port, --strictPort, and --host for vite command", () => {
    const args = ["vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["vite", "dev", "--port", "4567", "--strictPort", "--host", "127.0.0.1"]);
  });

  it("injects flags for absolute/relative vite paths", () => {
    const args = ["./node_modules/.bin/vite", "dev"];
    injectFrameworkFlags(args, 4000);
    expect(args).toEqual([
      "./node_modules/.bin/vite",
      "dev",
      "--port",
      "4000",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("skips --port injection when --port is already present", () => {
    const args = ["vite", "dev", "--port", "3000"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["vite", "dev", "--port", "3000", "--host", "127.0.0.1"]);
  });

  it("skips --host injection when --host is already present", () => {
    const args = ["vite", "dev", "--host", "0.0.0.0"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["vite", "dev", "--host", "0.0.0.0", "--port", "4567", "--strictPort"]);
  });

  it("skips all injection when both --port and --host are present", () => {
    const args = ["vite", "dev", "--port", "3000", "--host", "0.0.0.0"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["vite", "dev", "--port", "3000", "--host", "0.0.0.0"]);
  });

  it("injects --port, --strictPort, and --host for vp (viteplus) command", () => {
    const args = ["vp", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["vp", "dev", "--port", "4567", "--strictPort", "--host", "127.0.0.1"]);
  });

  it("injects for react-router with --strictPort", () => {
    const args = ["react-router", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "react-router",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("injects for rsbuild without --strictPort", () => {
    const args = ["rsbuild", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["rsbuild", "dev", "--port", "4567", "--host", "127.0.0.1"]);
  });

  it("injects for astro without --strictPort", () => {
    const args = ["astro", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["astro", "dev", "--port", "4567", "--host", "127.0.0.1"]);
  });

  it("injects for ng without --strictPort", () => {
    const args = ["ng", "serve"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["ng", "serve", "--port", "4567", "--host", "127.0.0.1"]);
  });

  it("injects for react-native without --strictPort", () => {
    const args = ["react-native", "start"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["react-native", "start", "--port", "4567", "--host", "127.0.0.1"]);
  });

  it("injects for expo without --strictPort (defaults to localhost)", () => {
    const args = ["expo", "start"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["expo", "start", "--port", "4567", "--host", "localhost"]);
  });

  it("skips --host for expo in LAN mode (Metro defaults to LAN)", () => {
    const prev = process.env.PORTLESS_LAN;
    process.env.PORTLESS_LAN = "1";
    try {
      const args = ["expo", "start"];
      injectFrameworkFlags(args, 4567);
      expect(args).toEqual(["expo", "start", "--port", "4567"]);
    } finally {
      if (prev === undefined) delete process.env.PORTLESS_LAN;
      else process.env.PORTLESS_LAN = prev;
    }
  });

  it("does not inject for frameworks that read PORT", () => {
    const nextArgs = ["next", "dev"];
    injectFrameworkFlags(nextArgs, 4567);
    expect(nextArgs).toEqual(["next", "dev"]);

    const nuxtArgs = ["nuxt", "dev"];
    injectFrameworkFlags(nuxtArgs, 4567);
    expect(nuxtArgs).toEqual(["nuxt", "dev"]);

    const nodeArgs = ["node", "server.js"];
    injectFrameworkFlags(nodeArgs, 4567);
    expect(nodeArgs).toEqual(["node", "server.js"]);
  });

  it("does nothing for empty args", () => {
    const args: string[] = [];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([]);
  });

  // Package runner support (issue #146: bunx --bun vite dev gives 502)

  // Simple runners (npx, bunx, pnpx)

  it("injects flags for bunx vite dev", () => {
    const args = ["bunx", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "bunx",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("injects flags for bunx --bun vite dev", () => {
    const args = ["bunx", "--bun", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "bunx",
      "--bun",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("injects flags for npx vite dev", () => {
    const args = ["npx", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "npx",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("injects flags for npx with flags before framework", () => {
    const args = ["npx", "--yes", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "npx",
      "--yes",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("injects flags for pnpx vite dev", () => {
    const args = ["pnpx", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "pnpx",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  // Subcommand runners (yarn dlx/exec, pnpm dlx/exec)

  it("injects flags for yarn dlx vite dev", () => {
    const args = ["yarn", "dlx", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "yarn",
      "dlx",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("injects flags for yarn exec vite dev", () => {
    const args = ["yarn", "exec", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "yarn",
      "exec",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("injects flags for pnpm dlx vite dev", () => {
    const args = ["pnpm", "dlx", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "pnpm",
      "dlx",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  it("injects flags for pnpm exec astro dev", () => {
    const args = ["pnpm", "exec", "astro", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["pnpm", "exec", "astro", "dev", "--port", "4567", "--host", "127.0.0.1"]);
  });

  it("injects flags for npx rsbuild dev", () => {
    const args = ["npx", "rsbuild", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["npx", "rsbuild", "dev", "--port", "4567", "--host", "127.0.0.1"]);
  });

  // Implicit bin (yarn <framework>)

  it("injects flags for yarn vite (implicit bin)", () => {
    const args = ["yarn", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "yarn",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  // Runner with multiple flags

  it("skips multiple runner flags before framework", () => {
    const args = ["npx", "--yes", "--quiet", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "npx",
      "--yes",
      "--quiet",
      "vite",
      "dev",
      "--port",
      "4567",
      "--strictPort",
      "--host",
      "127.0.0.1",
    ]);
  });

  // Runner + --port / --host already present

  it("skips --port when already present via runner", () => {
    const args = ["bunx", "vite", "dev", "--port", "3000"];
    injectFrameworkFlags(args, 4567);
    expect(args).toContain("3000");
    expect(args).not.toContain("4567");
  });

  it("skips --host when already present via runner", () => {
    const args = ["npx", "vite", "dev", "--host", "0.0.0.0"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual([
      "npx",
      "vite",
      "dev",
      "--host",
      "0.0.0.0",
      "--port",
      "4567",
      "--strictPort",
    ]);
  });

  it("skips all injection when both --port and --host present via runner", () => {
    const args = ["bunx", "--bun", "vite", "dev", "--port", "3000", "--host", "0.0.0.0"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["bunx", "--bun", "vite", "dev", "--port", "3000", "--host", "0.0.0.0"]);
  });

  // Negative cases: runner with non-framework commands

  it("does not inject for bunx with non-framework command", () => {
    const args = ["bunx", "--bun", "next", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["bunx", "--bun", "next", "dev"]);
  });

  it("does not inject for npx with non-framework command", () => {
    const args = ["npx", "next", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["npx", "next", "dev"]);
  });

  it("does not inject for yarn with unrecognized subcommand", () => {
    const args = ["yarn", "run", "next", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["yarn", "run", "next", "dev"]);
  });

  it("does not inject for pnpm with unrecognized subcommand", () => {
    const args = ["pnpm", "run", "vite", "dev"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["pnpm", "run", "vite", "dev"]);
  });

  // Edge cases

  it("does not inject when runner has only flags and no command", () => {
    const args = ["bunx", "--bun"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["bunx", "--bun"]);
  });

  it("does not inject for runner alone with no arguments", () => {
    const args = ["npx"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["npx"]);
  });

  it("does not inject for yarn subcommand with no further arguments", () => {
    const args = ["yarn", "dlx"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["yarn", "dlx"]);
  });

  it("does not inject for yarn with only flags and no subcommand", () => {
    const args = ["yarn", "--silent"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["yarn", "--silent"]);
  });
});

describe("DEFAULT_TLD", () => {
  it("is localhost", () => {
    expect(DEFAULT_TLD).toBe("localhost");
  });
});

describe("getDefaultTld", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.PORTLESS_TLD;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PORTLESS_TLD;
    } else {
      process.env.PORTLESS_TLD = originalEnv;
    }
  });

  it("returns DEFAULT_TLD when PORTLESS_TLD is not set", () => {
    delete process.env.PORTLESS_TLD;
    expect(getDefaultTld()).toBe(DEFAULT_TLD);
  });

  it("returns PORTLESS_TLD when set", () => {
    process.env.PORTLESS_TLD = "test";
    expect(getDefaultTld()).toBe("test");
  });

  it("lowercases the value", () => {
    process.env.PORTLESS_TLD = "TEST";
    expect(getDefaultTld()).toBe("test");
  });

  it("trims whitespace", () => {
    process.env.PORTLESS_TLD = "  test  ";
    expect(getDefaultTld()).toBe("test");
  });

  it("returns DEFAULT_TLD when PORTLESS_TLD is empty", () => {
    process.env.PORTLESS_TLD = "";
    expect(getDefaultTld()).toBe(DEFAULT_TLD);
  });

  it("returns the first TLD when PORTLESS_TLD contains a list", () => {
    process.env.PORTLESS_TLD = "localhost,test";
    expect(getDefaultTld()).toBe("localhost");
  });
});

describe("getDefaultTlds", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.PORTLESS_TLD;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PORTLESS_TLD;
    } else {
      process.env.PORTLESS_TLD = originalEnv;
    }
  });

  it("returns DEFAULT_TLD when PORTLESS_TLD is not set", () => {
    delete process.env.PORTLESS_TLD;
    expect(getDefaultTlds()).toEqual([DEFAULT_TLD]);
  });

  it("parses comma separated values", () => {
    process.env.PORTLESS_TLD = "localhost, test";
    expect(getDefaultTlds()).toEqual(["localhost", "test"]);
  });

  it("deduplicates values in order", () => {
    process.env.PORTLESS_TLD = "test,localhost,test";
    expect(getDefaultTlds()).toEqual(["test", "localhost"]);
  });
});

describe("parseTldList", () => {
  it("parses and normalizes values", () => {
    expect(parseTldList(" TEST,localhost ")).toEqual(["test", "localhost"]);
  });

  it("rejects empty list entries", () => {
    expect(() => parseTldList("test,")).toThrow("TLD cannot be empty");
  });

  it("accepts a mix of single- and multi-segment TLDs", () => {
    expect(parseTldList("localhost,dev.example.com")).toEqual(["localhost", "dev.example.com"]);
  });
});

describe("buildProxyStartConfig", () => {
  it("forces .local and keeps explicit --ip in LAN mode", () => {
    expect(
      buildProxyStartConfig({
        useHttps: true,
        lanMode: true,
        lanIp: "192.168.1.42",
        lanIpExplicit: true,
        tld: "test",
        useWildcard: true,
        foreground: true,
        includePort: true,
        proxyPort: 8080,
      })
    ).toEqual({
      effectiveTld: "local",
      effectiveTlds: ["local"],
      args: [
        "--foreground",
        "--port",
        "8080",
        "--https",
        "--lan",
        "--ip",
        "192.168.1.42",
        "--wildcard",
      ],
    });
  });

  it("passes auto-detected LAN IP through an internal flag", () => {
    expect(
      buildProxyStartConfig({
        useHttps: false,
        lanMode: true,
        lanIp: "192.168.1.42",
        lanIpExplicit: false,
        tld: "localhost",
      })
    ).toEqual({
      effectiveTld: "local",
      effectiveTlds: ["local"],
      args: ["--no-tls", "--lan", INTERNAL_LAN_IP_FLAG, "192.168.1.42"],
    });
  });

  it("keeps custom TLDs outside LAN mode", () => {
    expect(
      buildProxyStartConfig({
        useHttps: false,
        lanMode: false,
        tld: "test",
      })
    ).toEqual({
      effectiveTld: "test",
      effectiveTlds: ["test"],
      args: ["--no-tls", "--tld", "test"],
    });
  });

  it("emits each TLD outside LAN mode", () => {
    expect(
      buildProxyStartConfig({
        useHttps: true,
        lanMode: false,
        tld: "localhost",
        tlds: ["localhost", "test"],
      })
    ).toEqual({
      effectiveTld: "localhost",
      effectiveTlds: ["localhost", "test"],
      args: ["--https", "--tld", "localhost", "--tld", "test"],
    });
  });
});

describe("readLanMarker / writeLanMarker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-lan-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads a LAN IP", () => {
    writeLanMarker(tmpDir, "192.168.1.42");
    expect(readLanMarker(tmpDir)).toBe("192.168.1.42");
  });

  it("removes the file when writing null", () => {
    writeLanMarker(tmpDir, "192.168.1.42");
    expect(fs.existsSync(path.join(tmpDir, "proxy.lan"))).toBe(true);

    writeLanMarker(tmpDir, null);
    expect(fs.existsSync(path.join(tmpDir, "proxy.lan"))).toBe(false);
    expect(readLanMarker(tmpDir)).toBeNull();
  });

  it("uses the LAN marker to remember LAN mode when the proxy is stopped", async () => {
    const prevStateDir = process.env.PORTLESS_STATE_DIR;
    try {
      fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355");
      writeTldFile(tmpDir, "local");
      writeLanMarker(tmpDir, "192.168.1.42");
      process.env.PORTLESS_STATE_DIR = tmpDir;

      await expect(discoverState()).resolves.toMatchObject({
        dir: tmpDir,
        port: 1355,
        tld: "local",
        lanMode: true,
        lanIp: null,
      });
    } finally {
      if (prevStateDir === undefined) {
        delete process.env.PORTLESS_STATE_DIR;
      } else {
        process.env.PORTLESS_STATE_DIR = prevStateDir;
      }
    }
  });
});

describe("readTldFromDir / writeTldFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-tld-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns DEFAULT_TLD when file does not exist", () => {
    expect(readTldFromDir(tmpDir)).toBe(DEFAULT_TLD);
    expect(readTldsFromDir(tmpDir)).toEqual([DEFAULT_TLD]);
  });

  it("writes and reads a custom TLD", () => {
    writeTldFile(tmpDir, "test");
    expect(readTldFromDir(tmpDir)).toBe("test");
    expect(readTldsFromDir(tmpDir)).toEqual(["test"]);
  });

  it("writes and reads multiple TLDs", () => {
    writeTldsFile(tmpDir, ["localhost", "test"]);
    expect(readTldFromDir(tmpDir)).toBe("localhost");
    expect(readTldsFromDir(tmpDir)).toEqual(["localhost", "test"]);
    expect(fs.readFileSync(path.join(tmpDir, "proxy.tld"), "utf-8")).toBe("localhost");
  });

  it("removes the file when writing the default TLD", () => {
    writeTldFile(tmpDir, "test");
    expect(fs.existsSync(path.join(tmpDir, "proxy.tld"))).toBe(true);

    writeTldFile(tmpDir, DEFAULT_TLD);
    expect(fs.existsSync(path.join(tmpDir, "proxy.tld"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "proxy.tlds"))).toBe(false);
    expect(readTldFromDir(tmpDir)).toBe(DEFAULT_TLD);
  });

  it("handles removing the default TLD file when it does not exist", () => {
    writeTldFile(tmpDir, DEFAULT_TLD);
    expect(readTldFromDir(tmpDir)).toBe(DEFAULT_TLD);
  });

  it("skips invalid persisted entries instead of resetting the whole list", () => {
    const tooLong = "a".repeat(70);
    fs.writeFileSync(
      path.join(tmpDir, "proxy.tlds"),
      JSON.stringify(["test", tooLong, "internal"])
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(readTldsFromDir(tmpDir)).toEqual(["test", "internal"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("getRiskyTldReason", () => {
  it("matches exact risky TLDs", () => {
    expect(getRiskyTldReason("dev")).toMatch(/HSTS/);
    expect(getRiskyTldReason("app")).toMatch(/HSTS/);
    expect(getRiskyTldReason("com")).toMatch(/public TLD/);
  });

  it("matches multi-segment TLDs under tree-wide risky suffixes", () => {
    expect(getRiskyTldReason("example.dev")).toMatch(/HSTS/);
    expect(getRiskyTldReason("myapp.app")).toMatch(/HSTS/);
    expect(getRiskyTldReason("foo.local")).toMatch(/mDNS/);
  });

  it("does not suffix-match ownership-class TLDs", () => {
    expect(getRiskyTldReason("dev.example.com")).toBeUndefined();
    expect(getRiskyTldReason("internal.example.org")).toBeUndefined();
  });

  it("returns undefined for safe TLDs", () => {
    expect(getRiskyTldReason("test")).toBeUndefined();
    expect(getRiskyTldReason("dev.internal")).toBeUndefined();
    expect(getRiskyTldReason("devx")).toBeUndefined();
  });
});

describe("validateTld", () => {
  it("returns null for valid TLDs", () => {
    expect(validateTld("localhost")).toBeNull();
    expect(validateTld("test")).toBeNull();
    expect(validateTld("internal")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateTld("")).toMatch(/cannot be empty/);
  });

  it("rejects TLDs with invalid characters", () => {
    expect(validateTld("MY_TLD")).toMatch(/must contain only/);
    expect(validateTld("tld!")).toMatch(/must contain only/);
    expect(validateTld("my tld")).toMatch(/must contain only/);
  });

  it("accepts multi-segment TLDs", () => {
    expect(validateTld("dev.example.com")).toBeNull();
    expect(validateTld("local.example.dev")).toBeNull();
    expect(validateTld("a.b.c.d.e")).toBeNull();
  });

  it("accepts hyphens inside labels", () => {
    expect(validateTld("my-tld")).toBeNull();
    expect(validateTld("dev.my-network.com")).toBeNull();
  });

  it("rejects empty labels", () => {
    expect(validateTld(".example.com")).toMatch(/labels cannot be empty/);
    expect(validateTld("example.com.")).toMatch(/labels cannot be empty/);
    expect(validateTld("example..com")).toMatch(/labels cannot be empty/);
  });

  it("rejects hyphens at label edges", () => {
    expect(validateTld("-bad.example.com")).toMatch(/must contain only/);
    expect(validateTld("bad-.example.com")).toMatch(/must contain only/);
  });

  it("rejects labels over 63 characters", () => {
    expect(validateTld(`${"a".repeat(64)}.example.com`)).toMatch(/63-character/);
  });

  it("rejects TLDs over 253 characters", () => {
    const label = "a".repeat(63);
    const long = [label, label, label, label, "example"].join(".");
    expect(validateTld(long)).toMatch(/253-character/);
  });

  it("allows public TLDs (they produce warnings elsewhere)", () => {
    for (const tld of ["com", "org", "net", "io", "app"]) {
      expect(validateTld(tld)).toBeNull();
      expect(RISKY_TLDS.has(tld)).toBe(true);
    }
  });

  it("allows risky TLDs (they produce warnings elsewhere)", () => {
    for (const tld of ["local", "dev"]) {
      expect(validateTld(tld)).toBeNull();
      expect(RISKY_TLDS.has(tld)).toBe(true);
    }
  });
});

describe("readPersistedProxyState", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-persist-test-"));
    prevStateDir = process.env.PORTLESS_STATE_DIR;
    process.env.PORTLESS_STATE_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevStateDir === undefined) {
      delete process.env.PORTLESS_STATE_DIR;
    } else {
      process.env.PORTLESS_STATE_DIR = prevStateDir;
    }
  });

  it("returns null when no state files exist", () => {
    expect(readPersistedProxyState()).toBeNull();
  });

  it("reads port from persisted state", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355");
    const state = readPersistedProxyState();
    expect(state).not.toBeNull();
    expect(state!.port).toBe(1355);
  });

  it("reads TLS marker from persisted state", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "443");
    writeTlsMarker(tmpDir, true);
    const state = readPersistedProxyState();
    expect(state).not.toBeNull();
    expect(state!.tls).toBe(true);
  });

  it("reads TLD from persisted state", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355");
    writeTldFile(tmpDir, "test");
    const state = readPersistedProxyState();
    expect(state).not.toBeNull();
    expect(state!.tld).toBe("test");
    expect(state!.tlds).toEqual(["test"]);
  });

  it("reads TLD list from persisted state", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355");
    writeTldsFile(tmpDir, ["localhost", "test"]);
    const state = readPersistedProxyState();
    expect(state).not.toBeNull();
    expect(state!.tld).toBe("localhost");
    expect(state!.tlds).toEqual(["localhost", "test"]);
  });

  it("reads LAN mode from persisted state", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355");
    writeLanMarker(tmpDir, "192.168.1.10");
    const state = readPersistedProxyState();
    expect(state).not.toBeNull();
    expect(state!.lanMode).toBe(true);
  });

  it("returns full previous config for a custom proxy setup", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "1355");
    writeTlsMarker(tmpDir, true);
    writeTldFile(tmpDir, "local");
    writeLanMarker(tmpDir, "192.168.1.42");
    const state = readPersistedProxyState();
    expect(state).toEqual({
      port: 1355,
      tls: true,
      tld: "local",
      tlds: ["local"],
      lanMode: true,
    });
  });
});

// Issue #364: the automatic sync ignored its result, so an unprivileged run
// registered a route, skipped the hosts block and said nothing. The sync runs in
// the detached daemon whose stdio goes to proxy.log, so the answer has to cross a
// process boundary. It crosses on the request that asked for it, which is what
// lets the outcome carry no timestamp, no owner and no schema version: a response
// cannot be stale, cannot belong to another caller, and cannot be left behind by
// a previous daemon.
describe("triggerHostsSync", () => {
  // A trigger, not a question. Every answer means the same thing: whatever could
  // happen has had its chance. So the only thing worth testing is that it always
  // settles, and settles fast, since callers await it before starting a child.
  const servers: http.Server[] = [];

  function serve(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler);
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no addr");
        resolve(addr.port);
      });
    });
  }

  afterEach(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    servers.length = 0;
  });

  // The one bit it reports is "a daemon acted", not "the sync worked". A caller
  // needs it to know whether the resolver is already current or whether someone
  // else's schedule still has work to do.
  it("reports that a daemon acted only on its acknowledgement", async () => {
    const ack = await serve((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    expect(await triggerHostsSync(ack)).toBe(true);
  });

  it.each([404, 403, 500])("reports no action on a %s answer", async (status) => {
    const port = await serve((_req, res) => {
      res.writeHead(status);
      res.end();
    });
    expect(await triggerHostsSync(port)).toBe(false);
  });

  it("reports no action when nothing is listening", async () => {
    expect(await triggerHostsSync(19899)).toBe(false);
  });

  // The reason the timeout is short: a caller awaits this before spawning a dev
  // server, so a daemon that accepts and never answers must not hold the terminal.
  it("settles at its own bound against a responder that never answers", async () => {
    const port = await serve(() => {
      // Never respond.
    });
    const started = Date.now();
    await triggerHostsSync(port);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("reportHostsSync", () => {
  const warnings: string[] = [];
  const onWarn = (m: string) => warnings.push(m);
  const acted = async () => true;
  const notActed = async () => false;

  beforeEach(() => {
    warnings.length = 0;
  });

  // The question issue #364 actually asks. RFC 6761 makes .localhost resolution a
  // SHOULD, and on current macOS and glibc it resolves with no hosts entry, so a
  // failed write there is invisible to the user. Reporting the write cannot tell
  // that apart from a custom TLD, where a failed write breaks the app.
  it("says nothing when the hostname resolves", async () => {
    await reportHostsSync(["a.localhost"], 1, false, onWarn, acted, async () => true);
    expect(warnings).toEqual([]);
  });

  it("warns naming only the hostnames that do not resolve", async () => {
    await reportHostsSync(
      ["good.test", "bad.test"],
      1,
      false,
      onWarn,
      acted,
      async (hostname) => hostname === "good.test"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bad.test");
    expect(warnings[0]).not.toContain("good.test");
  });

  // Order is the fix for a hazard, not a style choice. Querying before the daemon
  // writes can cache a negative that is about to become false, and macOS caches
  // negatives, so an early probe could break the resolution it checks.
  it("triggers the daemon before it reads the resolver", async () => {
    const order: string[] = [];
    await reportHostsSync(
      ["a.test"],
      1,
      false,
      onWarn,
      async () => {
        order.push("trigger");
        return true;
      },
      async () => {
        order.push("resolve");
        return true;
      }
    );
    expect(order).toEqual(["trigger", "resolve"]);
  });

  // A daemon too old to have this route still syncs, on its watcher. Reading the
  // resolver the instant its 404 arrives reports an absence a debounce away from
  // being false, which is exactly the class of defect this design was meant to end.
  it("gives an untriggerable daemon its chance before calling it a failure", async () => {
    let reads = 0;
    await reportHostsSync(["a.test"], 1, false, onWarn, notActed, async () => ++reads >= 3, 2000);
    expect(reads).toBeGreaterThan(1);
    expect(warnings).toEqual([]);
  });

  it("warns at the ceiling when an untriggerable daemon never syncs", async () => {
    const started = Date.now();
    await reportHostsSync(["a.test"], 1, false, onWarn, notActed, async () => false, 150);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(warnings).toHaveLength(1);
  });

  it("does not trigger at all when there is no hostname to report on", async () => {
    let triggered = false;
    await reportHostsSync([], 1, false, onWarn, async () => {
      triggered = true;
      return true;
    });
    expect(triggered).toBe(false);
    expect(warnings).toEqual([]);
  });
});

describe("syncHostsWithWarning", () => {
  // This latch bounds the daemon's own proxy.log on repeated route reloads. It
  // never bounds what users are told: delivery is per request, so each
  // registering CLI gets its own answer even while this is latched.
  it("warns once and stays quiet while the sync keeps failing", () => {
    let warns = 0;
    const fail = () => false;
    let latched = syncHostsWithWarning(["a.localhost"], false, () => warns++, fail);
    expect(warns).toBe(1);
    latched = syncHostsWithWarning(["a.localhost"], latched, () => warns++, fail);
    expect(warns).toBe(1);
    expect(latched).toBe(true);
  });

  it("re-arms after a success so a later failure warns again", () => {
    let warns = 0;
    const latched = syncHostsWithWarning(
      ["a.localhost"],
      true,
      () => warns++,
      () => true
    );
    expect(latched).toBe(false);
    syncHostsWithWarning(
      ["a.localhost"],
      latched,
      () => warns++,
      () => false
    );
    expect(warns).toBe(1);
  });

  // The startup warm-up runs with no routes. If its failure spent the latch, the
  // first real route's failure would find it already gone and log nothing.
  it("does not let an empty warm-up sync consume the latch", () => {
    let warns = 0;
    const latched = syncHostsWithWarning(
      [],
      false,
      () => warns++,
      () => false
    );
    expect(warns).toBe(0);
    expect(latched).toBe(false);
  });
});

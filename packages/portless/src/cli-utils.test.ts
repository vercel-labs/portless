import { describe, it, expect, afterEach, beforeEach } from "vitest";
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
  getProtocolPort,
  isHttpsEnvDisabled,
  injectFrameworkFlags,
  isProxyRunning,
  parsePidFromNetstat,
  readLanMarker,
  readPersistedProxyState,
  readTldFromDir,
  resolveStateDir,
  validateTld,
  writeLanMarker,
  writeTldFile,
  writeTlsMarker,
} from "./cli-utils.js";

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

describe("resolveStateDir", () => {
  it("returns user dir for all ports", () => {
    expect(resolveStateDir(80)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(443)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(1023)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(1024)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(8080)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(3000)).toBe(USER_STATE_DIR);
  });
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
      args: ["--no-tls", "--tld", "test"],
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
  });

  it("writes and reads a custom TLD", () => {
    writeTldFile(tmpDir, "test");
    expect(readTldFromDir(tmpDir)).toBe("test");
  });

  it("removes the file when writing the default TLD", () => {
    writeTldFile(tmpDir, "test");
    expect(fs.existsSync(path.join(tmpDir, "proxy.tld"))).toBe(true);

    writeTldFile(tmpDir, DEFAULT_TLD);
    expect(fs.existsSync(path.join(tmpDir, "proxy.tld"))).toBe(false);
    expect(readTldFromDir(tmpDir)).toBe(DEFAULT_TLD);
  });

  it("handles removing the default TLD file when it does not exist", () => {
    writeTldFile(tmpDir, DEFAULT_TLD);
    expect(readTldFromDir(tmpDir)).toBe(DEFAULT_TLD);
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
    expect(validateTld("my-tld")).toMatch(/must contain only/);
    expect(validateTld("my.tld")).toMatch(/must contain only/);
    expect(validateTld("MY_TLD")).toMatch(/must contain only/);
    expect(validateTld("tld!")).toMatch(/must contain only/);
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
      lanMode: true,
    });
  });
});

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_PROXY_PORT,
  DEFAULT_TLD,
  PRIVILEGED_PORT_THRESHOLD,
  RISKY_TLDS,
  SYSTEM_STATE_DIR,
  USER_STATE_DIR,
  findFreePort,
  getDefaultPort,
  getDefaultTld,
  injectFrameworkFlags,
  isProxyRunning,
  parsePidFromNetstat,
  readTldFromDir,
  resolveStateDir,
  validateTld,
  writeTldFile,
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
  it.skipIf(process.platform === "win32")("returns system dir for privileged ports", () => {
    expect(resolveStateDir(80)).toBe(SYSTEM_STATE_DIR);
    expect(resolveStateDir(443)).toBe(SYSTEM_STATE_DIR);
    expect(resolveStateDir(1023)).toBe(SYSTEM_STATE_DIR);
  });

  it("returns user dir for non-privileged ports", () => {
    expect(resolveStateDir(1024)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(8080)).toBe(USER_STATE_DIR);
    expect(resolveStateDir(3000)).toBe(USER_STATE_DIR);
  });
});

describe("constants", () => {
  it("DEFAULT_PROXY_PORT is 1355", () => {
    expect(DEFAULT_PROXY_PORT).toBe(1355);
  });

  it("PRIVILEGED_PORT_THRESHOLD is 1024", () => {
    expect(PRIVILEGED_PORT_THRESHOLD).toBe(1024);
  });

  it("SYSTEM_STATE_DIR is in tmpdir", () => {
    expect(SYSTEM_STATE_DIR).toBe(path.join(os.tmpdir(), "portless"));
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

  it("returns DEFAULT_PROXY_PORT when PORTLESS_PORT is not set", () => {
    delete process.env.PORTLESS_PORT;
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);
  });

  it("returns PORTLESS_PORT when set to a valid port", () => {
    process.env.PORTLESS_PORT = "8080";
    expect(getDefaultPort()).toBe(8080);
  });

  it("returns DEFAULT_PROXY_PORT when PORTLESS_PORT is invalid", () => {
    process.env.PORTLESS_PORT = "not-a-number";
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);
  });

  it("returns DEFAULT_PROXY_PORT when PORTLESS_PORT is out of range", () => {
    process.env.PORTLESS_PORT = "0";
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);

    process.env.PORTLESS_PORT = "70000";
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);
  });

  it("returns DEFAULT_PROXY_PORT when PORTLESS_PORT is empty", () => {
    process.env.PORTLESS_PORT = "";
    expect(getDefaultPort()).toBe(DEFAULT_PROXY_PORT);
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

  it("injects for expo without --strictPort", () => {
    const args = ["expo", "start"];
    injectFrameworkFlags(args, 4567);
    expect(args).toEqual(["expo", "start", "--port", "4567", "--host", "localhost"]);
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

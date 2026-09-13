import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const originalHosts = "127.0.0.1 localhost\n::1 localhost\n10.0.0.9 vpn.internal\n";
const staleHosts = originalHosts + "\n# portless-start\n127.0.0.1 old.localhost\n# portless-end\n";
let tempDir: string;
let hostsFile: string;
let preloadPath: string;

beforeAll(() => {
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(`Built CLI not found at ${CLI_PATH}. Run 'pnpm build' before running tests.`);
  }
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-cli-hosts-"));
  hostsFile = path.join(tempDir, "hosts");
  preloadPath = path.join(tempDir, "preload.cjs");
  fs.writeFileSync(hostsFile, staleHosts);
  fs.writeFileSync(path.join(tempDir, "routes.json"), "[]");
  // Run the real CLI, redirecting hosts I/O and intercepting elevation in its child process.
  fs.writeFileSync(
    preloadPath,
    `
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { syncBuiltinESMExports } = require("node:module");
const hostsPath = process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";
const fixtureDir = process.env.PORTLESS_STATE_DIR;
const fixtureHosts = path.join(fixtureDir, "hosts");
const readFileSync = fs.readFileSync;
const writeFileSync = fs.writeFileSync;
fs.readFileSync = (file, ...args) => {
  if (file !== hostsPath) return readFileSync(file, ...args);
  const code = process.env.PORTLESS_TEST_READ_ERROR;
  if (code) throw Object.assign(new Error("Cannot read hosts file"), { code });
  return readFileSync(fixtureHosts, ...args);
};
fs.writeFileSync = (file, ...args) => {
  if (file !== hostsPath) throw new Error("Unexpected CLI write: " + file);
  if (process.env.PORTLESS_TEST_READ_ONLY === "1") {
    throw Object.assign(new Error("Hosts file is read-only"), { code: "EACCES" });
  }
  return writeFileSync(fixtureHosts, ...args);
};
process.getuid = () => Number(process.env.PORTLESS_TEST_UID ?? "0");
childProcess.spawnSync = (command, args) => {
  if (command !== "sudo") throw new Error("Unexpected subprocess: " + command);
  writeFileSync(path.join(fixtureDir, "sudo.json"), JSON.stringify(args));
  return { status: 1 };
};
syncBuiltinESMExports();
`
  );
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function runHostsSync(env: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--require", preloadPath, CLI_PATH, "hosts", "sync"], {
    encoding: "utf-8",
    timeout: 10_000,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      PNPM_SCRIPT_SRC_DIR: "",
      npm_command: "",
      NO_COLOR: "1",
      PORTLESS: "1",
      PORTLESS_PORT: "1",
      PORTLESS_STATE_DIR: tempDir,
      PORTLESS_TEST_READ_ERROR: "",
      PORTLESS_TEST_READ_ONLY: "0",
      PORTLESS_TEST_UID: "0",
      ...env,
    },
  });
}

describe("hosts sync with no active routes", () => {
  it.each(["EIO", "EACCES"])("reports %s without changing stale entries", (code) => {
    const result = runHostsSync({ PORTLESS_TEST_READ_ERROR: code });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to update");
    expect(result.stdout).not.toContain("No active routes");
    expect(fs.readFileSync(hostsFile, "utf-8")).toBe(staleHosts);
  });

  it("reports a missing hosts file as failure without creating it", () => {
    fs.unlinkSync(hostsFile);

    const result = runHostsSync();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to update");
    expect(fs.existsSync(hostsFile)).toBe(false);
  });

  it("succeeds without rewriting a readable file that has no managed entries", () => {
    fs.writeFileSync(hostsFile, originalHosts);

    const result = runHostsSync({ PORTLESS_TEST_READ_ONLY: "1" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No active routes");
    expect(fs.readFileSync(hostsFile, "utf-8")).toBe(originalHosts);
  });

  it("removes stale managed entries while preserving system and custom entries", () => {
    const result = runHostsSync();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No active routes");
    expect(fs.readFileSync(hostsFile, "utf-8")).toBe(originalHosts);
  });

  it("reports failure when stale entries cannot be removed", () => {
    const result = runHostsSync({ PORTLESS_TEST_READ_ONLY: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to update");
    expect(fs.readFileSync(hostsFile, "utf-8")).toBe(staleHosts);
  });

  it.skipIf(process.platform === "win32")("retries with sudo and reports a failed retry", () => {
    const result = runHostsSync({ PORTLESS_TEST_READ_ERROR: "EACCES", PORTLESS_TEST_UID: "501" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Requesting sudo");
    expect(result.stderr).toContain("Failed to update");
    const sudoArgs: string[] = JSON.parse(
      fs.readFileSync(path.join(tempDir, "sudo.json"), "utf-8")
    );
    expect(sudoArgs.slice(-2)).toEqual(["hosts", "sync"]);
    expect(fs.readFileSync(hostsFile, "utf-8")).toBe(staleHosts);
  });
});

describe("hosts sync with active routes", () => {
  it("syncs route hostnames while preserving system and custom entries", () => {
    fs.writeFileSync(
      path.join(tempDir, "routes.json"),
      JSON.stringify([{ hostname: "app.localhost", port: 3000, pid: 0 }])
    );

    const result = runHostsSync();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Synced 1 hostname(s)");
    expect(result.stdout).toContain("app.localhost");
    expect(fs.readFileSync(hostsFile, "utf-8")).toBe(
      originalHosts + "\n# portless-start\n127.0.0.1 app.localhost\n# portless-end\n"
    );
  });
});

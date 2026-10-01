import { afterEach, describe, expect, it } from "vitest";
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../../packages/portless/dist/cli.js");
const FIXTURE_PATH = path.resolve(__dirname, "../fixtures/self-daemon/launcher.mjs");
const PROXY_PORT = 19121;

let stateDir: string | undefined;
let cliChild: ChildProcess | undefined;
let appPort: number | undefined;

function findPidsOnPort(port: number): number[] {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return output
      ? output
          .split("\n")
          .map((value) => Number(value))
          .filter((pid) => Number.isInteger(pid) && pid > 0)
      : [];
  } catch {
    return [];
  }
}

function killPort(port: number): void {
  for (const pid of findPidsOnPort(port)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may have exited between lookup and cleanup.
    }
  }
}

async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

async function requestThroughProxy(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `http://127.0.0.1:${PROXY_PORT}/`,
      { headers: { Host: hostname }, timeout: 1000 },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }
    );
    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("request timeout")));
    request.end();
  });
}

function readRoutes(): Array<{ hostname: string; port: number; pid: number }> {
  return JSON.parse(fs.readFileSync(path.join(stateDir!, "routes.json"), "utf8"));
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

afterEach(async () => {
  if (cliChild && cliChild.exitCode === null && cliChild.signalCode === null) {
    cliChild.kill("SIGTERM");
    await waitForExit(cliChild).catch(() => undefined);
  }
  if (appPort) {
    killPort(appPort);
    await waitFor(() => findPidsOnPort(appPort!).length === 0, 5000).catch(() => undefined);
  }
  if (stateDir) {
    spawnSync(process.execPath, [CLI_PATH, "proxy", "stop"], {
      env: {
        ...process.env,
        PORTLESS_PORT: String(PROXY_PORT),
        PORTLESS_STATE_DIR: stateDir,
        NO_COLOR: "1",
      },
      timeout: 10_000,
    });
    killPort(PROXY_PORT);
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  stateDir = undefined;
  cliChild = undefined;
  appPort = undefined;
});

describe("self-daemonizing command lifecycle", () => {
  it("keeps a serving route prune can clean after the launcher exits", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-self-daemon-"));
    const env = {
      ...process.env,
      PORTLESS_PORT: String(PROXY_PORT),
      PORTLESS_HTTPS: "0",
      PORTLESS_STATE_DIR: stateDir,
      NO_COLOR: "1",
    };

    const proxy = spawnSync(
      process.execPath,
      [CLI_PATH, "proxy", "start", "--no-tls", "-p", String(PROXY_PORT)],
      { env, encoding: "utf8", timeout: 15_000 }
    );
    expect(proxy.status).toBe(0);

    cliChild = spawn(process.execPath, [CLI_PATH, "self-daemon", process.execPath, FIXTURE_PATH], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitCode = await waitForExit(cliChild);
    expect(exitCode).toBe(0);

    const route = readRoutes().find((entry) => entry.hostname === "self-daemon.localhost");
    expect(route).toBeDefined();
    appPort = route!.port;

    await waitFor(async () => (await requestThroughProxy(route!.hostname)) === 200);

    const prune = spawnSync(process.execPath, [CLI_PATH, "prune"], {
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(prune.status).toBe(0);
    await waitFor(() => findPidsOnPort(appPort!).length === 0);
    expect(readRoutes()).toHaveLength(0);
  });
});

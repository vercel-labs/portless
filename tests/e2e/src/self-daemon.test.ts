import { afterEach, describe, expect, it } from "vitest";
import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../../packages/portless/dist/cli.js");
const FIXTURE_PATH = path.resolve(__dirname, "../fixtures/self-daemon/launcher.sh");
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

function startProxy(): NodeJS.ProcessEnv {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-self-daemon-"));
  const env = {
    ...process.env,
    PORTLESS_PORT: String(PROXY_PORT),
    PORTLESS_HTTPS: "0",
    PORTLESS_STATE_DIR: stateDir,
    PORTLESS_SYNC_HOSTS: "0",
    NO_COLOR: "1",
  };
  const proxy = spawnSync(
    process.execPath,
    [CLI_PATH, "proxy", "start", "--no-tls", "-p", String(PROXY_PORT)],
    { env, encoding: "utf8", timeout: 15_000 }
  );
  expect(proxy.status, proxy.stderr + proxy.stdout).toBe(0);
  return env;
}

describe.skipIf(process.platform === "win32")("self-daemonizing command lifecycle", () => {
  it("keeps serving the route after the launcher exits, until the server stops", async () => {
    const env = startProxy();

    cliChild = spawn(process.execPath, [CLI_PATH, "self-daemon", FIXTURE_PATH], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(await waitForExit(cliChild)).toBe(0);

    const route = readRoutes().find((entry) => entry.hostname === "self-daemon.localhost");
    expect(route).toBeDefined();
    appPort = route!.port;
    expect(findPidsOnPort(appPort)).toEqual([route!.pid]);
    expect(await requestThroughProxy(route!.hostname)).toBe(200);

    process.kill(route!.pid, "SIGTERM");
    await waitFor(() => findPidsOnPort(appPort!).length === 0);
    const list = spawnSync(process.execPath, [CLI_PATH, "list"], { env, encoding: "utf8" });
    expect(list.stdout).not.toContain("self-daemon.localhost");
  });

  it("removes the route when a foreground command exits", async () => {
    const env = startProxy();

    cliChild = spawn(process.execPath, [CLI_PATH, "foreground", "true"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(await waitForExit(cliChild)).toBe(0);
    expect(readRoutes()).toHaveLength(0);
  });

  it("does not hand the route to a server that held the port before the command ran", async () => {
    const env = startProxy();
    const foreign = http.createServer((_, response) => response.end("foreign"));
    await new Promise<void>((resolve) => foreign.listen(0, "127.0.0.1", resolve));
    const foreignPort = (foreign.address() as { port: number }).port;
    try {
      cliChild = spawn(
        process.execPath,
        [CLI_PATH, "occupied", "--app-port", String(foreignPort), "sh", "-c", "exit 1"],
        { env, stdio: ["ignore", "pipe", "pipe"] }
      );
      expect(await waitForExit(cliChild)).toBe(1);
      expect(readRoutes()).toHaveLength(0);
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { spawn, spawnSync, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../../packages/portless/dist/cli.js");
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/minimal-server");
const PROXY_PORT = 19013;

const isWindows = process.platform === "win32";

function killPort(port: number): void {
  try {
    if (isWindows) {
      const output = execSync("netstat -ano -p tcp", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const myPid = process.pid;
      for (const line of output.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const localAddr = parts[1];
        const lastColon = localAddr.lastIndexOf(":");
        if (lastColon === -1) continue;
        const addrPort = parseInt(localAddr.substring(lastColon + 1), 10);
        if (addrPort !== port) continue;
        const pid = parseInt(parts[parts.length - 1], 10);
        if (isNaN(pid) || pid <= 0 || pid === myPid) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already dead
        }
      }
    } else {
      const pids = execSync(`lsof -ti tcp:${port}`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      if (pids) {
        const myPid = process.pid;
        for (const raw of pids.split("\n")) {
          const pid = parseInt(raw, 10);
          if (isNaN(pid) || pid === myPid) continue;
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already dead
          }
        }
      }
    }
  } catch {
    // no process on port
  }
}

function findPidsOnPort(port: number): number[] {
  try {
    if (isWindows) {
      const output = execSync("netstat -ano -p tcp", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const pids: number[] = [];
      for (const line of output.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const localAddr = parts[1];
        const lastColon = localAddr.lastIndexOf(":");
        if (lastColon === -1) continue;
        const addrPort = parseInt(localAddr.substring(lastColon + 1), 10);
        if (addrPort !== port) continue;
        const pid = parseInt(parts[parts.length - 1], 10);
        if (!isNaN(pid) && pid > 0) pids.push(pid);
      }
      return pids;
    }
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (!output) return [];
    return output
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n) && n > 0);
  } catch {
    return [];
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface TestState {
  stateDir?: string;
  cliChild?: ChildProcess;
  appPort?: number;
}

async function cleanupTestState(state: TestState): Promise<void> {
  if (state.cliChild && !state.cliChild.killed) {
    state.cliChild.kill("SIGTERM");
    await sleep(1000);
    if (!state.cliChild.killed) state.cliChild.kill("SIGKILL");
  }
  if (state.appPort) killPort(state.appPort);

  if (state.stateDir) {
    spawnSync(process.execPath, [CLI_PATH, "proxy", "stop"], {
      env: {
        ...process.env,
        PORTLESS_PORT: PROXY_PORT.toString(),
        PORTLESS_STATE_DIR: state.stateDir,
        NO_COLOR: "1",
      },
      timeout: 10_000,
    });
  }

  killPort(PROXY_PORT);

  if (state.stateDir) {
    try {
      fs.rmSync(state.stateDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

async function startCliApp(
  appName: string,
  state: TestState,
  script = "server.js"
): Promise<{ hostname: string; appPort: number }> {
  state.stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-e2e-zombie-"));

  const baseEnv = {
    ...process.env,
    PORTLESS_PORT: PROXY_PORT.toString(),
    PORTLESS_HTTPS: "0",
    PORTLESS_STATE_DIR: state.stateDir,
    NO_COLOR: "1",
  };

  spawnSync(
    process.execPath,
    [CLI_PATH, "proxy", "start", "--no-tls", "-p", PROXY_PORT.toString()],
    { env: baseEnv, timeout: 15_000 }
  );

  state.cliChild = spawn(process.execPath, [CLI_PATH, appName, "node", script], {
    cwd: FIXTURE_DIR,
    env: { ...baseEnv, APP_NAME: appName },
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.cliChild.stdout!.on("data", () => {});
  state.cliChild.stderr!.on("data", () => {});

  const hostname = `${appName}.localhost`;
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          `http://127.0.0.1:${PROXY_PORT}/`,
          { headers: { Host: hostname } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          }
        );
        req.on("error", reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error("timeout"));
        });
        req.end();
      });
      if (status >= 200 && status < 400) {
        ready = true;
        break;
      }
    } catch {
      // not ready
    }
    await sleep(500);
  }
  expect(ready).toBe(true);

  const routesPath = path.join(state.stateDir, "routes.json");
  const routes: Array<{ hostname: string; port: number; pid: number }> = JSON.parse(
    fs.readFileSync(routesPath, "utf-8")
  );
  const route = routes.find((r) => r.hostname === hostname);
  expect(route).toBeDefined();
  state.appPort = route!.port;

  const devPids = findPidsOnPort(state.appPort);
  expect(devPids.length).toBeGreaterThan(0);

  return { hostname, appPort: state.appPort };
}

describe("zombie process prevention", () => {
  const state: TestState = {};

  afterEach(async () => {
    await cleanupTestState(state);
    state.stateDir = undefined;
    state.cliChild = undefined;
    state.appPort = undefined;
  });

  it("SIGTERM kills the dev server via process group", async () => {
    if (isWindows) return;

    // Use wrapper.js so the tree is: CLI -> /bin/sh -> node wrapper.js -> node server.js
    // Without wrapper.js, /bin/sh execs node directly and there's no grandchild to orphan.
    const { appPort } = await startCliApp("zombie-sigterm", state, "wrapper.js");

    // SIGTERM the portless CLI. The fix (detached + killTree) should kill the
    // entire process group, including the grandchild dev server.
    state.cliChild!.kill("SIGTERM");
    await sleep(2000);

    // The dev server must be dead. Without the process group fix, the
    // grandchild survives because child.kill() only kills /bin/sh.
    const survivors = findPidsOnPort(appPort);
    expect(survivors).toEqual([]);
  });

  it("SIGKILL leaves orphan, portless prune cleans it up", async () => {
    if (isWindows) return;

    const { appPort } = await startCliApp("zombie-sigkill", state);

    // SIGKILL is uncatchable so the signal handler never runs.
    // The dev server will survive.
    state.cliChild!.kill("SIGKILL");
    await sleep(2000);

    // Dev server should still be alive (SIGKILL cannot be intercepted)
    const survivors = findPidsOnPort(appPort);
    expect(survivors.length).toBeGreaterThan(0);

    // portless prune is the safety net for this scenario
    const pruneResult = spawnSync(process.execPath, [CLI_PATH, "prune"], {
      env: {
        ...process.env,
        PORTLESS_PORT: PROXY_PORT.toString(),
        PORTLESS_HTTPS: "0",
        PORTLESS_STATE_DIR: state.stateDir,
        NO_COLOR: "1",
      },
      encoding: "utf-8",
      timeout: 10_000,
    });
    expect(pruneResult.status).toBe(0);
    expect(pruneResult.stdout).toContain("killed");

    await sleep(1000);
    const pidsAfterPrune = findPidsOnPort(appPort);
    expect(pidsAfterPrune).toEqual([]);
  });
});

describe("portless prune", () => {
  let stateDir: string | undefined;
  let orphanServer: ChildProcess | undefined;
  const ORPHAN_PORT = 17200;

  afterEach(async () => {
    if (orphanServer && !orphanServer.killed) {
      orphanServer.kill("SIGKILL");
    }
    killPort(ORPHAN_PORT);
    killPort(PROXY_PORT);
    if (stateDir) {
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
      stateDir = undefined;
    }
  });

  it("kills orphaned processes and removes stale routes", async () => {
    if (isWindows) return;

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-e2e-prune-"));
    fs.mkdirSync(stateDir, { recursive: true });

    orphanServer = spawn(
      "node",
      [
        "-e",
        `
      const http = require("http");
      const s = http.createServer((_, res) => res.end("orphan"));
      s.listen(${ORPHAN_PORT}, "127.0.0.1", () => {
        console.log("listening");
      });
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("orphan server did not start")), 5000);
      orphanServer!.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    // Fake stale route: dead PID owns the orphan's port
    const deadPid = 2147483647;
    const routesPath = path.join(stateDir, "routes.json");
    fs.writeFileSync(
      routesPath,
      JSON.stringify([{ hostname: "orphan-test.localhost", port: ORPHAN_PORT, pid: deadPid }])
    );

    expect(findPidsOnPort(ORPHAN_PORT).length).toBeGreaterThan(0);

    const result = spawnSync(process.execPath, [CLI_PATH, "prune"], {
      env: {
        ...process.env,
        PORTLESS_STATE_DIR: stateDir,
        NO_COLOR: "1",
      },
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("orphan-test.localhost");
    expect(result.stdout).toContain("killed");
    expect(result.stdout).toContain("Pruned 1 stale route");

    await sleep(1000);
    expect(findPidsOnPort(ORPHAN_PORT)).toEqual([]);

    const routesAfter = JSON.parse(fs.readFileSync(routesPath, "utf-8"));
    expect(routesAfter).toEqual([]);
  });

  it("reports nothing when no orphans exist", async () => {
    if (isWindows) return;

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-e2e-prune-clean-"));

    const result = spawnSync(process.execPath, [CLI_PATH, "prune"], {
      env: {
        ...process.env,
        PORTLESS_STATE_DIR: stateDir,
        NO_COLOR: "1",
      },
      encoding: "utf-8",
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No orphaned routes found");
  });
});

import { execSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../../packages/portless/dist/cli.js");
const E2E_NODE_MODULES = path.resolve(__dirname, "../node_modules");
const VENV_DIR = path.resolve(__dirname, "../.venv");

// Each e2e test uses a unique proxy port to allow sequential runs without
// collisions. Current allocation: 19001-19011. Pick the next unused port
// when adding a new test.

/** Path to the Python binary inside the e2e venv. */
export const PYTHON_BIN = path.join(VENV_DIR, "bin", "python3");

/** Kill any process listening on the given TCP port (skips our own PID). */
function killPort(port: number): void {
  try {
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
  } catch {
    // no process on port
  }
}

export interface E2EContext {
  proxyPort: number;
  proxyUrl: string;
  stateDir: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  cleanup: () => Promise<void>;
}

export interface StartAppOptions {
  name: string;
  command: string[];
  cwd: string;
  proxyPort: number;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Resolve the absolute path to a fixture directory. */
export function fixtureDir(name: string): string {
  return path.resolve(__dirname, "../fixtures", name);
}

/**
 * Resolve the binary path for a framework command inside the e2e
 * node_modules. Falls back to the command as-is if not found.
 */
function resolveBin(command: string, cwd: string): string {
  const local = path.join(cwd, "node_modules", ".bin", command);
  if (fs.existsSync(local)) return local;

  const e2eBin = path.resolve(__dirname, "../node_modules/.bin", command);
  if (fs.existsSync(e2eBin)) return e2eBin;

  return command;
}

function makeRequest(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

/** Poll until the proxy returns HTTP 200 for the given hostname. */
async function waitForApp(proxyPort: number, hostname: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const url = `http://127.0.0.1:${proxyPort}/`;
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await makeRequest(url, hostname);
      if (status >= 200 && status < 400) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`App ${hostname} did not become ready within ${timeoutMs}ms`);
}

/**
 * Start a portless-managed app and wait for it to be reachable
 * through the proxy. Returns a context with a cleanup function.
 */
export async function startApp(opts: StartAppOptions): Promise<E2EContext> {
  const { name, command, cwd, proxyPort, timeoutMs = 60_000, env: extraEnv } = opts;

  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(
      `Built CLI not found at ${CLI_PATH}. Run 'pnpm build' in packages/portless first.`
    );
  }

  // Ensure no stale proxy/app is occupying the port from a previous test run
  killPort(proxyPort);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-e2e-"));

  const resolvedCmd = [resolveBin(command[0], cwd), ...command.slice(1)];

  const child = spawn(process.execPath, [CLI_PATH, name, ...resolvedCmd], {
    cwd,
    env: {
      ...process.env,
      PORTLESS_PORT: proxyPort.toString(),
      PORTLESS_STATE_DIR: stateDir,
      NODE_PATH: E2E_NODE_MODULES,
      NO_COLOR: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const hostname = name.includes(".") ? name : `${name}.localhost`;

  const cleanup = async () => {
    if (!child.killed) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    // Stop the proxy that was auto-started
    spawnSync(process.execPath, [CLI_PATH, "proxy", "stop"], {
      env: {
        ...process.env,
        PORTLESS_PORT: proxyPort.toString(),
        PORTLESS_STATE_DIR: stateDir,
        NO_COLOR: "1",
      },
      timeout: 10_000,
    });

    // The proxy daemon is detached, so it may survive the child being killed.
    // Force-kill anything still on the port.
    killPort(proxyPort);

    try {
      fs.rmSync(stateDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };

  try {
    await waitForApp(proxyPort, hostname, timeoutMs);
  } catch (err) {
    await cleanup();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  }

  return {
    proxyPort,
    proxyUrl: `http://${hostname}:${proxyPort}`,
    stateDir,
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    cleanup,
  };
}

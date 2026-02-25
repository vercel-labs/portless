import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync, spawn } from "node:child_process";
import { PORTLESS_HEADER } from "./proxy.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default proxy port. Uses an unprivileged port so sudo is not required. */
export const DEFAULT_PROXY_PORT = 1355;

/** Ports below this threshold require root/sudo to bind. */
export const PRIVILEGED_PORT_THRESHOLD = 1024;

/** System-wide state directory (used when proxy needs sudo). */
export const SYSTEM_STATE_DIR = "/tmp/portless";

/** Per-user state directory (used when proxy runs without sudo). */
export const USER_STATE_DIR = path.join(os.homedir(), ".portless");

/** Minimum app port when finding a free port. */
const MIN_APP_PORT = 4000;

/** Maximum app port when finding a free port. */
const MAX_APP_PORT = 4999;

/** Number of random port attempts before sequential scan. */
const RANDOM_PORT_ATTEMPTS = 50;

/** TCP connect timeout (ms) when checking if something is listening. */
const SOCKET_TIMEOUT_MS = 500;

/** Timeout (ms) for lsof when finding a PID on a port. */
const LSOF_TIMEOUT_MS = 5000;

/** Maximum poll attempts when waiting for the proxy to become ready. */
export const WAIT_FOR_PROXY_MAX_ATTEMPTS = 20;

/** Interval (ms) between proxy readiness polls. */
export const WAIT_FOR_PROXY_INTERVAL_MS = 250;

/** Signal name to signal number mapping for exit code calculation. */
export const SIGNAL_CODES: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGTERM: 15,
};

// ---------------------------------------------------------------------------
// Port configuration
// ---------------------------------------------------------------------------

/**
 * Return the effective default proxy port. Reads the PORTLESS_PORT env var
 * first, falling back to DEFAULT_PROXY_PORT (1355).
 */
export function getDefaultPort(): number {
  const envPort = process.env.PORTLESS_PORT;
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (!isNaN(port) && port >= 1 && port <= 65535) return port;
  }
  return DEFAULT_PROXY_PORT;
}

// ---------------------------------------------------------------------------
// State directory resolution
// ---------------------------------------------------------------------------

/**
 * Determine the state directory for a given proxy port.
 * Privileged ports (< 1024) use the system dir (/tmp/portless) so both
 * root and non-root processes can share state.  Unprivileged ports use
 * the user's home directory (~/.portless).
 */
export function resolveStateDir(port: number): string {
  if (process.env.PORTLESS_STATE_DIR) return process.env.PORTLESS_STATE_DIR;
  return port < PRIVILEGED_PORT_THRESHOLD ? SYSTEM_STATE_DIR : USER_STATE_DIR;
}

/** Read the proxy port from a given state directory. Returns null if unreadable. */
export function readPortFromDir(dir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "proxy.port"), "utf-8").trim();
    const port = parseInt(raw, 10);
    return isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

/** Name of the marker file that indicates the proxy is running with TLS. */
const TLS_MARKER_FILE = "proxy.tls";

/** Read the TLS marker from a state directory. */
export function readTlsMarker(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, TLS_MARKER_FILE));
  } catch {
    return false;
  }
}

/** Write or remove the TLS marker in the state directory. */
export function writeTlsMarker(dir: string, enabled: boolean): void {
  const markerPath = path.join(dir, TLS_MARKER_FILE);
  if (enabled) {
    fs.writeFileSync(markerPath, "1", { mode: 0o644 });
  } else {
    try {
      fs.unlinkSync(markerPath);
    } catch {
      // Marker may already be absent; non-fatal
    }
  }
}

/**
 * Return whether HTTPS mode is requested via the PORTLESS_HTTPS env var.
 */
export function isHttpsEnvEnabled(): boolean {
  const val = process.env.PORTLESS_HTTPS;
  return val === "1" || val === "true";
}

/**
 * Discover the active proxy's state directory, port, and TLS mode.
 * Checks the user-level dir first, then the system-level dir.
 * Falls back to the system dir with the default port if nothing is running.
 */
export async function discoverState(): Promise<{ dir: string; port: number; tls: boolean }> {
  // Env var override
  if (process.env.PORTLESS_STATE_DIR) {
    const dir = process.env.PORTLESS_STATE_DIR;
    const port = readPortFromDir(dir) ?? getDefaultPort();
    const tls = readTlsMarker(dir);
    return { dir, port, tls };
  }

  // Check user-level state first (~/.portless)
  const userPort = readPortFromDir(USER_STATE_DIR);
  if (userPort !== null) {
    const tls = readTlsMarker(USER_STATE_DIR);
    if (await isProxyRunning(userPort, tls)) {
      return { dir: USER_STATE_DIR, port: userPort, tls };
    }
  }

  // Check system-level state (/tmp/portless)
  const systemPort = readPortFromDir(SYSTEM_STATE_DIR);
  if (systemPort !== null) {
    const tls = readTlsMarker(SYSTEM_STATE_DIR);
    if (await isProxyRunning(systemPort, tls)) {
      return { dir: SYSTEM_STATE_DIR, port: systemPort, tls };
    }
  }

  // Nothing running; fall back based on default port
  const defaultPort = getDefaultPort();
  return { dir: resolveStateDir(defaultPort), port: defaultPort, tls: false };
}

// ---------------------------------------------------------------------------
// Port utilities
// ---------------------------------------------------------------------------

/**
 * Find a free port in the given range (default 4000-4999).
 * Tries random ports first for speed, then falls back to sequential scan.
 *
 * Note: There is an inherent TOCTOU race between verifying a port is free
 * and the child process actually binding to it. The random-first strategy
 * minimizes the window.
 */
export async function findFreePort(
  minPort = MIN_APP_PORT,
  maxPort = MAX_APP_PORT
): Promise<number> {
  if (minPort > maxPort) {
    throw new Error(`minPort (${minPort}) must be <= maxPort (${maxPort})`);
  }

  const tryPort = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(port, () => {
        server.close(() => resolve(true));
      });
      server.on("error", () => resolve(false));
    });
  };

  // Try random ports first
  for (let i = 0; i < RANDOM_PORT_ATTEMPTS; i++) {
    const port = minPort + Math.floor(Math.random() * (maxPort - minPort + 1));
    if (await tryPort(port)) {
      return port;
    }
  }

  // Fall back to sequential
  for (let port = minPort; port <= maxPort; port++) {
    if (await tryPort(port)) {
      return port;
    }
  }

  throw new Error(`No free port found in range ${minPort}-${maxPort}`);
}

/**
 * Check if a portless proxy is listening on the given port at 127.0.0.1.
 * Makes an HTTP(S) request and verifies the X-Portless response header to
 * distinguish the portless proxy from unrelated services.
 *
 * When `tls` is true, uses HTTPS with certificate verification disabled
 * (the proxy may use a self-signed or locally-trusted CA cert).
 */
export function isProxyRunning(port: number, tls = false): Promise<boolean> {
  return new Promise((resolve) => {
    const requestFn = tls ? https.request : http.request;
    const req = requestFn(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "HEAD",
        timeout: SOCKET_TIMEOUT_MS,
        ...(tls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        res.resume();
        resolve(res.headers[PORTLESS_HEADER.toLowerCase()] === "1");
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Process utilities
// ---------------------------------------------------------------------------

/**
 * Try to find the PID of a process listening on the given TCP port.
 * Uses lsof, which is available on macOS and most Linux distributions.
 * Returns null if the PID cannot be determined.
 */
export function findPidOnPort(port: number): number | null {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      timeout: LSOF_TIMEOUT_MS,
    });
    // lsof may return multiple PIDs (one per line); take the first
    const pid = parseInt(output.trim().split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Poll until the proxy is listening or the timeout is reached.
 * Returns true if the proxy became ready, false on timeout.
 */
export async function waitForProxy(
  port: number,
  maxAttempts = WAIT_FOR_PROXY_MAX_ATTEMPTS,
  intervalMs = WAIT_FOR_PROXY_INTERVAL_MS,
  tls = false
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (await isProxyRunning(port, tls)) {
      return true;
    }
  }
  return false;
}

/** Escape a string for safe inclusion in a single-quoted shell argument. */
function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Walk up from `cwd` to the filesystem root, collecting all
 * `node_modules/.bin` directories that exist. Returns them in
 * nearest-first order so the closest binaries take priority.
 */
function collectBinPaths(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = cwd;
  for (;;) {
    const bin = path.join(dir, "node_modules", ".bin");
    if (fs.existsSync(bin)) {
      dirs.push(bin);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Build a PATH string with `node_modules/.bin` directories prepended.
 */
function augmentedPath(env: NodeJS.ProcessEnv | undefined): string {
  const base = (env ?? process.env).PATH ?? "";
  const bins = collectBinPaths(process.cwd());
  return bins.length > 0 ? bins.join(path.delimiter) + path.delimiter + base : base;
}

/**
 * Spawn a command with proper signal forwarding, error handling, and exit
 * code propagation. Uses /bin/sh so that shell scripts and version manager
 * shims are resolved. Prepends node_modules/.bin to PATH so local project
 * binaries (e.g. next, vite) are found.
 */
export function spawnCommand(
  commandArgs: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    onCleanup?: () => void;
  }
): void {
  const env = { ...(options?.env ?? process.env), PATH: augmentedPath(options?.env) };
  const shellCmd = commandArgs.map(shellEscape).join(" ");
  const child = spawn("/bin/sh", ["-c", shellCmd], {
    stdio: "inherit",
    env,
  });

  let exiting = false;

  const cleanup = () => {
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    options?.onCleanup?.();
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    if (exiting) return;
    exiting = true;
    child.kill(signal);
    cleanup();
    process.exit(128 + (SIGNAL_CODES[signal] || 15));
  };

  const onSigInt = () => handleSignal("SIGINT");
  const onSigTerm = () => handleSignal("SIGTERM");

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  child.on("error", (err) => {
    if (exiting) return;
    exiting = true;
    console.error(`Failed to run command: ${err.message}`);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Is "${commandArgs[0]}" installed and in your PATH?`);
    }
    cleanup();
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (exiting) return;
    exiting = true;
    cleanup();
    if (signal) {
      process.exit(128 + (SIGNAL_CODES[signal] || 15));
    }
    process.exit(code ?? 1);
  });
}

// ---------------------------------------------------------------------------
// Framework-aware flag injection
// ---------------------------------------------------------------------------

/**
 * Frameworks that ignore the `PORT` env var. Maps command basename to the
 * flags needed. `strictPort` indicates whether `--strictPort` is supported
 * (prevents the framework from silently picking a different port).
 *
 * SvelteKit is not listed because its dev server is Vite under the hood,
 * so the `vite` entry already covers it.
 */
const FRAMEWORKS_NEEDING_PORT: Record<string, { strictPort: boolean }> = {
  vite: { strictPort: true },
  "react-router": { strictPort: true },
  astro: { strictPort: false },
  ng: { strictPort: false },
};

/**
 * Check if `commandArgs` invokes a framework that ignores `PORT` and, if so,
 * mutate the array in-place to append the correct CLI flags so the app
 * listens on the expected port and address.
 *
 * The portless proxy connects to 127.0.0.1 (IPv4), so we also inject
 * `--host 127.0.0.1` to prevent frameworks from binding to IPv6 `::1`.
 */
export function injectFrameworkFlags(commandArgs: string[], port: number): void {
  const cmd = commandArgs[0];
  if (!cmd) return;

  const basename = path.basename(cmd);
  const framework = FRAMEWORKS_NEEDING_PORT[basename];
  if (!framework) return;

  if (!commandArgs.includes("--port")) {
    commandArgs.push("--port", port.toString());
    if (framework.strictPort) {
      commandArgs.push("--strictPort");
    }
  }

  if (!commandArgs.includes("--host")) {
    commandArgs.push("--host", "127.0.0.1");
  }
}

/**
 * Prompt the user for input via readline. Returns empty string if stdin closes.
 */
export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.on("close", () => resolve(""));
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

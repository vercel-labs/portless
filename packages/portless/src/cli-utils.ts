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

/** True when running on Windows. */
export const isWindows = process.platform === "win32";

/** Unprivileged fallback port used when standard ports are unavailable. */
export const FALLBACK_PROXY_PORT = 1355;

/**
 * @deprecated Use FALLBACK_PROXY_PORT instead. Kept for backward compatibility
 * with tests and external consumers.
 */
export const DEFAULT_PROXY_PORT = FALLBACK_PROXY_PORT;

/** Ports below this threshold require root/sudo to bind (Unix only). */
export const PRIVILEGED_PORT_THRESHOLD = 1024;

/** Internal env var used to preserve an auto-detected LAN IP across daemonization. */
export const INTERNAL_LAN_IP_ENV = "PORTLESS_INTERNAL_LAN_IP";

/** Internal-only flag used to pass an auto-detected LAN IP through re-exec. */
export const INTERNAL_LAN_IP_FLAG = "--lan-ip-auto";

/**
 * @deprecated No longer used. All state now lives in USER_STATE_DIR.
 * Kept as a read-only reference for migration and cleanup of old installs.
 */
export const LEGACY_SYSTEM_STATE_DIR = isWindows
  ? path.join(os.tmpdir(), "portless")
  : "/tmp/portless";

/** Per-user state directory. All proxy state lives here regardless of port. */
export const USER_STATE_DIR = path.join(os.homedir(), ".portless");

/** Minimum app port when finding a free port. */
const MIN_APP_PORT = 4000;

/** Maximum app port when finding a free port. */
const MAX_APP_PORT = 4999;

/** Number of random port attempts before sequential scan. */
const RANDOM_PORT_ATTEMPTS = 50;

/**
 * Ports that browsers block for security reasons (WHATWG fetch spec "bad port"
 * list). Frameworks like Next.js also reject these. We skip them when
 * auto-selecting a port so the child process is never handed a port that the
 * browser will refuse to connect to.
 *
 * @see https://fetch.spec.whatwg.org/#port-blocking
 */
export const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

/** TCP connect timeout (ms) when checking if something is listening. */
const SOCKET_TIMEOUT_MS = 500;

/** Timeout (ms) for PID lookup when finding a process on a port. */
const PID_LOOKUP_TIMEOUT_MS = 5000;

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

/**
 * Kill a child process and its entire process tree. On Unix, when the child
 * was spawned with `detached: true`, it leads its own process group and
 * process.kill(-pid) reaches every descendant. Falls back to killing just
 * the child on Windows or when the group kill fails.
 */
export function killTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGTERM"
): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (!isWindows) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Process group may already be gone; fall through
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already dead
  }
}

// ---------------------------------------------------------------------------
// Port configuration
// ---------------------------------------------------------------------------

/**
 * Return the protocol-standard port for the given scheme.
 * HTTPS -> 443, HTTP -> 80.
 */
export function getProtocolPort(tls: boolean): number {
  return tls ? 443 : 80;
}

/**
 * Return the effective default proxy port. Reads the PORTLESS_PORT env var
 * first, then falls back to the protocol-standard port (443 for HTTPS,
 * 80 for HTTP). When `tls` is undefined the legacy fallback (1355) is used
 * so callers that don't yet know the protocol get backward-compatible behavior.
 */
export function getDefaultPort(tls?: boolean): number {
  const envPort = process.env.PORTLESS_PORT;
  if (envPort) {
    const port = parseInt(envPort, 10);
    if (!isNaN(port) && port >= 1 && port <= 65535) return port;
  }
  return tls === undefined ? FALLBACK_PROXY_PORT : getProtocolPort(tls);
}

// ---------------------------------------------------------------------------
// State directory resolution
// ---------------------------------------------------------------------------

/**
 * Determine the state directory for a given proxy port.
 * Always returns USER_STATE_DIR (~/.portless) unless PORTLESS_STATE_DIR is set.
 */
export function resolveStateDir(_port?: number): string {
  if (process.env.PORTLESS_STATE_DIR) return process.env.PORTLESS_STATE_DIR;
  return USER_STATE_DIR;
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
 * Name of the marker file that remembers LAN mode across proxy restarts.
 * While the proxy is running, the file stores the last known LAN IP.
 */
const LAN_MARKER_FILE = "proxy.lan";

/** Read the LAN marker from a state directory. Returns the last known IP or null. */
export function readLanMarker(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, LAN_MARKER_FILE), "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/** Write or remove the LAN marker in the state directory. */
export function writeLanMarker(dir: string, ip: string | null): void {
  const markerPath = path.join(dir, LAN_MARKER_FILE);
  if (!ip) {
    try {
      fs.unlinkSync(markerPath);
    } catch {
      // Marker may already be absent; non-fatal
    }
  } else {
    fs.writeFileSync(markerPath, ip, { mode: 0o644 });
  }
}

/** Default TLD when PORTLESS_TLD is not set. */
export const DEFAULT_TLD = "localhost";

/** TLDs that work but have known pitfalls worth warning about. */
export const RISKY_TLDS = new Map<string, string>([
  ["local", "conflicts with mDNS/Bonjour on macOS"],
  ["dev", "Google-owned; browsers force HTTPS via preloaded HSTS"],
  ["com", "public TLD; DNS requests will leak to the internet"],
  ["org", "public TLD; DNS requests will leak to the internet"],
  ["net", "public TLD; DNS requests will leak to the internet"],
  ["io", "public TLD; DNS requests will leak to the internet"],
  ["app", "public TLD; DNS requests will leak to the internet"],
  ["edu", "public TLD; DNS requests will leak to the internet"],
  ["gov", "public TLD; DNS requests will leak to the internet"],
  ["mil", "public TLD; DNS requests will leak to the internet"],
  ["int", "public TLD; DNS requests will leak to the internet"],
]);

/**
 * Validate a TLD string. Returns an error message if invalid, or null if OK.
 * Does not check for risky TLDs (those produce warnings, not errors).
 */
export function validateTld(tld: string): string | null {
  if (!tld) return "TLD cannot be empty";
  if (!/^[a-z0-9]+$/.test(tld)) {
    return `Invalid TLD "${tld}": must contain only lowercase letters and digits`;
  }
  return null;
}

/** Name of the file that stores the proxy's active TLD. */
const TLD_FILE = "proxy.tld";

/** Read the TLD from a state directory. Returns DEFAULT_TLD if absent. */
export function readTldFromDir(dir: string): string {
  try {
    const raw = fs.readFileSync(path.join(dir, TLD_FILE), "utf-8").trim();
    return raw || DEFAULT_TLD;
  } catch {
    return DEFAULT_TLD;
  }
}

/** Write or remove the TLD file in the state directory. */
export function writeTldFile(dir: string, tld: string): void {
  const filePath = path.join(dir, TLD_FILE);
  if (tld === DEFAULT_TLD) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // File may already be absent; non-fatal
    }
  } else {
    fs.writeFileSync(filePath, tld, { mode: 0o644 });
  }
}

/**
 * Return the effective TLD. Reads the PORTLESS_TLD env var first,
 * falling back to DEFAULT_TLD ("localhost"). Throws on invalid values.
 */
export function getDefaultTld(): string {
  const val = process.env.PORTLESS_TLD?.trim().toLowerCase();
  if (!val) return DEFAULT_TLD;
  const err = validateTld(val);
  if (err) throw new Error(`PORTLESS_TLD: ${err}`);
  return val;
}

/**
 * @deprecated Use isHttpsEnvDisabled instead. HTTPS is now enabled by default;
 * check whether it is disabled rather than enabled.
 */
export function isHttpsEnvEnabled(): boolean {
  const val = process.env.PORTLESS_HTTPS;
  return val === "1" || val === "true";
}

/**
 * Return whether HTTPS is explicitly disabled via the PORTLESS_HTTPS env var.
 * PORTLESS_HTTPS=0 is the env-var equivalent of --no-tls.
 */
export function isHttpsEnvDisabled(): boolean {
  const val = process.env.PORTLESS_HTTPS;
  return val === "0" || val === "false";
}

/**
 * Return whether wildcard subdomain fallback is requested via the
 * PORTLESS_WILDCARD env var.
 */
export function isWildcardEnvEnabled(): boolean {
  const val = process.env.PORTLESS_WILDCARD;
  return val === "1" || val === "true";
}

/**
 * Return whether LAN mode is requested via the PORTLESS_LAN env var.
 */
export function isLanEnvEnabled(): boolean {
  const val = process.env.PORTLESS_LAN;
  return val === "1" || val === "true";
}

/**
 * Read the last-known proxy configuration from the state directory on disk.
 * Unlike {@link discoverState}, this does not check whether the proxy is
 * actually running. It simply reads whatever state files exist so a
 * subsequent auto-start can reuse the previous settings.
 *
 * Returns null when no prior state is found.
 */
export function readPersistedProxyState(): {
  port: number;
  tls: boolean;
  tld: string;
  lanMode: boolean;
} | null {
  const dir = process.env.PORTLESS_STATE_DIR || USER_STATE_DIR;
  const port = readPortFromDir(dir);
  if (port !== null) {
    const tls = readTlsMarker(dir);
    const tld = readTldFromDir(dir);
    const lanIp = readLanMarker(dir);
    return { port, tls, tld, lanMode: lanIp !== null || tld === "local" };
  }

  return null;
}

export function buildProxyStartConfig(options: {
  useHttps: boolean;
  customCertPath?: string | null;
  customKeyPath?: string | null;
  lanMode: boolean;
  lanIp?: string | null;
  lanIpExplicit?: boolean;
  tld: string;
  useWildcard?: boolean;
  foreground?: boolean;
  includePort?: boolean;
  proxyPort?: number;
  skipTrust?: boolean;
}): { effectiveTld: string; args: string[] } {
  const effectiveTld = options.lanMode ? "local" : options.tld;
  const args: string[] = [];

  if (options.foreground) {
    args.push("--foreground");
  }

  if (options.includePort && options.proxyPort !== undefined) {
    args.push("--port", options.proxyPort.toString());
  }

  if (options.useHttps) {
    if (options.customCertPath && options.customKeyPath) {
      args.push("--cert", options.customCertPath, "--key", options.customKeyPath);
    } else {
      args.push("--https");
    }
  } else {
    args.push("--no-tls");
  }

  if (options.lanMode) {
    args.push("--lan");
    if (options.lanIp) {
      if (options.lanIpExplicit) {
        args.push("--ip", options.lanIp);
      } else {
        args.push(INTERNAL_LAN_IP_FLAG, options.lanIp);
      }
    }
  } else if (effectiveTld !== DEFAULT_TLD) {
    args.push("--tld", effectiveTld);
  }

  if (options.useWildcard) {
    args.push("--wildcard");
  }

  if (options.skipTrust) {
    args.push("--skip-trust");
  }

  return { effectiveTld, args };
}

/**
 * Discover the active proxy's state directory, port, TLS mode, TLD, LAN mode,
 * and current LAN IP when available.
 * Checks the user-level dir first, then the legacy /tmp/portless dir as a
 * read-only fallback for proxies started with older versions.
 */
export async function discoverState(): Promise<{
  dir: string;
  port: number;
  tls: boolean;
  tld: string;
  lanMode: boolean;
  lanIp: string | null;
}> {
  // Env var override
  if (process.env.PORTLESS_STATE_DIR) {
    const dir = process.env.PORTLESS_STATE_DIR;
    const port = readPortFromDir(dir) ?? getDefaultPort();
    const lanIp = readLanMarker(dir);
    if ((await isProxyRunning(port)) || (await isPortListening(port))) {
      const tls = readTlsMarker(dir);
      const tld = readTldFromDir(dir);
      return { dir, port, tls, tld, lanMode: lanIp !== null || tld === "local", lanIp };
    }

    return {
      dir,
      port,
      tls: readTlsMarker(dir),
      tld: readTldFromDir(dir),
      lanMode: lanIp !== null,
      lanIp: null,
    };
  }

  // Check user-level state first (~/.portless)
  const userPort = readPortFromDir(USER_STATE_DIR);
  if (userPort !== null) {
    // Always use plain HTTP for the liveness check. The TLS-enabled proxy
    // accepts plain HTTP via byte-peeking, so this works for both modes and
    // avoids TLS handshake timeouts that can cause false negatives.
    if (await isProxyRunning(userPort)) {
      const tls = readTlsMarker(USER_STATE_DIR);
      const tld = readTldFromDir(USER_STATE_DIR);
      const lanIp = readLanMarker(USER_STATE_DIR);
      return {
        dir: USER_STATE_DIR,
        port: userPort,
        tls,
        tld,
        lanMode: lanIp !== null || tld === "local",
        lanIp,
      };
    }
  }

  // Check legacy system-level state (/tmp/portless) for proxies started with
  // older versions. Read-only: no root operations are performed on this path.
  const legacyPort = readPortFromDir(LEGACY_SYSTEM_STATE_DIR);
  if (legacyPort !== null) {
    if (await isProxyRunning(legacyPort)) {
      const tls = readTlsMarker(LEGACY_SYSTEM_STATE_DIR);
      const tld = readTldFromDir(LEGACY_SYSTEM_STATE_DIR);
      const lanIp = readLanMarker(LEGACY_SYSTEM_STATE_DIR);
      return {
        dir: LEGACY_SYSTEM_STATE_DIR,
        port: legacyPort,
        tls,
        tld,
        lanMode: lanIp !== null || tld === "local",
        lanIp,
      };
    }
  }

  // State files didn't help. Probe well-known ports as a last resort.
  // Standard ports first (443, 80) since those are the new defaults, then the
  // legacy fallback port, then any PORTLESS_PORT override.
  const configuredPort = getDefaultPort();
  const probePorts = new Set([443, 80, FALLBACK_PROXY_PORT, configuredPort]);
  for (const port of probePorts) {
    if (await isProxyRunning(port)) {
      const dir = resolveStateDir(port);
      const markerTls = readTlsMarker(dir);
      // When the marker is missing, infer TLS from the port:
      // 443 is always HTTPS, 80 is always HTTP.
      const tls = markerTls || port === getProtocolPort(true);
      const tld = readTldFromDir(dir);
      const lanIp = readLanMarker(dir);
      return { dir, port, tls, tld, lanMode: lanIp !== null || tld === "local", lanIp };
    }
  }

  const dir = resolveStateDir(configuredPort);
  return {
    dir,
    port: configuredPort,
    tls: readTlsMarker(dir),
    tld: readTldFromDir(dir),
    lanMode: readLanMarker(dir) !== null,
    lanIp: null,
  };
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
    if (!BLOCKED_PORTS.has(port) && (await tryPort(port))) {
      return port;
    }
  }

  // Fall back to sequential
  for (let port = minPort; port <= maxPort; port++) {
    if (!BLOCKED_PORTS.has(port) && (await tryPort(port))) {
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

/** Check whether any process is listening on the given port at 127.0.0.1. */
export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

// ---------------------------------------------------------------------------
// Process utilities
// ---------------------------------------------------------------------------

/**
 * Parse the PID of a process listening on a given port from netstat output.
 * Exported for testing.
 */
export function parsePidFromNetstat(output: string, port: number): number | null {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("LISTENING")) continue;
    const parts = line.trim().split(/\s+/);
    // Format: TCP  0.0.0.0:PORT  0.0.0.0:0  LISTENING  PID
    if (parts.length < 5) continue;
    const localAddr = parts[1];
    const lastColon = localAddr.lastIndexOf(":");
    if (lastColon === -1) continue;
    const addrPort = parseInt(localAddr.substring(lastColon + 1), 10);
    if (addrPort === port) {
      const pid = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(pid) && pid > 0) return pid;
    }
  }
  return null;
}

/**
 * Find all PIDs listening on the given TCP port.
 * Uses lsof on macOS/Linux and netstat on Windows.
 */
export function findPidsOnPort(port: number): number[] {
  try {
    if (isWindows) {
      const output = execSync("netstat -ano -p tcp", {
        encoding: "utf-8",
        timeout: PID_LOOKUP_TIMEOUT_MS,
      });
      const pid = parsePidFromNetstat(output, port);
      return pid === null ? [] : [pid];
    }

    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      timeout: PID_LOOKUP_TIMEOUT_MS,
    });
    return output
      .trim()
      .split("\n")
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Try to find the PID of a process listening on the given TCP port.
 * Uses lsof on macOS/Linux and netstat on Windows.
 * Returns null if the PID cannot be determined.
 */
export function findPidOnPort(port: number): number | null {
  try {
    if (isWindows) {
      const output = execSync("netstat -ano -p tcp", {
        encoding: "utf-8",
        timeout: PID_LOOKUP_TIMEOUT_MS,
      });
      return parsePidFromNetstat(output, port);
    }

    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      timeout: PID_LOOKUP_TIMEOUT_MS,
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
export function augmentedPath(env: NodeJS.ProcessEnv | undefined, cwd?: string): string {
  const source = env ?? process.env;
  // On Windows, the PATH variable may be stored as "Path" (case-insensitive in
  // process.env but case-sensitive in plain objects created via spread).
  const base = source.PATH ?? source.Path ?? "";
  const bins = collectBinPaths(cwd ?? process.cwd());
  // Ensure node's own directory is in PATH so .cmd wrappers in node_modules/.bin
  // can locate the node executable (fixes Windows "node not recognized" errors).
  const nodeBin = path.dirname(process.execPath);
  const allBins = [...bins, nodeBin];
  return allBins.join(path.delimiter) + path.delimiter + base;
}

/**
 * Spawn a command with proper signal forwarding, error handling, and exit
 * code propagation. Uses /bin/sh (Unix) or cmd.exe (Windows) so that shell
 * scripts and version manager shims are resolved. Prepends node_modules/.bin
 * to PATH so local project binaries (e.g. next, vite) are found.
 */
export function spawnCommand(
  commandArgs: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    onCleanup?: () => void;
  }
): void {
  const env: Record<string, string | undefined> = {
    ...(options?.env ?? process.env),
    PATH: augmentedPath(options?.env),
  };

  // On Windows, process.env is a case-insensitive Proxy, but spreading it into
  // a plain object creates case-sensitive keys. The path variable may exist as
  // "Path" (Windows convention) alongside the "PATH" we just set above. cmd.exe
  // may read the wrong key, causing tools like bun to be missing from the child
  // process PATH. Delete any residual casing variants so only our "PATH" remains.
  if (isWindows) {
    for (const key of Object.keys(env)) {
      if (key !== "PATH" && key.toUpperCase() === "PATH") {
        delete env[key];
      }
    }
  }

  // On Unix, spawn detached so the child gets its own process group. This
  // lets us kill the entire tree (shell + grandchild dev server) with a
  // single process.kill(-pid, signal) instead of only the immediate child.
  const child = isWindows
    ? spawn("cmd.exe", ["/d", "/s", "/c", commandArgs.join(" ")], {
        stdio: "inherit",
        env,
      })
    : spawn("/bin/sh", ["-c", commandArgs.map(shellEscape).join(" ")], {
        stdio: "inherit",
        env,
        detached: true,
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
    killTree(child, signal);
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
  vp: { strictPort: true },
  "react-router": { strictPort: true },
  rsbuild: { strictPort: false },
  astro: { strictPort: false },
  ng: { strictPort: false },
  "react-native": { strictPort: false },
  expo: { strictPort: false },
};

/** Known package runners. Values list subcommands that run a package. */
const PACKAGE_RUNNERS: Record<string, string[]> = {
  npx: [],
  bunx: [],
  pnpx: [],
  yarn: ["dlx", "exec"],
  pnpm: ["dlx", "exec"],
};

/**
 * Find the basename of the framework command inside `commandArgs`, looking
 * past known package runners (npx, bunx, yarn dlx, …) and their flags.
 */
function findFrameworkBasename(commandArgs: string[]): string | null {
  if (commandArgs.length === 0) return null;

  const first = path.basename(commandArgs[0]);
  if (FRAMEWORKS_NEEDING_PORT[first]) return first;

  const subcommands = PACKAGE_RUNNERS[first];
  if (!subcommands) return null;

  let i = 1;

  if (subcommands.length > 0) {
    // Skip flags before the subcommand
    while (i < commandArgs.length && commandArgs[i].startsWith("-")) i++;
    if (i >= commandArgs.length) return null;
    if (!subcommands.includes(commandArgs[i])) {
      // Not a recognized subcommand — might be an implicit bin (e.g. `yarn vite`)
      const name = path.basename(commandArgs[i]);
      return FRAMEWORKS_NEEDING_PORT[name] ? name : null;
    }
    i++;
  }

  // Skip runner flags (e.g. `--bun`, `--yes`)
  while (i < commandArgs.length && commandArgs[i].startsWith("-")) i++;

  if (i >= commandArgs.length) return null;
  const name = path.basename(commandArgs[i]);
  return FRAMEWORKS_NEEDING_PORT[name] ? name : null;
}

/**
 * Check if `commandArgs` invokes a framework that ignores `PORT` and, if so,
 * mutate the array in-place to append the correct CLI flags so the app
 * listens on the expected port and address.
 *
 * Handles both direct invocation (`vite dev`) and invocation via package
 * runners (`bunx --bun vite dev`, `npx vite dev`, `yarn dlx vite dev`).
 *
 * The portless proxy connects to 127.0.0.1 (IPv4), so we also inject
 * `--host 127.0.0.1` to prevent frameworks from binding to IPv6 `::1`.
 *
 * Note: Expo's `--host` flag is *not* a bind address (it is a connection mode:
 * lan|tunnel|localhost). In LAN mode we skip `--host` entirely — Expo defaults
 * to LAN already and injecting the flag alongside HOST=127.0.0.1 causes Metro's
 * HMR WebSocket to degrade. Outside LAN mode, `--host localhost` keeps the
 * server local.
 */
export function injectFrameworkFlags(commandArgs: string[], port: number): void {
  const basename = findFrameworkBasename(commandArgs);
  if (!basename) return;

  const framework = FRAMEWORKS_NEEDING_PORT[basename];

  if (!commandArgs.includes("--port")) {
    commandArgs.push("--port", port.toString());
    if (framework.strictPort) {
      commandArgs.push("--strictPort");
    }
  }

  if (!commandArgs.includes("--host")) {
    // In LAN mode, let Expo use its default (LAN) — injecting --host alongside
    // HOST=127.0.0.1 causes Metro's HMR WebSocket to break after a few reloads.
    const isExpoLan = basename === "expo" && isLanEnvEnabled();
    if (isExpoLan) return;
    const hostValue = basename === "expo" ? "localhost" : "127.0.0.1";
    commandArgs.push("--host", hostValue);
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

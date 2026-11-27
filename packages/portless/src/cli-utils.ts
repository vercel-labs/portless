import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { execFileSync, execSync, spawn, type StdioOptions } from "node:child_process";
import { HOSTS_SYNC_PATH, PORTLESS_HEADER } from "./proxy.js";
import { DEFAULT_TLD, ProxyState, parseTldList } from "./proxy-state.js";
import {
  checkHostResolution,
  getManagedHostnames,
  syncHostsFile,
  type HostsResult,
} from "./hosts.js";
import { isYarnClassic, resolveScript, resolveScriptRaw } from "./config.js";
import {
  createLoopbackConnection,
  findStateDirProblem,
  parsePort,
  resolveUserHome,
} from "./utils.js";
import {
  HOSTS_SYNC_AUTH_CHALLENGE_HEADER,
  HOSTS_SYNC_AUTH_HEADER,
  HOSTS_SYNC_AUTH_PROOF_HEADER,
  createHostsSyncProof,
  generateHostsSyncChallenge,
  isValidHostsSyncToken,
  readHostsSyncToken,
} from "./hosts-sync-auth.js";

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

/** Listener address used when the proxy is only accessible from this machine. */
export const IPV4_LOOPBACK_PROXY_HOST = "127.0.0.1";

/** IPv6 listener address used when the proxy is only accessible from this machine. */
export const IPV6_LOOPBACK_PROXY_HOST = "::1";

/** IPv4 listener address used when LAN mode explicitly exposes the proxy. */
export const IPV4_LAN_PROXY_HOST = "0.0.0.0";

/** IPv6 listener address used when LAN mode explicitly exposes the proxy. */
export const IPV6_LAN_PROXY_HOST = "::";

export type ProxyBindTarget = {
  host: string;
  ipv6Only?: boolean;
};

/**
 * @deprecated No longer used. All state now lives in USER_STATE_DIR.
 * Kept as a read-only reference for migration and cleanup of old installs.
 */
export const LEGACY_SYSTEM_STATE_DIR = isWindows
  ? path.join(os.tmpdir(), "portless")
  : "/tmp/portless";

/** Per-user state directory. All proxy state lives here regardless of port. */
export const USER_STATE_DIR = path.join(resolveUserHome(), ".portless");

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

const COMMAND_SHUTDOWN_GRACE_MS = 5000;
const COMMAND_SHUTDOWN_FORCE_MS = 10_000;
const COMMAND_SHUTDOWN_POLL_MS = 50;

/** How long (ms) to wait for a signaled process group to exit before reporting it as surviving. */
const PROCESS_GROUP_EXIT_TIMEOUT_MS = 2000;

/** Interval (ms) between process group exit polls. */
const PROCESS_GROUP_POLL_MS = 100;

type TrackedProcess = {
  pid: number;
  pgid: number;
};

function trackProcessTree(rootPid: number, tracked: Map<number, TrackedProcess>): void {
  tracked.set(rootPid, { pid: rootPid, pgid: rootPid });
  if (isWindows) {
    return;
  }

  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], {
      encoding: "utf-8",
      timeout: PID_LOOKUP_TIMEOUT_MS,
    });
    const rows = output
      .trim()
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
        if (!match) return null;
        return {
          pid: parseInt(match[1], 10),
          ppid: parseInt(match[2], 10),
          pgid: parseInt(match[3], 10),
        };
      })
      .filter((row): row is { pid: number; ppid: number; pgid: number } => row !== null);

    const descendants = new Set([rootPid]);
    let foundDescendant = true;
    while (foundDescendant) {
      foundDescendant = false;
      for (const row of rows) {
        if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          foundDescendant = true;
        }
      }
    }

    for (const row of rows) {
      if (descendants.has(row.pid)) {
        tracked.set(row.pid, { pid: row.pid, pgid: row.pgid });
      }
    }
  } catch {
    // Fall back to the root process group that was already tracked.
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasRunningProcesses(tracked: Map<number, TrackedProcess>): boolean {
  return [...tracked.keys()].some(isProcessRunning);
}

function signalTrackedProcesses(
  tracked: Map<number, TrackedProcess>,
  signal: NodeJS.Signals
): void {
  if (isWindows) {
    for (const { pid } of tracked.values()) {
      killWindowsTree(pid);
    }
    return;
  }

  const groups = new Set([...tracked.values()].map(({ pgid }) => pgid));
  for (const pgid of groups) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // Already dead
    }
  }
}

/**
 * Return explicit IPv4 and IPv6 listener targets for the effective proxy mode.
 * LAN mode binds the unspecified addresses so other devices can reach the
 * proxy. Unprivileged mode binds them too, because macOS lets a non-root
 * process take a port below 1024 only on the wildcard address; the proxy
 * then refuses every peer that is not loopback itself.
 */
export function getProxyBindTargets(lanMode: boolean, unprivileged = false): ProxyBindTarget[] {
  return lanMode || unprivileged
    ? [{ host: IPV4_LAN_PROXY_HOST }, { host: IPV6_LAN_PROXY_HOST, ipv6Only: true }]
    : [{ host: IPV4_LOOPBACK_PROXY_HOST }, { host: IPV6_LOOPBACK_PROXY_HOST, ipv6Only: true }];
}

/**
 * Check whether this process may bind `port` on every target without root.
 * Resolves false only when a bind fails with EACCES (or EPERM), so callers can
 * elevate for that case alone. Any other outcome, such as EADDRINUSE, resolves
 * true and is left for the real listen to report.
 */
export async function canBindProxyPort(
  port: number,
  targets: readonly ProxyBindTarget[]
): Promise<boolean> {
  for (const target of targets) {
    const code = await new Promise<string | null>((resolve) => {
      const probe = net.createServer();
      probe.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "UNKNOWN"));
      probe.listen({ port, host: target.host, ipv6Only: target.ipv6Only, exclusive: true }, () =>
        probe.close(() => resolve(null))
      );
    });
    if (code === "EACCES" || code === "EPERM") return false;
  }
  return true;
}

/**
 * Whether this process can bind `port` without root on `platform`. macOS
 * allows any port on the wildcard address since Mojave. Linux moves the
 * boundary with `net.ipv4.ip_unprivileged_port_start`. Windows has none.
 */
export function canBindWithoutRoot(
  port: number,
  platform: NodeJS.Platform = process.platform,
  readUnprivilegedPortStart: () => string = () =>
    fs.readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf-8")
): { ok: true } | { ok: false; reason: string } {
  if (port >= PRIVILEGED_PORT_THRESHOLD || platform === "darwin" || platform === "win32") {
    return { ok: true };
  }
  if (platform !== "linux") {
    return {
      ok: false,
      reason: `Binding port ${port} without root is not supported on ${platform}.`,
    };
  }
  let start: number;
  try {
    start = parseInt(readUnprivilegedPortStart().trim(), 10);
  } catch {
    return { ok: false, reason: "Could not read net.ipv4.ip_unprivileged_port_start." };
  }
  if (!Number.isNaN(start) && port >= start) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Port ${port} is below net.ipv4.ip_unprivileged_port_start (${Number.isNaN(start) ? "unreadable" : start}).`,
  };
}

/**
 * Start a proxy listener on loopback unless LAN mode explicitly enables
 * access through the machine's network interfaces.
 */
export function listenOnProxyInterface(
  server: net.Server,
  port: number,
  target: ProxyBindTarget,
  listener?: () => void
): void {
  server.listen({ port, host: target.host, ipv6Only: target.ipv6Only }, listener);
}

/**
 * Kill a process and all of its descendants on Windows. Windows has no process
 * groups, and child.kill() only terminates the cmd.exe wrapper, which leaves
 * the dev server running and attached to the console.
 */
function killWindowsTree(pid: number): void {
  try {
    execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: PID_LOOKUP_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    // Already dead
  }
}

/**
 * Kill the command's descendants if this process dies without running its own
 * cleanup, such as when it is terminated with `taskkill /F`. Windows does not
 * end children with their parent, and the cmd.exe wrapper can exit alongside
 * us, so a detached watcher walks ParentProcessId links from the wrapper pid
 * (which survive the parent's exit) and checks creation times so a reused pid
 * is never killed.
 */
/**
 * Pids from `[pid, parentPid, createdAtMs]` rows that belong to the tree rooted
 * at `root`. A pid is only ours if its creation time fits the lineage: the root
 * was created before the watcher started, and every descendant after its
 * parent. A process holding the root pid that was created later is a reuse; it
 * and anything created after it are left alone. Runs inside the watcher script,
 * so it must stay self-contained.
 */
export function ownedProcessIds(
  rows: ReadonlyArray<readonly [number, number, number]>,
  root: number,
  watcherStartedAt: number
): number[] {
  const rootRow = rows.find(([pid]) => pid === root);
  const impostorAt = rootRow && rootRow[2] > watcherStartedAt ? rootRow[2] : Infinity;
  const created = new Map<number, number>();
  if (rootRow && impostorAt === Infinity) created.set(root, rootRow[2]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid, at] of rows) {
      if (created.has(pid) || pid === root) continue;
      const parentAt = created.get(ppid);
      const ok = ppid === root ? at < impostorAt : parentAt !== undefined && at >= parentAt;
      if (ok) {
        created.set(pid, at);
        grew = true;
      }
    }
  }
  return [...created.keys()];
}

function watchParentOnWindows(
  childPid: number,
  spawnedAt: number
): ReturnType<typeof spawn> | undefined {
  const script = `
    const { spawnSync } = require("child_process");
    const [parent, root, since] = process.argv.slice(1).map(Number);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const watcherStartedAt = Date.now();
    const ownedProcessIds = ${ownedProcessIds.toString()};
    const descendants = () => {
      const ps = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
      const out = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: ${PID_LOOKUP_TIMEOUT_MS} }).stdout || "";
      const rows = out.trim().split(/\\r?\\n/).map((l) => l.trim().split(" ").map(Number)).filter((r) => r.length === 3 && r[2] >= since);
      return ownedProcessIds(rows, root, watcherStartedAt);
    };
    const timer = setInterval(() => {
      if (alive(parent)) {
        if (!alive(root)) process.exit(0);
        return;
      }
      clearInterval(timer);
      for (const pid of descendants()) spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: ${PID_LOOKUP_TIMEOUT_MS} });
      process.exit(0);
    }, 500);
  `;
  try {
    // Run outside the user's cwd so the watcher never holds that directory open.
    const watcher = spawn(
      process.execPath,
      ["-e", script, String(process.pid), String(childPid), String(spawnedAt)],
      { cwd: path.dirname(process.execPath), detached: true, stdio: "ignore", windowsHide: true }
    );
    watcher.unref();
    return watcher;
  } catch {
    // Best effort; normal shutdown still kills the tree.
    return undefined;
  }
}

/**
 * On Windows, kill `child`'s tree if portless is force-killed before cleanup
 * runs. `spawnedAt` is taken just before spawning `child`. No-op elsewhere.
 * The watcher is only needed if we die without cleanup; it stops on a normal
 * exit.
 */
export function guardWindowsOrphans(child: ReturnType<typeof spawn>, spawnedAt: number): void {
  const watcher = isWindows && child.pid ? watchParentOnWindows(child.pid, spawnedAt) : undefined;
  if (watcher) process.once("exit", () => watcher.kill());
}

/**
 * Kill a child process and its entire process tree. On Unix, when the child
 * was spawned with `detached: true`, it leads its own process group and
 * process.kill(-pid) reaches every descendant. On Windows, taskkill /T walks
 * the tree. Falls back to killing just the child when neither is possible.
 */
export function killTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals = "SIGTERM"
): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (isWindows) {
    killWindowsTree(child.pid);
    return;
  }
  try {
    process.kill(-child.pid, signal);
    return;
  } catch {
    // Process group may already be gone; fall through
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
    const port = parsePort(envPort);
    if (port !== null) return port;
  }
  return tls === undefined ? FALLBACK_PROXY_PORT : getProtocolPort(tls);
}

// ---------------------------------------------------------------------------
// State directory resolution
// ---------------------------------------------------------------------------

/**
 * Determine the state directory.
 * Always returns USER_STATE_DIR (~/.portless) unless PORTLESS_STATE_DIR is set.
 */
export function resolveStateDir(): string {
  if (process.env.PORTLESS_STATE_DIR) return process.env.PORTLESS_STATE_DIR;
  return USER_STATE_DIR;
}

/** TLDs that work but have known pitfalls worth warning about. */
export const RISKY_TLDS = new Map<string, string>([
  ["local", "conflicts with mDNS/Bonjour on macOS"],
  ["dev", "Google-owned; browsers force HTTPS via preloaded HSTS"],
  ["app", "Google-owned; browsers force HTTPS via preloaded HSTS"],
  ["com", "public TLD; DNS requests will leak to the internet"],
  ["org", "public TLD; DNS requests will leak to the internet"],
  ["net", "public TLD; DNS requests will leak to the internet"],
  ["io", "public TLD; DNS requests will leak to the internet"],
  ["edu", "public TLD; DNS requests will leak to the internet"],
  ["gov", "public TLD; DNS requests will leak to the internet"],
  ["mil", "public TLD; DNS requests will leak to the internet"],
  ["int", "public TLD; DNS requests will leak to the internet"],
]);

/**
 * Risky TLDs whose failure mode applies to the whole suffix tree, so
 * multi-segment TLDs under them inherit the risk: mDNS claims all of
 * `*.local`, and the `.dev`/`.app` HSTS preload entries carry
 * includeSubDomains. Ownership-class entries (com, org, ...) only matter
 * for a bare TLD — a multi-segment TLD under a domain the user owns is
 * the recommended setup, not a pitfall.
 */
const SUFFIX_RISKY_TLDS = new Set(["local", "dev", "app"]);

/**
 * Look up the risky-TLD warning for a configured TLD. Matches exact entries
 * ("dev"), plus multi-segment TLDs whose suffix carries a tree-wide risk
 * ("example.dev" inherits the HSTS preload).
 */
export function getRiskyTldReason(tld: string): string | undefined {
  const exact = RISKY_TLDS.get(tld);
  if (exact) return exact;
  for (const risky of SUFFIX_RISKY_TLDS) {
    if (tld.endsWith(`.${risky}`)) return RISKY_TLDS.get(risky);
  }
  return undefined;
}

/**
 * Return the effective TLD list. Reads the PORTLESS_TLD env var first,
 * falling back to DEFAULT_TLD ("localhost"). Throws on invalid values.
 */
export function getDefaultTlds(): string[] {
  const val = process.env.PORTLESS_TLD?.trim().toLowerCase();
  if (!val) return [DEFAULT_TLD];
  const tlds = parseTldList(val, "PORTLESS_TLD");
  return tlds.length > 0 ? tlds : [DEFAULT_TLD];
}

/**
 * Return the primary effective TLD. Kept for callers that only need the
 * display or compatibility value.
 */
export function getDefaultTld(): string {
  return getDefaultTlds()[0] ?? DEFAULT_TLD;
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
 * Return whether unprivileged mode is requested via the PORTLESS_UNPRIVILEGED
 * env var: bind the wildcard address, accept loopback peers only, never sudo.
 */
export function isUnprivilegedEnvEnabled(): boolean {
  const val = process.env.PORTLESS_UNPRIVILEGED;
  return val === "1" || val === "true";
}

export function buildProxyStartConfig(options: {
  useHttps: boolean;
  customCertPath?: string | null;
  customKeyPath?: string | null;
  lanMode: boolean;
  lanIp?: string | null;
  lanIpExplicit?: boolean;
  tld: string;
  tlds?: readonly string[];
  useWildcard?: boolean;
  unprivileged?: boolean;
  foreground?: boolean;
  includePort?: boolean;
  proxyPort?: number;
  skipTrust?: boolean;
}): { effectiveTld: string; effectiveTlds: string[]; args: string[] } {
  const requestedTlds = options.tlds && options.tlds.length > 0 ? [...options.tlds] : [options.tld];
  const effectiveTlds = options.lanMode ? ["local"] : [...new Set(requestedTlds)];
  const effectiveTld = effectiveTlds[0] ?? DEFAULT_TLD;
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
  } else if (effectiveTlds.length > 1 || effectiveTld !== DEFAULT_TLD) {
    for (const tld of effectiveTlds) {
      args.push("--tld", tld);
    }
  }

  if (options.useWildcard) {
    args.push("--wildcard");
  }

  if (options.unprivileged) {
    args.push("--unprivileged");
  }

  if (options.skipTrust) {
    args.push("--skip-trust");
  }

  return { effectiveTld, effectiveTlds, args };
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
  tlds: string[];
  lanMode: boolean;
  lanIp: string | null;
}> {
  // Env var override
  if (process.env.PORTLESS_STATE_DIR) {
    const dir = process.env.PORTLESS_STATE_DIR;
    const state = new ProxyState(dir).read();
    const port = state.port ?? getDefaultPort();
    const running = (await isProxyRunning(port)) || (await isPortListening(port));
    return {
      dir,
      port,
      tls: state.tls,
      tld: state.tlds[0] ?? DEFAULT_TLD,
      tlds: state.tlds,
      lanMode: state.lanIp !== null,
      lanIp: running ? state.lanIp : null,
    };
  }

  // Check user-level state first (~/.portless)
  const userState = new ProxyState(USER_STATE_DIR);
  const userPort = userState.readPort();
  if (userPort !== null) {
    // Always use plain HTTP for the liveness check. The TLS-enabled proxy
    // accepts plain HTTP via byte-peeking, so this works for both modes and
    // avoids TLS handshake timeouts that can cause false negatives.
    if (await isProxyRunning(userPort)) {
      const settings = userState.read();
      return {
        dir: USER_STATE_DIR,
        port: userPort,
        tls: settings.tls,
        tld: settings.tlds[0] ?? DEFAULT_TLD,
        tlds: settings.tlds,
        lanMode: settings.lanIp !== null,
        lanIp: settings.lanIp,
      };
    }
  }

  // Check legacy system-level state (/tmp/portless) for proxies started with
  // older versions. Read-only: no root operations are performed on this path.
  const legacyState =
    findStateDirProblem(LEGACY_SYSTEM_STATE_DIR) === null
      ? new ProxyState(LEGACY_SYSTEM_STATE_DIR)
      : null;
  const legacyPort = legacyState?.readPort() ?? null;
  if (legacyState && legacyPort !== null) {
    if (await isProxyRunning(legacyPort)) {
      const settings = legacyState.read();
      return {
        dir: LEGACY_SYSTEM_STATE_DIR,
        port: legacyPort,
        tls: settings.tls,
        tld: settings.tlds[0] ?? DEFAULT_TLD,
        tlds: settings.tlds,
        lanMode: settings.lanIp !== null,
        lanIp: settings.lanIp,
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
      const dir = resolveStateDir();
      const state = new ProxyState(dir).read();
      // When the marker is missing, infer TLS from the port:
      // 443 is always HTTPS, 80 is always HTTP.
      return {
        dir,
        port,
        tls: state.tls || port === getProtocolPort(true),
        tld: state.tlds[0] ?? DEFAULT_TLD,
        tlds: state.tlds,
        lanMode: state.lanIp !== null,
        lanIp: state.lanIp,
      };
    }
  }

  const dir = resolveStateDir();
  const state = new ProxyState(dir).read();
  return {
    dir,
    port: configuredPort,
    tls: state.tls,
    tld: state.tlds[0] ?? DEFAULT_TLD,
    tlds: state.tlds,
    lanMode: state.lanIp !== null,
    lanIp: null,
  };
}

// ---------------------------------------------------------------------------
// Port utilities
// ---------------------------------------------------------------------------

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

/** Display name for the hosts file in user-facing text. */
export const HOSTS_DISPLAY = process.platform === "win32" ? "hosts file" : "/etc/hosts";

export function hostsUnresolvedMessage(hostnames: string[]): string {
  return `${hostnames.join(", ")} will not resolve. Run: portless hosts sync`;
}

const HOSTS_SYNC_TRIGGER_TIMEOUT_MS = 500;
const UNTRIGGERED_SYNC_CEILING_MS = 3500;

export type HostsSyncTrigger = "acted" | "absent" | "disabled" | "mute";

function probeHostsSyncAuth(
  port: number,
  tls: boolean,
  token: string | null,
  challenge: string,
  signal: AbortSignal
): Promise<"available" | "absent" | "mute"> {
  return new Promise((resolve) => {
    const requestFn = tls ? https.request : http.request;
    const req = requestFn(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "HEAD",
        headers: { [HOSTS_SYNC_AUTH_CHALLENGE_HEADER]: challenge },
        signal,
        ...(tls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const expectedProof = token ? createHostsSyncProof(token, challenge) : null;
        const suppliedProof = res.headers[HOSTS_SYNC_AUTH_PROOF_HEADER];
        const available =
          res.headers[PORTLESS_HEADER.toLowerCase()] === "1" &&
          typeof suppliedProof === "string" &&
          expectedProof !== null &&
          isValidHostsSyncToken(suppliedProof) &&
          crypto.timingSafeEqual(Buffer.from(suppliedProof), Buffer.from(expectedProof));
        res.resume();
        res.on("end", () => resolve(available ? "available" : "mute"));
        res.on("error", () => resolve("mute"));
      }
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" ? "absent" : "mute");
    });
    req.end();
  });
}

export async function triggerHostsSync(
  port: number,
  tls = false,
  stateDir = resolveStateDir()
): Promise<HostsSyncTrigger> {
  const signal = AbortSignal.timeout(HOSTS_SYNC_TRIGGER_TIMEOUT_MS);
  const token = readHostsSyncToken(stateDir);
  const challenge = generateHostsSyncChallenge();
  const capability = await probeHostsSyncAuth(port, tls, token, challenge, signal);
  if (capability !== "available") return capability;
  if (!token) return Promise.resolve("mute");
  return new Promise((resolve) => {
    const requestFn = tls ? https.request : http.request;
    const req = requestFn(
      {
        hostname: "127.0.0.1",
        port,
        path: HOSTS_SYNC_PATH,
        method: "POST",
        headers: { [HOSTS_SYNC_AUTH_HEADER]: token },
        signal,
        ...(tls ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const result =
          res.statusCode === 204 ? "acted" : res.statusCode === 409 ? "disabled" : "mute";
        res.resume();
        res.on("end", () => resolve(result));
        res.on("error", () => resolve("mute"));
      }
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" ? "absent" : "mute");
    });
    req.end();
  });
}

/**
 * Warn if a route hostname will not resolve. Issue #364.
 *
 * Reports resolution, not whether the file was written. `.localhost` resolves
 * without a hosts entry on current macOS and glibc (RFC 6761 says SHOULD), so a
 * skipped write there is invisible; a custom TLD resolves on neither.
 *
 * Waits by reading the hosts file, not by re-querying the resolver, because a
 * negative lookup can be cached and a name that is about to resolve would stay
 * negative.
 */
export async function reportHostsSync(
  hostnames: string[],
  port: number,
  tls: boolean,
  lanMode: boolean,
  onWarn: (message: string) => void,
  trigger: (port: number, tls: boolean) => Promise<HostsSyncTrigger> = triggerHostsSync,
  resolves: (hostname: string) => Promise<boolean> = checkHostResolution,
  ceilingMs = UNTRIGGERED_SYNC_CEILING_MS,
  readManaged: () => string[] = getManagedHostnames
): Promise<void> {
  const managed = lanMode
    ? hostnames.filter((hostname) => !hostname.endsWith(".local"))
    : hostnames;
  const found = await trigger(port, tls);

  const unresolved = async () => {
    const checked = await Promise.all(managed.map((hostname) => resolves(hostname)));
    return managed.filter((_, i) => !checked[i]);
  };

  if (found !== "mute") {
    const missing = await unresolved();
    if (missing.length > 0) onWarn(hostsUnresolvedMessage(missing));
    return;
  }

  const deadline = Date.now() + ceilingMs;
  while (Date.now() < deadline) {
    const written = new Set(readManaged());
    if (managed.every((hostname) => written.has(hostname))) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const missing = await unresolved();
  if (missing.length > 0) onWarn(hostsUnresolvedMessage(missing));
}

/**
 * Run a hosts-file sync and emit a one-time warning when it fails, so a daemon
 * that cannot write does not fill its log with the same line on every route
 * reload.
 *
 * This governs the daemon's own log only. Delivery to users is per request, so
 * this latch cannot silence anyone: several apps registering against the same
 * failing daemon are each told, which an earlier one-shot design got wrong.
 *
 * Returns the next "already warned" state, which the caller threads back in: a
 * failed sync latches it, a successful one re-arms it. An empty-route sync (the
 * warm-up at startup, or all routes removed) has nothing user-visible to write,
 * so its failure must not consume the latch, or the first real route's failure
 * finds it already spent.
 */
export function syncHostsWithWarning(
  hostnames: string[],
  alreadyWarned: boolean,
  onWarn: () => void,
  sync: (hostnames: string[]) => HostsResult = syncHostsFile
): boolean {
  if (sync(hostnames).action !== "failed") return false;
  if (hostnames.length === 0) return alreadyWarned;
  if (!alreadyWarned) onWarn();
  return true;
}

/** Check whether any process is listening on the given port on either loopback family. */
export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = createLoopbackConnection(port, (error, socket) => {
      clearTimeout(timer);
      socket?.destroy();
      resolve(error === null);
    });
    const timer = setTimeout(cancel, SOCKET_TIMEOUT_MS);
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
 * PIDs holding a listening TCP socket on `port`, read from /proc. Like lsof
 * without root, it sees only processes whose file descriptors are readable.
 */
function findPidsOnPortFromProc(port: number): number[] {
  const sockets = new Set<string>();
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    if (!fs.existsSync(table)) continue;
    for (const line of fs.readFileSync(table, "utf-8").split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === "0A" && parseInt(fields[1].split(":")[1], 16) === port) {
        sockets.add(`socket:[${fields[9]}]`);
      }
    }
  }
  if (sockets.size === 0) return [];
  return fs
    .readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .filter((pid) => {
      let fds: string[];
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`);
      } catch {
        return false;
      }
      return fds.some((fd) => {
        try {
          return sockets.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
        } catch {
          return false;
        }
      });
    })
    .map(Number);
}

/**
 * Find all PIDs listening on the given TCP port.
 * Reads /proc on Linux, uses lsof on macOS and netstat on Windows.
 */
export function findPidsOnPort(port: number): number[] {
  try {
    if (process.platform === "linux") return findPidsOnPortFromProc(port);
    if (isWindows) {
      const output = execSync("netstat -ano -p tcp", {
        encoding: "utf-8",
        timeout: PID_LOOKUP_TIMEOUT_MS,
        windowsHide: true,
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

function isProcessGroupAlive(groupId: number): boolean {
  if (isWindows || !Number.isInteger(groupId) || groupId <= 1) return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * PIDs of a process group that have not exited, or null where groups cannot be
 * listed. Unreaped zombies are left out: they keep the group number alive but
 * are not running.
 */
export function listProcessGroupMembers(groupId: number): number[] | null {
  if (isWindows || !Number.isInteger(groupId) || groupId <= 1) return null;
  try {
    const output = execFileSync("ps", ["-e", "-o", "pid=,pgid=,stat="], {
      encoding: "utf-8",
      timeout: PID_LOOKUP_TIMEOUT_MS,
    });
    const members: number[] = [];
    for (const line of output.split("\n")) {
      const [pid, group, stat] = line.trim().split(/\s+/);
      if (Number(group) !== groupId || Number(pid) <= 1) continue;
      if (stat?.startsWith("Z") === true) continue;
      members.push(Number(pid));
    }
    return members;
  } catch {
    return null;
  }
}

/** Whether a process group still has a running member. */
function groupHasLiveMember(groupId: number): boolean {
  const members = listProcessGroupMembers(groupId);
  return members === null ? isProcessGroupAlive(groupId) : members.length > 0;
}

/** Whether this exact process instance is still a member of the group. */
function isGroupMember(pid: number, startTime: string | undefined, groupId: number): boolean {
  return (
    startTime !== undefined &&
    pid > 1 &&
    getProcessGroupId(pid) === groupId &&
    getProcessStartTime(pid) === startTime
  );
}

/**
 * Find the listener a command left on `port` after its launcher exited, for
 * commands that self-daemonize (print an address and exit while the server
 * keeps running). The wait lasts up to `timeoutMs` while processes from the
 * launcher's process group are alive, or after a clean exit, since a detached
 * daemon leaves the group and may bind later. A failed foreground exit with an
 * empty group returns at once. Windows has no process group to watch.
 */
export async function findSelfDaemonizedListener(
  port: number,
  processGroupId: number | undefined,
  timeoutMs: number,
  exitedCleanly = false
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isPortListening(port)) {
      const pid = findPidOnPort(port);
      if (pid !== null) return pid;
    }
    const groupAlive =
      !isWindows && processGroupId !== undefined && isProcessGroupAlive(processGroupId);
    if (!groupAlive && !exitedCleanly) return null;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, COMMAND_SHUTDOWN_POLL_MS));
  }
}

/**
 * Read a process's start time. Paired with the PID it identifies one process
 * instance, so a recycled PID does not match. Linux reads the boot-relative
 * tick count from /proc, which wall-clock adjustments cannot shift; other
 * platforms use `ps` in a fixed locale and time zone. Returns null on Windows
 * or when the process does not exist.
 */
export function getProcessStartTime(pid: number): string | null {
  if (isWindows || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      // Fields after the parenthesized command name; starttime is field 22.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] || null;
    }
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: PID_LOOKUP_TIMEOUT_MS,
    });
    return output.trim().replace(/\s+/g, " ") || null;
  } catch {
    return null;
  }
}

/** Read the executable name of a process, without the Windows .exe suffix. Returns null if unreadable. */
export function getProcessCommand(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (isWindows) {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop).Name`,
        ],
        { encoding: "utf-8", windowsHide: true, timeout: PID_LOOKUP_TIMEOUT_MS }
      );
      return (
        output
          .trim()
          .replace(/\.exe$/i, "")
          .toLowerCase() || null
      );
    }
    const output = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: PID_LOOKUP_TIMEOUT_MS,
    });
    return path.basename(output.trim()) || null;
  } catch {
    return null;
  }
}

/**
 * Read the process group a live pid belongs to. Groups outlive their leader, so
 * a match here is evidence about a process, never proof it belongs to us.
 * Returns null on Windows or when the process is gone.
 */
export function getProcessGroupId(pid: number): number | null {
  if (isWindows || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const output = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: PID_LOOKUP_TIMEOUT_MS,
    });
    const pgid = Number(output.trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

/**
 * How a recorded process group ended after a stop attempt. A group is only
 * reported as stopped once it has no live member left, so a process that
 * closes its port but keeps running is never reported as killed.
 */
export type ProcessGroupState = "gone" | "stopped" | "survived" | "unverified";

export interface ProcessGroupStop {
  state: ProcessGroupState;
  /** Whether a signal reached the group. */
  signaled: boolean;
  /** A member that outlived the signal, recorded so a retry can verify it. */
  survivor?: { pid: number; startTime: string };
}

/** The member to record for a retry: a live listener of the recorded port first, then any live member. */
function pickGroupSurvivor(
  groupId: number,
  excluded: Set<number>,
  port: number | undefined
): { pid: number; startTime: string } | undefined {
  const members = listProcessGroupMembers(groupId) ?? [];
  const listeners =
    port === undefined ? [] : findPidsOnPort(port).filter((pid) => members.includes(pid));
  for (const pid of [...listeners, ...members]) {
    if (excluded.has(pid)) continue;
    const startTime = getProcessStartTime(pid);
    if (startTime) return { pid, startTime };
  }
  return undefined;
}

/**
 * Try to stop a recorded process group. Every identity recorded for the group is
 * tried, so one stale record cannot hide a valid one, and the group is signaled
 * only while the recorded leader or a recorded member still matches, so a
 * recycled group number is never signaled. The wait ends on real member exit,
 * not on the port closing, and a survivor is a member still running after the
 * signal, so a retry anchor is never a process that already exited.
 */
export async function stopProcessGroup(
  groupId: number,
  leaderStartTimes: (string | undefined)[],
  recordedMembers: { pid: number; startTime: string | undefined }[],
  signal: NodeJS.Signals = "SIGTERM",
  options: { port?: number; timeoutMs?: number } = {}
): Promise<ProcessGroupStop> {
  if (!groupHasLiveMember(groupId)) return { state: "gone", signaled: false };
  const proven =
    leaderStartTimes.some((startTime) => isGroupMember(groupId, startTime, groupId)) ||
    recordedMembers.some((member) => isGroupMember(member.pid, member.startTime, groupId));
  if (!proven) return { state: "unverified", signaled: false };
  let signaled = false;
  try {
    process.kill(-groupId, signal);
    signaled = true;
  } catch {
    signaled = false;
  }
  const deadline = Date.now() + (options.timeoutMs ?? PROCESS_GROUP_EXIT_TIMEOUT_MS);
  while (groupHasLiveMember(groupId)) {
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
      continue;
    }
    const excluded = new Set([groupId, ...recordedMembers.map((member) => member.pid)]);
    return {
      state: "survived",
      signaled,
      survivor: pickGroupSurvivor(groupId, excluded, options.port),
    };
  }
  return { state: "stopped", signaled };
}

/**
 * Try to find the PID of a process listening on the given TCP port.
 * Reads /proc on Linux, uses lsof on macOS and netstat on Windows.
 * Returns null if the PID cannot be determined.
 */
export function findPidOnPort(port: number): number | null {
  return findPidsOnPort(port)[0] ?? null;
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
 * Build a PATH string with `node_modules/.bin` directories prepended and the
 * running node's directory appended as a fallback.
 */
export function augmentedPath(env: NodeJS.ProcessEnv | undefined, cwd?: string): string {
  const source = env ?? process.env;
  // On Windows, the PATH variable may be stored as "Path" (case-insensitive in
  // process.env but case-sensitive in plain objects created via spread).
  const base = source.PATH ?? source.Path ?? "";
  const bins = collectBinPaths(cwd ?? process.cwd());
  // node's own directory goes last, as a fallback for .cmd wrappers in
  // node_modules/.bin on Windows ("node not recognized"). Ahead of the caller's
  // PATH it would shadow the node a version manager (asdf, nvm, fnm, mise) chose.
  const nodeBin = path.dirname(process.execPath);
  return [...bins, base, nodeBin].filter(Boolean).join(path.delimiter);
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
    noStdin?: boolean;
    onCleanup?: () => void;
    /** Awaited after the command exits on its own, before cleanup runs. */
    onExit?: (childPid: number | undefined, code: number | null) => Promise<void>;
    /** Called with the child's PID, which is also its process group on Unix. */
    onSpawn?: (pid: number) => void;
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

  const stdio: StdioOptions = options?.noStdin ? ["ignore", "inherit", "inherit"] : "inherit";
  const spawnedAt = Date.now();

  // On Unix, spawn detached so the child gets its own process group. This
  // lets us kill the entire tree (shell + grandchild dev server) with a
  // single process.kill(-pid, signal) instead of only the immediate child.
  const child = isWindows
    ? spawn("cmd.exe", ["/d", "/s", "/c", commandArgs.join(" ")], {
        stdio,
        env,
      })
    : spawn("/bin/sh", ["-c", commandArgs.map(shellEscape).join(" ")], {
        stdio,
        env,
        detached: true,
      });

  guardWindowsOrphans(child, spawnedAt);
  if (!isWindows && child.pid) options?.onSpawn?.(child.pid);

  let exiting = false;
  let shutdownSignal: NodeJS.Signals | undefined;
  let childExited = false;
  const trackedProcesses = new Map<number, TrackedProcess>();
  let graceTimer: NodeJS.Timeout | undefined;
  let forceTimer: NodeJS.Timeout | undefined;
  let shutdownPoll: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (graceTimer) clearTimeout(graceTimer);
    if (forceTimer) clearTimeout(forceTimer);
    if (shutdownPoll) clearInterval(shutdownPoll);
    process.removeListener("SIGINT", onSigInt);
    process.removeListener("SIGTERM", onSigTerm);
    process.removeListener("SIGHUP", onSigHup);
    options?.onCleanup?.();
  };

  const finish = (code: number) => {
    if (exiting) return;
    exiting = true;
    cleanup();
    process.exit(code);
  };

  const finishShutdownIfComplete = () => {
    if (!shutdownSignal || !childExited || hasRunningProcesses(trackedProcesses)) return;
    finish(128 + (SIGNAL_CODES[shutdownSignal] || 15));
  };

  const handleSignal = (signal: NodeJS.Signals) => {
    if (shutdownSignal) {
      if (child.pid) trackProcessTree(child.pid, trackedProcesses);
      signalTrackedProcesses(trackedProcesses, signal);
      return;
    }
    shutdownSignal = signal;
    if (child.pid) trackProcessTree(child.pid, trackedProcesses);
    killTree(child, signal);

    graceTimer = setTimeout(() => {
      if (child.pid) trackProcessTree(child.pid, trackedProcesses);
      signalTrackedProcesses(trackedProcesses, "SIGTERM");
    }, COMMAND_SHUTDOWN_GRACE_MS);

    forceTimer = setTimeout(() => {
      if (child.pid) trackProcessTree(child.pid, trackedProcesses);
      signalTrackedProcesses(trackedProcesses, "SIGKILL");
    }, COMMAND_SHUTDOWN_FORCE_MS);

    shutdownPoll = setInterval(finishShutdownIfComplete, COMMAND_SHUTDOWN_POLL_MS);
  };

  const onSigInt = () => handleSignal("SIGINT");
  const onSigTerm = () => handleSignal("SIGTERM");
  // The child runs in its own process group, so it never sees the SIGHUP a
  // closing terminal sends to the foreground group.
  const onSigHup = () => handleSignal("SIGHUP");

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("SIGHUP", onSigHup);

  child.on("error", (err) => {
    if (exiting || shutdownSignal) return;
    console.error(`Failed to run command: ${err.message}`);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Is "${commandArgs[0]}" installed and in your PATH?`);
    }
    finish(1);
  });

  child.on("exit", (code, signal) => {
    if (exiting) return;
    childExited = true;
    if (shutdownSignal) {
      finishShutdownIfComplete();
      return;
    }
    if (signal) {
      finish(128 + (SIGNAL_CODES[signal] || 15));
      return;
    }
    const onExit = options?.onExit;
    if (!onExit) {
      finish(code ?? 1);
      return;
    }
    onExit(child.pid, code)
      .catch(() => {
        // Exit hooks are best-effort.
      })
      .finally(() => finish(code ?? 1));
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
 * `serverSubcommands` are the subcommands that accept `--port`/`--host`;
 * `defaultIsServer` marks a CLI whose bare invocation starts that server.
 * Anything else gets no flags: those commands exit with an unknown-option error.
 *
 * `valueFlags` are the flags that consume the next token, needed only for CLIs
 * that accept flags before the subcommand — without them `vite --mode dev build`
 * reads `dev` as the subcommand and injects into a build. A CLI that lists none
 * is not classified at all once a flag precedes the subcommand.
 *
 * SvelteKit is not listed because its dev server is Vite under the hood,
 * so the `vite` entry already covers it.
 */
type FrameworkSpec = {
  strictPort: boolean;
  serverSubcommands: string[];
  nonServerSubcommands?: string[];
  defaultIsServer: boolean;
  positionalRootIsServer?: boolean;
  valueFlags?: string[];
  hostFlag?: string;
};

const FRAMEWORKS_NEEDING_PORT: Record<string, FrameworkSpec> = {
  vite: {
    strictPort: true,
    serverSubcommands: ["dev", "serve", "preview"],
    nonServerSubcommands: ["build", "optimize"],
    defaultIsServer: true,
    positionalRootIsServer: true,
    // Union of vite 6 and vite 7, listing a flag whether its value is required
    // or optional, since cac consumes the next token either way. Derived from
    // each CLI's own option table, not from its prose docs.
    valueFlags: [
      "--assetsDir",
      "--assetsInlineLimit",
      "--base",
      "--configLoader",
      "--host",
      "--manifest",
      "--minify",
      "--open",
      "--outDir",
      "--port",
      "--sourcemap",
      "--ssr",
      "--ssrManifest",
      "--target",
      "-c",
      "--config",
      "-d",
      "--debug",
      "-f",
      "--filter",
      "-l",
      "--logLevel",
      "-m",
      "--mode",
    ],
  },
  vitepress: {
    strictPort: true,
    serverSubcommands: ["dev", "serve", "preview"],
    nonServerSubcommands: ["build", "init"],
    defaultIsServer: true,
  },
  vp: { strictPort: true, serverSubcommands: ["dev"], defaultIsServer: false },
  "react-router": { strictPort: true, serverSubcommands: ["dev"], defaultIsServer: false },
  rsbuild: {
    strictPort: false,
    serverSubcommands: ["dev", "preview"],
    defaultIsServer: true,
    valueFlags: [
      "--base",
      "--config-loader",
      "--dist-path",
      "--env-dir",
      "--env-mode",
      "--environment",
      "--host",
      "--log-level",
      "--output",
      "--port",
      "-c",
      "--config",
      "-m",
      "--mode",
      "-o",
      "--open",
      "-r",
      "--root",
    ],
  },
  astro: {
    strictPort: false,
    serverSubcommands: ["dev", "preview"],
    defaultIsServer: false,
    valueFlags: [
      "--base",
      "--config",
      "--host",
      "--mode",
      "--open",
      "--outDir",
      "--port",
      "--root",
      "--site",
    ],
  },
  ng: { strictPort: false, serverSubcommands: ["serve", "dev", "s"], defaultIsServer: false },
  "react-native": { strictPort: false, serverSubcommands: ["start"], defaultIsServer: false },
  expo: { strictPort: false, serverSubcommands: ["start", "serve"], defaultIsServer: true },
  wrangler: {
    strictPort: false,
    serverSubcommands: ["dev"],
    defaultIsServer: false,
    hostFlag: "--ip",
  },
};

type RunnerOptionSpec = {
  valueFlags?: readonly string[];
  booleanFlags?: readonly string[];
  targetFlags?: readonly string[];
  scriptOnlyFlags?: readonly string[];
  cwdFlags?: readonly string[];
  attachedShortValues?: true;
};

type SkippedPrefix = {
  index: number;
  separator: boolean;
  unknownFlag: boolean;
  targetsOtherPackage: boolean;
  scriptOnly: boolean;
  cwd?: string;
};

type PackageRunnerSpec = {
  subcommands: string[];
  valueFlags?: readonly string[];
  attachedShortValues?: true;
  separatorRequired?: boolean;
};

const NPM_VALUE_FLAGS = [
  "-C",
  "-L",
  "-c",
  "-m",
  "-w",
  "--_auth",
  "--access",
  "--allow-directory",
  "--allow-file",
  "--allow-git",
  "--allow-remote",
  "--allow-scripts",
  "--also",
  "--audit-level",
  "--auth-type",
  "--before",
  "--browser",
  "--ca",
  "--cache",
  "--cache-max",
  "--cache-min",
  "--cafile",
  "--call",
  "--cert",
  "--cidr",
  "--cpu",
  "--depth",
  "--diff",
  "--diff-dst-prefix",
  "--diff-src-prefix",
  "--diff-unified",
  "--editor",
  "--enjoy-by",
  "--expect-result-count",
  "--expires",
  "--fetch-retries",
  "--fetch-retry-factor",
  "--fetch-retry-maxtimeout",
  "--fetch-retry-mintimeout",
  "--fetch-timeout",
  "--git",
  "--globalconfig",
  "--heading",
  "--https-proxy",
  "--include",
  "--init-author-email",
  "--init-author-name",
  "--init-author-url",
  "--init-license",
  "--init-module",
  "--init-type",
  "--init-version",
  "--init.author.email",
  "--init.author.name",
  "--init.author.url",
  "--init.license",
  "--init.module",
  "--init.version",
  "--install-strategy",
  "--key",
  "--libc",
  "--local-address",
  "--location",
  "--lockfile-version",
  "--loglevel",
  "--logs-dir",
  "--logs-max",
  "--maxsockets",
  "--message",
  "--min-release-age",
  "--min-release-age-exclude",
  "--name",
  "--node-gyp",
  "--node-options",
  "--noproxy",
  "--omit",
  "--only",
  "--orgs",
  "--orgs-permission",
  "--os",
  "--otp",
  "--pack-destination",
  "--package",
  "--packages",
  "--packages-and-scopes-permission",
  "--password",
  "--prefix",
  "--preid",
  "--provenance-file",
  "--proxy",
  "--reg",
  "--registry",
  "--replace-registry-host",
  "--save-prefix",
  "--sbom-format",
  "--sbom-type",
  "--scope",
  "--scopes",
  "--script-shell",
  "--searchexclude",
  "--searchlimit",
  "--searchopts",
  "--searchstaleness",
  "--shell",
  "--tag",
  "--tag-version-prefix",
  "--token-description",
  "--umask",
  "--user-agent",
  "--userconfig",
  "--viewer",
  "--which",
  "--workspace",
] as const;

const NPX_VALUE_FLAGS = [...NPM_VALUE_FLAGS, "-p"] as const;

const PNPM_VALUE_FLAGS = [
  "-F",
  "--filter",
  "--filter-prod",
  "-C",
  "--dir",
  "--env-file",
  "--store-dir",
  "--state-dir",
  "--npmrc-auth-file",
  "--userconfig",
  "--workspace-packages",
  "--registry",
  "--https-proxy",
  "--http-proxy",
  "--no-proxy",
  "--reporter",
  "--loglevel",
  "--workspace-concurrency",
  "--test-pattern",
  "--changed-files-ignore-pattern",
] as const;

const PNPM_DLX_VALUE_FLAGS = [
  "-p",
  "--package",
  "--allow-build",
  "--cpu",
  "--os",
  "--libc",
] as const;

const PNPM_BOOLEAN_FLAGS = [
  "-s",
  "--sequential",
  "--silent",
  "--if-present",
  "--dry-run",
  "--json",
  "-y",
  "--yes",
  "--ignore-workspace",
  "--color",
  "--no-color",
  "--no-progress",
  "--stream",
  "--aggregate-output",
  "--use-stderr",
  "-r",
  "--recursive",
  "-w",
  "--workspace-root",
  "--fail-if-no-match",
  "--no-fail-if-no-match",
  "--include-workspace-root",
  "--no-include-workspace-root",
  "--sort",
  "--no-sort",
  "--reverse",
  "--parallel",
  "--offline",
  "--prefer-offline",
] as const;

const YARN_CLASSIC_VALUE_FLAGS = [
  "--cwd",
  "--cache-folder",
  "--global-folder",
  "--https-proxy",
  "--link-folder",
  "--modules-folder",
  "--mutex",
  "--network-concurrency",
  "--network-timeout",
  "--otp",
  "--preferred-cache-folder",
  "--proxy",
  "--registry",
  "--use-yarnrc",
] as const;

const YARN_DLX_VALUE_FLAGS = ["-p", "--package"] as const;

const YARN_CLASSIC_BOOLEAN_FLAGS = [
  "-s",
  "--silent",
  "--verbose",
  "--offline",
  "--prefer-offline",
  "--enable-pnp",
  "--pnp",
  "--disable-pnp",
  "--strict-semver",
  "--json",
  "--ignore-scripts",
  "--har",
  "--ignore-platform",
  "--ignore-engines",
  "--ignore-optional",
  "--force",
  "--skip-integrity-check",
  "--check-files",
  "--no-bin-links",
  "--flat",
  "--no-lockfile",
  "--pure-lockfile",
  "--frozen-lockfile",
  "--update-checksums",
  "--link-duplicates",
  "--no-progress",
  "--non-interactive",
  "--no-node-version-check",
  "--focus",
  "--no-default-rc",
] as const;

const BUN_VALUE_FLAGS = [
  "--cwd",
  "--env-file",
  "-r",
  "--preload",
  "--require",
  "--import",
  "--install",
  "-e",
  "--eval",
  "-p",
  "--print",
  "--port",
  "--conditions",
  "--fetch-preconnect",
  "--max-http-header-size",
  "--dns-result-order",
  "--redirect-warnings",
  "--disable-warning",
  "--title",
  "--unhandled-rejections",
  "--console-depth",
  "--user-agent",
  "--cron-title",
  "--cron-period",
  "--main-fields",
  "--extension-order",
  "--tsconfig-override",
  "-d",
  "--define",
  "--drop",
  "--feature",
  "-l",
  "--loader",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--jsx-runtime",
  "--cpu-prof-name",
  "--cpu-prof-dir",
  "--cpu-prof-interval",
  "--heap-prof-name",
  "--heap-prof-dir",
  "--heap-prof-interval",
  "--watch-kill-signal",
] as const;

const BUN_BOOLEAN_FLAGS = [
  "-b",
  "--bun",
  "-c",
  "--config",
  "--inspect",
  "--inspect-wait",
  "--inspect-brk",
  "--silent",
  "--watch",
  "--hot",
  "--check",
  "--smol",
  "--interactive",
  "--if-present",
  "-i",
  "--prefer-offline",
  "--prefer-latest",
  "--cpu-prof",
  "--cpu-prof-md",
  "--heap-prof",
  "--heap-prof-md",
  "--experimental-http2-fetch",
  "--experimental-http3-fetch",
  "--insecure-http-parser",
  "--experimental-stream-iter",
  "--expose-gc",
  "--throw-deprecation",
  "--trace-warnings",
  "--trace-deprecation",
  "--pending-deprecation",
  "--zero-fill-buffers",
  "--use-system-ca",
  "--use-openssl-ca",
  "--use-bundled-ca",
  "--tls-min-v1.0",
  "--tls-min-v1.1",
  "--tls-min-v1.2",
  "--tls-min-v1.3",
  "--tls-max-v1.2",
  "--tls-max-v1.3",
  "--redis-preconnect",
  "--sql-preconnect",
  "--preserve-symlinks",
  "--preserve-symlinks-main",
  "--jsx-side-effects",
  "--ignore-dce-annotations",
  "--no-clear-screen",
  "--no-install",
  "--no-deprecation",
  "--no-warnings",
  "--no-addons",
  "--no-ffi-cc",
  "--no-macros",
  "--no-env-file",
] as const;

const BUN_X_VALUE_FLAGS = [
  "-p",
  "--package",
  "--cwd",
  "--env-file",
  "--minimum-release-age",
  "--registry",
  "--ca",
  "--cafile",
  "-r",
  "--preload",
  "--require",
  "--import",
] as const;

const BUN_X_BOOLEAN_FLAGS = [
  "-b",
  "--bun",
  "-c",
  "--config",
  "--silent",
  "--verbose",
  "--trust",
  "--ignore-scripts",
  "--no-install",
  "--smol",
  "--hot",
  "--watch",
  "--prefer-offline",
  "--prefer-latest",
] as const;

const PACKAGE_RUNNERS: Record<string, PackageRunnerSpec> = {
  npx: {
    subcommands: [],
    valueFlags: NPX_VALUE_FLAGS,
  },
  bunx: { subcommands: [], valueFlags: BUN_X_VALUE_FLAGS, attachedShortValues: true },
  pnpx: {
    subcommands: [],
    valueFlags: [...PNPM_VALUE_FLAGS, ...PNPM_DLX_VALUE_FLAGS],
    attachedShortValues: true,
  },
  yarn: {
    subcommands: ["dlx", "exec"],
    valueFlags: [...YARN_CLASSIC_VALUE_FLAGS, ...YARN_DLX_VALUE_FLAGS],
  },
  pnpm: {
    subcommands: ["dlx", "exec"],
    valueFlags: [...PNPM_VALUE_FLAGS, ...PNPM_DLX_VALUE_FLAGS],
    attachedShortValues: true,
  },
  npm: {
    subcommands: ["exec", "x"],
    valueFlags: NPM_VALUE_FLAGS,
    separatorRequired: true,
  },
};

/**
 * Find the index of the framework command inside `commandArgs`, looking past
 * known package runners (npx, bunx, yarn dlx, …) and their flags. Returns null
 * when no port-needing framework is present.
 */
type FrameworkInvocation = {
  basename: string;
  framework: FrameworkSpec;
  frameworkIndex: number;
  /** Null when npm parses the options after the framework and one of them may consume the next argument. */
  frameworkArgs: string[] | null;
  insertionIndex: number;
  separator?: string;
};

function optionName(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

function optionInlineValue(token: string): string | undefined {
  const eq = token.indexOf("=");
  return eq === -1 ? undefined : token.slice(eq + 1);
}

function mergeFlagList(
  first?: readonly string[],
  second?: readonly string[]
): readonly string[] | undefined {
  if (!first) return second;
  if (!second) return first;
  return [...first, ...second];
}

function mergeRunnerOptions(base: RunnerOptionSpec, sub?: RunnerOptionSpec): RunnerOptionSpec {
  if (!sub) return base;
  return {
    valueFlags: mergeFlagList(base.valueFlags, sub.valueFlags),
    booleanFlags: mergeFlagList(base.booleanFlags, sub.booleanFlags),
    targetFlags: mergeFlagList(base.targetFlags, sub.targetFlags),
    scriptOnlyFlags: mergeFlagList(base.scriptOnlyFlags, sub.scriptOnlyFlags),
    cwdFlags: mergeFlagList(base.cwdFlags, sub.cwdFlags),
    attachedShortValues: base.attachedShortValues || sub.attachedShortValues,
  };
}

function hasTrailingTargetFlag(
  args: string[],
  start: number,
  targetFlags: readonly string[]
): boolean {
  for (let i = start; i < args.length; i++) {
    const token = args[i];
    if (token === "--") break;
    if (token.startsWith("-") && targetFlags.includes(optionName(token))) return true;
  }
  return false;
}

/**
 * Scan leading option tokens for a runner or subcommand. When `booleanFlags` is
 * given, an unrecognized flag without `=` stops the scan as `unknownFlag` so a
 * value-taking flag's argument is never misread as the target command or script.
 */
function skipRunnerPrefix(
  commandArgs: string[],
  start: number,
  runner: RunnerOptionSpec
): SkippedPrefix {
  let index = start;
  let separator = false;
  let unknownFlag = false;
  let targetsOtherPackage = false;
  let scriptOnly = false;
  let cwd: string | undefined;

  while (index < commandArgs.length && commandArgs[index].startsWith("-")) {
    const token = commandArgs[index];
    if (token === "--") {
      index++;
      separator = true;
      break;
    }

    let name = optionName(token);
    let hasInlineValue = token.length !== name.length;
    let inlineValue = hasInlineValue ? optionInlineValue(token) : undefined;
    if (
      !hasInlineValue &&
      runner.attachedShortValues &&
      token.length > 2 &&
      token[1] !== "-" &&
      runner.valueFlags?.includes(token.slice(0, 2))
    ) {
      name = token.slice(0, 2);
      hasInlineValue = true;
      inlineValue = token.slice(2);
    }

    const isValueFlag = runner.valueFlags?.includes(name) === true;
    const isBooleanFlag = runner.booleanFlags?.includes(name) === true;

    if (!hasInlineValue && !isValueFlag && runner.booleanFlags && !isBooleanFlag) {
      unknownFlag = true;
      break;
    }

    if (runner.targetFlags?.includes(name)) targetsOtherPackage = true;
    if (runner.scriptOnlyFlags?.includes(name)) scriptOnly = true;

    index++;
    if (isValueFlag) {
      const value = hasInlineValue ? inlineValue : commandArgs[index];
      if (!hasInlineValue) index++;
      if (runner.cwdFlags?.includes(name) && value !== undefined) {
        cwd = value;
      }
    }
  }

  return { index, separator, unknownFlag, targetsOtherPackage, scriptOnly, cwd };
}

function parseFrameworkInvocation(commandArgs: string[]): FrameworkInvocation | null {
  if (commandArgs.length === 0) return null;

  const first = path.basename(commandArgs[0]);
  let frameworkIndex: number | null = FRAMEWORKS_NEEDING_PORT[first] ? 0 : null;
  let runnerSeparator = false;
  let needsSeparator = false;

  if (frameworkIndex === null) {
    const runner = PACKAGE_RUNNERS[first];
    if (!runner) return null;

    let skipped = skipRunnerPrefix(commandArgs, 1, runner);
    runnerSeparator = skipped.separator;
    let i = skipped.index;

    if (runner.subcommands.length > 0) {
      if (i >= commandArgs.length) return null;
      if (!runner.subcommands.includes(commandArgs[i])) {
        const name = path.basename(commandArgs[i]);
        frameworkIndex = FRAMEWORKS_NEEDING_PORT[name] ? i : null;
      } else {
        skipped = skipRunnerPrefix(commandArgs, i + 1, runner);
        runnerSeparator ||= skipped.separator;
        i = skipped.index;
      }
    }

    if (frameworkIndex === null) {
      skipped = skipRunnerPrefix(commandArgs, i, runner);
      runnerSeparator ||= skipped.separator;
      i = skipped.index;
      if (i >= commandArgs.length) return null;
      const name = path.basename(commandArgs[i]);
      frameworkIndex = FRAMEWORKS_NEEDING_PORT[name] ? i : null;
    }

    if (frameworkIndex !== null) {
      needsSeparator = Boolean(runner.separatorRequired) && !runnerSeparator;
    }
  }

  if (frameworkIndex === null) return null;
  const basename = path.basename(commandArgs[frameworkIndex]);
  const framework = FRAMEWORKS_NEEDING_PORT[basename];
  const optionEnd = commandArgs.indexOf("--", frameworkIndex + 1);
  const insertionIndex = needsSeparator || optionEnd === -1 ? commandArgs.length : optionEnd;
  let frameworkArgs: string[] | null;
  if (needsSeparator) {
    const beforeSeparator =
      optionEnd === -1
        ? commandArgs.slice(frameworkIndex + 1)
        : commandArgs.slice(frameworkIndex + 1, optionEnd);
    const npmMayConsumeValue = beforeSeparator.some(
      (arg, i) =>
        arg.startsWith("-") &&
        !arg.includes("=") &&
        i + 1 < beforeSeparator.length &&
        !beforeSeparator[i + 1].startsWith("-")
    );
    frameworkArgs = npmMayConsumeValue
      ? null
      : [
          ...beforeSeparator.filter((arg) => !arg.startsWith("-")),
          ...(optionEnd === -1 ? [] : commandArgs.slice(optionEnd + 1)),
        ];
  } else {
    frameworkArgs = commandArgs.slice(frameworkIndex + 1, insertionIndex);
  }
  return {
    basename,
    framework,
    frameworkIndex,
    frameworkArgs,
    insertionIndex,
    ...(needsSeparator && optionEnd === -1 ? { separator: "--" } : {}),
  };
}

/**
 * Find the basename of the framework command inside `commandArgs`, looking
 * past known package runners (npx, bunx, yarn dlx, …) and their flags.
 */
function findFrameworkBasename(commandArgs: string[]): string | null {
  return parseFrameworkInvocation(commandArgs)?.basename ?? null;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandBasename(token: string): string {
  const name = path.basename(token);
  return isWindows ? name.toLowerCase().replace(/\.(cmd|exe|bat|com)$/, "") : name;
}

function isTurboCommand(token: string, packageSpec: boolean): boolean {
  const name = commandBasename(token);
  return name === "turbo" || (packageSpec && !token.startsWith("@") && /^turbo@[^/]+$/.test(name));
}

function mentionsTurbo(commandArgs: string[]): boolean {
  return commandArgs.some((arg) => {
    const name = commandBasename(arg);
    return name === "turbo" || /^turbo@[^/]+$/.test(name);
  });
}

/** What a wrapper does to the command it runs and to the arguments forwarded through it. */
type Wrapped = RunnerOptionSpec & {
  /** Whether it swallows one `--`: always, or only when its own options do not end with one. */
  consumes?: "always" | "unless separated";
  /** What follows is a package spec such as `turbo@2`. */
  packageSpec?: true;
  /** What follows is a package script name: always after `run`, possibly after bare `yarn`. */
  script?: "always" | "maybe";
};

type WrapperSpec = Wrapped & {
  subcommands?: Record<string, Wrapped>;
  /** False when the command runs nothing without one of its subcommands. */
  bare?: false;
  /** True when the runner still parses its own flags after the script name until `--`. */
  parsesTrailingFlags?: true;
};

const NPM_EXEC: Wrapped = { consumes: "unless separated", packageSpec: true };
const NPM_RUN: Wrapped = { consumes: "unless separated", script: "always" };
const PNPM_RUN: Wrapped = { script: "always" };

/** Every command that a root script may put in front of Turbo. */
const COMMAND_WRAPPERS: Record<string, WrapperSpec> = {
  env: {
    valueFlags: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
    booleanFlags: ["-", "-i", "--ignore-environment", "-0", "--null", "-v", "--debug"],
    targetFlags: ["-C", "--chdir"],
    cwdFlags: ["-C", "--chdir"],
    attachedShortValues: true,
  },
  "cross-env": {},
  dotenv: {
    valueFlags: ["-e", "-v", "-p"],
    booleanFlags: ["-o", "--override", "--debug", "-x", "--expand"],
    attachedShortValues: true,
    consumes: "unless separated",
  },
  npx: {
    valueFlags: NPX_VALUE_FLAGS,
    packageSpec: true,
  },
  bunx: {
    valueFlags: BUN_X_VALUE_FLAGS,
    booleanFlags: BUN_X_BOOLEAN_FLAGS,
    attachedShortValues: true,
    packageSpec: true,
  },
  pnpx: {
    valueFlags: [...PNPM_VALUE_FLAGS, ...PNPM_DLX_VALUE_FLAGS],
    booleanFlags: [...PNPM_BOOLEAN_FLAGS, "-c", "--shell-mode"],
    attachedShortValues: true,
    packageSpec: true,
  },
  npm: {
    valueFlags: NPM_VALUE_FLAGS,
    targetFlags: ["-w", "--workspace", "--workspaces", "--ws", "-C", "--prefix"],
    parsesTrailingFlags: true,
    subcommands: {
      exec: NPM_EXEC,
      x: NPM_EXEC,
      run: NPM_RUN,
      "run-script": NPM_RUN,
    },
  },
  pnpm: {
    valueFlags: PNPM_VALUE_FLAGS,
    booleanFlags: PNPM_BOOLEAN_FLAGS,
    attachedShortValues: true,
    targetFlags: [
      "-F",
      "--filter",
      "--filter-prod",
      "-C",
      "--dir",
      "-r",
      "--recursive",
      "-w",
      "--workspace-root",
      "--workspace-packages",
    ],
    subcommands: {
      exec: { booleanFlags: ["-c", "--shell-mode"] },
      dlx: {
        packageSpec: true,
        valueFlags: PNPM_DLX_VALUE_FLAGS,
        booleanFlags: ["-c", "--shell-mode"],
      },
      run: PNPM_RUN,
      "run-script": PNPM_RUN,
    },
  },
  bun: {
    bare: false,
    valueFlags: BUN_VALUE_FLAGS,
    booleanFlags: BUN_BOOLEAN_FLAGS,
    attachedShortValues: true,
    cwdFlags: ["--cwd"],
    targetFlags: ["--cwd"],
    subcommands: {
      x: {
        packageSpec: true,
        valueFlags: BUN_X_VALUE_FLAGS,
        booleanFlags: BUN_X_BOOLEAN_FLAGS,
      },
      run: {
        consumes: "always",
        script: "always",
        valueFlags: ["-F", "--filter", "--shell", "--elide-lines"],
        booleanFlags: [
          "--workspaces",
          "--parallel",
          "--sequential",
          "--no-orphans",
          "--no-exit-on-error",
        ],
        targetFlags: ["-F", "--filter", "--workspaces"],
        scriptOnlyFlags: ["-F", "--filter", "--workspaces"],
      },
    },
  },
};

const YARN_CLASSIC_WRAPPER: WrapperSpec = {
  consumes: "unless separated",
  script: "maybe",
  valueFlags: YARN_CLASSIC_VALUE_FLAGS,
  booleanFlags: YARN_CLASSIC_BOOLEAN_FLAGS,
  targetFlags: ["--cwd"],
  parsesTrailingFlags: true,
  subcommands: {
    exec: { consumes: "unless separated" },
    dlx: { packageSpec: true, valueFlags: YARN_DLX_VALUE_FLAGS, booleanFlags: ["-q", "--quiet"] },
    run: {
      consumes: "unless separated",
      script: "always",
    },
  },
};

const YARN_BERRY_WRAPPER: WrapperSpec = {
  script: "maybe",
  valueFlags: ["--cwd"],
  booleanFlags: [],
  targetFlags: ["--cwd"],
  subcommands: {
    exec: {},
    dlx: { packageSpec: true, valueFlags: YARN_DLX_VALUE_FLAGS, booleanFlags: ["-q", "--quiet"] },
    run: {
      script: "always",
      valueFlags: ["--require"],
      booleanFlags: ["-T", "--top-level", "-B", "--binaries-only", "--inspect", "--inspect-brk"],
      targetFlags: ["-T", "--top-level"],
    },
  },
};

type Unwrapped = {
  /** The command left after every wrapper, starting at its executable or script name. */
  command: string[];
  /** `--` separators the wrappers swallow before the command sees forwarded arguments. */
  consumed: number;
  packageSpec: boolean;
  /** Whether the target is a local script (`always`/`maybe`), an external or unidentifiable script (`opaque`), or a command (`undefined`). */
  script: Wrapped["script"] | "opaque";
};

/** Strip environment assignments and wrappers from the front of a script's tokens. */
function unwrapCommand(tokens: string[], packageDir: string): Unwrapped | null {
  const classic = isYarnClassic(packageDir);
  let command = tokens;
  let consumed = 0;
  let packageSpec = false;
  let script: Unwrapped["script"];
  let inOtherDir = false;
  let currentDir = packageDir;
  for (;;) {
    const first = command[0];
    if (first === undefined) return null;
    if (ENV_ASSIGNMENT.test(first)) {
      command = command.slice(1);
      continue;
    }
    const name = commandBasename(first);
    const spec =
      name === "yarn"
        ? classic
          ? YARN_CLASSIC_WRAPPER
          : YARN_BERRY_WRAPPER
        : COMMAND_WRAPPERS[name];
    if (!spec) return { command, consumed, packageSpec, script };

    const pre = skipRunnerPrefix(command, 1, spec);
    if (pre.unknownFlag) return { command, consumed, packageSpec, script };

    let options = pre;
    let wrapped: Wrapped = spec;
    let effectiveOptions: RunnerOptionSpec = spec;
    const subcommand = pre.separator ? undefined : spec.subcommands?.[command[pre.index] ?? ""];
    if (subcommand) {
      wrapped = subcommand;
      effectiveOptions = mergeRunnerOptions(spec, subcommand);
      const post = skipRunnerPrefix(command, pre.index + 1, effectiveOptions);
      options = {
        index: post.index,
        separator: post.separator,
        unknownFlag: post.unknownFlag,
        targetsOtherPackage: pre.targetsOtherPackage || post.targetsOtherPackage,
        scriptOnly: pre.scriptOnly || post.scriptOnly,
        cwd: post.cwd ?? pre.cwd,
      };
    } else if (spec.bare === false) {
      return { command, consumed, packageSpec, script };
    }

    if (options.unknownFlag) {
      return {
        command: command.slice(options.index),
        consumed,
        packageSpec: false,
        script: wrapped.script ? "opaque" : undefined,
      };
    }

    if (
      !options.targetsOtherPackage &&
      !options.separator &&
      spec.parsesTrailingFlags &&
      effectiveOptions.targetFlags &&
      hasTrailingTargetFlag(command, options.index + 1, effectiveOptions.targetFlags)
    ) {
      options = { ...options, targetsOtherPackage: true };
    }

    const targetsOtherPackage: boolean = inOtherDir || options.targetsOtherPackage;
    const resolvedDir = options.cwd ? path.resolve(currentDir, options.cwd) : currentDir;

    if (wrapped.script === "always") {
      const target = command[options.index];
      if (target === undefined || target.startsWith("-")) return null;
      if (name === "bun" && !options.scriptOnly && !resolveScript(target, resolvedDir)) {
        wrapped = {};
      }
    }

    if (wrapped.consumes && (wrapped.consumes === "always" || !options.separator)) {
      consumed++;
    }

    packageSpec = wrapped.packageSpec === true;
    command = command.slice(options.index);
    inOtherDir = targetsOtherPackage;
    currentDir = resolvedDir;

    if (wrapped.script && targetsOtherPackage) {
      return {
        command,
        consumed,
        packageSpec: false,
        script: wrapped.script === "always" ? "opaque" : undefined,
      };
    }

    script = wrapped.script;
    if (script === "always") return { command, consumed, packageSpec, script };
  }
}

/**
 * Positionals after a framework name, with flag values consumed so a value is
 * never mistaken for a subcommand. Returns null when the subcommand cannot be
 * identified: a CLI with no `valueFlags` hits a flag before any positional, and
 * `--mode dev build` and `--open build` cannot both be resolved without knowing
 * which of the two flags takes a value. Flags after the subcommand no longer
 * affect it, so an unknown one is treated as a boolean there.
 *
 * `--name=value` is self-contained and never consumes. Everything after a bare
 * `--` belongs to the underlying process, not to the framework.
 */
function frameworkPositionals(args: string[], framework: FrameworkSpec): string[] | null {
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg.includes("=")) continue;
    if (framework.valueFlags?.includes(arg)) {
      i++;
      continue;
    }
    if (!framework.valueFlags && positionals.length === 0) return null;
  }

  return positionals;
}

/**
 * Whether the arguments after a framework name invoke one of its server
 * subcommands, and so may receive `--port`/`--host`.
 *
 * The first positional is the subcommand; later ones are its own arguments,
 * such as a root path in `vite dev ./app`. An unrecognized subcommand is
 * declined, not assumed to be a server.
 */
function invokesFrameworkServer(frameworkArgs: string[], framework: FrameworkSpec): boolean {
  const positionals = frameworkPositionals(frameworkArgs, framework);
  if (positionals === null) return false;

  const [subcommand] = positionals;
  if (subcommand === undefined) return framework.defaultIsServer;
  if (framework.serverSubcommands.includes(subcommand)) return true;
  if (framework.nonServerSubcommands?.includes(subcommand)) return false;
  return framework.positionalRootIsServer === true;
}

/**
 * Check if `commandArgs` invokes a framework that ignores `PORT` and, if so,
 * mutate the array in-place to add the correct CLI flags so the app listens on
 * the expected port and address. Returns the flags that were added.
 *
 * Handles both direct invocation (`vite dev`) and invocation via package
 * runners (`bunx --bun vite dev`, `npx vite dev`, `yarn dlx vite dev`).
 *
 * Appends nothing unless the invocation reaches one of the framework's server
 * subcommands (see invokesFrameworkServer): `vite build` and `vite optimize`
 * reject `--port` outright.
 *
 * We also inject `--host 127.0.0.1` so frameworks bind IPv4 loopback
 * predictably. The proxy itself dials both loopback families (see
 * createLoopbackConnection), so this is belt-and-suspenders for apps
 * that honor the flag; apps that ignore it and bind `::1` only still work.
 *
 * Note: Expo's `--host` flag is *not* a bind address (it is a connection mode:
 * lan|tunnel|localhost). In LAN mode we skip `--host` entirely — Expo defaults
 * to LAN already and injecting the flag alongside HOST=127.0.0.1 causes Metro's
 * HMR WebSocket to degrade. Outside LAN mode, `--host localhost` keeps the
 * server local.
 */
export function injectFrameworkFlags(commandArgs: string[], port: number): string[] {
  const invocation = parseFrameworkInvocation(commandArgs);
  if (!invocation) return [];
  const { basename, framework, frameworkArgs, insertionIndex, separator } = invocation;

  if (!frameworkArgs || !invokesFrameworkServer(frameworkArgs, framework)) return [];

  const flags: string[] = [];

  if (!hasCliOption(frameworkArgs, "--port")) {
    flags.push("--port", port.toString());
    if (framework.strictPort) {
      flags.push("--strictPort");
    }
  }

  const hostFlag = framework.hostFlag ?? "--host";
  const hasHostChoice =
    hasCliOption(frameworkArgs, hostFlag) ||
    (basename === "expo" &&
      ["--localhost", "--lan", "--tunnel"].some((option) => hasCliOption(frameworkArgs, option)));
  if (!hasHostChoice) {
    const isExpoLan = basename === "expo" && isLanEnvEnabled();
    if (!isExpoLan) {
      flags.push(hostFlag, basename === "expo" ? "localhost" : "127.0.0.1");
    }
  }

  const inserted = separator && flags.length > 0 ? [separator, ...flags] : flags;
  commandArgs.splice(insertionIndex, 0, ...inserted);
  return inserted;
}

/** Package managers whose `<pm> run <script>` delegates to a package.json script. */
const PACKAGE_SCRIPT_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/**
 * Detect whether appending arguments to a raw script string would change what
 * the shell runs. Flags are forwarded by concatenating them onto this string,
 * which the package manager hands back to a shell, so the shell parses it a
 * second time: appending is not composition. Checked against the raw script
 * string rather than the tokenized array, because splitCommand collapses
 * newlines and would leave a glued operator (`vite dev&&node`) hidden inside a
 * single token.
 *
 * Two classes make appending unsafe, and they fail differently:
 * - Something starts a new command, so the appended flags land on the wrong
 *   one: the control operators (`&&`, `||`, `;`, `|`, `&`) and a bare newline.
 * - Something makes the shell discard the tail. A word-initial `#` opens a
 *   comment and swallows every appended flag silently: the script exits 0 with
 *   the framework on its own port, so the failure surfaces much later as a 502.
 *
 * Three classes of false positives are excluded:
 * - Metacharacters inside single or double quotes (`'/foo&bar'`) — they are
 *   part of an argument, not shell syntax, so quote state is tracked the same
 *   way `splitCommand` tracks it.
 * - `&` used as part of a shell redirection rather than a separator: `2>&1`
 *   (duplicate a file descriptor) and `&>`/`>&` (redirect stdout+stderr) both
 *   contain `&` adjacent to `>` but do not start a new command.
 * - A `#` that does not start a word. `vite --tag v1#2` is one argument,
 *   and `vite --define X=$(git rev-parse HEAD)` substitutes mid-word and still
 *   accepts appended flags. Only a word-initial occurrence changes parsing.
 *
 * Subshells (`(vite dev)`) and command substitution (`` `printf vite` dev ``,
 * `$(printf vite) dev`) are deliberately absent. Neither discards the tail, and
 * the framework resolver already declines every one of those scripts because
 * their first token is not a name it recognizes, so a guard clause for them
 * would be unreachable. A regression test pins that outcome instead.
 */
export function isUnsafeToAppendArgs(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let atWordStart = true;
  const chars = Array.from(command);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (escaped) {
      escaped = false;
      // A backslash before a newline is a line continuation: the shell removes
      // both characters and joins the lines, so whatever governed word
      // position before it still governs after. `vite dev \<newline># note`
      // reads as `vite dev # note`, and that `#` does open a comment.
      if (ch === "\n" || ch === "\r") continue;
      // Any other escaped character is part of the current word, so what
      // follows it is not word-initial: `--open /foo\ #bar` is one argument.
      atWordStart = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      atWordStart = false;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      atWordStart = false;
      continue;
    }
    if (inSingle || inDouble) continue;

    if (ch === ";" || ch === "\n" || ch === "\r" || ch === "|") return true;
    // A word-initial `#` opens a comment, so everything after it — including
    // the flags we are about to append — is discarded by the shell. Word start
    // is tracked rather than read off the previous character: an escaped space
    // keeps the word open even though the raw character before `#` is a space.
    if (ch === "#" && atWordStart) return true;
    if (ch === "&") {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      // Only POSIX file-descriptor duplication is a redirection rather than a
      // separator: `2>&1`, `>&2`, `2>&-`. `&>` and `>& file` are bash
      // extensions, and package managers run scripts through `sh`, which is
      // dash on Debian and Ubuntu. There `vite dev &> out.log --port 4567`
      // backgrounds `vite dev` and runs the rest as its own command, so the
      // appended flags never reach the framework.
      if (prev === ">" && next !== undefined && /[0-9-]/.test(next)) continue;
      return true;
    }
    atWordStart = ch === " " || ch === "\t";
  }
  return false;
}

function hasCliOption(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

/**
 * Resolve the tokens of the package script a command delegates to, or null
 * when the command is not `<pm> run <script>` or the script does not exist.
 *
 * Answers one question only: which command will run. Whether portless may
 * safely append flags to that command is a separate question, asked by
 * isSafeToInjectIntoScript. Conflating the two is its own defect: a script
 * portless declines to append to still runs a framework, and the consumer that
 * needs the framework's identity rather than its flags — the Expo LAN
 * environment carve-out — must still get an answer.
 */
function resolvePackageScriptTokens(commandArgs: string[], packageDir: string): string[] | null {
  if (commandArgs.length < 3) return null;

  const runner = path.basename(commandArgs[0]);
  if (!PACKAGE_SCRIPT_MANAGERS.has(runner)) return null;

  const [, runSubcommand, scriptName] = commandArgs;
  // Conservative shape match: `<pm> run <script>`. Runner flags between
  // `run` and the script name (e.g. `bun run --bun dev`) are left alone.
  if (runSubcommand !== "run" || scriptName.startsWith("-")) return null;

  return resolveScript(scriptName, packageDir);
}

/**
 * Decide whether portless may append flags to a resolved package script. Kept
 * apart from resolving it: a script can be perfectly identifiable and still be
 * one portless must not touch.
 */
function isSafeToInjectIntoScript(
  scriptName: string,
  rawScript: string[],
  packageDir: string
): boolean {
  // A script the shell re-parses in a way appending would break. Test the raw
  // script string, not the tokens: splitCommand collapses newlines and hides
  // glued operators (`vite dev&&node`, `vite dev\nnode x`) inside a single
  // token where a per-token check cannot see the separator, and it drops a
  // trailing comment entirely.
  const rawScriptText = resolveScriptRaw(scriptName, packageDir);
  if (rawScriptText && isUnsafeToAppendArgs(rawScriptText)) return false;
  // A `--` after the framework name ends its option list, so appended flags
  // would arrive as positional data.
  const invocation = parseFrameworkInvocation(rawScript);
  if (invocation && rawScript.includes("--", invocation.frameworkIndex + 1)) return false;
  // Non-server subcommands need no check here: injectFrameworkFlags appends
  // nothing for them.
  return true;
}

/**
 * Resolve which port-ignoring framework a command ultimately invokes, looking
 * past package runners (`bunx vite dev`) and through one level of package
 * script indirection (`bun run dev` where `"dev": "expo start"`). Returns null
 * when the command reaches no framework portless knows about.
 *
 * Deciding which framework runs drives two independent effects, and both must
 * read the same answer: the CLI flags appended below, and the environment
 * `runApp` exports before spawning. Resolving the framework here while the env
 * binder re-derived it from `path.basename(commandArgs[0])` is what left Expo
 * package scripts with `HOST=127.0.0.1` in LAN mode, degrading Metro's HMR
 * websocket — the exact condition the carve-out exists to avoid. Route every
 * new consumer through this function rather than reading commandArgs[0].
 *
 * Deliberately independent of whether portless will inject flags: an Expo
 * script portless declines to append to still runs Metro, and still must not
 * get HOST in LAN mode. Shapes this cannot see through remain unresolved
 * (a subshell or a leading command substitution hides the framework name from
 * a tokenizer that does not parse shell syntax); those are recorded as a known
 * gap rather than papered over.
 */
export function resolveFrameworkBasename(
  commandArgs: string[],
  packageDir: string = process.cwd()
): string | null {
  const direct = findFrameworkBasename(commandArgs);
  if (direct) return direct;
  const scriptTokens = resolvePackageScriptTokens(commandArgs, packageDir);
  return scriptTokens ? findFrameworkBasename(scriptTokens) : null;
}

export type TurboRootForwarding =
  | { kind: "none" }
  | { kind: "forward"; separators: number }
  | { kind: "unsafe"; turbo: boolean }
  | { kind: "too-deep" };

/** How many package scripts a root script may delegate through before portless stops following. */
const MAX_SCRIPT_DELEGATION_DEPTH = 5;

type ScriptWalkResult =
  | { kind: "missing" }
  | { kind: "unsafe"; scriptName: string; turbo: boolean }
  | { kind: "too-deep" }
  | { kind: "leaf"; separators: number; turbo: boolean };

function walkScript(scriptName: string, packageDir: string, chain: string[]): ScriptWalkResult {
  const raw = resolveScriptRaw(scriptName, packageDir);
  const tokens = resolveScript(scriptName, packageDir);
  if (!raw || !tokens) return { kind: "missing" };
  if (isUnsafeToAppendArgs(raw)) {
    return { kind: "unsafe", scriptName, turbo: mentionsTurbo(tokens) };
  }
  const unwrapped = unwrapCommand(tokens, packageDir);
  if (!unwrapped) return { kind: "leaf", separators: 0, turbo: false };
  const { command, packageSpec, script } = unwrapped;
  const literalSeparators = command.slice(1).filter((arg) => arg === "--").length;
  const turbo =
    script !== "always" && script !== "opaque" && isTurboCommand(command[0], packageSpec);
  if (turbo) {
    return {
      kind: "leaf",
      separators: Math.max(0, unwrapped.consumed + 1 - literalSeparators),
      turbo: true,
    };
  }
  if (
    !script ||
    script === "opaque" ||
    chain.includes(command[0]) ||
    !resolveScript(command[0], packageDir)
  ) {
    return {
      kind: "leaf",
      separators: Math.max(0, unwrapped.consumed - literalSeparators),
      turbo: false,
    };
  }
  if (chain.length - 1 >= MAX_SCRIPT_DELEGATION_DEPTH) return { kind: "too-deep" };
  const child = walkScript(command[0], packageDir, [...chain, command[0]]);
  if (child.kind === "too-deep" || child.kind === "unsafe") return child;
  const childSeparators = child.kind === "leaf" ? child.separators : 0;
  const childTurbo = child.kind === "leaf" && child.turbo;
  return {
    kind: "leaf",
    separators: Math.max(0, unwrapped.consumed + childSeparators - literalSeparators),
    turbo: childTurbo,
  };
}

export function resolveTurboRootForwarding(
  scriptName: string,
  packageDir: string
): TurboRootForwarding {
  const result = walkScript(scriptName, packageDir, [scriptName]);
  if (result.kind === "unsafe") return { kind: "unsafe", turbo: result.turbo };
  if (result.kind === "too-deep") return result;
  if (result.kind === "leaf" && result.turbo) {
    return { kind: "forward", separators: result.separators };
  }
  return { kind: "none" };
}

export type ScriptArgForwarding =
  | { kind: "missing" }
  | { kind: "forward"; separators: number }
  | { kind: "unsafe"; scriptName: string }
  | { kind: "too-deep" };

/**
 * Resolve how forwarded arguments pass through a package script, following
 * wrappers and nested scripts and counting the `--` separators they consume.
 */
export function resolveScriptArgForwarding(
  scriptName: string,
  packageDir: string
): ScriptArgForwarding {
  const result = walkScript(scriptName, packageDir, [scriptName]);
  if (result.kind === "missing") return result;
  if (result.kind === "unsafe") return { kind: "unsafe", scriptName: result.scriptName };
  if (result.kind === "too-deep") return result;
  return { kind: "forward", separators: result.separators };
}

/**
 * When the child command delegates to a package script (`<pm> run <script>`),
 * the framework command lives inside package.json where injectFrameworkFlags
 * cannot see it (it only inspects argv). Resolve the script, compute the flags
 * the underlying framework needs, and forward them through the package manager
 * so e.g. `bun run dev` becomes `bun run dev --port <n> --strictPort`.
 *
 * Covers zero-arg mode (`portless` resolving the dev script) and explicit
 * delegation (`portless run npm run dev`). The script must exist in
 * package.json at `packageDir` (the directory the child will run in).
 */
export function injectPackageScriptFrameworkFlags(
  commandArgs: string[],
  port: number,
  packageDir: string = process.cwd()
): void {
  const rawScript = resolvePackageScriptTokens(commandArgs, packageDir);
  if (!rawScript) return;
  const [, , scriptName] = commandArgs;
  if (!isSafeToInjectIntoScript(scriptName, rawScript, packageDir)) return;

  // Probe the script plus any user-supplied trailing args so an existing
  // --port/--host (in either place) suppresses injection of that flag.
  // Each flag is independent: injectFrameworkFlags checks --port and --host
  // separately, so an existing --port must not suppress a missing --host
  // (and vice versa).
  const userExtras = commandArgs.slice(3).filter((arg) => arg !== "--");
  const probe = [...rawScript, ...userExtras];
  const forwardedFlags = injectFrameworkFlags(probe, port);
  if (forwardedFlags.length === 0) return;

  // npm requires `--` before arguments meant for the package script.
  // bun, pnpm, and yarn forward trailing arguments directly.
  if (path.basename(commandArgs[0]) === "npm" && !commandArgs.includes("--")) {
    commandArgs.push("--");
  }
  commandArgs.push(...forwardedFlags);
}

/**
 * Prompt the user for input via readline. Returns empty string if stdin closes.
 */
export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.on("close", () => resolve(""));
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
      rl.close();
    });
  });
}

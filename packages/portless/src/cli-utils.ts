import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { execFileSync, execSync, spawn } from "node:child_process";
import { HOSTS_SYNC_PATH, PORTLESS_HEADER } from "./proxy.js";
import { checkHostResolution, getManagedHostnames, syncHostsFile } from "./hosts.js";
import { resolveScript, resolveScriptRaw } from "./config.js";
import { createLoopbackConnection, resolveUserHome } from "./utils.js";
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

const COMMAND_SHUTDOWN_GRACE_MS = 5000;
const COMMAND_SHUTDOWN_FORCE_MS = 10_000;
const COMMAND_SHUTDOWN_POLL_MS = 50;

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
      try {
        process.kill(pid, signal);
      } catch {
        // Already dead
      }
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

/** Return explicit IPv4 and IPv6 listener targets for the effective proxy mode. */
export function getProxyBindTargets(lanMode: boolean): ProxyBindTarget[] {
  return lanMode
    ? [{ host: IPV4_LAN_PROXY_HOST }, { host: IPV6_LAN_PROXY_HOST, ipv6Only: true }]
    : [{ host: IPV4_LOOPBACK_PROXY_HOST }, { host: IPV6_LOOPBACK_PROXY_HOST, ipv6Only: true }];
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
const CUSTOM_CERT_MARKER_FILE = "proxy.custom-cert";

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

export function readCustomCertMarker(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, CUSTOM_CERT_MARKER_FILE));
  } catch {
    return false;
  }
}

export function writeCustomCertMarker(dir: string, enabled: boolean): void {
  const markerPath = path.join(dir, CUSTOM_CERT_MARKER_FILE);
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
 * Validate a TLD string. Returns an error message if invalid, or null if OK.
 * Does not check for risky TLDs (those produce warnings, not errors).
 */
export function validateTld(tld: string): string | null {
  if (!tld) return "TLD cannot be empty";
  if (tld.length > 253) {
    return `Invalid TLD "${tld}": exceeds 253-character DNS limit`;
  }

  const labelRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  const labels = tld.split(".");
  for (const label of labels) {
    if (!label) {
      return `Invalid TLD "${tld}": labels cannot be empty`;
    }
    if (label.length > 63) {
      return `Invalid TLD "${tld}": label "${label}" exceeds 63-character DNS limit`;
    }
    if (!labelRe.test(label)) {
      return `Invalid TLD "${tld}": labels must contain only lowercase letters, digits, and interior hyphens`;
    }
  }
  return null;
}

/** Parse a comma separated TLD list and remove duplicates in order. */
export function parseTldList(value: string, source = "TLD"): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const tlds: string[] = [];
  const seen = new Set<string>();
  for (const rawPart of trimmed.split(",")) {
    const tld = rawPart.trim().toLowerCase();
    const err = validateTld(tld);
    if (err) throw new Error(source === "TLD" ? err : `${source}: ${err}`);
    if (!seen.has(tld)) {
      seen.add(tld);
      tlds.push(tld);
    }
  }
  return tlds;
}

/** Name of the file that stores the proxy's active TLD. */
const TLD_FILE = "proxy.tld";
const TLDS_FILE = "proxy.tlds";

function readLegacyTldFromDir(dir: string): string {
  try {
    const raw = fs.readFileSync(path.join(dir, TLD_FILE), "utf-8").trim();
    return raw || DEFAULT_TLD;
  } catch {
    return DEFAULT_TLD;
  }
}

/** Read all TLDs from a state directory. Returns the default TLD if absent. */
export function readTldsFromDir(dir: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(dir, TLDS_FILE), "utf-8").trim();
    const parsed = raw.startsWith("[")
      ? JSON.parse(raw)
      : raw
          .split(/\r?\n/)
          .flatMap((line) => line.split(","))
          .map((line) => line.trim())
          .filter(Boolean);
    if (!Array.isArray(parsed)) return [readLegacyTldFromDir(dir)];
    // Skip invalid persisted entries individually so one bad TLD (e.g. written
    // before validation tightened) does not silently reset the whole list.
    const tlds = parsed.flatMap((value) => {
      if (typeof value !== "string") return [];
      try {
        return parseTldList(value);
      } catch (err) {
        console.warn(
          `Warning: ignoring invalid TLD entry in ${TLDS_FILE}: ${err instanceof Error ? err.message : String(err)}`
        );
        return [];
      }
    });
    return tlds.length > 0 ? [...new Set(tlds)] : [DEFAULT_TLD];
  } catch {
    return [readLegacyTldFromDir(dir)];
  }
}

/** Read the primary TLD from a state directory. Returns DEFAULT_TLD if absent. */
export function readTldFromDir(dir: string): string {
  return readTldsFromDir(dir)[0] ?? DEFAULT_TLD;
}

/** Write or remove the TLD files in the state directory. */
export function writeTldsFile(dir: string, tlds: readonly string[]): void {
  const uniqueTlds = [...new Set(tlds)];
  const tldsPath = path.join(dir, TLDS_FILE);
  const tldPath = path.join(dir, TLD_FILE);

  if (uniqueTlds.length === 1 && uniqueTlds[0] === DEFAULT_TLD) {
    try {
      fs.unlinkSync(tldsPath);
    } catch {
      // File may already be absent; non-fatal
    }
    try {
      fs.unlinkSync(tldPath);
    } catch {
      // File may already be absent; non-fatal
    }
  } else {
    fs.writeFileSync(tldsPath, uniqueTlds.join("\n") + "\n", { mode: 0o644 });
    fs.writeFileSync(tldPath, uniqueTlds[0] ?? DEFAULT_TLD, { mode: 0o644 });
  }
}

/** Write or remove the primary TLD file in the state directory. */
export function writeTldFile(dir: string, tld: string): void {
  writeTldsFile(dir, [tld]);
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
  tlds: string[];
  lanMode: boolean;
} | null {
  const dir = process.env.PORTLESS_STATE_DIR || USER_STATE_DIR;
  const port = readPortFromDir(dir);
  if (port !== null) {
    const tls = readTlsMarker(dir);
    const tlds = readTldsFromDir(dir);
    const tld = tlds[0] ?? DEFAULT_TLD;
    const lanIp = readLanMarker(dir);
    return { port, tls, tld, tlds, lanMode: lanIp !== null };
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
  tlds?: readonly string[];
  useWildcard?: boolean;
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
    const port = readPortFromDir(dir) ?? getDefaultPort();
    const lanIp = readLanMarker(dir);
    if ((await isProxyRunning(port)) || (await isPortListening(port))) {
      const tls = readTlsMarker(dir);
      const tlds = readTldsFromDir(dir);
      const tld = tlds[0] ?? DEFAULT_TLD;
      return {
        dir,
        port,
        tls,
        tld,
        tlds,
        lanMode: lanIp !== null,
        lanIp,
      };
    }

    const tlds = readTldsFromDir(dir);
    return {
      dir,
      port,
      tls: readTlsMarker(dir),
      tld: tlds[0] ?? DEFAULT_TLD,
      tlds,
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
      const tlds = readTldsFromDir(USER_STATE_DIR);
      const tld = tlds[0] ?? DEFAULT_TLD;
      const lanIp = readLanMarker(USER_STATE_DIR);
      return {
        dir: USER_STATE_DIR,
        port: userPort,
        tls,
        tld,
        tlds,
        lanMode: lanIp !== null,
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
      const tlds = readTldsFromDir(LEGACY_SYSTEM_STATE_DIR);
      const tld = tlds[0] ?? DEFAULT_TLD;
      const lanIp = readLanMarker(LEGACY_SYSTEM_STATE_DIR);
      return {
        dir: LEGACY_SYSTEM_STATE_DIR,
        port: legacyPort,
        tls,
        tld,
        tlds,
        lanMode: lanIp !== null,
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
      const tlds = readTldsFromDir(dir);
      const tld = tlds[0] ?? DEFAULT_TLD;
      const lanIp = readLanMarker(dir);
      return {
        dir,
        port,
        tls,
        tld,
        tlds,
        lanMode: lanIp !== null,
        lanIp,
      };
    }
  }

  const dir = resolveStateDir(configuredPort);
  const tlds = readTldsFromDir(dir);
  return {
    dir,
    port: configuredPort,
    tls: readTlsMarker(dir),
    tld: tlds[0] ?? DEFAULT_TLD,
    tlds,
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
  stateDir = resolveStateDir(port)
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
  if (managed.length === 0) return;
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
  sync: (hostnames: string[]) => boolean = syncHostsFile
): boolean {
  if (sync(hostnames)) return false;
  if (hostnames.length === 0) return alreadyWarned;
  if (!alreadyWarned) onWarn();
  return true;
}

/** Check whether any process is listening on the given port on either loopback family. */
export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createLoopbackConnection(port);
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

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

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
    finish(code ?? 1);
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
  astro: { strictPort: false, serverSubcommands: ["dev", "preview"], defaultIsServer: false },
  ng: { strictPort: false, serverSubcommands: ["serve", "dev", "s"], defaultIsServer: false },
  "react-native": { strictPort: false, serverSubcommands: ["start"], defaultIsServer: false },
  expo: { strictPort: false, serverSubcommands: ["start", "serve"], defaultIsServer: true },
};

type PackageRunnerSpec = {
  subcommands: string[];
  valueFlags?: string[];
};

const PACKAGE_RUNNERS: Record<string, PackageRunnerSpec> = {
  npx: {
    subcommands: [],
    valueFlags: ["-c", "--call", "-p", "--package", "-w", "--workspace", "--allow-scripts"],
  },
  bunx: { subcommands: [] },
  pnpx: { subcommands: [], valueFlags: ["-p", "--package"] },
  yarn: { subcommands: ["dlx", "exec"] },
  pnpm: { subcommands: ["dlx", "exec"] },
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
  frameworkArgs: string[];
  insertionIndex: number;
};

function parseFrameworkInvocation(commandArgs: string[]): FrameworkInvocation | null {
  if (commandArgs.length === 0) return null;

  const first = path.basename(commandArgs[0]);
  let frameworkIndex: number | null = FRAMEWORKS_NEEDING_PORT[first] ? 0 : null;

  if (frameworkIndex === null) {
    const runner = PACKAGE_RUNNERS[first];
    if (!runner) return null;

    let i = 1;
    const skipRunnerOptions = () => {
      while (i < commandArgs.length && commandArgs[i].startsWith("-")) {
        const option = commandArgs[i];
        i++;
        if (option === "--") break;
        if (!option.includes("=") && runner.valueFlags?.includes(option)) i++;
      }
    };

    if (runner.subcommands.length > 0) {
      skipRunnerOptions();
      if (i >= commandArgs.length) return null;
      if (!runner.subcommands.includes(commandArgs[i])) {
        const name = path.basename(commandArgs[i]);
        frameworkIndex = FRAMEWORKS_NEEDING_PORT[name] ? i : null;
      } else {
        i++;
      }
    }

    if (frameworkIndex === null) {
      skipRunnerOptions();
      if (i >= commandArgs.length) return null;
      const name = path.basename(commandArgs[i]);
      frameworkIndex = FRAMEWORKS_NEEDING_PORT[name] ? i : null;
    }
  }

  if (frameworkIndex === null) return null;
  const basename = path.basename(commandArgs[frameworkIndex]);
  const framework = FRAMEWORKS_NEEDING_PORT[basename];
  const optionEnd = commandArgs.indexOf("--", frameworkIndex + 1);
  const insertionIndex = optionEnd === -1 ? commandArgs.length : optionEnd;
  return {
    basename,
    framework,
    frameworkIndex,
    frameworkArgs: commandArgs.slice(frameworkIndex + 1, insertionIndex),
    insertionIndex,
  };
}

/**
 * Find the basename of the framework command inside `commandArgs`, looking
 * past known package runners (npx, bunx, yarn dlx, …) and their flags.
 */
function findFrameworkBasename(commandArgs: string[]): string | null {
  return parseFrameworkInvocation(commandArgs)?.basename ?? null;
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
  const { basename, framework, frameworkArgs, insertionIndex } = invocation;

  if (!invokesFrameworkServer(frameworkArgs, framework)) return [];

  const flags: string[] = [];

  if (!hasCliOption(frameworkArgs, "--port")) {
    flags.push("--port", port.toString());
    if (framework.strictPort) {
      flags.push("--strictPort");
    }
  }

  const hasHostChoice =
    hasCliOption(frameworkArgs, "--host") ||
    (basename === "expo" &&
      ["--localhost", "--lan", "--tunnel"].some((option) => hasCliOption(frameworkArgs, option)));
  if (!hasHostChoice) {
    const isExpoLan = basename === "expo" && isLanEnvEnabled();
    if (!isExpoLan) {
      flags.push("--host", basename === "expo" ? "localhost" : "127.0.0.1");
    }
  }

  commandArgs.splice(insertionIndex, 0, ...flags);
  return flags;
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
function isUnsafeToAppendArgs(command: string): boolean {
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
  // A script that ends its own option list keeps everything after `--` as
  // positional data, so appended flags arrive as data too and the framework
  // never reads them as options. Appending cannot reach past a `--` that lives
  // inside the script, so leave the script alone.
  if (rawScript.includes("--")) return false;
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

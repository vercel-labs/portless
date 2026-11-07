import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { RouteInfo } from "./types.js";
import { fixOwnership, isErrnoException, isProcessAlive as isPidAlive } from "./utils.js";

/** How long (ms) before a lock directory is considered stale and forcibly removed. */
const STALE_LOCK_THRESHOLD_MS = 10_000;

/** Total time budget (ms) for acquiring the file lock before giving up. */
const LOCK_TIMEOUT_MS = 15_000;

/** Initial delay (ms) between lock acquisition retries (doubles each attempt). */
const LOCK_RETRY_BASE_MS = 10;

/** Maximum delay (ms) between lock acquisition retries. */
const LOCK_RETRY_CAP_MS = 100;

/** File permission mode for route and state files. */
export const FILE_MODE = 0o644;

/** Directory permission mode for the state directory. */
export const DIR_MODE = 0o755;

export interface RouteMapping extends RouteInfo {
  pid: number;
  /** Process group of the command portless spawned for this route. */
  childPgid?: number;
  /** Start time of the process group leader, as reported by `ps`. */
  childStartTime?: string;
  orphanPid?: number;
  orphanStartTime?: string;
  tailscaleUrl?: string;
  tailscaleHttpsPort?: number;
  tailscaleFunnel?: boolean;
  ngrokUrl?: string;
  ngrokPid?: number;
  cloudflareUrl?: string;
  cloudflarePid?: number;
}

type RouteMetadataPatch = {
  childPgid?: number | null;
  childStartTime?: string | null;
  tailscaleUrl?: string | null;
  tailscaleHttpsPort?: number | null;
  tailscaleFunnel?: boolean | null;
  ngrokUrl?: string | null;
  ngrokPid?: number | null;
  cloudflareUrl?: string | null;
  cloudflarePid?: number | null;
};

export function isValidUpstream(value: unknown): value is NonNullable<RouteInfo["upstream"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const upstream = value as Record<string, unknown>;
  if (Object.keys(upstream).some((key) => key !== "tls" && key !== "host")) return false;
  if ("tls" in upstream && typeof upstream.tls !== "boolean") return false;
  if (!("host" in upstream)) return true;
  if (typeof upstream.host !== "string" || !upstream.host) return false;
  const authority = upstream.host;
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(authority);
  if (!match) return false;
  const hostname = match[1];
  if (
    match[2] !== undefined &&
    (match[2].length > 5 || Number(match[2]) < 1 || Number(match[2]) > 65535)
  )
    return false;
  if (hostname.startsWith("[")) return net.isIPv6(hostname.slice(1, -1));
  if (/^[0-9.]+$/.test(hostname) && hostname.includes(".")) return net.isIPv4(hostname);
  if (hostname.length > 253) return false;
  return hostname.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/i.test(label));
}

/** Runtime check that a parsed JSON value is a valid RouteMapping. */
function isValidRoute(value: unknown): value is RouteMapping {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RouteMapping).hostname === "string" &&
    typeof (value as RouteMapping).port === "number" &&
    typeof (value as RouteMapping).pid === "number" &&
    (!("upstream" in value) || isValidUpstream((value as RouteMapping).upstream))
  );
}

/** Whether two entries describe the same route and the same recorded process group. */
function isSameRouteRecord(a: RouteMapping, b: RouteMapping): boolean {
  return (
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.pid === b.pid &&
    a.childPgid === b.childPgid &&
    a.childStartTime === b.childStartTime
  );
}

/** Whether the portless process that registered an entry is gone; aliases never go stale. */
function isStaleRoute(route: RouteMapping): boolean {
  return route.pid !== 0 && !isPidAlive(route.pid);
}

/** Whether a stale entry still records a process group, share or member worth recovering. */
function hasRecoveryData(route: RouteMapping): boolean {
  return (
    route.childPgid !== undefined ||
    route.childStartTime !== undefined ||
    route.orphanPid !== undefined ||
    route.orphanStartTime !== undefined ||
    route.tailscaleHttpsPort !== undefined ||
    route.ngrokPid !== undefined ||
    route.cloudflarePid !== undefined
  );
}

/** Entries a write keeps: every live route plus stale records that still hold recovery data. */
function retainStaleRecords(routes: RouteMapping[]): RouteMapping[] {
  return routes.filter((route) => !isStaleRoute(route) || hasRecoveryData(route));
}

/**
 * Put every active entry before stale recovery records, preserving relative
 * order within each group. Readers and on-disk consumers use the first entry
 * for a hostname, so an active route must never follow a closed generation.
 */
function orderActiveFirst(routes: RouteMapping[]): RouteMapping[] {
  const active: RouteMapping[] = [];
  const stale: RouteMapping[] = [];
  for (const route of routes) {
    (isStaleRoute(route) ? stale : active).push(route);
  }
  return [...active, ...stale];
}

/** The entry a reader or a takeover means by a hostname: the live one. */
function findActiveRoute(routes: RouteMapping[], hostname: string): RouteMapping | undefined {
  return routes.find((route) => route.hostname === hostname && !isStaleRoute(route));
}

/**
 * Thrown when a route is already registered by a live process and --force was
 * not specified. With --force, the existing process is killed instead.
 */
export class RouteConflictError extends Error {
  readonly hostname: string;
  readonly existingPid: number;

  constructor(hostname: string, existingPid: number) {
    super(
      existingPid === 0
        ? `"${hostname}" is a static alias. Use --force to replace it; re-add the alias with "portless alias" afterwards.`
        : `"${hostname}" is already registered by a running process (PID ${existingPid}). ` +
            `Use --force to override.`
    );
    this.name = "RouteConflictError";
    this.hostname = hostname;
    this.existingPid = existingPid;
  }
}

/**
 * Manages route mappings stored as a JSON file on disk.
 * Supports file locking and stale-route cleanup.
 */
export class RouteStore {
  /** The state directory path. */
  readonly dir: string;
  private readonly routesPath: string;
  private readonly lockPath: string;
  readonly pidPath: string;
  readonly portFilePath: string;
  private readonly onWarning: ((message: string) => void) | undefined;

  constructor(dir: string, options?: { onWarning?: (message: string) => void }) {
    this.dir = dir;
    this.routesPath = path.join(dir, "routes.json");
    this.lockPath = path.join(dir, "routes.lock");
    this.pidPath = path.join(dir, "proxy.pid");
    this.portFilePath = path.join(dir, "proxy.port");
    this.onWarning = options?.onWarning;
  }

  ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
    }
    try {
      fs.chmodSync(this.dir, DIR_MODE);
    } catch {
      // May fail if directory is owned by another user; non-fatal
    }
    fixOwnership(this.dir);
  }

  getRoutesPath(): string {
    return this.routesPath;
  }

  // Locking
  // ---------------------------------------------------------------------------

  private static readonly sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

  private syncSleep(ms: number): void {
    Atomics.wait(RouteStore.sleepBuffer, 0, 0, ms);
  }

  private acquireLock(): boolean {
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let delay = LOCK_RETRY_BASE_MS;

    while (Date.now() < deadline) {
      try {
        fs.mkdirSync(this.lockPath);
        return true;
      } catch (err: unknown) {
        if (!isErrnoException(err)) return false;
        if (err.code === "EEXIST") {
          try {
            const stat = fs.statSync(this.lockPath);
            if (Date.now() - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
              fs.rmSync(this.lockPath, { recursive: true });
              continue;
            }
          } catch {
            continue;
          }
        } else if (process.platform !== "win32" || err.code !== "EPERM") {
          return false;
        }
        const jitter = Math.floor(Math.random() * delay);
        this.syncSleep(delay + jitter);
        delay = Math.min(delay * 2, LOCK_RETRY_CAP_MS);
      }
    }
    return false;
  }

  private releaseLock(): void {
    try {
      fs.rmSync(this.lockPath, { recursive: true });
    } catch {
      // Lock may already be removed; non-fatal
    }
  }

  // Route I/O
  // ---------------------------------------------------------------------------

  /** Whether the process that owns `route` is still running. */
  isRouteOwnerAlive(route: RouteMapping): boolean {
    return route.pid === 0 || this.isProcessAlive(route.pid);
  }

  private isProcessAlive(pid: number): boolean {
    return pid === 0 || isPidAlive(pid);
  }

  /**
   * Load the routes a caller should act on: entries whose portless process is
   * still alive, plus aliases. Stale entries stay in the file for `prune`.
   * With `persistCleanup` the caller holds the lock and ordinary stale entries
   * are dropped from disk, while records with recovery data are kept.
   */
  loadRoutes(persistCleanup = false): RouteMapping[] {
    const routes = this.readRouteFile(this.routesPath);
    const kept = retainStaleRecords(routes);
    if (persistCleanup && kept.length !== routes.length) {
      try {
        this.saveRoutes(kept);
      } catch {
        // Write may fail (permissions); non-fatal
      }
    }
    return kept.filter((route) => !isStaleRoute(route));
  }

  private withLock<T>(run: () => T): T {
    this.ensureDir();
    if (!this.acquireLock()) {
      throw new Error("Failed to acquire route lock");
    }
    try {
      return run();
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Apply one change under the route lock. Every write works on the whole
   * stored array, so stale records with recovery data survive route adds,
   * updates, takeover and removals until `prune` resolves them.
   */
  private mutateRoutes<T>(
    mutate: (routes: RouteMapping[]) => { value: T; changed: boolean },
    replaceSkippedHostname?: string
  ): T {
    return this.withLock(() => {
      const routes = this.readRouteFile(this.routesPath);
      const outcome = mutate(routes);
      if (outcome.changed) this.saveRoutes(retainStaleRecords(routes), replaceSkippedHostname);
      return outcome.value;
    });
  }

  private skippedRoutes(): unknown[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.routesPath, "utf-8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return [];
      throw err;
    }
    try {
      const existing: unknown = JSON.parse(raw);
      return Array.isArray(existing) ? existing.filter((value) => !isValidRoute(value)) : [];
    } catch {
      return [];
    }
  }

  private hasSkippedRoute(hostname: string): boolean {
    return this.skippedRoutes().some(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "hostname" in value &&
        value.hostname === hostname
    );
  }

  private saveRoutes(routes: RouteMapping[], replaceSkippedHostname?: string): void {
    const skipped = this.skippedRoutes().filter(
      (value) =>
        replaceSkippedHostname === undefined ||
        typeof value !== "object" ||
        value === null ||
        !("hostname" in value) ||
        value.hostname !== replaceSkippedHostname
    );
    const tempPath = `${this.routesPath}.tmp`;
    try {
      fs.rmSync(tempPath, { force: true });
      fs.writeFileSync(
        tempPath,
        JSON.stringify([...orderActiveFirst(routes), ...skipped], null, 2),
        {
          mode: FILE_MODE,
          flag: "wx",
        }
      );
      fixOwnership(tempPath);
      fs.renameSync(tempPath, this.routesPath);
    } catch (err) {
      fs.rmSync(tempPath, { force: true });
      throw err;
    }
  }

  private readRouteFile(file: string): RouteMapping[] {
    if (!fs.existsSync(file)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(file, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.onWarning?.(`Corrupted routes file (invalid JSON): ${file}`);
        return [];
      }
      if (!Array.isArray(parsed)) {
        this.onWarning?.(`Corrupted routes file (expected array): ${file}`);
        return [];
      }
      const routes = orderActiveFirst(parsed.filter(isValidRoute));
      if (routes.length !== parsed.length) {
        this.onWarning?.(`Skipped invalid route entries in ${file}`);
      }
      return routes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onWarning?.(`Could not read routes file: ${message}`);
      return [];
    }
  }

  /**
   * Register a route. When `force` is true and the hostname is already claimed
   * by another live process, that process is sent SIGTERM before the route is
   * replaced. Returns the PID of the killed process (if any) so the caller can
   * log it. A stale record for the same hostname is left for `prune`.
   */
  addRoute(
    hostname: string,
    port: number,
    pid: number,
    force = false,
    upstream?: RouteInfo["upstream"]
  ): number | undefined {
    if (upstream !== undefined && !isValidUpstream(upstream)) {
      throw new Error("Invalid upstream configuration");
    }
    let killedPid: number | undefined;
    this.mutateRoutes(
      (routes) => {
        if (!force && this.hasSkippedRoute(hostname)) {
          throw new Error(
            `"${hostname}" has an invalid or unsupported stored route. Use --force to replace it.`
          );
        }
        const existing = findActiveRoute(routes, hostname);
        const isAlias = existing?.pid === 0;
        if (existing && existing.pid !== pid) {
          if (!force) {
            throw new RouteConflictError(hostname, existing.pid);
          }
          // --force: kill the existing process before taking over; an alias has none
          if (!isAlias) {
            try {
              process.kill(existing.pid, "SIGTERM");
              killedPid = existing.pid;
            } catch {
              // Process may have exited between the check and the kill; non-fatal
            }
          }
        }
        const kept = routes.filter((route) => route.hostname !== hostname || isStaleRoute(route));
        kept.push({
          hostname,
          port,
          pid,
          registeredAt: Date.now(),
          ...(upstream === undefined ? {} : { upstream }),
        });
        routes.length = 0;
        routes.push(...kept);
        return { value: undefined, changed: true };
      },
      force ? hostname : undefined
    );
    return killedPid;
  }

  /**
   * Load all valid routes without filtering out dead PIDs, with active entries
   * before stale recovery records. Used by `portless prune` to discover stale
   * entries whose owning CLI is gone but whose dev server may still hold a
   * port, and by startup and doctor views that must see recovery records.
   */
  loadRoutesRaw(): RouteMapping[] {
    return this.readRouteFile(this.routesPath);
  }

  /** Return routes whose owners are dead without removing them from storage. */
  findStaleRoutes(): RouteMapping[] {
    return this.withLock(() => this.readRouteFile(this.routesPath).filter(isStaleRoute));
  }

  /**
   * Record the group member `prune` verified this run, only while the stored
   * stale record is still the one it examined.
   */
  recordStaleOrphan(route: RouteMapping, orphanPid: number, orphanStartTime: string): boolean {
    return this.mutateRoutes((routes) => {
      const current = routes.find((entry) => isSameRouteRecord(entry, route));
      if (!current || !isStaleRoute(current)) return { value: false, changed: false };
      current.orphanPid = orphanPid;
      current.orphanStartTime = orphanStartTime;
      return { value: true, changed: true };
    });
  }

  /** Remove one route only while its recorded owner is still dead. */
  removeStaleRoute(hostname: string, ownerPid: number): boolean {
    return this.mutateRoutes((routes) => {
      const index = routes.findIndex(
        (route) => route.hostname === hostname && route.pid === ownerPid && isStaleRoute(route)
      );
      if (index === -1) return { value: false, changed: false };
      routes.splice(index, 1);
      return { value: true, changed: true };
    });
  }

  /**
   * Update metadata on an existing route entry. Only provided fields are
   * merged. The live entry for the hostname is updated, so a stale record with
   * the same hostname keeps the metadata it needs for recovery.
   */
  updateRoute(hostname: string, fields: RouteMetadataPatch): void {
    this.mutateRoutes((routes) => {
      const route = findActiveRoute(routes, hostname);
      if (!route) return { value: undefined, changed: false };
      if ("childPgid" in fields) {
        if (fields.childPgid === null) delete route.childPgid;
        else if (fields.childPgid !== undefined) route.childPgid = fields.childPgid;
      }
      if ("childStartTime" in fields) {
        if (fields.childStartTime === null) delete route.childStartTime;
        else if (fields.childStartTime !== undefined) route.childStartTime = fields.childStartTime;
      }
      if ("tailscaleUrl" in fields) {
        if (fields.tailscaleUrl === null) delete route.tailscaleUrl;
        else if (fields.tailscaleUrl !== undefined) route.tailscaleUrl = fields.tailscaleUrl;
      }
      if ("tailscaleHttpsPort" in fields) {
        if (fields.tailscaleHttpsPort === null) delete route.tailscaleHttpsPort;
        else if (fields.tailscaleHttpsPort !== undefined)
          route.tailscaleHttpsPort = fields.tailscaleHttpsPort;
      }
      if ("tailscaleFunnel" in fields) {
        if (fields.tailscaleFunnel === null) delete route.tailscaleFunnel;
        else if (fields.tailscaleFunnel !== undefined)
          route.tailscaleFunnel = fields.tailscaleFunnel;
      }
      if ("ngrokUrl" in fields) {
        if (fields.ngrokUrl === null) delete route.ngrokUrl;
        else if (fields.ngrokUrl !== undefined) route.ngrokUrl = fields.ngrokUrl;
      }
      if ("ngrokPid" in fields) {
        if (fields.ngrokPid === null) delete route.ngrokPid;
        else if (fields.ngrokPid !== undefined) route.ngrokPid = fields.ngrokPid;
      }
      if ("cloudflareUrl" in fields) {
        if (fields.cloudflareUrl === null) delete route.cloudflareUrl;
        else if (fields.cloudflareUrl !== undefined) route.cloudflareUrl = fields.cloudflareUrl;
      }
      if ("cloudflarePid" in fields) {
        if (fields.cloudflarePid === null) delete route.cloudflarePid;
        else if (fields.cloudflarePid !== undefined) route.cloudflarePid = fields.cloudflarePid;
      }
      return { value: undefined, changed: true };
    });
  }

  /**
   * Hand a route over to another process. Only applies while the route is
   * still owned by `fromPid`, so a `--force` takeover is never overwritten.
   */
  transferRoute(hostname: string, fromPid: number, toPid: number): boolean {
    return this.mutateRoutes((routes) => {
      const route = routes.find(
        (entry) => entry.hostname === hostname && entry.pid === fromPid && !isStaleRoute(entry)
      );
      if (!route) return { value: false, changed: false };
      route.pid = toPid;
      // Tunnels and Serve config stop with the previous owner.
      delete route.ngrokUrl;
      delete route.ngrokPid;
      delete route.cloudflareUrl;
      delete route.cloudflarePid;
      delete route.tailscaleUrl;
      delete route.tailscaleHttpsPort;
      delete route.tailscaleFunnel;
      return { value: true, changed: true };
    });
  }

  /**
   * Remove a route by hostname. When `ownerPid` is provided, the entry is
   * only removed while it is still owned by that pid. Exit cleanups must
   * pass their own pid: after a `--force` takeover the killed process would
   * otherwise deregister the route the new owner just registered. Stale
   * records are left for `prune`.
   */
  removeRoute(hostname: string, ownerPid?: number): void {
    this.mutateRoutes((routes) => {
      const kept = routes.filter(
        (route) =>
          route.hostname !== hostname ||
          isStaleRoute(route) ||
          (ownerPid !== undefined && route.pid !== ownerPid)
      );
      const changed = kept.length !== routes.length;
      routes.length = 0;
      routes.push(...kept);
      return { value: undefined, changed };
    });
  }
}

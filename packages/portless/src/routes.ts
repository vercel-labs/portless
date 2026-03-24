import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { RouteInfo } from "./types.js";
import { SYSTEM_STATE_DIR } from "./cli-utils.js";
import { fixOwnership, isErrnoException } from "./utils.js";

/** How long (ms) before a lock directory is considered stale and forcibly removed. */
const STALE_LOCK_THRESHOLD_MS = 10_000;

/** Default maximum number of retries when acquiring the file lock. */
const LOCK_MAX_RETRIES = 20;

/** Delay (ms) between lock acquisition retries. */
const LOCK_RETRY_DELAY_MS = 50;

/** File permission mode for route and state files. */
export const FILE_MODE = 0o644;

/** Directory permission mode for the user state directory. */
export const DIR_MODE = 0o755;

/** Directory permission mode for the system state directory (world-writable with sticky bit). */
export const SYSTEM_DIR_MODE = 0o1777;

/** File permission mode for shared state files in the system state directory. */
export const SYSTEM_FILE_MODE = 0o666;

export interface RouteMapping extends RouteInfo {
  pid: number;
}

interface ActiveTcpListener {
  hostname: string;
  listenPort: number;
  targetPort: number;
  status: "active" | "closing";
}

async function canListenOnLocalhost(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

/** Runtime check that a parsed JSON value is a valid RouteMapping. */
function isValidRoute(value: unknown): value is RouteMapping {
  const route = value as RouteMapping;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof route.hostname === "string" &&
    typeof route.port === "number" &&
    typeof route.pid === "number" &&
    (route.type === undefined || route.type === "http" || route.type === "tcp") &&
    (route.listenPort === undefined || typeof route.listenPort === "number")
  );
}

/**
 * Thrown when a route is already registered by a live process and --force
 * was not specified.
 */
export class RouteConflictError extends Error {
  readonly hostname: string;
  readonly existingPid: number;

  constructor(hostname: string, existingPid: number) {
    super(
      `"${hostname}" is already registered by a running process (PID ${existingPid}). ` +
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
  readonly tcpListenersPath: string;
  private readonly onWarning: ((message: string) => void) | undefined;

  constructor(dir: string, options?: { onWarning?: (message: string) => void }) {
    this.dir = dir;
    this.routesPath = path.join(dir, "routes.json");
    this.lockPath = path.join(dir, "routes.lock");
    this.pidPath = path.join(dir, "proxy.pid");
    this.portFilePath = path.join(dir, "proxy.port");
    this.tcpListenersPath = path.join(dir, "tcp-listeners.json");
    this.onWarning = options?.onWarning;
  }

  private isSystemDir(): boolean {
    return this.dir === SYSTEM_STATE_DIR;
  }

  private get dirMode(): number {
    return this.isSystemDir() ? SYSTEM_DIR_MODE : DIR_MODE;
  }

  private get fileMode(): number {
    return this.isSystemDir() ? SYSTEM_FILE_MODE : FILE_MODE;
  }

  ensureDir(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: this.dirMode });
    }
    try {
      fs.chmodSync(this.dir, this.dirMode);
    } catch {
      // May fail if directory is owned by another user (e.g. root); non-fatal
    }
    fixOwnership(this.dir);
  }

  getRoutesPath(): string {
    return this.routesPath;
  }

  // -- Locking ---------------------------------------------------------------

  private static readonly sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

  private syncSleep(ms: number): void {
    Atomics.wait(RouteStore.sleepBuffer, 0, 0, ms);
  }

  private acquireLock(maxRetries = LOCK_MAX_RETRIES, retryDelayMs = LOCK_RETRY_DELAY_MS): boolean {
    for (let i = 0; i < maxRetries; i++) {
      try {
        fs.mkdirSync(this.lockPath);
        return true;
      } catch (err: unknown) {
        if (isErrnoException(err) && err.code === "EEXIST") {
          // Check for stale lock
          try {
            const stat = fs.statSync(this.lockPath);
            if (Date.now() - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
              fs.rmSync(this.lockPath, { recursive: true });
              continue;
            }
          } catch {
            // Lock dir gone already; retry
            continue;
          }
          // Wait and retry
          this.syncSleep(retryDelayMs);
        } else {
          // Unexpected error (e.g. missing parent dir); cannot acquire lock
          return false;
        }
      }
    }
    // Timed out waiting for lock
    return false;
  }

  private releaseLock(): void {
    try {
      fs.rmSync(this.lockPath, { recursive: true });
    } catch {
      // Lock may already be removed; non-fatal
    }
  }

  // -- Route I/O -------------------------------------------------------------

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "EPERM") {
        return true;
      }
      return false;
    }
  }

  private isProxyDaemonAlive(): boolean {
    try {
      const pid = parseInt(fs.readFileSync(this.pidPath, "utf-8"), 10);
      return !isNaN(pid) && this.isProcessAlive(pid);
    } catch {
      return false;
    }
  }

  loadActiveTcpListeners(): ActiveTcpListener[] {
    if (!this.isProxyDaemonAlive()) return [];
    if (!fs.existsSync(this.tcpListenersPath)) return [];

    try {
      const raw = fs.readFileSync(this.tcpListenersPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed.filter(
        (listener): listener is ActiveTcpListener =>
          typeof listener === "object" &&
          listener !== null &&
          typeof (listener as ActiveTcpListener).hostname === "string" &&
          typeof (listener as ActiveTcpListener).listenPort === "number" &&
          typeof (listener as ActiveTcpListener).targetPort === "number" &&
          ((listener as ActiveTcpListener).status === "active" ||
            (listener as ActiveTcpListener).status === "closing")
      );
    } catch {
      return [];
    }
  }

  /**
   * Load routes from disk, filtering out stale entries whose owning process
   * is no longer alive. Stale-route cleanup is only persisted when the caller
   * already holds the lock (i.e. inside addRoute/removeRoute) to avoid
   * unprotected concurrent writes.
   */
  loadRoutes(persistCleanup = false): RouteMapping[] {
    if (!fs.existsSync(this.routesPath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.routesPath, "utf-8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.onWarning?.(`Corrupted routes file (invalid JSON): ${this.routesPath}`);
        return [];
      }
      if (!Array.isArray(parsed)) {
        this.onWarning?.(`Corrupted routes file (expected array): ${this.routesPath}`);
        return [];
      }
      const routes: RouteMapping[] = parsed.filter(isValidRoute);
      // Filter out stale routes whose owning process is no longer alive
      const alive = routes.filter((r) => r.pid === 0 || this.isProcessAlive(r.pid));
      if (persistCleanup && alive.length !== routes.length) {
        // Persist the cleaned-up list so stale entries don't accumulate.
        // Only safe when caller holds the lock.
        try {
          fs.writeFileSync(this.routesPath, JSON.stringify(alive, null, 2), {
            mode: this.fileMode,
          });
        } catch {
          // Write may fail (permissions); non-fatal
        }
      }
      return alive;
    } catch {
      return [];
    }
  }

  private saveRoutes(routes: RouteMapping[]): void {
    fs.writeFileSync(this.routesPath, JSON.stringify(routes, null, 2), { mode: this.fileMode });
    fixOwnership(this.routesPath);
  }

  addRoute(
    hostname: string,
    port: number,
    pid: number,
    force = false,
    extra?: { type?: "tcp"; listenPort?: number }
  ): void {
    this.ensureDir();
    if (!this.acquireLock()) {
      throw new Error("Failed to acquire route lock");
    }
    try {
      const routes = this.loadRoutes(true);
      const existing = routes.find((r) => r.hostname === hostname);
      if (existing && existing.pid !== pid && this.isProcessAlive(existing.pid) && !force) {
        throw new RouteConflictError(hostname, existing.pid);
      }
      const filtered = routes.filter((r) => r.hostname !== hostname);
      filtered.push({
        hostname,
        port,
        pid,
        type: extra?.type,
        listenPort: extra?.listenPort,
      });
      this.saveRoutes(filtered);
    } finally {
      this.releaseLock();
    }
  }

  async addTcpRoute(
    hostname: string,
    port: number,
    pid: number,
    force = false,
    options: { minListenPort: number; maxListenPort: number }
  ): Promise<number> {
    this.ensureDir();
    for (let attempt = 0; attempt < 5; attempt++) {
      let candidatePorts: number[] = [];

      // We need one lock pass to derive candidate ports from the latest route
      // table, then release it before async bind probes, and finally re-lock
      // before saving to avoid holding the directory lock across async I/O.
      if (!this.acquireLock()) {
        throw new Error("Failed to acquire route lock");
      }
      try {
        const routes = this.loadRoutes(true);
        const existing = routes.find((r) => r.hostname === hostname);
        if (existing && existing.pid !== pid && this.isProcessAlive(existing.pid) && !force) {
          throw new RouteConflictError(hostname, existing.pid);
        }

        const filtered = routes.filter((r) => r.hostname !== hostname);

        if (existing?.type === "tcp" && existing.listenPort !== undefined) {
          const activeListeners = this.loadActiveTcpListeners();
          const existingListenerActive = activeListeners.some(
            (listener) =>
              listener.hostname === hostname && listener.listenPort === existing.listenPort
          );

          if (existingListenerActive) {
            filtered.push({
              hostname,
              port,
              pid,
              type: "tcp",
              listenPort: existing.listenPort,
            });
            this.saveRoutes(filtered);
            return existing.listenPort;
          }

          candidatePorts.push(existing.listenPort);
        }

        const usedListenPorts = new Set(
          filtered
            .filter((route) => route.type === "tcp" && route.listenPort !== undefined)
            .map((route) => route.listenPort as number)
        );

        candidatePorts = candidatePorts.filter((candidate) => !usedListenPorts.has(candidate));
        for (
          let candidate = options.minListenPort;
          candidate <= options.maxListenPort;
          candidate++
        ) {
          if (usedListenPorts.has(candidate) || candidatePorts.includes(candidate)) continue;
          candidatePorts.push(candidate);
        }
      } finally {
        this.releaseLock();
      }

      let selectedPort: number | null = null;
      for (const candidate of candidatePorts) {
        if (await canListenOnLocalhost(candidate)) {
          selectedPort = candidate;
          break;
        }
      }
      if (selectedPort === null) {
        throw new Error(
          `No free TCP proxy port found in range ${options.minListenPort}-${options.maxListenPort}.`
        );
      }

      if (!this.acquireLock()) {
        throw new Error("Failed to acquire route lock");
      }
      try {
        const routes = this.loadRoutes(true);
        const existing = routes.find((r) => r.hostname === hostname);
        if (existing && existing.pid !== pid && this.isProcessAlive(existing.pid) && !force) {
          throw new RouteConflictError(hostname, existing.pid);
        }

        const filtered = routes.filter((r) => r.hostname !== hostname);
        const usedListenPorts = new Set(
          filtered
            .filter((route) => route.type === "tcp" && route.listenPort !== undefined)
            .map((route) => route.listenPort as number)
        );
        // There is still a small TOCTOU window between the bind probe above and
        // the daemon actually listening on the selected port. We re-check
        // route-level ownership here to avoid duplicate assignments, and the
        // daemon's EADDRINUSE handling covers the remaining race with external
        // processes.
        if (usedListenPorts.has(selectedPort)) continue;

        filtered.push({
          hostname,
          port,
          pid,
          type: "tcp",
          listenPort: selectedPort,
        });
        this.saveRoutes(filtered);
        return selectedPort;
      } finally {
        this.releaseLock();
      }
    }

    throw new Error("Failed to allocate TCP proxy port due to concurrent route updates.");
  }

  removeRoute(hostname: string): void {
    this.ensureDir();
    if (!this.acquireLock()) {
      throw new Error("Failed to acquire route lock");
    }
    try {
      const routes = this.loadRoutes(true).filter((r) => r.hostname !== hostname);
      this.saveRoutes(routes);
    } finally {
      this.releaseLock();
    }
  }
}

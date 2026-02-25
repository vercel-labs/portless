import * as fs from "node:fs";
import * as path from "node:path";
import type { RouteInfo } from "./types.js";
import { fixOwnership, isErrnoException } from "./utils.js";
import { SYSTEM_STATE_DIR } from "./cli-utils.js";

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

/** Runtime check that a parsed JSON value is a valid RouteMapping. */
function isValidRoute(value: unknown): value is RouteMapping {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RouteMapping).hostname === "string" &&
    typeof (value as RouteMapping).port === "number" &&
    typeof (value as RouteMapping).pid === "number"
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
  private readonly onWarning: ((message: string) => void) | undefined;

  constructor(dir: string, options?: { onWarning?: (message: string) => void }) {
    this.dir = dir;
    this.routesPath = path.join(dir, "routes.json");
    this.lockPath = path.join(dir, "routes.lock");
    this.pidPath = path.join(dir, "proxy.pid");
    this.portFilePath = path.join(dir, "proxy.port");
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
    } catch {
      return false;
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
      const alive = routes.filter((r) => this.isProcessAlive(r.pid));
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

  addRoute(hostname: string, port: number, pid: number, force = false): void {
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
      filtered.push({ hostname, port, pid });
      this.saveRoutes(filtered);
    } finally {
      this.releaseLock();
    }
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

/**
 * Until the first lease, the proxy never idles out this soon (ms) after it
 * starts listening, so an auto-start has time to register and lease the route
 * it was started for.
 */
export const IDLE_EXIT_BOOT_GRACE_MS = 30_000;

/** Most leases the proxy holds at once, so it never becomes an fd sink. */
export const MAX_LEASES = 32;

/** The open response a `portless run` holds; it closes when that process exits. */
export interface LeaseConnection {
  on(event: "close", listener: () => void): unknown;
  end(): void;
}

export type LeaseResult = "held" | "full" | "closing";

export interface IdleExitTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export interface IdleExitTrackerOptions {
  /** How long (ms) the proxy lingers after its last lease closes; 0 turns idle exit off. */
  graceMs: number;
  /**
   * Whether routes.json still has an alias or a route with a live owner. A
   * route handed to a self-daemonized server (#444) has an owner but no lease.
   */
  hasLiveRoutes: () => boolean;
  /** Stop the proxy. Called at most once. */
  onIdle: () => void;
  maxLeases?: number;
  timers?: IdleExitTimers;
}

const defaultTimers: IdleExitTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Track the leases held by running apps and stop the proxy once none has
 * been held for `graceMs`. A lease closing starts the countdown and a new
 * lease cancels it, so nothing polls.
 */
export function createIdleExitTracker(options: IdleExitTrackerOptions) {
  const timers = options.timers ?? defaultTimers;
  const maxLeases = options.maxLeases ?? MAX_LEASES;
  const leases = new Set<LeaseConnection>();
  let bootUntil: number | null = null;
  let leasedOnce = false;
  let pinned = false;
  let closed = false;
  let timer: unknown = null;

  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };

  const arm = () => {
    cancel();
    if (options.graceMs <= 0 || bootUntil === null || closed || pinned || leases.size > 0) {
      return;
    }
    const delay = leasedOnce
      ? options.graceMs
      : Math.max(options.graceMs, bootUntil - timers.now());
    timer = timers.setTimeout(expire, delay);
  };

  function expire() {
    timer = null;
    // One read of routes.json per expiry: a lease-less live route re-arms.
    if (options.hasLiveRoutes()) {
      arm();
      return;
    }
    closed = true;
    options.onIdle();
  }

  return {
    /** Start the boot grace; call once the proxy is listening. */
    start(): void {
      bootUntil = timers.now() + Math.max(options.graceMs, IDLE_EXIT_BOOT_GRACE_MS);
      arm();
    },

    /** Hold `connection` until it closes. */
    lease(connection: LeaseConnection): LeaseResult {
      if (closed) return "closing";
      if (leases.size >= maxLeases) return "full";
      leases.add(connection);
      leasedOnce = true;
      cancel();
      connection.on("close", () => {
        if (leases.delete(connection) && leases.size === 0) arm();
      });
      return "held";
    },

    /** Keep the proxy up while static aliases exist, which no process leases. */
    setPinned(value: boolean): void {
      if (value === pinned) return;
      pinned = value;
      if (pinned) cancel();
      else arm();
    },

    /** Refuse new leases and end the held ones, for a shutdown. */
    closeAll(): void {
      closed = true;
      cancel();
      const held = [...leases];
      leases.clear();
      for (const connection of held) connection.end();
    },
  };
}

export type IdleExitTracker = ReturnType<typeof createIdleExitTracker>;

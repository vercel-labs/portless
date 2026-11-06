import { describe, expect, it, vi } from "vitest";
import { createIdleExitTracker, IDLE_EXIT_BOOT_GRACE_MS } from "./idle-exit.js";
import type { IdleExitTimers, LeaseConnection } from "./idle-exit.js";

/** Timers driven by advance(), so every test controls the clock exactly. */
function createFakeTimers(): IdleExitTimers & {
  advance: (ms: number) => void;
  pending: () => number;
} {
  let now = 0;
  let nextId = 1;
  const scheduled = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = nextId++;
      scheduled.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => {
      scheduled.delete(handle as number);
    },
    advance: (ms) => {
      const until = now + ms;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        scheduled.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
    pending: () => scheduled.size,
  };
}

/** A lease connection the test can close, like a `portless run` process exiting. */
function createConnection(): LeaseConnection & { close: () => void; ended: boolean } {
  const listeners: (() => void)[] = [];
  const connection = {
    ended: false,
    on: (_event: "close", listener: () => void) => listeners.push(listener),
    end: () => {
      connection.ended = true;
      connection.close();
    },
    close: () => {
      for (const listener of listeners.splice(0)) listener();
    },
  };
  return connection;
}

function setup(graceMs = 5000, options: { maxLeases?: number } = {}) {
  const timers = createFakeTimers();
  const state = { liveRoutes: false };
  const onIdle = vi.fn();
  const hasLiveRoutes = vi.fn(() => state.liveRoutes);
  const tracker = createIdleExitTracker({
    graceMs,
    hasLiveRoutes,
    onIdle,
    timers,
    maxLeases: options.maxLeases,
  });
  return { timers, state, onIdle, hasLiveRoutes, tracker };
}

describe("createIdleExitTracker", () => {
  it("stops after the boot grace when nothing ever leases", () => {
    const { timers, onIdle, tracker } = setup();
    tracker.start();
    timers.advance(IDLE_EXIT_BOOT_GRACE_MS - 1);
    expect(onIdle).not.toHaveBeenCalled();
    timers.advance(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("uses the linger as the boot grace when the linger is longer", () => {
    const { timers, onIdle, tracker } = setup(60_000);
    tracker.start();
    timers.advance(59_999);
    expect(onIdle).not.toHaveBeenCalled();
    timers.advance(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("does not count before the proxy is listening", () => {
    const { timers, onIdle } = setup();
    timers.advance(10 * IDLE_EXIT_BOOT_GRACE_MS);
    expect(onIdle).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it("lingers after the last lease closes, even inside the boot grace", () => {
    const { timers, onIdle, tracker } = setup();
    tracker.start();
    const lease = createConnection();
    expect(tracker.lease(lease)).toBe("held");
    timers.advance(1000);
    lease.close();
    timers.advance(4999);
    expect(onIdle).not.toHaveBeenCalled();
    timers.advance(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("stays up while any lease is held and stops after the last one", () => {
    const { timers, onIdle, tracker } = setup();
    tracker.start();
    const web = createConnection();
    const storybook = createConnection();
    tracker.lease(web);
    tracker.lease(storybook);
    storybook.close();
    timers.advance(10 * IDLE_EXIT_BOOT_GRACE_MS);
    expect(onIdle).not.toHaveBeenCalled();
    web.close();
    timers.advance(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending exit when a new lease arrives", () => {
    const { timers, onIdle, tracker } = setup();
    tracker.start();
    const first = createConnection();
    tracker.lease(first);
    first.close();
    timers.advance(4000);
    const second = createConnection();
    tracker.lease(second);
    timers.advance(10 * IDLE_EXIT_BOOT_GRACE_MS);
    expect(onIdle).not.toHaveBeenCalled();
    second.close();
    timers.advance(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("fires at most once and refuses leases afterwards", () => {
    const { timers, onIdle, tracker } = setup();
    tracker.start();
    timers.advance(IDLE_EXIT_BOOT_GRACE_MS);
    expect(tracker.lease(createConnection())).toBe("closing");
    timers.advance(10 * IDLE_EXIT_BOOT_GRACE_MS);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toBe(0);
  });

  it("refuses leases over the cap", () => {
    const { tracker } = setup(5000, { maxLeases: 2 });
    tracker.start();
    expect(tracker.lease(createConnection())).toBe("held");
    expect(tracker.lease(createConnection())).toBe("held");
    expect(tracker.lease(createConnection())).toBe("full");
  });

  it("ends held leases on closeAll and never fires afterwards", () => {
    const { timers, onIdle, tracker } = setup();
    tracker.start();
    const leases = [createConnection(), createConnection()];
    for (const lease of leases) tracker.lease(lease);
    tracker.closeAll();
    expect(leases.every((lease) => lease.ended)).toBe(true);
    expect(tracker.lease(createConnection())).toBe("closing");
    timers.advance(10 * IDLE_EXIT_BOOT_GRACE_MS);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("stays up while an alias pins it and lingers once the alias is gone", () => {
    const { timers, onIdle, tracker } = setup();
    tracker.setPinned(true);
    tracker.start();
    timers.advance(10 * IDLE_EXIT_BOOT_GRACE_MS);
    expect(onIdle).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
    tracker.setPinned(false);
    timers.advance(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("keeps the boot grace when an alias goes away before any lease", () => {
    const { timers, onIdle, tracker } = setup();
    tracker.setPinned(true);
    tracker.start();
    timers.advance(1000);
    tracker.setPinned(false);
    timers.advance(IDLE_EXIT_BOOT_GRACE_MS - 1001);
    expect(onIdle).not.toHaveBeenCalled();
    timers.advance(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("re-arms instead of stopping while routes.json has a live route without a lease (#444)", () => {
    const { timers, state, onIdle, hasLiveRoutes, tracker } = setup();
    tracker.start();
    const launcher = createConnection();
    tracker.lease(launcher);
    // The launcher exits; its route now belongs to the server it daemonized.
    state.liveRoutes = true;
    launcher.close();
    timers.advance(5000);
    expect(hasLiveRoutes).toHaveBeenCalledTimes(1);
    expect(onIdle).not.toHaveBeenCalled();
    timers.advance(5000);
    expect(hasLiveRoutes).toHaveBeenCalledTimes(2);

    state.liveRoutes = false;
    timers.advance(5000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("reads routes.json only when a countdown expires", () => {
    const { timers, hasLiveRoutes, tracker } = setup();
    tracker.start();
    const lease = createConnection();
    tracker.lease(lease);
    timers.advance(10 * IDLE_EXIT_BOOT_GRACE_MS);
    expect(hasLiveRoutes).not.toHaveBeenCalled();
    expect(timers.pending()).toBe(0);
  });

  it("schedules nothing when idle exit is off, but still holds leases", () => {
    const { timers, onIdle, hasLiveRoutes, tracker } = setup(0);
    tracker.start();
    const lease = createConnection();
    expect(tracker.lease(lease)).toBe("held");
    lease.close();
    timers.advance(10 * IDLE_EXIT_BOOT_GRACE_MS);
    expect(timers.pending()).toBe(0);
    expect(hasLiveRoutes).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });
});

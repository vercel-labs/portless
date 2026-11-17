import { afterEach, describe, expect, it, vi } from "vitest";
import { startLanIpMonitor } from "./mdns.js";

describe("startLanIpMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports LAN IP changes, loss, and recovery", async () => {
    vi.useFakeTimers();

    let currentIp: string | null = "192.168.1.42";
    const changes: Array<[string | null, string | null]> = [];
    const monitor = startLanIpMonitor({
      initialIp: currentIp,
      intervalMs: 1000,
      resolveIp: async () => currentIp,
      onChange: (nextIp, previousIp) => {
        changes.push([nextIp, previousIp]);
      },
    });

    currentIp = "192.168.1.77";
    await vi.advanceTimersByTimeAsync(1000);
    currentIp = null;
    await vi.advanceTimersByTimeAsync(1000);
    currentIp = "192.168.1.99";
    await vi.advanceTimersByTimeAsync(1000);

    monitor.stop();

    expect(changes).toEqual([
      ["192.168.1.77", "192.168.1.42"],
      [null, "192.168.1.77"],
      ["192.168.1.99", null],
    ]);
  });

  it("does not notify when the LAN IP is unchanged", async () => {
    vi.useFakeTimers();

    const onChange = vi.fn();
    const monitor = startLanIpMonitor({
      initialIp: "192.168.1.42",
      intervalMs: 1000,
      resolveIp: async () => "192.168.1.42",
      onChange,
    });

    await vi.advanceTimersByTimeAsync(3000);
    monitor.stop();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("invokes onError when resolveIp throws", async () => {
    vi.useFakeTimers();

    const errors: unknown[] = [];
    const monitor = startLanIpMonitor({
      initialIp: "192.168.1.42",
      intervalMs: 1000,
      resolveIp: async () => {
        throw new Error("network gone");
      },
      onChange: () => {},
      onError: (err) => {
        errors.push(err);
      },
    });

    await vi.advanceTimersByTimeAsync(1000);
    monitor.stop();

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("network gone");
  });

  it("stops polling after stop is called", async () => {
    vi.useFakeTimers();

    let currentIp = "192.168.1.42";
    const onChange = vi.fn();
    const monitor = startLanIpMonitor({
      initialIp: currentIp,
      intervalMs: 1000,
      resolveIp: async () => currentIp,
      onChange,
    });

    monitor.stop();
    currentIp = "192.168.1.77";
    await vi.advanceTimersByTimeAsync(1000);

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("publish", () => {
  afterEach(() => {
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  async function loadWithFakeSpawn() {
    vi.resetModules();
    const { EventEmitter } = await import("node:events");
    type FakeChild = InstanceType<typeof EventEmitter> & { kill: ReturnType<typeof vi.fn> };
    const children: FakeChild[] = [];
    vi.doMock("node:child_process", () => ({
      spawnSync: vi.fn(() => ({})),
      spawn: vi.fn(() => {
        const child = Object.assign(new EventEmitter(), { kill: vi.fn() }) as FakeChild;
        children.push(child);
        return child;
      }),
    }));
    const mdns = await import("./mdns.js");
    return { mdns, children };
  }

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "keeps tracking a replacement publisher when the old one exits late",
    async () => {
      const { mdns, children } = await loadWithFakeSpawn();

      mdns.publish("myapp.local", 443, "192.168.1.10");
      // Port change: unpublish + republish before the old child exits.
      mdns.unpublish("myapp.local");
      mdns.publish("myapp.local", 443, "192.168.1.10");
      children[0].emit("exit", null, "SIGTERM");

      expect(mdns.getPublished()).toEqual(["myapp.local"]);

      // The route is removed later; the live publisher must still be killed.
      mdns.unpublish("myapp.local");
      expect(children[1].kill).toHaveBeenCalledWith("SIGTERM");
    }
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "keeps tracking republished hostnames after cleanupAll on LAN IP change",
    async () => {
      const { mdns, children } = await loadWithFakeSpawn();

      mdns.publish("a.local", 443, "192.168.1.10");
      mdns.publish("b.local", 443, "192.168.1.10");
      mdns.cleanupAll();
      mdns.publish("a.local", 443, "192.168.1.20");
      mdns.publish("b.local", 443, "192.168.1.20");
      children[0].emit("exit", null, "SIGTERM");
      children[1].emit("error", new Error("late"));

      expect(mdns.getPublished().sort()).toEqual(["a.local", "b.local"]);
    }
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "forgets a publisher that exits on its own",
    async () => {
      const { mdns, children } = await loadWithFakeSpawn();

      mdns.publish("myapp.local", 443, "192.168.1.10");
      children[0].emit("exit", 1, null);

      expect(mdns.getPublished()).toEqual([]);
    }
  );
});

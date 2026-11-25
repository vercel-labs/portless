import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMdnsController, startLanIpMonitor } from "./mdns.js";

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

describe("createMdnsController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function publishers(stubborn = false) {
    const children: Array<ChildProcess & { signals: string[] }> = [];
    const commands: Array<{ command: string; args: string[] }> = [];
    const spawnProcess = vi.fn((command: string, args: string[]) => {
      commands.push({ command, args });
      const child = new EventEmitter() as ChildProcess & { signals: string[] };
      Object.assign(child, {
        pid: 10000 + children.length,
        exitCode: null,
        signalCode: null,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        signals: [],
        kill: (signal: string) => {
          child.signals.push(signal);
          if (!stubborn || signal === "SIGKILL") {
            Object.assign(child, { signalCode: signal as NodeJS.Signals });
            child.emit("exit", null, signal);
            child.emit("close", null, signal);
          }
          return true;
        },
      });
      children.push(child);
      return child;
    });
    return { children, commands, spawnProcess: spawnProcess as unknown as typeof spawn };
  }

  it("stops removed routes and all routes without reporting intentional exits", async () => {
    const { children, spawnProcess } = publishers();
    const onError = vi.fn();
    const controller = createMdnsController({
      platform: "darwin",
      spawn: spawnProcess,
      listProcesses: () => "",
    });
    await controller.reconcile("192.168.1.1", ["one", { hostname: "two.local" }], 443, onError);
    await controller.reconcile("192.168.1.1", ["two.local"], 443, onError);
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(children[1].signals).toEqual([]);
    await controller.reconcile(null, [], 443, onError);
    expect(children[1].signals).toEqual(["SIGTERM"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("waits for a stubborn publisher to die before publishing the new IP", async () => {
    vi.useFakeTimers();
    const { children, commands, spawnProcess } = publishers(true);
    const controller = createMdnsController({
      platform: "darwin",
      spawn: spawnProcess,
      listProcesses: () => "",
      stopGraceMs: 50,
    });
    await controller.reconcile("192.168.1.1", ["one"]);
    const change = controller.reconcile("192.168.1.2", ["one"]);
    await vi.advanceTimersByTimeAsync(49);
    expect(children[0].signals).toEqual(["SIGTERM"]);
    expect(commands).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await change;
    expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(children[0].signalCode).toBe("SIGKILL");
    expect(commands[1].args.at(-1)).toBe("192.168.1.2");
  });

  it.each([
    ["darwin", "/usr/bin/dns-sd -P one _http._tcp local 443 one.local 192.168.1.1"],
    ["linux", "/usr/bin/avahi-publish-address -f -R one.local 192.168.1.1"],
  ] as const)(
    "sweeps matching %s orphans without touching active or unrelated processes",
    async (platform, command) => {
      const { children, spawnProcess } = publishers();
      const killPid = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      });
      let output = "";
      const listProcesses = vi.fn(() => output);
      const controller = createMdnsController({
        platform,
        spawn: spawnProcess,
        listProcesses,
        killPid,
      });
      await controller.reconcile("192.168.1.1", ["one"]);
      output = `${children[0].pid} ${command}\n20001 ${command}\n20002 ${command} extra\n${process.pid} ${command}`;
      await controller.reconcile("192.168.1.1", ["one", "one.local"]);
      expect(killPid).toHaveBeenCalledWith(20001, "SIGTERM");
      expect(killPid).not.toHaveBeenCalledWith(children[0].pid, expect.anything());
      expect(killPid).not.toHaveBeenCalledWith(20002, expect.anything());
      expect(killPid).not.toHaveBeenCalledWith(process.pid, expect.anything());
      expect(listProcesses).toHaveBeenCalledTimes(2);
    }
  );

  it("escalates an orphan that survives the grace period before publishing", async () => {
    vi.useFakeTimers();
    const { commands, spawnProcess } = publishers();
    const killPid = vi.fn();
    const controller = createMdnsController({
      platform: "linux",
      spawn: spawnProcess,
      killPid,
      stopGraceMs: 50,
      listProcesses: () => "20001 avahi-publish-address -f -R one.local 192.168.1.1",
    });
    const start = controller.reconcile("192.168.1.1", ["one"]);
    await vi.advanceTimersByTimeAsync(49);
    expect(killPid).toHaveBeenCalledWith(20001, "SIGTERM");
    expect(killPid).not.toHaveBeenCalledWith(20001, "SIGKILL");
    expect(commands).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await start;
    expect(killPid).toHaveBeenCalledWith(20001, "SIGKILL");
    expect(commands).toHaveLength(1);
  });

  it("kills matching publishers when a stopped child never confirms exit", async () => {
    vi.useFakeTimers();
    const { children, spawnProcess } = publishers(true);
    const killPid = vi.fn();
    const controller = createMdnsController({
      platform: "linux",
      spawn: spawnProcess,
      killPid,
      stopGraceMs: 20,
      stopKillWaitMs: 20,
      listProcesses: () =>
        children.length
          ? `20001 avahi-publish-address -R one.local 192.168.1.1\n20002 avahi-publish-address -R other.local 192.168.1.1`
          : "",
    });
    await controller.reconcile("192.168.1.1", ["one"]);
    children[0].kill = (signal) => {
      children[0].signals.push(String(signal));
      return true;
    };
    const stop = controller.reconcile(null, []);
    await vi.advanceTimersByTimeAsync(40);
    await stop;
    expect(children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(killPid).toHaveBeenCalledWith(20001, "SIGKILL");
    expect(killPid).not.toHaveBeenCalledWith(20002, expect.anything());
  });

  it("coalesces overlapping reconciliations to the latest desired state", async () => {
    vi.useFakeTimers();
    const { commands, spawnProcess } = publishers(true);
    const controller = createMdnsController({
      platform: "linux",
      spawn: spawnProcess,
      listProcesses: () => "",
      stopGraceMs: 50,
    });
    await controller.reconcile("192.168.1.1", ["one"]);
    const first = controller.reconcile("192.168.1.2", ["two"]);
    await vi.advanceTimersByTimeAsync(10);
    const latest = controller.reconcile("192.168.1.3", ["three"]);
    expect(latest).toBe(first);
    await vi.advanceTimersByTimeAsync(40);
    await latest;
    expect(commands.map(({ args }) => args.slice(-2))).toEqual([
      ["one.local", "192.168.1.1"],
      ["three.local", "192.168.1.3"],
    ]);
  });

  it("reports repeated failures once and retries on each reconcile", async () => {
    const { children, commands, spawnProcess } = publishers();
    const onError = vi.fn();
    const controller = createMdnsController({
      platform: "linux",
      spawn: spawnProcess,
      listProcesses: () => "",
    });
    await controller.reconcile("192.168.1.1", ["one"], 443, onError);
    children[0].stderr?.emit("data", "failure\n");
    children[0].emit("close", 1, null);
    await controller.reconcile("192.168.1.1", ["one"], 443, onError);
    children[1].stderr?.emit("data", "failure\n");
    children[1].emit("close", 1, null);
    await controller.reconcile("192.168.1.1", ["one"], 443, onError);
    expect(commands).toHaveLength(3);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("mDNS publishing for one failed: failure");
  });
});

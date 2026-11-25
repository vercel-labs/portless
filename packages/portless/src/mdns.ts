import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { isIP } from "node:net";
import path from "node:path";

import { getLocalNetworkIp } from "./lan-ip.js";

type MdnsPublisher = {
  command: string;
  probeArgs: string[];
  missingReason: string;
  buildArgs: (fqdn: string, name: string, port: number, ip: string) => string[];
};

type LanIpMonitorOptions = {
  initialIp: string | null;
  intervalMs?: number;
  resolveIp?: () => Promise<string | null>;
  onChange: (nextIp: string | null, previousIp: string | null) => void;
  onError?: (error: unknown) => void;
};

/** Polling interval (ms) for refreshing the auto-detected LAN IP. */
export const LAN_IP_POLL_INTERVAL_MS = 5000;

function getMdnsPublisher(platform: NodeJS.Platform = process.platform): MdnsPublisher | null {
  if (platform === "darwin") {
    return {
      command: "dns-sd",
      probeArgs: ["-h"],
      missingReason: "dns-sd not found",
      buildArgs: (fqdn, name, port, ip) => [
        "-P",
        name,
        "_http._tcp",
        "local",
        port.toString(),
        fqdn,
        ip,
      ],
    };
  }

  if (platform === "linux") {
    return {
      command: "avahi-publish-address",
      probeArgs: ["--help"],
      missingReason:
        "avahi-publish-address not found. Install avahi-utils: sudo apt install avahi-utils",
      buildArgs: (fqdn, _name, _port, ip) => ["-f", "-R", fqdn, ip],
    };
  }

  return null;
}

function hasCommand(command: string, probeArgs: string[]): boolean {
  const result = spawnSync(command, probeArgs, {
    stdio: "ignore",
    timeout: 1000,
    windowsHide: true,
  });
  return (result.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
}

/**
 * Poll the default LAN IP and notify when it changes.
 *
 * Used only for auto-detected LAN mode so the daemon can follow Wi-Fi/IP
 * changes without changing the explicit `--ip` contract.
 */
export function startLanIpMonitor(options: LanIpMonitorOptions): { stop: () => void } {
  const resolveIp = options.resolveIp ?? getLocalNetworkIp;
  let currentIp = options.initialIp;
  let stopped = false;
  let polling = false;

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      const nextIp = await resolveIp();
      if (stopped || nextIp === currentIp) return;
      const previousIp = currentIp;
      currentIp = nextIp;
      options.onChange(nextIp, previousIp);
    } catch (error) {
      options.onError?.(error);
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, options.intervalMs ?? LAN_IP_POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Check if mDNS publishing is supported on the current platform.
 */
export function isMdnsSupported(): { supported: boolean; reason?: string } {
  const publisher = getMdnsPublisher();
  if (!publisher) {
    return { supported: false, reason: "mDNS publishing is not supported on this platform" };
  }

  if (!hasCommand(publisher.command, publisher.probeArgs)) {
    return { supported: false, reason: publisher.missingReason };
  }

  return { supported: true };
}

/**
 * Check that the system mDNS daemon accepts clients, returning why not or null.
 * Only Linux needs this: avahi-daemon is optional there, while macOS always runs mDNSResponder.
 */
export function getMdnsDaemonProblem(): string | null {
  if (process.platform !== "linux") return null;
  const result = spawnSync("avahi-browse", ["--cache", "_http._tcp"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 1000,
  });
  if (result.status === 0) return null;
  return (
    result.stderr?.trim() ||
    result.error?.message ||
    `avahi-browse exited with code ${result.status}`
  );
}

/**
 * Extract the service name from a hostname for dns-sd registration.
 * e.g., "myapp.local" -> "myapp", "api.myapp.local" -> "api.myapp"
 */
function serviceName(hostname: string): string {
  return hostname.replace(/\.local$/, "");
}

export const MDNS_STOP_GRACE_MS = 500;
export const MDNS_KILL_WAIT_MS = 500;

type Publication =
  | {
      state: "publishing";
      ip: string;
      port: number;
      fqdn: string;
      args: string[];
      child: ChildProcess;
    }
  | {
      state: "stopping";
      ip: string;
      port: number;
      fqdn: string;
      args: string[];
      child: ChildProcess;
      done: Promise<void>;
    }
  | { state: "failed"; ip: string; port: number; error: string };

function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function resolvePublisherIdentity(options: MdnsControllerOptions): {
  uid?: number;
  gid?: number;
  dropPrivileges: boolean;
} {
  if (options.uid !== undefined) {
    return { uid: options.uid, gid: options.gid, dropPrivileges: false };
  }
  const processUid = process.getuid?.();
  if (processUid === undefined) return { dropPrivileges: false };
  if (processUid === 0) {
    const sudoUid = parseNonNegativeInt(process.env.SUDO_UID);
    const sudoGid = parseNonNegativeInt(process.env.SUDO_GID);
    if (sudoUid !== undefined && sudoUid > 0) {
      return { uid: sudoUid, gid: sudoGid, dropPrivileges: true };
    }
  }
  return { uid: processUid, dropPrivileges: false };
}

export interface MdnsControllerOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  gid?: number;
  spawn?: typeof spawn;
  listProcesses?: () => string;
  killPid?: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  stopGraceMs?: number;
  stopKillWaitMs?: number;
}

export interface MdnsController {
  reconcile(
    ip: string | null,
    routes: Iterable<string | { hostname: string }>,
    port?: number,
    onError?: (msg: string) => void
  ): Promise<void>;
}

function fqdnFor(hostname: string): string {
  return hostname.endsWith(".local") ? hostname : `${hostname}.local`;
}

function findMatchingPublisherPids(
  output: string,
  platform: NodeJS.Platform,
  fqdns: Set<string>,
  excludePids: Set<number>,
  owner: { pid: number; uid: number | undefined; port: number; ip?: string }
): number[] {
  const matches: number[] = [];
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const pidText = parts.shift() ?? "";
    const ppidText = parts.shift() ?? "";
    const uidText = parts.shift() ?? "";
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const uid = Number(uidText);
    if (
      !/^\d+$/.test(pidText) ||
      !/^\d+$/.test(ppidText) ||
      !/^\d+$/.test(uidText) ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      pid === owner.pid ||
      excludePids.has(pid)
    )
      continue;
    if (owner.uid !== undefined && uid !== owner.uid) continue;
    if (ppid !== owner.pid && ppid !== 1) continue;
    const command = path.basename(parts[0] ?? "");
    const portText = String(owner.port);
    for (const fqdn of fqdns) {
      const darwinIp = parts[7] ?? "";
      const darwinMatch =
        platform === "darwin" &&
        command === "dns-sd" &&
        parts.length === 8 &&
        parts[1] === "-P" &&
        parts[2] === serviceName(fqdn) &&
        parts[3] === "_http._tcp" &&
        parts[4] === "local" &&
        parts[5] === portText &&
        parts[6] === fqdn &&
        isIP(darwinIp) !== 0 &&
        (owner.ip === undefined || darwinIp === owner.ip);
      const linuxIp = parts.length === 5 ? (parts[4] ?? "") : (parts[3] ?? "");
      const linuxMatch =
        platform === "linux" &&
        command === "avahi-publish-address" &&
        ((parts.length === 5 &&
          parts[1] === "-f" &&
          parts[2] === "-R" &&
          parts[3] === fqdn &&
          isIP(linuxIp) !== 0) ||
          (parts.length === 4 && parts[1] === "-R" && parts[2] === fqdn && isIP(linuxIp) !== 0)) &&
        (owner.ip === undefined || linuxIp === owner.ip);
      if (darwinMatch || linuxMatch) {
        matches.push(pid);
        break;
      }
    }
  }
  return matches;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
    child.once("close", onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

export function createMdnsController(options: MdnsControllerOptions = {}): MdnsController {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawn ?? spawn;
  const listProcesses =
    options.listProcesses ??
    (() =>
      spawnSync("ps", ["-eo", "pid=,ppid=,uid=,args="], { encoding: "utf8", timeout: 1000 })
        .stdout ?? "");
  const identity = resolvePublisherIdentity(options);
  const currentUid = identity.uid;
  const killPid = options.killPid ?? ((pid, signal) => process.kill(pid, signal));
  const stopGraceMs = options.stopGraceMs ?? MDNS_STOP_GRACE_MS;
  const stopKillWaitMs = options.stopKillWaitMs ?? MDNS_KILL_WAIT_MS;
  const publications = new Map<string, Publication>();
  let desired: {
    ip: string | null;
    port: number;
    hostnames: Set<string>;
    onError?: (msg: string) => void;
  } = {
    ip: null,
    port: 443,
    hostnames: new Set(),
  };
  let dirty = false;
  let active: Promise<void> | undefined;

  const trackedPids = () =>
    new Set(
      [...publications.values()].flatMap((pub) =>
        pub.state === "publishing" && pub.child.pid !== undefined ? [pub.child.pid] : []
      )
    );
  const matchingPids = (hostnames: string[], port: number, ip?: string) =>
    findMatchingPublisherPids(
      listProcesses(),
      platform,
      new Set(hostnames.map(fqdnFor)),
      trackedPids(),
      {
        pid: process.pid,
        uid: currentUid,
        port,
        ip,
      }
    );
  const signalPid = (pid: number, signal: NodeJS.Signals | 0): boolean => {
    try {
      killPid(pid, signal);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const signalChild = (child: ChildProcess, signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };

  const stopPublication = (hostname: string, pub: Publication): Promise<void> => {
    if (pub.state === "stopping") return pub.done;
    if (pub.state === "failed") {
      publications.delete(hostname);
      return Promise.resolve();
    }
    const stopping: Extract<Publication, { state: "stopping" }> = {
      ...pub,
      state: "stopping",
      done: Promise.resolve(),
    };
    const done = Promise.resolve()
      .then(async () => {
        let exited = waitForExit(pub.child, stopGraceMs);
        signalChild(pub.child, "SIGTERM");
        if (!(await exited)) {
          exited = waitForExit(pub.child, stopKillWaitMs);
          signalChild(pub.child, "SIGKILL");
          if (!(await exited)) {
            for (const pid of matchingPids([hostname], pub.port, pub.ip)) signalPid(pid, "SIGKILL");
          }
        }
      })
      .finally(() => {
        if (publications.get(hostname) === stopping) publications.delete(hostname);
      });
    stopping.done = done;
    publications.set(hostname, stopping);
    return done;
  };

  const sweepOrphans = async (hostnames: string[], port: number) => {
    const pids = matchingPids(hostnames, port);
    if (pids.length === 0) return;
    for (const pid of pids) signalPid(pid, "SIGTERM");
    const deadline = Date.now() + stopGraceMs;
    let alive = pids.filter((pid) => signalPid(pid, 0));
    while (alive.length > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(25, deadline - Date.now()));
        timer.unref?.();
      });
      alive = alive.filter((pid) => signalPid(pid, 0));
    }
    for (const pid of alive) signalPid(pid, "SIGKILL");
  };

  const spawnPublication = (
    hostname: string,
    port: number,
    ip: string,
    onError?: (msg: string) => void
  ) => {
    const previous = publications.get(hostname);
    const previousError = previous?.state === "failed" ? previous.error : undefined;
    const fqdn = fqdnFor(hostname);
    const publisher = getMdnsPublisher(platform);
    if (!publisher) return;
    const args = publisher.buildArgs(fqdn, serviceName(fqdn), port, ip);
    const spawnOpts: Parameters<typeof spawn>[2] = {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      ...(identity.dropPrivileges && identity.uid !== undefined ? { uid: identity.uid } : {}),
      ...(identity.dropPrivileges && identity.gid !== undefined ? { gid: identity.gid } : {}),
    };
    const child = spawnProcess(publisher.command, args, spawnOpts);
    let lastLine = "";
    const keepLastLine = (chunk: string) => {
      const output = lastLine + chunk;
      lastLine = output.slice(output.trimEnd().lastIndexOf("\n") + 1);
    };
    child.stdout?.setEncoding("utf8").on("data", keepLastLine);
    child.stderr?.setEncoding("utf8").on("data", keepLastLine);
    const fail = (error: string) => {
      const current = publications.get(hostname);
      if (current?.state !== "publishing" || current.child !== child) return;
      publications.set(hostname, { state: "failed", ip, port, error });
      if (previousError !== error) onError?.(`mDNS publishing for ${hostname} failed: ${error}`);
    };
    child.on("error", (err) => {
      fail(
        (err as NodeJS.ErrnoException).code === "ENOENT" ? publisher.missingReason : err.message
      );
    });
    child.on("close", (code, signal) => {
      fail(
        signal
          ? `${publisher.command} was stopped by ${signal}`
          : lastLine.trim() || `${publisher.command} exited with code ${code}`
      );
    });
    publications.set(hostname, { state: "publishing", ip, port, fqdn, args, child });
  };

  const sync = async () => {
    try {
      while (dirty) {
        dirty = false;
        const target = desired;
        const stopPromises: Promise<void>[] = [];
        for (const [hostname, pub] of [...publications.entries()]) {
          const wanted = target.ip !== null && target.hostnames.has(hostname);
          const matchesTarget =
            wanted &&
            pub.state === "publishing" &&
            pub.ip === target.ip &&
            pub.port === target.port;
          if (matchesTarget) continue;
          if (pub.state === "failed") {
            if (!wanted || pub.ip !== target.ip || pub.port !== target.port)
              publications.delete(hostname);
            continue;
          }
          stopPromises.push(stopPublication(hostname, pub));
        }
        if (stopPromises.length > 0) await Promise.all(stopPromises);
        if (dirty) continue;
        if (target.ip === null) continue;
        const ip = target.ip;
        const toSpawn = [...target.hostnames].filter((hostname) => {
          const cur = publications.get(hostname);
          return cur?.state !== "publishing" || cur.ip !== ip || cur.port !== target.port;
        });
        if (toSpawn.length > 0) {
          await sweepOrphans(toSpawn, target.port);
          if (dirty) continue;
          for (const hostname of toSpawn)
            spawnPublication(hostname, target.port, ip, target.onError);
        }
      }
    } finally {
      active = undefined;
    }
  };

  return {
    reconcile(ip, routes, port = 443, onError) {
      desired = {
        ip,
        port,
        hostnames: new Set(
          [...routes].map((route) => (typeof route === "string" ? route : route.hostname))
        ),
        onError,
      };
      dirty = true;
      if (!active) {
        active = Promise.resolve().then(sync);
      }
      return active;
    },
  };
}

const defaultController = createMdnsController();

export function reconcile(
  ip: string | null,
  routes: Iterable<string | { hostname: string }>,
  port = 443,
  onError?: (msg: string) => void
): Promise<void> {
  return defaultController.reconcile(ip, routes, port, onError);
}

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { getLocalNetworkIp } from "./lan-ip.js";

export { getLocalNetworkIp };

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

/** Map of hostname -> running dns-sd/avahi child process. */
const activePublishers = new Map<string, ChildProcess>();

/** Polling interval (ms) for refreshing the auto-detected LAN IP. */
export const LAN_IP_POLL_INTERVAL_MS = 5000;

function getMdnsPublisher(): MdnsPublisher | null {
  if (process.platform === "darwin") {
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

  if (process.platform === "linux") {
    return {
      command: "avahi-publish-address",
      probeArgs: ["--help"],
      missingReason:
        "avahi-publish-address not found. Install avahi-utils: sudo apt install avahi-utils",
      buildArgs: (fqdn, _name, _port, ip) => ["-R", fqdn, ip],
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
 * Extract the service name from a hostname for dns-sd registration.
 * e.g., "myapp.local" -> "myapp", "api.myapp.local" -> "api.myapp"
 */
function serviceName(hostname: string): string {
  return hostname.replace(/\.local$/, "");
}

/**
 * Publish an mDNS record for a hostname.
 *
 * On macOS: spawns `dns-sd -P` which publishes both a DNS-SD service record
 * and an A record mapping the hostname to the given IP.
 *
 * On Linux: spawns `avahi-publish-address` to create an mDNS A record.
 *
 * The child process stays alive to maintain the record. Call unpublish()
 * or cleanupAll() to remove it.
 */
export function publish(
  hostname: string,
  port: number,
  ip: string,
  onError?: (msg: string) => void
): void {
  // Don't double-publish
  if (activePublishers.has(hostname)) return;

  const fqdn = hostname.endsWith(".local") ? hostname : `${hostname}.local`;
  const name = serviceName(fqdn);
  const publisher = getMdnsPublisher();
  if (!publisher) {
    return;
  }

  const child = spawn(publisher.command, publisher.buildArgs(fqdn, name, port, ip), {
    stdio: "ignore",
    detached: false,
  });

  child.on("error", (err) => {
    activePublishers.delete(hostname);
    const msg =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? publisher.missingReason
        : `mDNS publish error for ${hostname}: ${err.message}`;
    onError?.(msg);
  });

  child.on("exit", () => {
    activePublishers.delete(hostname);
  });

  activePublishers.set(hostname, child);
}

/**
 * Unpublish a previously published mDNS record by killing its child process.
 */
export function unpublish(hostname: string): void {
  const child = activePublishers.get(hostname);
  if (!child) return;
  activePublishers.delete(hostname);
  child.kill("SIGTERM");
}

/**
 * Kill all active mDNS publisher processes. Called during proxy shutdown.
 */
export function cleanupAll(): void {
  for (const child of activePublishers.values()) {
    child.kill("SIGTERM");
  }
  activePublishers.clear();
}

/**
 * Return the list of currently published hostnames.
 */
export function getPublished(): string[] {
  return [...activePublishers.keys()];
}

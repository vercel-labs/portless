import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { getPlatformCapabilities, type MdnsPublisherSpec } from "./capabilities.js";
import { getLocalNetworkIp } from "./lan-ip.js";

export { getLocalNetworkIp };

type LanIpMonitorOptions = {
  initialIp: string | null;
  intervalMs?: number;
  resolveIp?: () => Promise<string | null>;
  onChange: (nextIp: string | null, previousIp: string | null) => void;
  onError?: (error: unknown) => void;
};

/** Lifecycle of one hostname's mDNS record. A hostname with no entry is unpublished. */
type Publication =
  | { state: "publishing"; child: ChildProcess }
  | { state: "failed"; error: string };

/** Map of hostname -> mDNS publication. */
const publications = new Map<string, Publication>();

/** Polling interval (ms) for refreshing the auto-detected LAN IP. */
export const LAN_IP_POLL_INTERVAL_MS = 5000;

function getMdnsPublisher(): MdnsPublisherSpec | null {
  const caps = getPlatformCapabilities();
  return caps.lanMdns.supported ? caps.lanMdns.publisher : null;
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
export function isMdnsSupported(): { supported: boolean; reason?: string; hint?: string } {
  const caps = getPlatformCapabilities();
  if (!caps.lanMdns.supported) {
    return {
      supported: false,
      reason: caps.lanMdns.reason,
      ...(caps.lanMdns.hint ? { hint: caps.lanMdns.hint } : {}),
    };
  }

  const publisher = caps.lanMdns.publisher;
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

/**
 * Publish an mDNS record for a hostname.
 *
 * On macOS: spawns `dns-sd -P` which publishes both a DNS-SD service record
 * and an A record mapping the hostname to the given IP.
 *
 * On Linux: spawns `avahi-publish-address` to create an mDNS A record. It
 * waits for avahi-daemon when the daemon is not running yet.
 *
 * The child process stays alive to maintain the record. Call unpublish()
 * or cleanupAll() to remove it. If it exits on its own, onError gets its
 * error (unless it repeats the previous one) and the next publish() retries.
 */
export function publish(
  hostname: string,
  port: number,
  ip: string,
  onError?: (msg: string) => void
): void {
  const previous = publications.get(hostname);
  // Don't double-publish
  if (previous?.state === "publishing") return;

  const fqdn = hostname.endsWith(".local") ? hostname : `${hostname}.local`;
  const name = serviceName(fqdn);
  const publisher = getMdnsPublisher();
  if (!publisher) {
    return;
  }

  const child = spawn(publisher.command, publisher.buildArgs(fqdn, name, port, ip), {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
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
    publications.set(hostname, { state: "failed", error });
    if (previous?.error !== error) onError?.(`mDNS publishing for ${hostname} failed: ${error}`);
  };

  child.on("error", (err) => {
    fail((err as NodeJS.ErrnoException).code === "ENOENT" ? publisher.missingReason : err.message);
  });

  child.on("close", (code, signal) => {
    fail(
      signal
        ? `${publisher.command} was stopped by ${signal}`
        : lastLine.trim() || `${publisher.command} exited with code ${code}`
    );
  });

  publications.set(hostname, { state: "publishing", child });
}

/**
 * Unpublish a previously published mDNS record by killing its child process.
 */
export function unpublish(hostname: string): void {
  const publication = publications.get(hostname);
  publications.delete(hostname);
  if (publication?.state === "publishing") publication.child.kill("SIGTERM");
}

/**
 * Kill all active mDNS publisher processes. Called during proxy shutdown.
 */
export function cleanupAll(): void {
  for (const publication of publications.values()) {
    if (publication.state === "publishing") publication.child.kill("SIGTERM");
  }
  publications.clear();
}

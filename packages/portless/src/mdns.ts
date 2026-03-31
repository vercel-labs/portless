import { spawn, type ChildProcess } from "node:child_process";
import * as os from "node:os";

/** Map of hostname -> running dns-sd/avahi child process. */
const activePublishers = new Map<string, ChildProcess>();

/**
 * Detect the local network IP address.
 * Returns the first non-internal IPv4 address, preferring common
 * interface names (en0, eth0, wlan0). Returns null if offline.
 */
export function getLocalNetworkIp(): string | null {
  const interfaces = os.networkInterfaces();
  const preferred = ["en0", "eth0", "wlan0", "Wi-Fi"];

  // Check preferred interfaces first
  for (const name of preferred) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }

  // Fall back to any non-internal IPv4
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }

  return null;
}

/**
 * Check if mDNS publishing is supported on the current platform.
 */
export function isMdnsSupported(): { supported: boolean; reason?: string } {
  if (process.platform === "darwin") {
    return { supported: true };
  }
  if (process.platform === "linux") {
    return { supported: true };
  }
  return { supported: false, reason: "mDNS publishing is not supported on this platform" };
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
  let child: ChildProcess;

  if (process.platform === "darwin") {
    // dns-sd -P <name> <type> <domain> <port> <host> <ip>
    child = spawn("dns-sd", ["-P", name, "_http._tcp", "local", port.toString(), fqdn, ip], {
      stdio: "ignore",
      detached: false,
    });
  } else if (process.platform === "linux") {
    // avahi-publish-address -R allows re-registration on conflict
    child = spawn("avahi-publish-address", ["-R", fqdn, ip], {
      stdio: "ignore",
      detached: false,
    });
  } else {
    return;
  }

  child.on("error", (err) => {
    activePublishers.delete(hostname);
    const msg =
      (err as NodeJS.ErrnoException).code === "ENOENT"
        ? process.platform === "linux"
          ? "avahi-publish-address not found. Install avahi-utils: sudo apt install avahi-utils"
          : "dns-sd not found"
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
  for (const [hostname, child] of activePublishers) {
    child.kill("SIGTERM");
    activePublishers.delete(hostname);
  }
}

/**
 * Return the list of currently published hostnames.
 */
export function getPublished(): string[] {
  return [...activePublishers.keys()];
}

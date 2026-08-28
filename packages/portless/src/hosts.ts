import * as fs from "node:fs";
import * as dns from "node:dns";
import * as path from "node:path";

const isWindows = process.platform === "win32";

const HOSTS_PATH = isWindows
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";
const LOOPBACK_ADDRESS = "127.0.0.1";
const MARKER_START = "# portless-start";
const MARKER_END = "# portless-end";

/**
 * Read the current /etc/hosts file content.
 * Returns empty string if the file cannot be read.
 */
function readHostsFile(): string {
  try {
    return fs.readFileSync(HOSTS_PATH, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Extract the portless-managed block from /etc/hosts content.
 * Returns the lines between the markers (exclusive), or an empty array
 * if no managed block exists.
 */
export function extractManagedBlock(content: string): string[] {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return [];
  const block = content.slice(startIdx + MARKER_START.length, endIdx);
  return block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Remove the portless-managed block from /etc/hosts content and return
 * the cleaned content with trailing newlines normalized.
 */
export function removeBlock(content: string): string {
  const startIdx = content.indexOf(MARKER_START);
  const endIdx = content.indexOf(MARKER_END);
  if (startIdx === -1 || endIdx === -1) return content;
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + MARKER_END.length);
  return (before + after).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Build a portless-managed block for the given hostnames.
 */
export function buildBlock(hostnames: string[]): string {
  if (hostnames.length === 0) return "";
  const entries = hostnames.map((h) => `${LOOPBACK_ADDRESS} ${h}`).join("\n");
  return `${MARKER_START}\n${entries}\n${MARKER_END}`;
}

/**
 * Whether the proxy should write route hostnames to the hosts file.
 * Disabled only when `PORTLESS_SYNC_HOSTS` is `0` or `false` (opt-out).
 */
export function shouldAutoSyncHosts(syncVal: string | undefined): boolean {
  return syncVal !== "0" && syncVal !== "false";
}

/**
 * Whether the managed block is exactly these hostnames, no others, each on
 * loopback. Exactness, not coverage: a superset means a removed route's entry is
 * still resolving. Pure so it is testable without the hosts path.
 */
export function blockMatchesHostnames(content: string, hostnames: string[]): boolean {
  const lines = extractManagedBlock(content);
  const wanted = new Set(hostnames);
  if (wanted.size !== hostnames.length) return false;
  const seen = new Set<string>();
  for (const line of lines) {
    const tokens = line.split("#", 1)[0].trim().split(/\s+/);
    const [address, ...aliases] = tokens;
    if (address !== LOOPBACK_ADDRESS || aliases.length === 0) return false;
    for (const hostname of aliases) {
      if (!wanted.has(hostname) || seen.has(hostname)) return false;
      seen.add(hostname);
    }
  }
  return seen.size === wanted.size;
}

/**
 * Rewrite the managed block to exactly these hostnames. Needs privilege.
 *
 * Returns whether the block matches afterwards, which is the writer's question.
 * Whether some hostname resolves is a weaker, different question: use
 * `checkHostResolution`, since a hosts entry is only one reason a name resolves.
 *
 * Skips the write when the block already matches, so a no-op reload does not
 * rewrite the file.
 */
export function syncHostsFile(hostnames: string[]): boolean {
  const content = readHostsFile();
  if (blockMatchesHostnames(content, hostnames)) return true;
  try {
    const cleaned = removeBlock(content);
    if (hostnames.length === 0) {
      fs.writeFileSync(HOSTS_PATH, cleaned);
    } else {
      const block = buildBlock(hostnames);
      fs.writeFileSync(HOSTS_PATH, cleaned.trimEnd() + "\n\n" + block + "\n");
    }
  } catch {
    return false;
  }
  // Re-read rather than assume the write landed.
  return blockMatchesHostnames(readHostsFile(), hostnames);
}

/**
 * Remove the portless-managed block from /etc/hosts.
 * Returns true on success, false on failure.
 */
export function cleanHostsFile(): boolean {
  try {
    const content = readHostsFile();
    if (!content.includes(MARKER_START)) return true;
    fs.writeFileSync(HOSTS_PATH, removeBlock(content));
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the current portless-managed hostnames from /etc/hosts.
 */
export function getManagedHostnames(): string[] {
  const content = readHostsFile();
  return extractManagedBlock(content).flatMap((line) => {
    const [, ...aliases] = line.split("#", 1)[0].trim().split(/\s+/);
    return aliases;
  });
}

/**
 * Check whether the system DNS resolver selects an address where the local
 * proxy listens.
 */
export function checkHostResolution(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    dns.lookup(hostname, (err, address) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(address === "127.0.0.1" || address === "::1");
    });
  });
}

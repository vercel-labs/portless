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
 * Whether the managed block is already exactly what a sync would write: these
 * hostnames, no others, each mapped to loopback.
 *
 * Exactness is the contract, not coverage. A subset test would call the block
 * correct while it still carried a hostname whose route was removed, and the
 * sync that skipped on the strength of that answer would leave the stale entry
 * resolving forever. It would also accept a wrong address, since a line is only
 * useful if it points at loopback.
 *
 * Pure, so the question can be tested without the hosts path, which is a module
 * constant with no test seam.
 */
export function blockMatchesHostnames(content: string, hostnames: string[]): boolean {
  const lines = extractManagedBlock(content);
  const wanted = new Set(hostnames);
  if (lines.length !== wanted.size) return false;
  const seen = new Set<string>();
  for (const line of lines) {
    const [address, hostname] = line.split(/\s+/);
    if (address !== LOOPBACK_ADDRESS || !hostname || !wanted.has(hostname)) return false;
    seen.add(hostname);
  }
  return seen.size === wanted.size;
}

/**
 * Whether the managed block resolves every given hostname, ignoring whatever
 * else it contains.
 *
 * This is the weaker question, and it is the right one to answer a caller with.
 * A caller asks "will my hostname resolve", and a stale entry left by some other
 * route does not change that answer.
 */
export function blockResolvesHostnames(content: string, hostnames: string[]): boolean {
  const managed = new Set(
    extractManagedBlock(content)
      .filter((line) => line.split(/\s+/)[0] === LOOPBACK_ADDRESS)
      .map((line) => line.split(/\s+/)[1] ?? "")
      .filter(Boolean)
  );
  return hostnames.every((hostname) => managed.has(hostname));
}

/**
 * Sync the hosts file so the portless-managed block resolves every given
 * hostname. Replaces any existing managed block. Writing needs privilege the
 * user may not have.
 *
 * Two different questions are asked here on purpose, and collapsing them into
 * one produces a defect either way.
 *
 * **Whether to skip** is exactness. The write rebuilds the block to exactly this
 * set, so only an already-exact block makes skipping it harmless. A coverage test
 * here calls a block correct while it still carries a hostname whose route was
 * removed, and the skip then leaves that entry resolving forever.
 *
 * **What to report** is coverage. The caller asks whether its own hostname will
 * resolve. Answering with exactness means an unprivileged daemon that cannot
 * delete someone else's stale entry reports failure to every later registration
 * whose hostname does resolve, which is a false alarm on the common path.
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
    // Unwritable, so the state is whatever it already was. Report on that state
    // rather than on the write, because the block may already resolve this
    // caller from an earlier run.
    return blockResolvesHostnames(content, hostnames);
  }
  // Re-read rather than assume the write landed.
  return blockResolvesHostnames(readHostsFile(), hostnames);
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
  return extractManagedBlock(content)
    .map((line) => {
      const parts = line.split(/\s+/);
      return parts.length >= 2 ? parts[1] : "";
    })
    .filter(Boolean);
}

/**
 * Check whether a hostname resolves to 127.0.0.1 via the system DNS resolver.
 * Returns true if resolution works, false otherwise.
 */
export function checkHostResolution(hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    dns.lookup(hostname, { family: 4 }, (err, address) => {
      if (err) {
        resolve(false);
        return;
      }
      resolve(address === "127.0.0.1");
    });
  });
}

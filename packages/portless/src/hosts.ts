import * as fs from "node:fs";
import * as dns from "node:dns";

const HOSTS_PATH = "/etc/hosts";
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
  const entries = hostnames.map((h) => `127.0.0.1 ${h}`).join("\n");
  return `${MARKER_START}\n${entries}\n${MARKER_END}`;
}

/**
 * Sync /etc/hosts to include entries for all given hostnames.
 * Replaces any existing portless-managed block. Requires root access.
 * Returns true on success, false on failure.
 */
export function syncHostsFile(hostnames: string[]): boolean {
  try {
    const content = readHostsFile();
    const cleaned = removeBlock(content);

    if (hostnames.length === 0) {
      fs.writeFileSync(HOSTS_PATH, cleaned);
    } else {
      const block = buildBlock(hostnames);
      fs.writeFileSync(HOSTS_PATH, cleaned.trimEnd() + "\n\n" + block + "\n");
    }
    return true;
  } catch {
    return false;
  }
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
 * Check whether a .localhost subdomain resolves to 127.0.0.1 via the
 * system DNS resolver. Returns true if resolution works, false otherwise.
 */
export function checkLocalhostResolution(hostname: string): Promise<boolean> {
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

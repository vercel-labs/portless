import * as crypto from "node:crypto";
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

/** Integrity of the portless-managed block in the hosts file. */
export type HostsBlockState = "ok" | "malformed";

/** Outcome of reconciling the portless-managed hosts block. */
export type HostsAction = "synced" | "cleaned" | "unchanged" | "failed";

/** Explicit result returned by hosts file sync and cleanup operations. */
export interface HostsResult {
  action: HostsAction;
  block: HostsBlockState;
  changed: boolean;
}

type ManagedBlockInspection =
  | { status: "absent" }
  | { status: "present"; startIdx: number; endIdx: number }
  | { status: "malformed" };

function inspectManagedBlock(content: string): ManagedBlockInspection {
  const occurrences = (marker: string): number[] => {
    const indices: number[] = [];
    let index = content.indexOf(marker);
    while (index !== -1) {
      indices.push(index);
      index = content.indexOf(marker, index + 1);
    }
    return indices;
  };
  const starts = occurrences(MARKER_START);
  const ends = occurrences(MARKER_END);
  if (starts.length === 0 && ends.length === 0) return { status: "absent" };
  if (starts.length === 1 && ends.length === 1 && starts[0] < ends[0]) {
    return { status: "present", startIdx: starts[0], endIdx: ends[0] };
  }
  return { status: "malformed" };
}

/**
 * Read the current /etc/hosts file content.
 * Returns null if the file cannot be read, including when it does not exist.
 */
function readHostsFile(): string | null {
  try {
    return fs.readFileSync(HOSTS_PATH, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Extract the portless-managed block from /etc/hosts content.
 * Returns the lines between the markers (exclusive), or an empty array
 * if no managed block exists.
 */
export function extractManagedBlock(content: string): string[] {
  const inspected = inspectManagedBlock(content);
  if (inspected.status !== "present") return [];
  const block = content.slice(inspected.startIdx + MARKER_START.length, inspected.endIdx);
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
  const inspected = inspectManagedBlock(content);
  if (inspected.status !== "present") return content;
  const before = content.slice(0, inspected.startIdx);
  const after = content.slice(inspected.endIdx + MARKER_END.length);
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
  const inspected = inspectManagedBlock(content);
  if (inspected.status === "malformed") return false;
  if (hostnames.length === 0) return inspected.status === "absent";
  if (inspected.status === "absent") return false;
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

function tryIgnore(fn: () => void): void {
  try {
    fn();
  } catch {
    return;
  }
}

function writeHostsFileAtomic(content: string, previousContent: string): void {
  let targetPath = HOSTS_PATH;
  tryIgnore(() => {
    targetPath = fs.realpathSync(HOSTS_PATH);
  });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.portless-hosts.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let mode = 0o644;
  tryIgnore(() => {
    mode = fs.statSync(targetPath).mode & 0o777;
  });
  try {
    fs.writeFileSync(tempPath, content, { mode, flag: "wx", flush: true });
    tryIgnore(() => {
      fs.chmodSync(tempPath, mode);
    });
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EBUSY" && code !== "EXDEV") throw renameError;
      tryIgnore(() => {
        fs.rmSync(tempPath, { force: true });
      });
      try {
        fs.writeFileSync(targetPath, content, { flush: true });
        return;
      } catch (fallbackError) {
        tryIgnore(() => {
          fs.writeFileSync(targetPath, previousContent, { flush: true });
        });
        throw fallbackError;
      }
    }
  } catch (error) {
    tryIgnore(() => {
      fs.rmSync(tempPath, { force: true });
    });
    throw error;
  }
}

function reconcileHostsFile(hostnames: string[]): HostsResult {
  const content = readHostsFile();
  if (content === null) return { action: "failed", block: "ok", changed: false };
  if (inspectManagedBlock(content).status === "malformed") {
    return { action: "failed", block: "malformed", changed: false };
  }
  if (blockMatchesHostnames(content, hostnames)) {
    return { action: "unchanged", block: "ok", changed: false };
  }
  const cleaned = removeBlock(content);
  const next =
    hostnames.length === 0 ? cleaned : cleaned.trimEnd() + "\n\n" + buildBlock(hostnames) + "\n";
  try {
    writeHostsFileAtomic(next, content);
  } catch {
    return { action: "failed", block: "ok", changed: false };
  }
  const verification = readHostsFile();
  if (verification === null) return { action: "failed", block: "ok", changed: false };
  if (inspectManagedBlock(verification).status === "malformed") {
    return { action: "failed", block: "malformed", changed: false };
  }
  if (!blockMatchesHostnames(verification, hostnames)) {
    return { action: "failed", block: "ok", changed: false };
  }
  return { action: hostnames.length === 0 ? "cleaned" : "synced", block: "ok", changed: true };
}

/** Rewrite the managed block to match the hostnames and report the result. */
export function syncHostsFile(hostnames: string[]): HostsResult {
  return reconcileHostsFile(hostnames);
}

/** Remove the managed block and report the result. */
export function cleanHostsFile(): HostsResult {
  return reconcileHostsFile([]);
}

/**
 * Return the current portless-managed hostnames from /etc/hosts.
 * A read failure returns an empty array for best-effort callers; it does not
 * prove that the hosts file is empty or was read successfully.
 */
export function getManagedHostnames(): string[] {
  const content = readHostsFile();
  if (content === null) return [];
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

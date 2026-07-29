import * as fs from "node:fs";
import * as path from "node:path";
import {
  HOSTS_SYNC_STATUS_FILE,
  isHostsSyncStatusTemp,
  LEGACY_SYSTEM_STATE_DIR,
  USER_STATE_DIR,
} from "./cli-utils.js";

/** Filenames portless creates under a state directory (allowlisted for clean). */
const PORTLESS_STATE_FILES = [
  "routes.json",
  "routes.lock",
  "proxy.pid",
  "proxy.port",
  "proxy.log",
  "proxy.tls",
  "proxy.custom-cert",
  "proxy.tld",
  "proxy.tlds",
  "proxy.lan",
  HOSTS_SYNC_STATUS_FILE,
  "ca.trusted",
  "ca.trust-refresh-pending",
  "ca-key.pem",
  "ca.pem",
  "server-key.pem",
  "server.pem",
  "server.csr",
  "server-ext.cnf",
  "ca.srl",
] as const;

const HOST_CERTS_DIR = "host-certs";
const CA_IDENTITY_FILES = new Set(["ca-key.pem", "ca.pem", "ca.trust-refresh-pending"]);

export type RemovePortlessStateFilesOptions = {
  preserveCAIdentity?: boolean;
};

export type CATrustRemovalResult = {
  removed: boolean;
  error?: string;
};

/**
 * Unique existing state directories to consider for cleanup: user dir, system
 * dir, and PORTLESS_STATE_DIR when set.
 */
export function collectStateDirsForCleanup(): string[] {
  const dirs = new Set<string>();
  const add = (d: string | undefined) => {
    const trimmed = d?.trim();
    if (!trimmed) return;
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved)) dirs.add(resolved);
  };
  add(USER_STATE_DIR);
  add(LEGACY_SYSTEM_STATE_DIR);
  add(process.env.PORTLESS_STATE_DIR);
  return [...dirs];
}

/** Attempt CA trust removal wherever cleanup finds a CA certificate. */
export function attemptCATrustRemovalForCleanup(
  stateDirs: string[],
  untrust: (stateDir: string) => CATrustRemovalResult
): Map<string, CATrustRemovalResult> {
  const results = new Map<string, CATrustRemovalResult>();
  for (const stateDir of stateDirs) {
    if (!fs.existsSync(path.join(stateDir, "ca.pem"))) continue;
    results.set(stateDir, untrust(stateDir));
  }
  return results;
}

/**
 * Best-effort removal of portless state files under dir. Only known filenames
 * are deleted; other files in the directory are left intact.
 */
export function removePortlessStateFiles(
  dir: string,
  options: RemovePortlessStateFilesOptions = {}
): void {
  for (const f of PORTLESS_STATE_FILES) {
    if (options.preserveCAIdentity && CA_IDENTITY_FILES.has(f)) continue;
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      // ENOENT or permission; non-fatal
    }
  }
  // The status file is written atomically as a temporary plus a rename, so a
  // crash between the two orphans a file whose name carries a PID. No static
  // allowlist can enumerate those. The match rule is not restated here: it is
  // owned by the writer's module, so changing the naming on one side cannot
  // silently leave the other side unable to find what it now creates.
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (!isHostsSyncStatusTemp(entry)) continue;
      try {
        fs.unlinkSync(path.join(dir, entry));
      } catch {
        // ENOENT or permission; non-fatal
      }
    }
  } catch {
    // Directory unreadable; the allowlist pass above already reported what it could.
  }
  try {
    fs.rmSync(path.join(dir, HOST_CERTS_DIR), { recursive: true, force: true });
  } catch {
    // non-fatal
  }
}

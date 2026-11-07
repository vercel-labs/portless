import * as fs from "node:fs";
import * as path from "node:path";
import { LEGACY_SYSTEM_STATE_DIR, USER_STATE_DIR } from "./cli-utils.js";

/** Filenames portless creates under a state directory (allowlisted for clean). */
const PORTLESS_STATE_FILES = [
  "routes.json",
  "routes.json.tmp",
  "routes.lock",
  "proxy.pid",
  "proxy.port",
  "proxy.log",
  "proxy.tls",
  "proxy.custom-cert",
  "proxy.tld",
  "proxy.tlds",
  "proxy.lan",
  "proxy.hosts-sync-token",
  "proxy.hosts-sync-token.tmp",
  "ca.trusted",
  "ca.trust-refresh-pending",
  "ca-key.pem",
  "ca.pem",
  "server-key.pem",
  "server.pem",
  "server.csr",
  "server-ext.cnf",
  "ca.srl",
  "cloudflared.yml",
] as const;

const HOST_CERTS_DIR = "host-certs";
const CA_IDENTITY_FILES = new Set(["ca-key.pem", "ca.pem", "ca.trust-refresh-pending"]);
const PROXY_RUNTIME_FILES = new Set([
  "proxy.pid",
  "proxy.port",
  "proxy.log",
  "proxy.hosts-sync-token",
  "proxy.hosts-sync-token.tmp",
]);

export type RemovePortlessStateFilesOptions = {
  preserveCAIdentity?: boolean;
  preserveProxyRuntime?: boolean;
};

/** Whether a path is an existing real directory rather than a symlink. */
export function isCleanableStateDir(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

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
    if (isCleanableStateDir(resolved)) dirs.add(resolved);
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
    if (!isCleanableStateDir(stateDir)) continue;
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
): string[] {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [dir];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [dir];
  }

  const failures: string[] = [];
  for (const f of PORTLESS_STATE_FILES) {
    if (options.preserveCAIdentity && CA_IDENTITY_FILES.has(f)) continue;
    if (options.preserveProxyRuntime && PROXY_RUNTIME_FILES.has(f)) continue;
    const file = path.join(dir, f);
    try {
      if (f === "routes.lock") fs.rmSync(file, { recursive: true, force: true });
      else fs.unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(file);
    }
  }
  const hostCerts = path.join(dir, HOST_CERTS_DIR);
  try {
    const stat = fs.lstatSync(hostCerts);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(hostCerts);
    else fs.rmSync(hostCerts, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(hostCerts);
  }
  return failures;
}

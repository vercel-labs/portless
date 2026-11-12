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
  "proxy.start",
  "proxy.start.tmp",
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
  "proxy.start",
  "proxy.start.tmp",
  "proxy.log",
  "proxy.hosts-sync-token",
  "proxy.hosts-sync-token.tmp",
  "proxy.tls",
  "proxy.custom-cert",
  "proxy.tld",
  "proxy.tlds",
  "proxy.lan",
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

/**
 * UIDs allowed to own a state directory during cleanup: root, the current user,
 * and the invoking sudo user.
 */
function allowedStateDirOwners(): Set<number> | null {
  if (process.platform === "win32") return null;
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const owners = new Set<number>([0, uid]);
  const sudoUid = Number.parseInt(process.env.SUDO_UID ?? "", 10);
  if (Number.isInteger(sudoUid) && sudoUid >= 0) owners.add(sudoUid);
  return owners;
}

/**
 * Whether every ancestor of a state directory is either owned by an allowed
 * user, not world-writable, or protected by the sticky bit.
 */
function hasSafeStateDirAncestry(dir: string, owners: Set<number>): boolean {
  let current: string;
  try {
    current = path.dirname(fs.realpathSync(dir));
  } catch {
    return false;
  }
  for (;;) {
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const worldWritable = (stat.mode & 0o002) !== 0;
      const sticky = (stat.mode & 0o1000) !== 0;
      if (!owners.has(stat.uid) && worldWritable && !sticky) return false;
    } catch {
      return false;
    }
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

/**
 * Whether a state directory is safe for cleanup: a real directory, not
 * world-writable, and not inside an untrusted world-writable parent directory.
 * When `enforceOwner` is true (used for the shared legacy `/tmp/portless`
 * path), the directory must also be owned by the current user, the invoking
 * sudo user, or root.
 */
export function isSafeCleanableStateDir(dir: string, enforceOwner = false): boolean {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const owners = allowedStateDirOwners();
    if (!owners) return true;
    if (enforceOwner && !owners.has(stat.uid)) return false;
    if ((stat.mode & 0o002) !== 0) return false;
    return hasSafeStateDirAncestry(dir, owners);
  } catch {
    return false;
  }
}

export type CATrustRemovalResult = {
  removed: boolean;
  error?: string;
};

export type CollectedStateDirs = {
  dirs: string[];
  failures: string[];
};

/**
 * Canonicalize configured state directories and report invalid paths.
 * Skip legacy system directories that are symlinked or owned by another user.
 */
export function collectStateDirsForCleanupWithFailures(): CollectedStateDirs {
  const dirs = new Set<string>();
  const failures = new Set<string>();
  const add = (d: string | undefined, allowSymlink = true) => {
    const trimmed = d?.trim();
    if (!trimmed) return;
    const resolved = path.resolve(trimmed);
    const enforceOwner = !allowSymlink;
    if (!allowSymlink && !isSafeCleanableStateDir(resolved, enforceOwner)) return;
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      failures.add(resolved);
      return;
    }
    if (!isSafeCleanableStateDir(canonical, enforceOwner)) {
      if (allowSymlink) failures.add(resolved);
      return;
    }
    dirs.add(canonical);
  };
  add(USER_STATE_DIR);
  add(LEGACY_SYSTEM_STATE_DIR, false);
  add(process.env.PORTLESS_STATE_DIR);
  return { dirs: [...dirs], failures: [...failures] };
}

/** Attempt CA trust removal wherever cleanup finds a CA certificate. */
export function attemptCATrustRemovalForCleanup(
  stateDirs: string[],
  untrust: (stateDir: string) => CATrustRemovalResult
): Map<string, CATrustRemovalResult> {
  const results = new Map<string, CATrustRemovalResult>();
  for (const stateDir of stateDirs) {
    if (!isSafeCleanableStateDir(stateDir)) continue;
    try {
      const caPath = path.join(stateDir, "ca.pem");
      if (fs.lstatSync(caPath).isSymbolicLink()) {
        results.set(stateDir, {
          removed: false,
          error: "Could not inspect CA certificate: refusing symlinked ca.pem",
        });
        continue;
      }
      fs.statSync(caPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      const message = error instanceof Error ? error.message : String(error);
      results.set(stateDir, {
        removed: false,
        error: `Could not inspect CA certificate: ${message}`,
      });
      continue;
    }
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
  if (options.preserveProxyRuntime) return failures;
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

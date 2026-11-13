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

/**
 * UIDs allowed to own a state directory during cleanup: root, the current user,
 * and, when running as root under sudo, the invoking sudo user.
 */
function allowedStateDirOwners(): Set<number> | null {
  if (process.platform === "win32") return null;
  const uid = process.getuid?.();
  if (uid === undefined) return null;
  const owners = new Set<number>([0, uid]);
  if (uid === 0) {
    const sudoUid = Number.parseInt(process.env.SUDO_UID ?? "", 10);
    if (Number.isInteger(sudoUid) && sudoUid >= 0) owners.add(sudoUid);
  }
  return owners;
}

export type StateDirProblem =
  | { reason: "not-directory"; path: string }
  | { reason: "foreign-owner"; path: string }
  | { reason: "writable-by-others"; path: string }
  | { reason: "unsafe-parent"; path: string };

/**
 * The first ancestor of a state directory that another user could use to swap
 * the directory: one owned by someone else, or writable by group or others
 * without the sticky bit. Returns null when every ancestor is safe.
 */
function findUnsafeStateDirAncestor(dir: string, owners: Set<number>): string | null {
  let current: string;
  try {
    current = path.dirname(fs.realpathSync(dir));
  } catch {
    return path.dirname(dir);
  }
  for (;;) {
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory()) return current;
      if (!owners.has(stat.uid)) return current;
      const writableByOthers = (stat.mode & 0o022) !== 0;
      const sticky = (stat.mode & 0o1000) !== 0;
      if (writableByOthers && !sticky) return current;
    } catch {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Why a state directory cannot be trusted with CA material or elevated work,
 * or null when only its owner can change it. The directory must be a real
 * directory owned by the current user, the invoking sudo user, or root, not
 * writable by group or others, and reachable only through safe ancestors.
 */
export function findStateDirProblem(dir: string): StateDirProblem | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return { reason: "not-directory", path: dir };
  }
  if (!stat.isDirectory()) return { reason: "not-directory", path: dir };
  const owners = allowedStateDirOwners();
  if (!owners) return null;
  if (!owners.has(stat.uid)) return { reason: "foreign-owner", path: dir };
  if ((stat.mode & 0o022) !== 0) return { reason: "writable-by-others", path: dir };
  const ancestor = findUnsafeStateDirAncestor(dir, owners);
  return ancestor ? { reason: "unsafe-parent", path: ancestor } : null;
}

/** Whether cleanup may act on a state directory. See findStateDirProblem. */
export function isCleanableStateDir(dir: string): boolean {
  return findStateDirProblem(dir) === null;
}

/**
 * A sentence fragment saying why a state directory path is refused, or null
 * when it is safe. Resolves symlinks first, so a link to a safe directory is
 * accepted.
 */
export function explainUnsafeStateDir(dir: string): string | null {
  let canonical: string;
  try {
    canonical = fs.realpathSync(dir);
  } catch {
    return "it cannot be resolved";
  }
  const problem = findStateDirProblem(canonical);
  if (!problem) return null;
  switch (problem.reason) {
    case "not-directory":
      return "it is not a directory";
    case "foreign-owner":
      return "it is owned by another user";
    case "writable-by-others":
      return `other users can write to it. Run: chmod go-w ${problem.path}`;
    case "unsafe-parent":
      return `other users can replace it through ${problem.path}`;
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
    if (!allowSymlink && !isCleanableStateDir(resolved)) return;
    let canonical: string;
    try {
      canonical = fs.realpathSync(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      failures.add(resolved);
      return;
    }
    if (!isCleanableStateDir(canonical)) {
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
    if (!isCleanableStateDir(stateDir)) continue;
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
    fs.lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [dir];
  }
  if (!isCleanableStateDir(dir)) return [dir];

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

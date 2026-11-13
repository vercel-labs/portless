import * as fs from "node:fs";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

type UserHomeOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  passwdHome?: (username: string) => string | null;
};

function readPasswdHome(username: string): string | null {
  try {
    const passwd = fs.readFileSync("/etc/passwd", "utf-8");
    for (const line of passwd.split("\n")) {
      const fields = line.split(":");
      if (fields[0] === username && fields[5]) return fields[5];
    }
  } catch {
    // Fall back to the platform's conventional home directory.
  }
  return null;
}

/**
 * Resolve the home directory that owns portless state. When sudo changes the
 * effective user to root, retain the invoking user's home so elevated proxy
 * processes and unprivileged app processes share the same route store.
 */
export function resolveUserHome(options: UserHomeOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();

  if (platform === "win32") return env.USERPROFILE || homedir;

  const sudoUser = env.SUDO_USER;
  if (!sudoUser || sudoUser === "root") return homedir;

  const home = env.HOME;
  if (home && home !== "/root" && home !== "/var/root") return home;

  const passwdHome = (options.passwdHome ?? readPasswdHome)(sudoUser);
  if (passwdHome) return passwdHome;

  return platform === "darwin"
    ? path.posix.join("/Users", sudoUser)
    : path.posix.join("/home", sudoUser);
}

/**
 * Race both literal loopback addresses and hand off the first connected socket synchronously.
 * Return a cancel function that aborts pending attempts with ABORT_ERR.
 */
export function createLoopbackConnection(
  port: number,
  callback: (error: NodeJS.ErrnoException | null, socket?: net.Socket) => void
): () => void {
  let settled = false;
  const errors: NodeJS.ErrnoException[] = [];
  const cleanup: ((winner?: net.Socket) => void)[] = [];
  const finish = (error: NodeJS.ErrnoException | null, socket?: net.Socket) => {
    if (settled) return;
    settled = true;
    for (const dispose of cleanup) dispose(socket);
    callback(error, socket);
  };

  queueMicrotask(() => {
    if (settled) return;
    for (const [index, host] of ["127.0.0.1", "::1"].entries()) {
      const onError = (error: NodeJS.ErrnoException) => {
        if (settled || errors[index]) return;
        errors[index] = error;
        if (errors[0] && errors[1]) {
          finish(
            Object.assign(new AggregateError(errors, "Both loopback connections failed"), {
              code: errors[0].code,
            })
          );
        }
      };
      try {
        const socket = net.connect({ host, port, family: index === 0 ? 4 : 6 });
        const onConnect = () => finish(null, socket);
        const onClose = () => {
          socket.removeListener("connect", onConnect);
          socket.removeListener("error", onError);
          onError(
            Object.assign(new Error("Connection closed before connecting"), {
              code: "ECONNRESET",
              address: host,
              port,
              syscall: "connect",
            })
          );
        };
        cleanup.push((winner) => {
          socket.removeListener("connect", onConnect);
          if (socket === winner) {
            socket.removeListener("error", onError);
            socket.removeListener("close", onClose);
          } else {
            socket.destroy();
          }
        });
        socket.on("error", onError);
        socket.once("connect", onConnect);
        socket.once("close", onClose);
      } catch (error) {
        onError(error as NodeJS.ErrnoException);
      }
    }
  });

  return () => {
    if (settled) return;
    finish(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }));
  };
}

/**
 * When running under sudo, fix file ownership so the real user can
 * read/write the file later without sudo. No-op on Windows or when not
 * running as root.
 */
export function fixOwnership(...paths: string[]): void {
  if (process.platform === "win32") return;
  const uid = process.env.SUDO_UID;
  const gid = process.env.SUDO_GID;
  if (!uid || process.getuid?.() !== 0) return;
  for (const p of paths) {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) continue;
      fs.lchownSync(p, parseInt(uid, 10), parseInt(gid || uid, 10));
    } catch {
      // Best-effort
    }
  }
}

/** Type guard for Node.js system errors with an error code. */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

/** Return whether a process exists, treating permission denial as alive. */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isErrnoException(err) && err.code === "EPERM";
  }
}

/**
 * Escape HTML special characters to prevent XSS.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Parse a port string, returning null unless it is a whole number from 1 to 65535. */
export function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Format a URL for the given hostname. Omits the port when it matches the
 * protocol default (80 for HTTP, 443 for HTTPS).
 */
export function formatUrl(hostname: string, proxyPort: number, tls = false): string {
  const proto = tls ? "https" : "http";
  const defaultPort = tls ? 443 : 80;
  return proxyPort === defaultPort
    ? `${proto}://${hostname}`
    : `${proto}://${hostname}:${proxyPort}`;
}

/**
 * Format how long a route has been registered as one compact unit, such as
 * `45s`, `12m`, `2h`, or `3d`. Uses floor rounding. A registration time up to
 * 60 seconds ahead of `now` (clock skew, common on WSL2) shows `0s`. Returns
 * null when there is no usable registration time, so callers can omit uptime.
 */
export function formatUptime(registeredAt: unknown, now: number): string | null {
  if (typeof registeredAt !== "number" || !Number.isFinite(registeredAt) || registeredAt <= 0) {
    return null;
  }
  const elapsedMs = now - registeredAt;
  if (elapsedMs < -60000) return null;
  const seconds = Math.floor(Math.max(elapsedMs, 0) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Parse and normalize a hostname input for use as a subdomain of the
 * configured TLD. Strips protocol prefixes, validates characters, and
 * appends the TLD suffix if needed.
 */
export function parseHostname(input: string, tld = "localhost"): string {
  const suffix = `.${tld}`;

  // Remove any protocol prefix
  let hostname = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  // Backward compat: strip default .localhost suffix when switching to a custom TLD
  if (tld !== "localhost" && hostname.endsWith(".localhost")) {
    hostname = hostname.slice(0, -".localhost".length);
  }

  // Validate non-empty
  if (!hostname || hostname === suffix) {
    throw new Error("Hostname cannot be empty");
  }

  // Add TLD suffix if not present
  if (!hostname.endsWith(suffix)) {
    hostname = `${hostname}${suffix}`;
  }

  // Validate hostname characters (letters, digits, hyphens, dots)
  const name = hostname.slice(0, -suffix.length);
  if (name.includes("..")) {
    throw new Error(`Invalid hostname "${name}": consecutive dots are not allowed`);
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name)) {
    throw new Error(
      `Invalid hostname "${name}": must contain only lowercase letters, digits, hyphens, and dots`
    );
  }

  // Validate per-label length (RFC 1035: max 63 characters per label)
  const labels = name.split(".");
  for (const label of labels) {
    if (label.length > 63) {
      throw new Error(
        `Invalid hostname "${name}": label "${label}" exceeds 63-character DNS limit`
      );
    }
  }

  if (hostname.length > 253) {
    throw new Error(`Invalid hostname "${hostname}": exceeds 253-character DNS limit`);
  }

  return hostname;
}

/**
 * Parse a hostname input for every configured TLD, or only for the target
 * TLDs. Strips any configured TLD suffix from the input before expanding.
 */
export function parseHostnames(
  input: string,
  tlds: readonly string[] = ["localhost"],
  targetTlds?: readonly string[]
): string[] {
  const uniqueTlds = [...new Set(tlds)];
  const expandTlds = targetTlds?.length
    ? uniqueTlds.filter((tld) => targetTlds.includes(tld))
    : uniqueTlds;
  let baseInput = input
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .toLowerCase();

  for (const tld of [...uniqueTlds].sort((a, b) => b.length - a.length)) {
    const suffix = `.${tld}`;
    if (baseInput.endsWith(suffix)) {
      baseInput = baseInput.slice(0, -suffix.length);
      break;
    }
  }

  // Skip a TLD that fails for TLD-specific reasons (e.g. app.TLD exceeds the
  // 253-char DNS limit) instead of losing the valid TLDs in the same list.
  // Throw only when no TLD survives, so input-wide errors still surface.
  const hostnames: string[] = [];
  const skipped: string[] = [];
  let firstError: unknown;
  for (const tld of expandTlds) {
    try {
      hostnames.push(parseHostname(baseInput, tld));
    } catch (err) {
      firstError ??= err;
      skipped.push(`"${tld}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (hostnames.length === 0) throw firstError ?? new Error("No usable TLD remains");
  for (const detail of skipped) {
    console.warn(`Warning: skipping TLD ${detail}`);
  }
  return hostnames;
}

/**
 * UIDs allowed to own a state directory: root, the current user, and, when
 * running as root under sudo, the invoking sudo user.
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
  | { reason: "unresolvable"; path: string }
  | { reason: "not-directory"; path: string }
  | { reason: "foreign-owner"; path: string }
  | { reason: "writable-by-others"; path: string }
  | { reason: "unsafe-parent"; path: string }
  | { reason: "unsafe-link"; path: string };

/**
 * The first directory, from `start` up to the root, that another user could
 * use to swap what lies below it: one owned by someone else, or writable by
 * group or others without the sticky bit. Returns null when all are safe.
 */
function findUnsafeDirInChain(start: string, owners: Set<number>): string | null {
  let current = start;
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

type TrustedPath = { path: string } | { unsafe: string } | { missing: string };

const MAX_SYMLINK_HOPS = 40;

function splitAbsolutePath(absolute: string): string[] {
  return absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
}

/**
 * Resolve a path like realpath, but refuse to follow a symlink another user
 * could create or retarget: one an allowed user does not own, or one held in
 * a directory that fails findUnsafeDirInChain.
 */
function resolveTrustedPath(target: string, owners: Set<number>): TrustedPath {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let pending = splitAbsolutePath(absolute);
  let current = root;
  let hops = 0;
  while (pending.length > 0) {
    const next = path.join(current, pending[0]!);
    pending = pending.slice(1);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch {
      return { missing: next };
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS || !owners.has(stat.uid)) return { unsafe: next };
    const holder = findUnsafeDirInChain(current, owners);
    if (holder) return { unsafe: holder };
    let linked: string;
    try {
      linked = path.resolve(current, fs.readlinkSync(next));
    } catch {
      return { missing: next };
    }
    pending = [...splitAbsolutePath(linked), ...pending];
    current = root;
  }
  return { path: current };
}

/**
 * The first ancestor of a state directory that another user could use to swap
 * or redirect the directory, or null when every ancestor is safe.
 */
function findUnsafeStateDirAncestor(dir: string, owners: Set<number>): string | null {
  const resolved = resolveTrustedPath(dir, owners);
  if ("unsafe" in resolved) return resolved.unsafe;
  if ("missing" in resolved) return path.dirname(dir);
  return findUnsafeDirInChain(path.dirname(resolved.path), owners);
}

/**
 * Why a state directory cannot be trusted to name a CA, a process to signal,
 * or elevated work, or null when only its owner can change it. The directory
 * must be a real directory owned by the current user, the invoking sudo user,
 * or root, reachable only through safe ancestors, and not writable by group or
 * others. A "writable-by-others" result means the owner and ancestors passed.
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
  const ancestor = findUnsafeStateDirAncestor(dir, owners);
  if (ancestor) return { reason: "unsafe-parent", path: ancestor };
  if ((stat.mode & 0o022) !== 0) return { reason: "writable-by-others", path: dir };
  return null;
}

/** Whether portless may act on a state directory. See findStateDirProblem. */
export function isCleanableStateDir(dir: string): boolean {
  return findStateDirProblem(dir) === null;
}

/**
 * Resolve a state directory path through trusted symlinks only and check the
 * directory it names. `canonical` is null when the path cannot be used at all.
 */
function locateStateDir(dir: string): {
  canonical: string | null;
  problem: StateDirProblem | null;
} {
  const owners = allowedStateDirOwners();
  let canonical: string;
  if (owners) {
    const resolved = resolveTrustedPath(dir, owners);
    if ("unsafe" in resolved) {
      return { canonical: null, problem: { reason: "unsafe-link", path: resolved.unsafe } };
    }
    if ("missing" in resolved) {
      return { canonical: null, problem: { reason: "unresolvable", path: resolved.missing } };
    }
    canonical = resolved.path;
  } else {
    try {
      canonical = fs.realpathSync(dir);
    } catch {
      return { canonical: null, problem: { reason: "unresolvable", path: dir } };
    }
  }
  return { canonical, problem: findStateDirProblem(canonical) };
}

function describeStateDirProblem(problem: StateDirProblem | null): string | null {
  if (!problem) return null;
  switch (problem.reason) {
    case "unresolvable":
      return "it cannot be resolved";
    case "not-directory":
      return "it is not a directory";
    case "foreign-owner":
      return "it is owned by another user";
    case "writable-by-others":
      return `other users can write to it. Run: chmod go-w ${problem.path}`;
    case "unsafe-parent":
      return `other users can replace it through ${problem.path}`;
    case "unsafe-link":
      return `other users can redirect it through ${problem.path}`;
  }
}

/**
 * A sentence fragment saying why a state directory path is refused, or null
 * when it is safe. A symlink to a safe directory is accepted when no other
 * user could have created or retargeted the link.
 */
export function explainUnsafeStateDir(dir: string): string | null {
  return describeStateDirProblem(locateStateDir(dir).problem);
}

/** Permission mode for a state directory: writable only by its owner. */
const STATE_DIR_MODE = 0o755;

/**
 * Set the mode of a checked state directory through a no-follow directory
 * descriptor, so a path swapped for a symlink or a file is never changed.
 */
function setStateDirMode(canonical: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      canonical,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    if (!fs.fstatSync(fd).isDirectory()) return false;
    fs.fchmodSync(fd, STATE_DIR_MODE);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Create a state directory if it is missing and make it writable only by its
 * owner, whatever the umask. The mode and owner are changed only on a
 * directory that passes findStateDirProblem, or on one its own unprivileged
 * owner is repairing. Returns why the directory is still unsafe, or null.
 */
export function ensureStateDir(dir: string): string | null {
  let located = locateStateDir(dir);
  if (located.problem?.reason === "unresolvable") {
    fs.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });
    located = locateStateDir(dir);
  }
  const { canonical, problem } = located;
  if (canonical === null || process.platform === "win32") return describeStateDirProblem(problem);
  if (problem === null) {
    setStateDirMode(canonical);
    fixOwnership(canonical);
    return null;
  }
  const ownerRepair = problem.reason === "writable-by-others" && process.getuid?.() !== 0;
  if (ownerRepair && setStateDirMode(canonical)) return null;
  return describeStateDirProblem(problem);
}

/**
 * Prepare a state directory for use. As root, throws when the directory fails
 * findStateDirProblem, so a privileged process never runs on state another
 * user controls.
 */
export function requireStateDir(dir: string): void {
  const unsafe = ensureStateDir(dir);
  if (unsafe && process.platform !== "win32" && process.getuid?.() === 0) {
    throw new Error(`Cannot use state directory ${dir} as root: ${unsafe}`);
  }
}

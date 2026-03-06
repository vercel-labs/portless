import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Hostname sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use as a .localhost hostname label.
 * Lowercases, replaces invalid characters with hyphens, collapses consecutive
 * hyphens, and trims leading/trailing hyphens.
 */
export function sanitizeForHostname(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Project name inference
// ---------------------------------------------------------------------------

export interface InferredName {
  name: string;
  source: string;
}

/**
 * Infer the project name by walking up from `cwd`:
 *   1. package.json `name` field (strips `@scope/` prefix)
 *   2. Git repo root directory name
 *   3. Current directory basename
 *
 * First match that yields a non-empty sanitized name wins.
 */
export function inferProjectName(cwd: string = process.cwd()): InferredName {
  // 1. Walk up looking for package.json
  const pkgResult = findPackageJsonName(cwd);
  if (pkgResult) {
    const sanitized = sanitizeForHostname(pkgResult);
    if (sanitized) {
      return { name: sanitized, source: "package.json" };
    }
  }

  // 2. Git repo root directory name
  const gitRoot = findGitRoot(cwd);
  if (gitRoot) {
    const sanitized = sanitizeForHostname(path.basename(gitRoot));
    if (sanitized) {
      return { name: sanitized, source: "git root" };
    }
  }

  // 3. Current directory basename
  const sanitized = sanitizeForHostname(path.basename(cwd));
  if (sanitized) {
    return { name: sanitized, source: "directory name" };
  }

  throw new Error("Could not infer a project name from package.json, git root, or directory name");
}

/**
 * Walk up from `startDir` looking for a package.json with a `name` field.
 * Returns the name (with `@scope/` prefix stripped) or null.
 */
function findPackageJsonName(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const raw = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (typeof pkg.name === "string" && pkg.name) {
        // Strip scoped prefix: @org/myapp → myapp
        return pkg.name.replace(/^@[^/]+\//, "");
      }
    } catch {
      // No package.json here or invalid JSON; keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Find the git repo root by trying `git rev-parse --show-toplevel` first,
 * then falling back to walking up and looking for a `.git` directory.
 */
function findGitRoot(startDir: string): string | null {
  // Try git CLI
  try {
    const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: startDir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (toplevel) return toplevel;
  } catch {
    // git binary unavailable or not a git repo
  }

  // Fallback: walk up looking for .git directory
  let dir = startDir;
  for (;;) {
    const gitPath = path.join(dir, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) return dir;
      // .git file (worktree or submodule) — the actual repo root is elsewhere,
      // but this directory is inside a git repo so it's a reasonable fallback
      if (stat.isFile()) return dir;
    } catch {
      // No .git here; keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Worktree detection
// ---------------------------------------------------------------------------

export interface WorktreePrefix {
  prefix: string;
  source: string;
}

/** Branch names that represent the default/primary checkout — no prefix needed. */
const DEFAULT_BRANCHES = new Set(["main", "master"]);

/**
 * Convert a branch name to a worktree prefix. Uses only the last segment
 * after the final `/` (e.g. `feature/auth` → `auth`). Returns null for
 * default branches, detached HEAD, or names that sanitize to empty.
 */
function branchToPrefix(branch: string): string | null {
  if (!branch || branch === "HEAD" || DEFAULT_BRANCHES.has(branch)) return null;
  const lastSegment = branch.split("/").pop()!;
  const prefix = sanitizeForHostname(lastSegment);
  return prefix || null;
}

/**
 * Detect if the current directory is inside a multi-worktree git repo (or
 * a Jujutsu multi-workspace repo) and return a prefix for hostname
 * composition.
 *
 * Checks (in order):
 *   1. Jujutsu (jj) workspaces — `.jj/repo` as a file indicates a linked
 *      workspace. The workspace name is used as the prefix.
 *   2. `git worktree list` — if there are multiple worktrees, the branch
 *      name is used as the prefix.
 *   3. `.git` file parsing — fallback when git CLI is unavailable.
 */
export function detectWorktreePrefix(cwd: string = process.cwd()): WorktreePrefix | null {
  // Jujutsu (jj) workspaces
  const jjResult = detectJujutsuWorkspacePrefix(cwd);
  if (jjResult !== undefined) return jjResult;

  // Primary: git CLI
  const cliResult = detectWorktreeViaCli(cwd);
  if (cliResult !== undefined) return cliResult;

  // Fallback: parse .git file and HEAD when git binary is unavailable
  return detectWorktreeViaFilesystem(cwd);
}

/** Workspace names that represent the default/primary checkout — no prefix needed. */
const DEFAULT_WORKSPACES = new Set(["default"]);

/**
 * Detect Jujutsu (jj) workspace prefix. Returns:
 *   - `{ prefix, source }` if in a non-default linked workspace
 *   - `null` if in the default workspace or not using multiple workspaces
 *   - `undefined` if not a jj repo (caller should try git detection)
 *
 * Jujutsu workspaces are similar to git worktrees but use a `.jj/` directory.
 * In a linked workspace, `.jj/repo` is a *file* pointing to the main repo's
 * `.jj/repo/` directory. In the main workspace, `.jj/repo` is a directory.
 *
 * The workspace name is obtained via `jj log` and used as the prefix after
 * stripping the project name prefix (e.g. workspace "myapp-fix-ui" with
 * project "myapp" yields prefix "fix-ui").
 */
function detectJujutsuWorkspacePrefix(cwd: string): WorktreePrefix | null | undefined {
  // Walk up to find .jj directory
  let dir = cwd;
  let jjDir: string | null = null;
  for (;;) {
    const candidate = path.join(dir, ".jj");
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        jjDir = candidate;
        break;
      }
    } catch {
      // No .jj here; keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (!jjDir) return undefined; // Not a jj repo

  // Check if .jj/repo is a file (linked workspace) or directory (main)
  const repoPath = path.join(jjDir, "repo");
  try {
    const stat = fs.statSync(repoPath);
    if (stat.isDirectory()) {
      // Main workspace — check if there are multiple workspaces
      // by looking for a workspace_store directory with entries
      try {
        const wsStorePath = path.join(repoPath, "workspace_store");
        const wsStoreEntries = fs.readdirSync(wsStorePath).filter((f) => f !== "index");
        if (wsStoreEntries.length === 0) return null; // Single workspace
      } catch {
        return null; // No workspace_store or not readable
      }

      // Multiple workspaces exist but we're in the main/default one
      return null;
    }
  } catch {
    return undefined; // Can't stat .jj/repo
  }

  // Linked workspace — get the workspace name via jj CLI
  try {
    const wsName = execFileSync(
      "jj",
      ["log", "-r", "@", "--no-graph", "-T", "self.working_copies()", "--ignore-working-copy"],
      {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      }
    )
      .trim()
      .replace(/@$/, ""); // Strip trailing @

    if (!wsName || DEFAULT_WORKSPACES.has(wsName)) return null;

    // Try to strip the project name prefix for a cleaner subdomain.
    // e.g. workspace "smile-admin-act-1408" with project "smile-admin" → "act-1408"
    const projectName = inferProjectName(cwd).name;
    let prefix = wsName;
    if (projectName && wsName.startsWith(projectName + "-")) {
      prefix = wsName.slice(projectName.length + 1);
    }

    const sanitized = sanitizeForHostname(prefix);
    if (!sanitized) return null;

    return { prefix: sanitized, source: "jj workspace" };
  } catch {
    // jj CLI unavailable — try filesystem fallback
    // The checkout file in .jj/working_copy/ contains the workspace name
    // as a suffix in the binary data, but parsing it is fragile.
    // Fall through to git detection (jj repos may be colocated with git).
    return undefined;
  }
}

/**
 * Use git CLI to detect worktree prefix. Returns:
 *   - `{ prefix, source }` if in a non-default-branch worktree
 *   - `null` if not in a worktree setup, or on main/master
 *   - `undefined` if git CLI is unavailable (caller should try fallback)
 */
function detectWorktreeViaCli(cwd: string): WorktreePrefix | null | undefined {
  try {
    const listOutput = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });

    // Count worktrees — each block starts with "worktree "
    const worktreeCount = listOutput.split("\n").filter((l) => l.startsWith("worktree ")).length;
    if (worktreeCount <= 1) return null;

    // Multiple worktrees exist — use branch name as prefix
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const prefix = branchToPrefix(branch);
    if (!prefix) return null;

    return { prefix, source: "git branch" };
  } catch {
    return undefined;
  }
}

/**
 * Fallback worktree detection when git CLI is unavailable. Walks up from
 * `startDir` looking for a `.git` file (worktrees have a file, not a
 * directory) and reads the branch name from the gitdir's HEAD file.
 */
function detectWorktreeViaFilesystem(startDir: string): WorktreePrefix | null {
  let dir = startDir;
  for (;;) {
    const gitPath = path.join(dir, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        // Regular .git directory — not a worktree
        return null;
      }
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, "utf-8").trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (!match) return null;

        const gitdir = match[1];
        // Only treat as a worktree if gitdir points into a /worktrees/ path.
        // Submodules point to /modules/ instead.
        if (!gitdir.match(/\/worktrees\/[^/]+$/)) return null;

        // Read the branch name from the worktree's HEAD file
        const branch = readBranchFromHead(path.resolve(dir, gitdir));
        const prefix = branchToPrefix(branch ?? "");
        if (!prefix) return null;

        return { prefix, source: "git branch" };
      }
    } catch {
      // No .git here; keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read the current branch name from a gitdir's HEAD file.
 * Returns null for detached HEAD or unreadable files.
 */
function readBranchFromHead(gitdir: string): string | null {
  try {
    const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf-8").trim();
    const refMatch = head.match(/^ref: refs\/heads\/(.+)$/);
    return refMatch ? refMatch[1] : null;
  } catch {
    return null;
  }
}

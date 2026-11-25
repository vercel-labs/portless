import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorktreeConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Hostname sanitization
// ---------------------------------------------------------------------------

/** Maximum length of a single DNS label per RFC 1035. */
const MAX_DNS_LABEL_LENGTH = 63;

/**
 * Truncate a DNS label to fit within the 63-character limit (RFC 1035).
 * When truncation is needed, a short hash suffix is appended to preserve
 * uniqueness (e.g. "very-long-name" → "very-long-na-a1b2c3").
 * The hash is derived from the full (pre-truncated) label.
 */
export function truncateLabel(label: string): string {
  if (label.length <= MAX_DNS_LABEL_LENGTH) return label;

  // 6-char hex hash from the full label for uniqueness after truncation
  const hash = createHash("sha256").update(label).digest("hex").slice(0, 6);
  // Reserve space for "-" separator + 6-char hash = 7 chars
  const maxPrefixLength = MAX_DNS_LABEL_LENGTH - 7;
  const prefix = label.slice(0, maxPrefixLength).replace(/-+$/, "");
  return `${prefix}-${hash}`;
}

function sanitizeLabel(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Sanitize and truncate a hostname label. */
export function sanitizeForHostname(name: string): string {
  return truncateLabel(sanitizeLabel(name));
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
      windowsHide: true,
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

interface WorktreePrefix {
  prefix: string;
  source: string;
}

type WorktreePrefixStyle = NonNullable<WorktreeConfig["prefix"]>;

type WorktreeLayout =
  | { kind: "template"; template: string }
  | { kind: "flat"; fullPrefix: string }
  | { kind: "base"; base: string }
  | { kind: "prepend" };

export interface WorktreeNaming extends WorktreePrefix {
  layout: WorktreeLayout;
}

function truncateHostname(name: string): string {
  return name.split(".").map(truncateLabel).join(".");
}

/** Compose a hostname and enforce the DNS label length limit. */
export function composeHostname(baseName: string, naming: WorktreeNaming | null): string {
  if (!naming) return truncateHostname(baseName);

  const { prefix, layout } = naming;
  switch (layout.kind) {
    case "template":
      return truncateHostname(
        layout.template
          .replaceAll("{worktree}", prefix)
          .replaceAll("{name}", truncateHostname(baseName))
          .toLowerCase()
      );
    case "flat": {
      const labels = baseName.split(".");
      if (!labels.includes("")) {
        return truncateLabel(`${layout.fullPrefix}-${labels.join("-")}`.toLowerCase());
      }
      break;
    }
    case "base": {
      if (baseName.toLowerCase().endsWith(`.${layout.base}`)) {
        const split = baseName.length - layout.base.length;
        return truncateHostname(`${baseName.slice(0, split)}${prefix}.${baseName.slice(split)}`);
      }
      break;
    }
    case "prepend":
      break;
  }

  return truncateHostname(`${prefix}.${baseName}`);
}

const DEFAULT_BRANCHES = new Set(["main", "master"]);

function branchToPrefix(branch: string, style: WorktreePrefixStyle): string | null {
  if (!branch || branch === "HEAD" || DEFAULT_BRANCHES.has(branch)) return null;
  const label = style === "branch" ? branch : branch.split("/").pop()!;
  return sanitizeLabel(label) || null;
}

/** Resolve the worktree prefix and hostname layout for a directory. */
export function resolveWorktreeNaming({
  cwd = process.cwd(),
  config,
  override,
}: {
  cwd?: string;
  config?: WorktreeConfig;
  override?: string | null;
} = {}): WorktreeNaming | null {
  if (override === null) return null;

  let detected: WorktreePrefix | null | undefined;
  if (override !== undefined) {
    detected = { prefix: sanitizeLabel(override), source: "--prefix flag" };
  } else if (process.env.PORTLESS_PREFIX !== undefined) {
    detected = { prefix: sanitizeLabel(process.env.PORTLESS_PREFIX), source: "PORTLESS_PREFIX" };
  } else {
    const style = config?.prefix ?? "last-segment";
    detected = detectWorktreeViaCli(cwd, style);
    if (detected === undefined) detected = detectWorktreeViaFilesystem(cwd, style);
  }
  if (!detected?.prefix) return null;

  const layout: WorktreeLayout = config?.hostnameTemplate
    ? { kind: "template", template: config.hostnameTemplate }
    : config?.flat
      ? { kind: "flat", fullPrefix: detected.prefix }
      : config?.base
        ? { kind: "base", base: config.base.toLowerCase() }
        : { kind: "prepend" };
  return { prefix: truncateLabel(detected.prefix), source: detected.source, layout };
}

function detectWorktreeViaCli(
  cwd: string,
  style: WorktreePrefixStyle
): WorktreePrefix | null | undefined {
  try {
    const output = execFileSync(
      "git",
      ["rev-parse", "--git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"],
      {
        cwd,
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }
    ).trim();
    const [gitDir, gitCommonDir, branch] = output.split(/\r?\n/);
    if (!gitDir || !gitCommonDir || !branch) return undefined;
    if (path.resolve(cwd, gitDir) === path.resolve(cwd, gitCommonDir)) return null;

    const prefix = branchToPrefix(branch, style);
    return prefix ? { prefix, source: "git branch" } : null;
  } catch {
    return undefined;
  }
}

/**
 * Fallback worktree detection when git CLI is unavailable. Walks up from
 * `startDir` looking for a `.git` file (worktrees have a file, not a
 * directory) and reads the branch name from the gitdir's HEAD file.
 */
function detectWorktreeViaFilesystem(
  startDir: string,
  style: WorktreePrefixStyle
): WorktreePrefix | null {
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
        if (!gitdir.match(/[/\\]worktrees[/\\][^/\\]+$/)) return null;

        // Read the branch name from the worktree's HEAD file
        const branch = readBranchFromHead(path.resolve(dir, gitdir));
        const prefix = branchToPrefix(branch ?? "", style);
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

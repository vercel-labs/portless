import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkspacePackage {
  dir: string;
  name: string | null;
  scripts: Record<string, string>;
}

/**
 * Walk up from `cwd` looking for pnpm-workspace.yaml.
 * Returns the directory containing it, or null.
 */
export function findWorkspaceRoot(cwd: string = process.cwd()): string | null {
  let dir = cwd;
  for (;;) {
    const wsPath = path.join(dir, "pnpm-workspace.yaml");
    try {
      fs.accessSync(wsPath, fs.constants.R_OK);
      return dir;
    } catch {
      // not here
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Discover all workspace packages from pnpm-workspace.yaml at `workspaceRoot`.
 * Returns packages that have a package.json (ignoring dirs without one).
 */
export function discoverWorkspacePackages(workspaceRoot: string): WorkspacePackage[] {
  const wsPath = path.join(workspaceRoot, "pnpm-workspace.yaml");
  let content: string;
  try {
    content = fs.readFileSync(wsPath, "utf-8");
  } catch {
    return [];
  }

  const globs = parsePnpmWorkspaceYaml(content);
  const dirs = expandPackageGlobs(workspaceRoot, globs);
  const packages: WorkspacePackage[] = [];

  for (const dir of dirs) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const raw = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      const name = typeof pkg.name === "string" ? pkg.name.replace(/^@[^/]+\//, "") : null;
      const scripts = typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {};
      packages.push({ dir, name, scripts });
    } catch {
      // no package.json or invalid; skip
    }
  }

  return packages;
}

/**
 * Parse the `packages:` list from pnpm-workspace.yaml content.
 * Handles the simple format (flat list of `- <glob>` lines under `packages:`).
 * No YAML library needed.
 */
export function parsePnpmWorkspaceYaml(content: string): string[] {
  const lines = content.split("\n");
  const globs: string[] = [];
  let inPackages = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }

    if (inPackages) {
      // End of list: non-empty line that isn't indented or a list item
      if (
        line.length > 0 &&
        !line.startsWith(" ") &&
        !line.startsWith("\t") &&
        !line.startsWith("-")
      ) {
        break;
      }

      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^-\s+['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/);
      if (match) {
        const glob = match[1].trim();
        if (glob) globs.push(glob);
      }
    }
  }

  return globs;
}

/**
 * Expand workspace globs to actual directories. Supports:
 * - `dir/*` (single-level wildcard, most common)
 * - `dir` (literal directory)
 * - Negation patterns (`!dir`) are used to filter out matches.
 */
export function expandPackageGlobs(root: string, globs: string[]): string[] {
  const included = new Set<string>();
  const excluded = new Set<string>();

  for (const glob of globs) {
    if (glob.startsWith("!")) {
      const negated = glob.slice(1);
      for (const dir of expandSingleGlob(root, negated)) {
        excluded.add(dir);
      }
    } else {
      for (const dir of expandSingleGlob(root, glob)) {
        included.add(dir);
      }
    }
  }

  for (const dir of excluded) {
    included.delete(dir);
  }

  return [...included].sort();
}

function expandSingleGlob(root: string, glob: string): string[] {
  if (glob.endsWith("/*") || glob.endsWith("/**")) {
    const baseDir = glob.replace(/\/\*+$/, "");
    const fullBase = path.join(root, baseDir);
    try {
      const entries = fs.readdirSync(fullBase, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => path.join(fullBase, e.name));
    } catch {
      return [];
    }
  }

  const full = path.join(root, glob);
  try {
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return [full];
  } catch {
    // doesn't exist
  }
  return [];
}

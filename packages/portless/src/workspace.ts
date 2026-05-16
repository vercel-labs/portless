import * as fs from "node:fs";
import * as path from "node:path";

export interface WorkspacePackage {
  dir: string;
  /** Package name with scope stripped (e.g., `@org/web` → `web`). */
  name: string | null;
  /** Npm scope without the `@` prefix (e.g., `@og-sdk/web` → `og-sdk`). Null if unscoped. */
  scope: string | null;
  scripts: Record<string, string>;
}

type WorkspaceSource = "pnpm" | "package-json";

/**
 * Walk up from `cwd` looking for a workspace root.
 * Checks `pnpm-workspace.yaml` first, then `package.json` with a
 * `"workspaces"` field (npm, yarn, bun). Returns the directory and
 * the source type, or null if no workspace root is found.
 */
export function findWorkspaceRoot(cwd: string = process.cwd()): string | null {
  let dir = cwd;
  for (;;) {
    try {
      fs.accessSync(path.join(dir, "pnpm-workspace.yaml"), fs.constants.R_OK);
      return dir;
    } catch {
      // not here
    }

    if (readWorkspacesFromPackageJson(dir) !== null) {
      return dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Determine the workspace source at a given root directory.
 * Prefers pnpm-workspace.yaml over package.json workspaces.
 */
function detectWorkspaceSource(workspaceRoot: string): WorkspaceSource | null {
  try {
    fs.accessSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), fs.constants.R_OK);
    return "pnpm";
  } catch {
    // not pnpm
  }
  if (readWorkspacesFromPackageJson(workspaceRoot) !== null) {
    return "package-json";
  }
  return null;
}

/**
 * Read the `"workspaces"` field from package.json in `dir`.
 * Supports both array form (`["apps/*"]`) and yarn-classic object
 * form (`{ "packages": ["apps/*"] }`). Returns null if not found.
 */
export function readWorkspacesFromPackageJson(dir: string): string[] | null {
  const pkgPath = path.join(dir, "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    if (!pkg || typeof pkg !== "object") return null;
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) {
      return ws.filter((g: unknown) => typeof g === "string");
    }
    if (ws && typeof ws === "object" && !Array.isArray(ws) && Array.isArray(ws.packages)) {
      return ws.packages.filter((g: unknown) => typeof g === "string");
    }
  } catch {
    // missing or unparseable
  }
  return null;
}

/**
 * Discover all workspace packages at `workspaceRoot`.
 * Supports pnpm (pnpm-workspace.yaml) and npm/yarn/bun (package.json workspaces).
 * Returns packages that have a package.json (ignoring dirs without one).
 */
export function discoverWorkspacePackages(workspaceRoot: string): WorkspacePackage[] {
  const source = detectWorkspaceSource(workspaceRoot);
  let globs: string[];

  if (source === "pnpm") {
    const wsPath = path.join(workspaceRoot, "pnpm-workspace.yaml");
    let content: string;
    try {
      content = fs.readFileSync(wsPath, "utf-8");
    } catch {
      return [];
    }
    globs = parsePnpmWorkspaceYaml(content);
  } else if (source === "package-json") {
    globs = readWorkspacesFromPackageJson(workspaceRoot) ?? [];
  } else {
    return [];
  }

  const dirs = expandPackageGlobs(workspaceRoot, globs);
  const packages: WorkspacePackage[] = [];

  for (const dir of dirs) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const raw = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      const rawName = typeof pkg.name === "string" ? pkg.name : null;
      const scopeMatch = rawName?.match(/^@([^/]+)\//);
      const scope = scopeMatch ? scopeMatch[1] : null;
      const name = rawName ? rawName.replace(/^@[^/]+\//, "") : null;
      const scripts = typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts : {};
      packages.push({ dir, name, scope, scripts });
    } catch {
      // no package.json or invalid; skip
    }
  }

  return packages;
}

/**
 * Parse the `packages:` list from pnpm-workspace.yaml content.
 *
 * Supports the two common forms:
 *   - Block list: `packages:\n  - glob\n  - glob`
 *   - Flow sequence: `packages: [glob, glob]`
 *
 * This is an intentionally minimal parser covering the subset of YAML
 * used by pnpm workspaces. It does not handle anchors, aliases, multi-line
 * flow sequences, or nested structures.
 */
export function parsePnpmWorkspaceYaml(content: string): string[] {
  const lines = content.split("\n");
  const globs: string[] = [];
  let inPackages = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    const headerMatch = line.match(/^packages\s*:(.*)/);
    if (headerMatch) {
      const rest = headerMatch[1].trim();
      if (rest.startsWith("[")) {
        return parseFlowSequence(rest);
      }
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

/** Parse a YAML flow sequence like `[apps/*, packages/*]`. */
function parseFlowSequence(input: string): string[] {
  const inner = input.replace(/^\[/, "").replace(/]\s*$/, "");
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^['"]/, "").replace(/['"]$/, "").trim())
    .filter(Boolean);
}

/**
 * Expand workspace globs to actual directories.
 *
 * Supported patterns:
 *   dir/\*  or  dir/\*\*   single-level wildcard
 *   dir/\*\/sub             mid-path wildcard
 *   dir/prefix-\*           prefix wildcard within a segment
 *   dir                     literal directory
 *   !dir                    negation (filters out matches)
 *
 * Only star wildcards within a single path segment are supported.
 * Regex, question marks, and character classes are not handled.
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

/** Match a single path segment against a pattern containing `*`. */
function segmentMatches(pattern: string, name: string): boolean {
  if (pattern === "*" || pattern === "**") return true;
  const starIdx = pattern.indexOf("*");
  if (starIdx === -1) return pattern === name;
  const prefix = pattern.slice(0, starIdx);
  const suffix = pattern.slice(starIdx + 1).replace(/\*+$/, "");
  return name.startsWith(prefix) && name.endsWith(suffix);
}

function expandSingleGlob(root: string, glob: string): string[] {
  const segments = glob.split("/");
  return expandSegments(root, segments);
}

function expandSegments(base: string, segments: string[]): string[] {
  if (segments.length === 0) {
    try {
      const stat = fs.statSync(base);
      if (stat.isDirectory()) return [base];
    } catch {
      // doesn't exist
    }
    return [];
  }

  const [current, ...rest] = segments;

  if (current.includes("*")) {
    try {
      const entries = fs.readdirSync(base, { withFileTypes: true });
      const matched = entries.filter((e) => e.isDirectory() && segmentMatches(current, e.name));
      if (rest.length === 0) {
        return matched.map((e) => path.join(base, e.name));
      }
      const results: string[] = [];
      for (const entry of matched) {
        results.push(...expandSegments(path.join(base, entry.name), rest));
      }
      return results;
    } catch {
      return [];
    }
  }

  return expandSegments(path.join(base, current), rest);
}

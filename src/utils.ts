import * as fs from "node:fs";
import * as path from "node:path";

/** Type guard for Node.js system errors with an error code. */
export function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
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

/**
 * Format a .localhost URL, including the port only when it is not 80 (standard HTTP).
 */
export function formatUrl(hostname: string, proxyPort: number): string {
  return proxyPort === 80 ? `http://${hostname}` : `http://${hostname}:${proxyPort}`;
}

/**
 * Parse and normalize a hostname input for use as a .localhost subdomain.
 * Strips protocol prefixes, validates characters, and appends .localhost if needed.
 */
export function parseHostname(input: string): string {
  // Remove any protocol prefix
  let hostname = input
    .trim()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .toLowerCase();

  // Validate non-empty
  if (!hostname || hostname === ".localhost") {
    throw new Error("Hostname cannot be empty");
  }

  // Add .localhost if not present
  if (!hostname.endsWith(".localhost")) {
    hostname = `${hostname}.localhost`;
  }

  // Validate hostname characters (letters, digits, hyphens, dots)
  const name = hostname.replace(/\.localhost$/, "");
  if (name.includes("..")) {
    throw new Error(`Invalid hostname "${name}": consecutive dots are not allowed`);
  }
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(name)) {
    throw new Error(
      `Invalid hostname "${name}": must contain only lowercase letters, digits, hyphens, and dots`
    );
  }

  return hostname;
}

/**
 * Sanitize a package name into a valid hostname segment.
 * - Strips npm scope (@scope/pkg -> pkg)
 * - Replaces invalid hostname chars with hyphens
 * - Lowercases
 * - Trims leading/trailing hyphens
 * Returns null if the result is empty.
 */
export function sanitizePackageName(name: string): string | null {
  // Strip scope
  let sanitized = name.replace(/^@[^/]+\//, "");
  // Lowercase
  sanitized = sanitized.toLowerCase();
  // Replace invalid chars (anything not a-z, 0-9, hyphen, dot) with hyphen
  sanitized = sanitized.replace(/[^a-z0-9.-]/g, "-");
  // Collapse consecutive hyphens
  sanitized = sanitized.replace(/-{2,}/g, "-");
  // Trim leading/trailing hyphens
  sanitized = sanitized.replace(/^-+|-+$/g, "");
  return sanitized || null;
}

/**
 * Portless config file shape.
 */
export interface PortlessConfig {
  names?: Record<string, string>;
}

/**
 * Search upward from `startDir` for a `.portlessrc.json` file.
 * Returns the parsed config, or null if not found.
 */
export function loadPortlessConfig(startDir: string): PortlessConfig | null {
  let dir = startDir;
  while (true) {
    const configPath = path.join(dir, ".portlessrc.json");
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(raw) as PortlessConfig;
    } catch {
      // Not found or invalid; continue searching
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Auto-resolve the app name for `portless run`.
 *
 * Resolution order:
 * 1. Check `.portlessrc.json` names map (keyed by npm_package_name or package.json name)
 * 2. Sanitize the package name from npm_package_name env var or nearest package.json
 * 3. Fall back to basename of cwd
 *
 * Returns the resolved name (without .localhost suffix).
 */
export function resolveAppName(cwd: string): string {
  // Determine the raw package name
  let packageName: string | undefined = process.env.npm_package_name;

  if (!packageName) {
    // Walk up to find nearest package.json
    let dir = cwd;
    while (true) {
      const pkgPath = path.join(dir, "package.json");
      try {
        const raw = fs.readFileSync(pkgPath, "utf-8");
        const pkg = JSON.parse(raw);
        if (typeof pkg.name === "string" && pkg.name) {
          packageName = pkg.name;
        }
        break;
      } catch {
        // Not found; continue up
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Load config for overrides
  const config = loadPortlessConfig(cwd);

  // Check config name override
  if (packageName && config?.names?.[packageName]) {
    return config.names[packageName];
  }

  // Sanitize the package name
  if (packageName) {
    const sanitized = sanitizePackageName(packageName);
    if (sanitized) return sanitized;
  }

  // Fallback: directory basename
  const basename = path.basename(cwd);
  const sanitized = sanitizePackageName(basename);
  if (sanitized) return sanitized;

  throw new Error("Could not determine app name. Provide a name explicitly: portless <name> <cmd>");
}

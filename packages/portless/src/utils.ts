import * as fs from "node:fs";

/**
 * When running under sudo, fix file ownership so the real user can
 * read/write the file later without sudo. No-op when not running as root.
 */
export function fixOwnership(...paths: string[]): void {
  const uid = process.env.SUDO_UID;
  const gid = process.env.SUDO_GID;
  if (!uid || process.getuid?.() !== 0) return;
  for (const p of paths) {
    try {
      fs.chownSync(p, parseInt(uid, 10), parseInt(gid || uid, 10));
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
 * Format a .localhost URL. Omits the port when it matches the protocol default
 * (80 for HTTP, 443 for HTTPS).
 */
export function formatUrl(hostname: string, proxyPort: number, tls = false): string {
  const proto = tls ? "https" : "http";
  const defaultPort = tls ? 443 : 80;
  return proxyPort === defaultPort
    ? `${proto}://${hostname}`
    : `${proto}://${hostname}:${proxyPort}`;
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

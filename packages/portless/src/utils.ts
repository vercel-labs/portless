import * as fs from "node:fs";
import * as net from "node:net";

/**
 * Both loopback families, tried in order. Dev servers that bind `localhost`
 * on Node 17+ resolve it verbatim and may listen on IPv6 `::1` only (Vite's
 * default host does this), while most others bind IPv4 `127.0.0.1` only.
 */
function loopbackLookup(
  _hostname: string,
  _options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: { address: string; family: number }[]
  ) => void
): void {
  callback(null, [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ]);
}

/**
 * Open a TCP connection to a local app port, trying both loopback families
 * instead of hardcoding IPv4. Uses Node's Happy Eyeballs implementation
 * (`autoSelectFamily`) with a fixed address list, so no DNS lookup happens:
 * 127.0.0.1 is attempted first and `::1` is tried when it fails (issue #320).
 */
export function createLoopbackConnection(port: number): net.Socket {
  return net.connect({
    host: "localhost",
    port,
    autoSelectFamily: true,
    lookup: loopbackLookup as net.LookupFunction,
  });
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
 * Parse and normalize a hostname input for use as a subdomain of the
 * configured TLD. Strips protocol prefixes, validates characters, and
 * appends the TLD suffix if needed.
 */
export function parseHostname(input: string, tld = "localhost"): string {
  const suffix = `.${tld}`;

  // Remove any protocol prefix
  let hostname = input
    .trim()
    .replace(/^https?:\/\//, "")
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

  return hostname;
}

/**
 * Parse a hostname input for every configured TLD. If the input already ends
 * with one of those TLDs, use the stripped base name for the full set.
 */
export function parseHostnames(input: string, tlds: readonly string[] = ["localhost"]): string[] {
  const uniqueTlds = [...new Set(tlds)];
  let baseInput = input
    .trim()
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .toLowerCase();

  for (const tld of uniqueTlds) {
    const suffix = `.${tld}`;
    if (baseInput.endsWith(suffix)) {
      baseInput = baseInput.slice(0, -suffix.length);
      break;
    }
  }

  return uniqueTlds.map((tld) => parseHostname(baseInput, tld));
}

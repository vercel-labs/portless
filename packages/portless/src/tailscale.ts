import { spawnSync } from "node:child_process";

const TAILSCALE_BINARY = "tailscale";

/**
 * Port allocation sequence for tailscale serve HTTPS ports.
 * First app gets 443 (default HTTPS), subsequent apps get 8443+.
 */
const PREFERRED_PORTS = [443, 8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450];

interface TailscaleCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type TailscaleCommandRunner = (args: string[]) => TailscaleCommandResult;

interface TailscaleStatusJson {
  Self?: {
    DNSName?: string;
    HostName?: string;
  };
  CurrentTailnet?: {
    MagicDNSSuffix?: string;
  };
}

export interface TailscaleReadyResult {
  dnsName: string;
  baseUrl: string;
}

function defaultRunner(args: string[]): TailscaleCommandResult {
  const result = spawnSync(TAILSCALE_BINARY, args, { encoding: "utf-8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

function trimDot(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function runOrThrow(
  args: string[],
  action: string,
  runner: TailscaleCommandRunner
): TailscaleCommandResult {
  const result = runner(args);
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        "Tailscale CLI not found. Install Tailscale (https://tailscale.com/download) and ensure `tailscale` is on PATH."
      );
    }
    throw new Error(`Failed to ${action}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(`Failed to ${action}: ${details || "unknown tailscale error"}`);
  }
  return result;
}

function parseStatusJson(raw: string): TailscaleStatusJson {
  try {
    return JSON.parse(raw) as TailscaleStatusJson;
  } catch {
    throw new Error("Failed to parse `tailscale status --json` output.");
  }
}

function statusToDnsName(status: TailscaleStatusJson): string {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName === "string" && dnsName.length > 0) {
    return trimDot(dnsName);
  }

  const host = status.Self?.HostName;
  const suffix = status.CurrentTailnet?.MagicDNSSuffix;
  if (
    typeof host === "string" &&
    host.length > 0 &&
    typeof suffix === "string" &&
    suffix.length > 0
  ) {
    return `${host}.${trimDot(suffix)}`;
  }

  throw new Error(
    "Could not determine Tailscale node DNS name from `tailscale status --json`. Is Tailscale connected?"
  );
}

/**
 * Verify that the Tailscale CLI is installed and the node is connected.
 * Returns the node's DNS name and base URL.
 */
export function ensureTailscaleReady(
  runner: TailscaleCommandRunner = defaultRunner
): TailscaleReadyResult {
  runOrThrow(["version"], "check tailscale version", runner);
  const statusResult = runOrThrow(["status", "--json"], "read tailscale status", runner);
  const status = parseStatusJson(statusResult.stdout);
  const dnsName = statusToDnsName(status);
  return {
    dnsName,
    baseUrl: `https://${dnsName}`,
  };
}

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

interface ServeStatusWeb {
  [hostPort: string]: {
    Handlers?: Record<string, unknown>;
  };
}

interface ServeStatusJson {
  Web?: ServeStatusWeb;
  TCP?: Record<string, unknown>;
}

/**
 * Query `tailscale serve status --json` and return the set of HTTPS ports
 * currently in use.
 */
export function getUsedServePorts(runner: TailscaleCommandRunner = defaultRunner): Set<number> {
  const result = runner(["serve", "status", "--json"]);
  if (result.error || result.status !== 0) {
    return new Set();
  }
  try {
    const config = JSON.parse(result.stdout) as ServeStatusJson;
    const ports = new Set<number>();
    if (config.Web) {
      for (const hostPort of Object.keys(config.Web)) {
        const match = hostPort.match(/:(\d+)$/);
        if (match) {
          ports.add(parseInt(match[1], 10));
        }
      }
    }
    if (config.TCP) {
      for (const portStr of Object.keys(config.TCP)) {
        const p = parseInt(portStr, 10);
        if (!isNaN(p)) ports.add(p);
      }
    }
    return ports;
  } catch {
    return new Set();
  }
}

/**
 * Pick the next available HTTPS port from the preferred sequence.
 * Returns the first port not in `usedPorts`.
 */
export function findAvailableServePort(usedPorts: Set<number>): number {
  for (const port of PREFERRED_PORTS) {
    if (!usedPorts.has(port)) return port;
  }
  // Extend beyond the preferred list
  let port = PREFERRED_PORTS[PREFERRED_PORTS.length - 1] + 1;
  while (usedPorts.has(port)) port++;
  return port;
}

// ---------------------------------------------------------------------------
// Register / unregister
// ---------------------------------------------------------------------------

function isConflictError(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return (
    text.includes("already") ||
    text.includes("exists") ||
    text.includes("conflict") ||
    text.includes("in use")
  );
}

export interface RegisterServeOptions {
  runner?: TailscaleCommandRunner;
}

/**
 * Register a `tailscale serve` mapping: HTTPS on `httpsPort` proxying to
 * `http://127.0.0.1:<localPort>`. Uses `--bg` so it persists until removed.
 */
export function registerServe(
  localPort: number,
  httpsPort: number,
  options?: RegisterServeOptions
): void {
  const runner = options?.runner ?? defaultRunner;
  const target = `http://127.0.0.1:${localPort}`;
  const result = runner(["serve", "--bg", "--yes", `--https=${httpsPort}`, target]);
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        "Tailscale CLI not found. Install Tailscale (https://tailscale.com/download) and ensure `tailscale` is on PATH."
      );
    }
    throw new Error(`Failed to register tailscale serve: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (isConflictError(result.stderr, result.stdout)) {
      throw new Error(
        `Tailscale HTTPS port ${httpsPort} is already in use. ` +
          "Stop the existing serve or let portless auto-assign a different port."
      );
    }
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(
      `Failed to register tailscale serve on port ${httpsPort}: ${details || "unknown tailscale error"}`
    );
  }
}

/**
 * Remove a `tailscale serve` mapping on the given HTTPS port.
 */
export function unregisterServe(
  httpsPort: number,
  options?: { ignoreMissing?: boolean; runner?: TailscaleCommandRunner }
): void {
  const runner = options?.runner ?? defaultRunner;
  const result = runner(["serve", "--yes", `--https=${httpsPort}`, "off"]);
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return;
    throw new Error(`Failed to remove tailscale serve: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
    const looksLikeMissing =
      text.includes("not found") ||
      text.includes("no serve config") ||
      text.includes("nothing to remove") ||
      text.includes("does not exist");
    if (options?.ignoreMissing && looksLikeMissing) return;
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(
      `Failed to remove tailscale serve on port ${httpsPort}: ${details || "unknown tailscale error"}`
    );
  }
}

/**
 * Register a `tailscale funnel` mapping: HTTPS on `httpsPort` proxying to
 * `http://127.0.0.1:<localPort>`. Exposes the service to the public internet.
 */
export function registerFunnel(
  localPort: number,
  httpsPort: number,
  options?: RegisterServeOptions
): void {
  const runner = options?.runner ?? defaultRunner;
  const target = `http://127.0.0.1:${localPort}`;
  const result = runner(["funnel", "--bg", "--yes", `--https=${httpsPort}`, target]);
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        "Tailscale CLI not found. Install Tailscale (https://tailscale.com/download) and ensure `tailscale` is on PATH."
      );
    }
    throw new Error(`Failed to register tailscale funnel: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (isConflictError(result.stderr, result.stdout)) {
      throw new Error(
        `Tailscale Funnel HTTPS port ${httpsPort} is already in use. ` +
          "Tailscale Funnel supports ports 443, 8443, and 10000."
      );
    }
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(
      `Failed to register tailscale funnel on port ${httpsPort}: ${details || "unknown tailscale error"}`
    );
  }
}

/**
 * Remove a `tailscale funnel` mapping on the given HTTPS port.
 */
export function unregisterFunnel(
  httpsPort: number,
  options?: { ignoreMissing?: boolean; runner?: TailscaleCommandRunner }
): void {
  const runner = options?.runner ?? defaultRunner;
  const result = runner(["funnel", "--yes", `--https=${httpsPort}`, "off"]);
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return;
    throw new Error(`Failed to remove tailscale funnel: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
    const looksLikeMissing =
      text.includes("not found") ||
      text.includes("no serve config") ||
      text.includes("nothing to remove") ||
      text.includes("does not exist");
    if (options?.ignoreMissing && looksLikeMissing) return;
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(
      `Failed to remove tailscale funnel on port ${httpsPort}: ${details || "unknown tailscale error"}`
    );
  }
}

// ---------------------------------------------------------------------------
// URL formatting
// ---------------------------------------------------------------------------

/** Build a display URL, omitting the port for 443 (default HTTPS). */
export function formatTailscaleUrl(baseUrl: string, httpsPort: number): string {
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (httpsPort === 443) return trimmed;
  return `${trimmed}:${httpsPort}`;
}

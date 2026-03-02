import { spawnSync } from "node:child_process";

const TAILSCALE_BINARY = "tailscale";
const TAILSCALE_HTTPS_PORT = 443;

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

function defaultRunner(args: string[]): TailscaleCommandResult {
  const result = spawnSync(TAILSCALE_BINARY, args, {
    encoding: "utf-8",
  });
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
  runner: TailscaleCommandRunner = defaultRunner
): TailscaleCommandResult {
  const result = runner(args);
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        "Tailscale CLI not found. Install Tailscale and ensure `tailscale` is on PATH."
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

  throw new Error("Could not determine Tailscale node DNS name from `tailscale status --json`.");
}

export function ensureTailscaleReady(runner: TailscaleCommandRunner = defaultRunner): {
  baseUrl: string;
  dnsName: string;
} {
  runOrThrow(["version"], "check tailscale version", runner);
  const statusResult = runOrThrow(["status", "--json"], "read tailscale status", runner);
  const status = parseStatusJson(statusResult.stdout);
  const dnsName = statusToDnsName(status);
  return {
    dnsName,
    baseUrl: `https://${dnsName}`,
  };
}

function isLikelyMissingPathError(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return (
    text.includes("not found") ||
    text.includes("no serve config") ||
    text.includes("nothing to remove") ||
    text.includes("does not exist")
  );
}

function isPathConflictError(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  return (
    text.includes("already") ||
    text.includes("exists") ||
    text.includes("conflict") ||
    text.includes("in use")
  );
}

export function tailscalePathFor(hostname: string): string {
  return `/${hostname}`;
}

export function formatTailscaleUrl(baseUrl: string, hostname: string): string {
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}${tailscalePathFor(hostname)}`;
}

export function unregisterServePath(
  hostname: string,
  options?: {
    ignoreMissing?: boolean;
    runner?: TailscaleCommandRunner;
  }
): void {
  const runner = options?.runner ?? defaultRunner;
  const path = tailscalePathFor(hostname);
  const result = runner([
    "serve",
    "--yes",
    `--https=${TAILSCALE_HTTPS_PORT}`,
    `--set-path=${path}`,
    "off",
  ]);
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        "Tailscale CLI not found. Install Tailscale and ensure `tailscale` is on PATH."
      );
    }
    throw new Error(`Failed to remove Tailscale path ${path}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options?.ignoreMissing && isLikelyMissingPathError(result.stderr, result.stdout)) {
      return;
    }
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(
      `Failed to remove Tailscale path ${path}: ${details || "unknown tailscale error"}`
    );
  }
}

export function registerServePath(
  hostname: string,
  port: number,
  options?: {
    force?: boolean;
    runner?: TailscaleCommandRunner;
  }
): void {
  const runner = options?.runner ?? defaultRunner;
  const path = tailscalePathFor(hostname);

  if (options?.force) {
    unregisterServePath(hostname, { ignoreMissing: true, runner });
  }

  const target = `http://127.0.0.1:${port}`;
  const result = runner([
    "serve",
    "--bg",
    "--yes",
    `--https=${TAILSCALE_HTTPS_PORT}`,
    `--set-path=${path}`,
    target,
  ]);

  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      throw new Error(
        "Tailscale CLI not found. Install Tailscale and ensure `tailscale` is on PATH."
      );
    }
    throw new Error(`Failed to add Tailscale path ${path}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (!options?.force && isPathConflictError(result.stderr, result.stdout)) {
      throw new Error(
        `Tailscale path ${path} is already configured. Re-run with --force to replace it.`
      );
    }
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(
      `Failed to add Tailscale path ${path}: ${details || "unknown tailscale error"}`
    );
  }
}

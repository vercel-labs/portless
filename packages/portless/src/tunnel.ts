import { spawn, spawnSync } from "node:child_process";
import { guardWindowsOrphans } from "./cli-utils.js";

const NGROK_BINARY = "ngrok";
const NGROK_START_TIMEOUT_MS = 30_000;
const NGROK_COMMAND_TIMEOUT_MS = 10_000;
const OUTPUT_BUFFER_LIMIT = 16_384;

export interface TunnelChildProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type TunnelSpawner = (args: string[]) => TunnelChildProcess;

interface TunnelCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type TunnelCommandRunner = (args: string[]) => TunnelCommandResult;

export interface StartNgrokOptions {
  hostHeader?: string;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  spawner?: TunnelSpawner;
  timeoutMs?: number;
}

export interface StartedNgrok {
  url: string;
  pid?: number;
  child: TunnelChildProcess;
}

export interface TunnelProvider {
  binary: string;
  versionArgs: string[];
  buildArgs(localPort: number, options: StartNgrokOptions): string[];
  extractUrl(output: string): string | null;
  formatOutputError(output: string): Error;
  notFound: string;
  timeout: string;
}

function defaultSpawner(binary: string, args: string[]): TunnelChildProcess {
  const spawnedAt = Date.now();
  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  guardWindowsOrphans(child, spawnedAt);
  return child as TunnelChildProcess;
}

function defaultRunner(binary: string, args: string[]): TunnelCommandResult {
  const result = spawnSync(binary, args, {
    encoding: "utf-8",
    killSignal: "SIGKILL",
    timeout: NGROK_COMMAND_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}

export function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function formatSpawnError(provider: TunnelProvider, error: Error): Error {
  const errno = error as NodeJS.ErrnoException;
  if (errno.code === "ENOENT") {
    return new Error(provider.notFound);
  }
  return new Error(`Failed to start ${provider.binary}: ${error.message}`);
}

function formatOutputError(output: string): Error {
  const details = normalizeSpace(output);
  const lower = details.toLowerCase();
  if (
    lower.includes("authtoken") ||
    lower.includes("authentication") ||
    lower.includes("not logged in")
  ) {
    return new Error(
      "ngrok could not start because authentication is not configured. Run `ngrok config add-authtoken <token>`, then run portless again."
    );
  }
  return new Error(
    `Failed to start ngrok tunnel: ${details || "ngrok exited before printing a public URL"}`
  );
}

export function ensureTunnelAvailable(
  provider: TunnelProvider,
  runner: TunnelCommandRunner = (args) => defaultRunner(provider.binary, args)
): void {
  const result = runner(provider.versionArgs);
  if (result.error) {
    throw formatSpawnError(provider, result.error);
  }
  if (result.status !== 0) {
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(
      `Failed to check ${provider.binary} version: ${details || `unknown ${provider.binary} error`}`
    );
  }
}

export function ensureNgrokAvailable(runner?: TunnelCommandRunner): void {
  ensureTunnelAvailable(ngrok, runner);
}

function cleanUrl(value: string): string {
  return value.replace(/[),.]+$/g, "");
}

export function extractNgrokUrl(output: string): string | null {
  const urlMatches = output.matchAll(/https:\/\/[^\s"'<>]+/g);
  for (const match of urlMatches) {
    const raw = match[0];
    const matchIndex = match.index ?? 0;
    const before = output.slice(Math.max(0, matchIndex - 80), matchIndex).toLowerCase();
    const looksLikeTunnel =
      before.includes("forwarding") ||
      before.includes("url=") ||
      before.includes('"url"') ||
      before.includes("started tunnel");
    if (!looksLikeTunnel) continue;

    const candidate = cleanUrl(raw);
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname === "ngrok.com" || parsed.hostname.endsWith(".ngrok.com")) {
        continue;
      }
      return parsed.toString().replace(/\/$/, "");
    } catch {
      continue;
    }
  }
  return null;
}

export function buildNgrokArgs(localPort: number, hostHeader = "rewrite"): string[] {
  return [
    "http",
    "--log=stdout",
    "--log-format=logfmt",
    `--host-header=${hostHeader}`,
    `http://127.0.0.1:${localPort}`,
  ];
}

const ngrok: TunnelProvider = {
  binary: NGROK_BINARY,
  versionArgs: ["version"],
  buildArgs: (localPort, options) => buildNgrokArgs(localPort, options.hostHeader),
  extractUrl: extractNgrokUrl,
  formatOutputError,
  notFound:
    "ngrok CLI not found. Install ngrok (https://ngrok.com/download) and ensure `ngrok` is on PATH.",
  timeout:
    "Timed out waiting for ngrok to print a public URL. Check that ngrok is authenticated and can connect.",
};

export function startNgrok(
  localPort: number,
  options: StartNgrokOptions = {}
): Promise<StartedNgrok> {
  return startTunnel(ngrok, localPort, options);
}

export function startTunnel(
  provider: TunnelProvider,
  localPort: number,
  options: StartNgrokOptions
): Promise<StartedNgrok> {
  const spawner = options.spawner ?? ((args) => defaultSpawner(provider.binary, args));
  const timeoutMs = options.timeoutMs ?? NGROK_START_TIMEOUT_MS;
  const args = provider.buildArgs(localPort, options);

  let child: TunnelChildProcess;
  try {
    child = spawner(args);
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    return Promise.reject(formatSpawnError(provider, error));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let started = false;
    let output = "";

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const appendOutput = (chunk: Buffer | string) => {
      if (settled) return;
      output += chunk.toString();
      if (output.length > OUTPUT_BUFFER_LIMIT) {
        output = output.slice(-OUTPUT_BUFFER_LIMIT);
      }
      const url = provider.extractUrl(output);
      if (url) {
        settle(() => {
          started = true;
          resolve({ url, pid: child.pid, child });
        });
      }
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // non-fatal
      }
      settle(() => reject(new Error(provider.timeout)));
    }, timeoutMs);

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (err) => {
      settle(() => reject(formatSpawnError(provider, err)));
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        if (started) options.onExit?.(code, signal);
        return;
      }
      settle(() => {
        const suffix = signal ? ` (signal ${signal})` : code !== null ? ` (exit ${code})` : "";
        const error = provider.formatOutputError(output);
        reject(new Error(`${error.message}${suffix}`));
      });
    });
  });
}

export function stopNgrokProcess(child: TunnelChildProcess | undefined): void {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort cleanup.
  }
}

export function stopTunnelPid(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process may already be gone, or may belong to another user.
  }
}

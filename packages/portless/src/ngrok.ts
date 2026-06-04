import { spawn, spawnSync } from "node:child_process";

const NGROK_BINARY = "ngrok";
const NGROK_START_TIMEOUT_MS = 30_000;
const NGROK_COMMAND_TIMEOUT_MS = 10_000;
const OUTPUT_BUFFER_LIMIT = 16_384;

export interface NgrokChildProcess {
  pid?: number;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export type NgrokSpawner = (args: string[]) => NgrokChildProcess;

interface NgrokCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type NgrokCommandRunner = (args: string[]) => NgrokCommandResult;

export interface StartNgrokOptions {
  hostHeader?: string;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  spawner?: NgrokSpawner;
  timeoutMs?: number;
}

export interface StartedNgrok {
  url: string;
  pid?: number;
  child: NgrokChildProcess;
}

function defaultSpawner(args: string[]): NgrokChildProcess {
  return spawn(NGROK_BINARY, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }) as NgrokChildProcess;
}

function defaultRunner(args: string[]): NgrokCommandResult {
  const result = spawnSync(NGROK_BINARY, args, {
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

function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function formatSpawnError(error: Error): Error {
  const errno = error as NodeJS.ErrnoException;
  if (errno.code === "ENOENT") {
    return new Error(
      "ngrok CLI not found. Install ngrok (https://ngrok.com/download) and ensure `ngrok` is on PATH."
    );
  }
  return new Error(`Failed to start ngrok: ${error.message}`);
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

export function ensureNgrokAvailable(runner: NgrokCommandRunner = defaultRunner): void {
  const result = runner(["version"]);
  if (result.error) {
    throw formatSpawnError(result.error);
  }
  if (result.status !== 0) {
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(`Failed to check ngrok version: ${details || "unknown ngrok error"}`);
  }
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

export function startNgrok(
  localPort: number,
  options: StartNgrokOptions = {}
): Promise<StartedNgrok> {
  const spawner = options.spawner ?? defaultSpawner;
  const timeoutMs = options.timeoutMs ?? NGROK_START_TIMEOUT_MS;
  const args = buildNgrokArgs(localPort, options.hostHeader);

  let child: NgrokChildProcess;
  try {
    child = spawner(args);
  } catch (err: unknown) {
    return Promise.reject(formatSpawnError(err instanceof Error ? err : new Error(String(err))));
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
      const url = extractNgrokUrl(output);
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
      settle(() =>
        reject(
          new Error(
            "Timed out waiting for ngrok to print a public URL. Check that ngrok is authenticated and can connect."
          )
        )
      );
    }, timeoutMs);

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (err) => {
      settle(() => reject(formatSpawnError(err)));
    });
    child.on("exit", (code, signal) => {
      if (settled) {
        if (started) options.onExit?.(code, signal);
        return;
      }
      settle(() => {
        const suffix = signal ? ` (signal ${signal})` : code !== null ? ` (exit ${code})` : "";
        const error = formatOutputError(output);
        reject(new Error(`${error.message}${suffix}`));
      });
    });
  });
}

export function stopNgrokProcess(child: NgrokChildProcess | undefined): void {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort cleanup.
  }
}

export function stopNgrok(route: { ngrokPid?: number }): void {
  if (!route.ngrokPid) return;
  try {
    process.kill(route.ngrokPid, "SIGTERM");
  } catch {
    // Process may already be gone, or may belong to another user.
  }
}

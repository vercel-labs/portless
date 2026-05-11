import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const NETBIRD_BINARY = "netbird";

const DEFAULT_EXPOSE_TIMEOUT_MS = 30_000;

interface NetbirdCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type NetbirdCommandRunner = (args: string[]) => NetbirdCommandResult;

interface NetbirdStatusJson {
  daemonStatus?: string;
  fqdn?: string;
}

export interface NetbirdReadyResult {
  daemonStatus: string;
  fqdn: string;
}

function defaultRunner(args: string[]): NetbirdCommandResult {
  const result = spawnSync(NETBIRD_BINARY, args, { encoding: "utf-8" });
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

function cliNotFoundError(): Error {
  return new Error(
    "NetBird CLI not found. Install NetBird (https://netbird.io/download) and ensure `netbird` is on PATH."
  );
}

function runOrThrow(
  args: string[],
  action: string,
  runner: NetbirdCommandRunner
): NetbirdCommandResult {
  const result = runner(args);
  if (result.error) {
    const errno = result.error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") throw cliNotFoundError();
    throw new Error(`Failed to ${action}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(`Failed to ${action}: ${details || "unknown netbird error"}`);
  }
  return result;
}

/**
 * Verify the NetBird daemon is connected. Throws if the CLI is missing or the
 * daemon is in any state other than "Connected".
 */
export function ensureNetbirdReady(
  runner: NetbirdCommandRunner = defaultRunner
): NetbirdReadyResult {
  const result = runOrThrow(["status", "--json"], "read netbird status", runner);
  let status: NetbirdStatusJson;
  try {
    status = JSON.parse(result.stdout) as NetbirdStatusJson;
  } catch {
    throw new Error("Failed to parse `netbird status --json` output.");
  }
  const daemonStatus = status.daemonStatus ?? "Unknown";
  if (daemonStatus !== "Connected") {
    throw new Error(
      `NetBird is not connected (status: ${daemonStatus}). Run \`netbird up\` first.`
    );
  }
  return { daemonStatus, fqdn: status.fqdn ?? "" };
}

// ---------------------------------------------------------------------------
// expose
// ---------------------------------------------------------------------------

export type ExposeProtocol = "http" | "https" | "tcp" | "udp" | "tls";

export interface ExposeOptions {
  protocol?: ExposeProtocol;
  password?: string;
  pin?: string;
  namePrefix?: string;
  externalPort?: number;
  customDomain?: string;
  userGroups?: string[];
}

export interface ExposeInfo {
  name: string;
  url: string;
  domain: string;
  protocol: string;
}

/**
 * Build the argument vector for `netbird expose`. The local port is always
 * the final positional argument, matching the CLI's required order.
 */
export function buildExposeArgs(localPort: number, options: ExposeOptions = {}): string[] {
  const args = ["expose"];
  if (options.protocol) args.push("--protocol", options.protocol);
  if (options.password) args.push("--with-password", options.password);
  if (options.pin) args.push("--with-pin", options.pin);
  if (options.namePrefix) args.push("--with-name-prefix", options.namePrefix);
  if (options.externalPort !== undefined) {
    args.push("--with-external-port", options.externalPort.toString());
  }
  if (options.customDomain) args.push("--with-custom-domain", options.customDomain);
  if (options.userGroups && options.userGroups.length > 0) {
    args.push("--with-user-groups", options.userGroups.join(","));
  }
  args.push(localPort.toString());
  return args;
}

/**
 * Parse the labelled block printed by `netbird expose` once the service is
 * registered. Returns null until all four fields (Name, URL, Domain, Protocol)
 * have been seen.
 */
export function parseExposeInfo(output: string): ExposeInfo | null {
  const fields: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(Name|URL|Domain|Protocol):\s+(.+?)\s*$/);
    if (match) fields[match[1].toLowerCase()] = match[2];
  }
  if (!fields.name || !fields.url || !fields.domain || !fields.protocol) return null;
  return {
    name: fields.name,
    url: fields.url,
    domain: fields.domain,
    protocol: fields.protocol,
  };
}

interface ExposeStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface ExposeProcessLike {
  stdout: ExposeStream | null;
  stderr: ExposeStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type ExposeSpawner = (args: string[]) => ExposeProcessLike;

export interface StartExposeOptions extends ExposeOptions {
  spawner?: ExposeSpawner;
  timeoutMs?: number;
}

export interface ExposeHandle {
  info: ExposeInfo;
  process: ExposeProcessLike;
  stop(): void;
}

function defaultSpawner(args: string[]): ChildProcess {
  return spawn(NETBIRD_BINARY, args, { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Spawn `netbird expose` and resolve once the public URL has been printed.
 * The returned handle owns the child process; call `stop()` to terminate
 * exposure. Rejects on CLI missing, early exit, or timeout.
 */
export function startExpose(
  localPort: number,
  options: StartExposeOptions = {}
): Promise<ExposeHandle> {
  const {
    spawner = defaultSpawner,
    timeoutMs = DEFAULT_EXPOSE_TIMEOUT_MS,
    ...exposeOptions
  } = options;
  const args = buildExposeArgs(localPort, exposeOptions);
  const child = spawner(args);

  return new Promise<ExposeHandle>((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Timed out waiting for netbird expose to publish URL after ${timeoutMs}ms`));
    }, timeoutMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const tryResolve = () => {
      const info = parseExposeInfo(stdoutBuf + "\n" + stderrBuf);
      if (!info) return;
      settle(() =>
        resolve({
          info,
          process: child,
          stop: () => {
            child.kill("SIGTERM");
          },
        })
      );
    };

    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      tryResolve();
    });

    child.stderr?.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      tryResolve();
    });

    child.on("error", (err) => {
      const errno = err as NodeJS.ErrnoException;
      settle(() => {
        if (errno.code === "ENOENT") {
          reject(cliNotFoundError());
          return;
        }
        reject(new Error(`Failed to start netbird expose: ${err.message}`));
      });
    });

    child.on("exit", (code) => {
      settle(() => {
        const details = normalizeSpace(stderrBuf || stdoutBuf);
        reject(new Error(`netbird expose exited with code ${code}: ${details || "unknown error"}`));
      });
    });
  });
}

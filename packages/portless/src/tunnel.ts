import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as net from "node:net";
import { guardWindowsOrphans } from "./cli-utils.js";

const START_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 10_000;
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

export interface TunnelCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type TunnelCommandRunner = (args: string[]) => TunnelCommandResult;

export interface TunnelStartOptions {
  hostHeader?: string;
  url?: string;
  appName?: string;
  configPath?: string;
  password?: string;
  pin?: string;
  groups?: string[];
  relayHost?: string;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  spawner?: TunnelSpawner;
  timeoutMs?: number;
}

export interface StartedTunnel {
  url: string;
  pid?: number;
  child: TunnelChildProcess;
}

export interface TunnelProvider {
  binary: string;
  versionArgs: string[];
  validateReady?(result: TunnelCommandResult): void;
  buildArgs(localPort: number, options: TunnelStartOptions): string[];
  extractUrl(output: string): string | null;
  formatOutputError(output: string): Error;
  notFound: string;
  timeout: string;
}

export interface ProcessTunnelSpec {
  readonly id: "ngrok" | "cloudflare" | "netbird";
  readonly label: string;
  readonly binary: string;
  readonly env: string;
  readonly via: string;
  readonly install: string;
  readonly urlField: "ngrokUrl" | "cloudflareUrl" | "netbirdUrl";
  readonly pidField: "ngrokPid" | "cloudflarePid" | "netbirdPid";
  readonly ensure: (runner?: TunnelCommandRunner) => void;
  readonly start: (localPort: number, options: TunnelStartOptions) => Promise<StartedTunnel>;
  readonly formatHint?: (message: string) => string[] | null;
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
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
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

function formatSpawnError(provider: TunnelProvider, error: Error): Error {
  const errno = error as NodeJS.ErrnoException;
  if (errno.code === "ENOENT") {
    return new Error(provider.notFound);
  }
  return new Error(`Failed to start ${provider.binary}: ${error.message}`);
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
  provider.validateReady?.(result);
}

export function startTunnel(
  provider: TunnelProvider,
  localPort: number,
  options: TunnelStartOptions
): Promise<StartedTunnel> {
  const spawner = options.spawner ?? ((args) => defaultSpawner(provider.binary, args));
  const timeoutMs = options.timeoutMs ?? START_TIMEOUT_MS;
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
      settle(() => reject(new Error(provider.timeout)));
      stopTunnelProcess(child);
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

export function stopTunnelProcess(child: TunnelChildProcess | undefined): void {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
}

export function stopTunnelPid(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

export function normalizeNgrokUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("ngrok URL cannot be empty.");
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const invalid = () =>
    new Error(
      `Invalid ngrok URL "${raw}". Use an http:// or https:// URL (for example, https://my-app.ngrok.dev).`
    );
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalid();
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) {
    throw invalid();
  }
  return parsed.toString().replace(/\/$/, "");
}

export function buildNgrokArgs(localPort: number, hostHeader = "rewrite", url?: string): string[] {
  return [
    "http",
    "--log=stdout",
    "--log-format=logfmt",
    `--host-header=${hostHeader}`,
    ...(url ? [`--url=${normalizeNgrokUrl(url)}`] : []),
    `http://127.0.0.1:${localPort}`,
  ];
}

export function extractNgrokUrl(output: string): string | null {
  const urlMatches = output.matchAll(/https?:\/\/[^\s"'<>]+/g);
  for (const match of urlMatches) {
    const matchIndex = match.index ?? 0;
    const before = output.slice(Math.max(0, matchIndex - 80), matchIndex).toLowerCase();
    const trimmedBefore = before.trimEnd();
    if (/(?:addr\s*[:=]\s*["']?|->)$/.test(trimmedBefore)) continue;
    const looksLikeTunnel =
      before.includes("forwarding") ||
      before.includes("url=") ||
      before.includes('"url"') ||
      before.includes("started tunnel");
    if (!looksLikeTunnel) continue;

    const candidate = match[0].replace(/[),.]+$/g, "");
    try {
      const parsed = new URL(candidate);
      if (
        parsed.hostname === "ngrok.com" ||
        parsed.hostname.endsWith(".ngrok.com") ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1" ||
        parsed.hostname === "[::1]"
      ) {
        continue;
      }
      return parsed.toString().replace(/\/$/, "");
    } catch {
      continue;
    }
  }
  return null;
}

const ngrok: TunnelProvider = {
  binary: "ngrok",
  versionArgs: ["version"],
  buildArgs: (localPort, options) => buildNgrokArgs(localPort, options.hostHeader, options.url),
  extractUrl: extractNgrokUrl,
  formatOutputError: (output) => {
    if (output.includes("ERR_NGROK_4018")) {
      return new Error(
        "ngrok could not start because authentication is not configured. Run `ngrok config add-authtoken <token>`, then run portless again."
      );
    }
    const errorLines = output.match(/^ERROR:.*/gm)?.map((line) => line.slice("ERROR:".length));
    const details = normalizeSpace(errorLines?.join(" ") ?? output);
    return new Error(
      `Failed to start ngrok tunnel: ${details || "ngrok exited before printing a public URL"}`
    );
  },
  notFound:
    "ngrok CLI not found. Install ngrok (https://ngrok.com/download) and ensure `ngrok` is on PATH.",
  timeout:
    "Timed out waiting for ngrok to print a public URL. Check that ngrok is authenticated and can connect.",
};

export function ensureNgrokAvailable(runner?: TunnelCommandRunner): void {
  ensureTunnelAvailable(ngrok, runner);
}

export function startNgrok(
  localPort: number,
  options: TunnelStartOptions = {}
): Promise<StartedTunnel> {
  return startTunnel(ngrok, localPort, options);
}

export function buildCloudflareArgs(port: number, host = "", config = ""): string[] {
  const flags = ["--no-autoupdate", "--grace-period", "1s", "--config", config];
  return ["tunnel", ...flags, "--url", `http://127.0.0.1:${port}`, "--http-host-header", host];
}

export function extractCloudflareUrl(output: string): string | null {
  const url = output.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  return url && /Registered tunnel connection|Connection \S+ registered/.test(output) ? url : null;
}

const cloudflare: TunnelProvider = {
  binary: "cloudflared",
  versionArgs: ["--version"],
  buildArgs: (port, options) => buildCloudflareArgs(port, options.hostHeader, options.configPath),
  extractUrl: extractCloudflareUrl,
  formatOutputError: (output) => {
    const errors = output.match(/.* ERR .*/g) ?? [];
    const details = errors.map(normalizeSpace).join(" ") || "cloudflared exited before connecting";
    return new Error(`Failed to start Cloudflare tunnel: ${details}`);
  },
  notFound:
    "cloudflared CLI not found. Install cloudflared (https://developers.cloudflare.com/tunnel/downloads/) and ensure `cloudflared` is on PATH.",
  timeout:
    "Timed out waiting for cloudflared to connect. Check that outbound UDP port 7844 is open, or set TUNNEL_TRANSPORT_PROTOCOL=http2 and try again.",
};

export function ensureCloudflaredAvailable(runner?: TunnelCommandRunner): void {
  ensureTunnelAvailable(cloudflare, runner);
}

export async function startCloudflare(
  port: number,
  options: TunnelStartOptions
): Promise<StartedTunnel> {
  if (options.configPath) writeFileSync(options.configPath, "{}");
  return startTunnel(cloudflare, port, options);
}

export function buildNetbirdArgs(localPort: number, options: TunnelStartOptions = {}): string[] {
  const args = ["expose", "--protocol", "http"];
  if (options.password) args.push("--with-password", options.password);
  if (options.pin) args.push("--with-pin", options.pin);
  if (options.appName) {
    const prefix = options.appName
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32);
    if (prefix) args.push("--with-name-prefix", prefix);
  }
  if (options.groups?.length) {
    const cleaned = options.groups.map((group) => group.trim()).filter(Boolean);
    if (cleaned.length) args.push("--with-user-groups", cleaned.join(","));
  }
  args.push(String(localPort));
  return args;
}

export function extractNetbirdUrl(output: string): string | null {
  const match = output.match(/^\s*URL:\s*(https?:\/\/\S+)/im);
  if (!match) return null;
  try {
    return new URL(match[1]).toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

const netbird: TunnelProvider = {
  binary: "netbird",
  versionArgs: ["status", "--json"],
  validateReady: (result) => {
    let status: string | undefined;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (parsed && typeof parsed === "object" && "daemonStatus" in parsed) {
        const daemonStatus = parsed.daemonStatus;
        if (typeof daemonStatus === "string") status = daemonStatus;
      }
    } catch {
      status = undefined;
    }
    if (status !== "Connected") {
      throw new Error(
        `NetBird is not connected${status ? ` (status: ${status})` : ""}. Run \`netbird up\`, then run portless again.`
      );
    }
  },
  buildArgs: buildNetbirdArgs,
  extractUrl: extractNetbirdUrl,
  formatOutputError: (output) => {
    const details = normalizeSpace(output);
    return new Error(
      `Failed to start NetBird tunnel: ${details || "NetBird exited before printing a public URL"}`
    );
  },
  notFound:
    "NetBird CLI not found. Install NetBird (https://netbird.io/download) and ensure `netbird` is on PATH.",
  timeout:
    "Timed out waiting for NetBird to print a public URL. Check that NetBird is connected and try again.",
};

/** Extract the peer's NetBird WireGuard IP from `netbird status --json` output. */
export function extractNetbirdIp(stdout: string): string | null {
  return extractNetbirdInterface(stdout)?.ip ?? null;
}

function extractNetbirdInterface(
  stdout: string
): { ip: string; prefixLength: number | null } | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || !("netbirdIp" in parsed)) return null;
    const raw = (parsed as { netbirdIp?: unknown }).netbirdIp;
    if (typeof raw !== "string") return null;
    const [rawIp = "", rawMask] = raw.trim().split("/");
    const family = net.isIP(rawIp);
    if (family === 0) return null;
    const maxBits = family === 4 ? 32 : 128;
    const parsedMask = rawMask !== undefined && /^\d+$/.test(rawMask) ? Number(rawMask) : null;
    const prefixLength =
      parsedMask !== null && parsedMask >= 0 && parsedMask <= maxBits ? parsedMask : null;
    return { ip: rawIp, prefixLength };
  } catch {
    return null;
  }
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const num = Number(part);
    if (!Number.isInteger(num) || num < 0 || num > 255) return null;
    value = (value << 8) | num;
  }
  return value >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const [head, tail] = ip.split("::");
  if (ip.split("::").length > 2) return null;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? left.length !== 8 : missing < 0) return null;
  const groups =
    tail === undefined ? left : [...left, ...Array<string>(missing).fill("0"), ...right];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

function isInCidr(candidate: string, base: string, prefixLength: number): boolean {
  const family = net.isIP(base);
  if (family === 0 || net.isIP(candidate) !== family) return false;
  if (prefixLength === 0) return true;
  if (family === 4) {
    const a = ipv4ToInt(candidate);
    const b = ipv4ToInt(base);
    if (a === null || b === null) return false;
    const mask = prefixLength === 32 ? 0xffffffff : (~0 << (32 - prefixLength)) >>> 0;
    return (a & mask) === (b & mask);
  }
  const a = ipv6ToBigInt(candidate);
  const b = ipv6ToBigInt(base);
  if (a === null || b === null) return false;
  const shift = BigInt(128 - prefixLength);
  return a >> shift === b >> shift;
}

/** Whether a peer source address belongs to loopback or the NetBird overlay subnet. */
export function isAllowedNetbirdRelayPeer(
  remoteAddress: string | undefined,
  bindHost: string,
  prefixLength: number | null = null
): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;
  if (normalized === bindHost || normalized === "127.0.0.1" || normalized === "::1") return true;
  if (prefixLength !== null && isInCidr(normalized, bindHost, prefixLength)) return true;
  if (prefixLength === null && isInCidr(bindHost, "100.64.0.0", 10)) {
    return isInCidr(normalized, "100.64.0.0", 10);
  }
  return false;
}

function createNetbirdLoopbackRelay(
  bindHost: string,
  prefixLength: number | null,
  localPort: number
): Promise<{ port: number; close: () => void } | null> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((client) => {
      if (!isAllowedNetbirdRelayPeer(client.remoteAddress, bindHost, prefixLength)) {
        client.destroy();
        return;
      }
      const upstream = net.connect(localPort, "127.0.0.1");
      sockets.add(client);
      sockets.add(upstream);
      const cleanup = () => {
        sockets.delete(client);
        sockets.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      client.on("error", cleanup);
      upstream.on("error", cleanup);
      client.on("close", cleanup);
      upstream.on("close", cleanup);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    server.once("error", () => resolve(null));
    server.listen(0, bindHost, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        resolve(null);
        return;
      }
      resolve({
        port: address.port,
        close: () => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          try {
            server.close();
          } catch {
            return;
          }
        },
      });
    });
  });
}

export function ensureNetbirdAvailable(runner?: TunnelCommandRunner): void {
  ensureTunnelAvailable(netbird, runner);
}

export async function startNetbird(
  localPort: number,
  options: TunnelStartOptions = {}
): Promise<StartedTunnel> {
  let relayHost = options.relayHost;
  let relayPrefix: number | null = null;
  if (!relayHost && !options.spawner) {
    const status = defaultRunner(netbird.binary, netbird.versionArgs);
    if (!status.error && status.status === 0) {
      const iface = extractNetbirdInterface(status.stdout);
      relayHost = iface?.ip;
      relayPrefix = iface?.prefixLength ?? null;
    }
  }
  const relay = relayHost
    ? await createNetbirdLoopbackRelay(relayHost, relayPrefix, localPort)
    : null;
  const exposePort = relay ? relay.port : localPort;
  const closeRelay = () => relay?.close();
  try {
    const started = await startTunnel(netbird, exposePort, {
      ...options,
      onExit: (code, signal) => {
        closeRelay();
        options.onExit?.(code, signal);
      },
    });
    if (!relay) return started;
    const rawKill = started.child.kill.bind(started.child);
    started.child.kill = (signal?: NodeJS.Signals) => {
      closeRelay();
      return rawKill(signal);
    };
    return started;
  } catch (err) {
    closeRelay();
    throw err;
  }
}

export const PROCESS_TUNNELS: readonly ProcessTunnelSpec[] = [
  {
    id: "ngrok",
    label: "ngrok",
    binary: "ngrok",
    env: "PORTLESS_NGROK",
    via: "ngrok",
    install: "https://ngrok.com/download",
    urlField: "ngrokUrl",
    pidField: "ngrokPid",
    ensure: ensureNgrokAvailable,
    start: startNgrok,
    formatHint: (message) =>
      message.includes("authentication is not configured")
        ? ["Configure ngrok authentication:", "  ngrok config add-authtoken <token>"]
        : null,
  },
  {
    id: "cloudflare",
    label: "Cloudflare",
    binary: "cloudflared",
    env: "PORTLESS_CLOUDFLARE",
    via: "Cloudflare Tunnel",
    install: "https://developers.cloudflare.com/tunnel/downloads/",
    urlField: "cloudflareUrl",
    pidField: "cloudflarePid",
    ensure: ensureCloudflaredAvailable,
    start: startCloudflare,
  },
  {
    id: "netbird",
    label: "NetBird",
    binary: "netbird",
    env: "PORTLESS_NETBIRD",
    via: "NetBird",
    install: "https://netbird.io/download",
    urlField: "netbirdUrl",
    pidField: "netbirdPid",
    ensure: ensureNetbirdAvailable,
    start: startNetbird,
    formatHint: (message) =>
      message.includes("not connected")
        ? ["Make sure NetBird is connected:", "  netbird up"]
        : null,
  },
];

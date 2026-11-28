import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
const TAILSCALE_BINARY = "tailscale";
const TAILSCALE_COMMAND_TIMEOUT_MS = 30_000;
const FUNNEL_PORTS = [443, 8443, 10000];
const PREFERRED_SERVE_PORTS = [443, 8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450];
const PREFERRED_HTTP_SERVE_PORTS = [80, 8080, 8081, 8082, 8083, 8084, 8085, 8086, 8087];
interface TailscaleCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
export type TailscaleCommandRunner = (args: string[]) => TailscaleCommandResult;
export type TailscaleShareKind = "serve" | "funnel" | "service";
export type TailscaleShareRequest =
  | { kind: "serve"; preferredPort?: number }
  | { kind: "funnel"; preferredPort?: number }
  | { kind: "service"; serviceName: string };
export type TailscaleShareRecord =
  | { kind: "https"; port: number }
  | { kind: "tcp"; port: number }
  | { kind: "funnel"; port: number }
  | { kind: "service"; serviceId: string; serviceName: string };
export interface TailscaleReady {
  readonly request: TailscaleShareRequest;
  readonly transport: "https" | "tcp" | "funnel" | "service";
  readonly host: string;
  readonly baseUrl: string;
  readonly serviceId?: string;
  readonly serviceName?: string;
}
export interface EnsureTailscaleReadyOptions {
  runner?: TailscaleCommandRunner;
}
export interface ShareTailscaleOptions {
  localPort: number;
  kind: TailscaleShareKind;
  preferredPort?: number;
  serviceName?: string;
  ready?: TailscaleReady;
  claimShare?: (record: TailscaleShareRecord) => string | null;
  releaseShare?: () => void;
  runner?: TailscaleCommandRunner;
}
export interface TailscaleShareResult {
  url: string;
  record: TailscaleShareRecord;
  pendingApproval?: boolean;
}
interface TailscaleStatusJson {
  Self?: {
    Capabilities?: string[];
    CapMap?: Record<string, unknown>;
    DNSName?: string;
    HostName?: string;
    ID?: string;
    TailscaleIPs?: string[];
    Tags?: string[];
  };
  CurrentTailnet?: {
    MagicDNSSuffix?: string;
    MagicDNSEnabled?: boolean;
  };
}
interface ServeStatusJson {
  Web?: Record<string, unknown>;
  TCP?: Record<string, unknown>;
  Services?: Record<string, { Web?: Record<string, unknown>; TCP?: Record<string, unknown> }>;
  Foreground?: Record<string, ServeStatusJson>;
}
function runTailscaleCommand(command: string, args: string[]): TailscaleCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    killSignal: "SIGKILL",
    timeout: TAILSCALE_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}
/** Resolve an existing Windows `.cmd` shim on PATH. */
export function findWindowsCmdShim(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, `${name}.cmd`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
function defaultRunner(args: string[]): TailscaleCommandResult {
  const result = runTailscaleCommand(TAILSCALE_BINARY, args);
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (process.platform !== "win32" || (code !== "ENOENT" && code !== "EINVAL")) return result;
  const shim = findWindowsCmdShim(TAILSCALE_BINARY);
  if (!shim) return result;
  return runTailscaleCommand(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", shim, ...args]);
}
function normalizeSpace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
function throwCommandError(error: Error, action: string): never {
  if ((error as NodeJS.ErrnoException).code === "ENOENT")
    throw new Error(
      "Tailscale CLI not found. Install Tailscale (https://tailscale.com/download) and ensure `tailscale` is on PATH."
    );
  throw new Error(`Failed to ${action}: ${error.message}`);
}
function runOrThrow(
  args: string[],
  action: string,
  runner: TailscaleCommandRunner
): TailscaleCommandResult {
  const result = runner(args);
  if (result.error) throwCommandError(result.error, action);
  if (result.status !== 0) {
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(`Failed to ${action}: ${details || "unknown tailscale error"}`);
  }
  return result;
}
function trimDot(value: string): string {
  return value.replace(/\.+$/, "");
}
function statusToDnsName(status: TailscaleStatusJson): string {
  const dnsName = status.Self?.DNSName;
  if (typeof dnsName === "string" && trimDot(dnsName).length > 0) return trimDot(dnsName);
  const host = status.Self?.HostName;
  const suffix = status.CurrentTailnet?.MagicDNSSuffix;
  if (
    typeof host === "string" &&
    host.length > 0 &&
    typeof suffix === "string" &&
    trimDot(suffix)
  ) {
    return `${host}.${trimDot(suffix)}`;
  }
  throw new Error(
    "Could not determine Tailscale node DNS name from `tailscale status --json`. Is Tailscale connected?"
  );
}
function hasCapability(status: TailscaleStatusJson, capability: string): boolean {
  const matches = (value: string): boolean => {
    const normalized = value.toLowerCase();
    return normalized === capability || normalized.endsWith(`/${capability}`);
  };
  const capabilities = status.Self?.Capabilities;
  return (
    (Array.isArray(capabilities) && capabilities.some(matches)) ||
    Boolean(status.Self?.CapMap && Object.keys(status.Self.CapMap).some(matches))
  );
}
function throwHttpsNotEnabled(): never {
  throw new Error(
    "Tailscale HTTPS is not enabled on your tailnet. " +
      "Enable HTTPS certificates in Tailscale DNS settings, then run portless again."
  );
}
function throwFunnelNotEnabled(status: TailscaleStatusJson): never {
  const nodeId = status.Self?.ID;
  const enableUrl =
    typeof nodeId === "string" && nodeId.length > 0
      ? ` Visit https://login.tailscale.com/f/funnel?node=${nodeId} to enable it.`
      : "";
  throw new Error(
    "Tailscale Funnel is not enabled on your tailnet. " +
      "Enable Funnel for this node, then run portless again." +
      enableUrl
  );
}
/** Normalize and validate a Tailscale service name. */
export function normalizeServiceName(raw: string): string {
  const name = raw.trim().replace(/^svc:/i, "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name))
    throw new Error(
      `Invalid Tailscale service name "${raw}". Use 1-63 lowercase letters, numbers, and hyphens, starting and ending with a letter or number.`
    );
  return name;
}
export function inferServiceName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return normalizeServiceName(name || raw);
}
function validatePort(port: number, kind: TailscaleShareKind): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Invalid Tailscale port "${port}". Must be a port number between 1 and 65535.`);
  if (kind === "funnel" && !FUNNEL_PORTS.includes(port))
    throw new Error(
      `Tailscale Funnel cannot use port ${port}. Funnel supports ports 443, 8443, and 10000.`
    );
}
/** Verify Tailscale readiness and choose the transport for a share. */
export function ensureTailscaleReady(
  request: TailscaleShareRequest = { kind: "serve" },
  options: EnsureTailscaleReadyOptions = {}
): TailscaleReady {
  const normalizedRequest: TailscaleShareRequest =
    request.kind === "service"
      ? { kind: "service", serviceName: normalizeServiceName(request.serviceName) }
      : request;
  if (normalizedRequest.kind !== "service" && normalizedRequest.preferredPort !== undefined) {
    validatePort(normalizedRequest.preferredPort, normalizedRequest.kind);
  }
  const runner = options.runner ?? defaultRunner;
  runOrThrow(["version"], "check tailscale version", runner);
  const statusResult = runOrThrow(["status", "--json"], "read tailscale status", runner);
  let status: TailscaleStatusJson;
  try {
    status = JSON.parse(statusResult.stdout) as TailscaleStatusJson;
  } catch {
    throw new Error("Failed to parse `tailscale status --json` output.");
  }
  if (normalizedRequest.kind === "serve" && status.CurrentTailnet?.MagicDNSEnabled === false) {
    const ips = status.Self?.TailscaleIPs;
    const validIps = Array.isArray(ips)
      ? ips.filter((ip) => typeof ip === "string" && ip.trim())
      : [];
    const ip = validIps.find((value) => value.includes(".")) ?? validIps[0];
    if (!ip)
      throw new Error(
        "Could not determine this node's Tailscale IP from `tailscale status --json`. Is Tailscale connected?"
      );
    const host = ip.includes(".") || (ip.startsWith("[") && ip.endsWith("]")) ? ip : `[${ip}]`;
    return { request: normalizedRequest, transport: "tcp", host, baseUrl: `http://${host}` };
  }
  if (status.CurrentTailnet?.MagicDNSEnabled === false) {
    const feature = normalizedRequest.kind === "funnel" ? "Funnel" : "Services";
    throw new Error(
      `MagicDNS is disabled on your tailnet. Tailscale ${feature} require${feature === "Funnel" ? "s" : ""} MagicDNS; enable it in Tailscale DNS settings, then run portless again.`
    );
  }
  if (!hasCapability(status, "https")) throwHttpsNotEnabled();
  if (normalizedRequest.kind === "funnel") {
    if (!hasCapability(status, "funnel")) throwFunnelNotEnabled(status);
    const host = statusToDnsName(status);
    return { request: normalizedRequest, transport: "funnel", host, baseUrl: `https://${host}` };
  }
  if (normalizedRequest.kind === "service") {
    if (!Array.isArray(status.Self?.Tags) || status.Self.Tags.length === 0)
      throw new Error(
        "Tailscale Services require this device to use a tag-based identity. Re-authenticate with --advertise-tags=tag:<name>, then run portless again."
      );
    let suffix = trimDot(status.CurrentTailnet?.MagicDNSSuffix?.trim() ?? "");
    if (!suffix) {
      try {
        const dnsName = statusToDnsName(status);
        const dot = dnsName.indexOf(".");
        suffix = dot < 0 ? "" : dnsName.slice(dot + 1);
      } catch {
        suffix = "";
      }
    }
    if (!suffix)
      throw new Error(
        "Could not determine Tailscale MagicDNS suffix from `tailscale status --json`. Is MagicDNS enabled?"
      );
    const serviceName = normalizedRequest.serviceName;
    const serviceId = `svc:${serviceName}`;
    const host = `${serviceName}.${suffix}`;
    return {
      request: normalizedRequest,
      transport: "service",
      host,
      baseUrl: `https://${host}`,
      serviceId,
      serviceName,
    };
  }
  const host = statusToDnsName(status);
  return { request: normalizedRequest, transport: "https", host, baseUrl: `https://${host}` };
}
function readServeStatus(runner: TailscaleCommandRunner): {
  ports: Set<number>;
  services: Set<string>;
} {
  const ports = new Set<number>();
  const services = new Set<string>();
  const result = runner(["serve", "status", "--json"]);
  if (result.error || result.status !== 0) return { ports, services };
  try {
    const config = JSON.parse(result.stdout) as ServeStatusJson;
    for (const session of [config, ...Object.values(config.Foreground ?? {})]) {
      if (!session || typeof session !== "object") continue;
      for (const key of [...Object.keys(session.Web ?? {}), ...Object.keys(session.TCP ?? {})]) {
        const match = key.match(/:(\d+)$/) ?? key.match(/^(\d+)$/);
        if (match) ports.add(Number(match[1]));
      }
      for (const [id, entry] of Object.entries(session.Services ?? {})) {
        if (
          entry &&
          typeof entry === "object" &&
          (Object.keys(entry.Web ?? {}).length > 0 || Object.keys(entry.TCP ?? {}).length > 0)
        ) {
          services.add(id.toLowerCase());
        }
      }
    }
  } catch {
    ports.clear();
    services.clear();
  }
  return { ports, services };
}
function findAvailablePort(used: Set<number>, transport: "https" | "tcp" | "funnel"): number {
  const pool =
    transport === "funnel"
      ? FUNNEL_PORTS
      : transport === "tcp"
        ? PREFERRED_HTTP_SERVE_PORTS
        : PREFERRED_SERVE_PORTS;
  for (const port of pool) if (!used.has(port)) return port;
  if (transport === "funnel")
    throw new Error(
      "All Tailscale Funnel ports are in use (443, 8443, 10000). Stop an existing funnel to free a port."
    );
  let port = pool[pool.length - 1] + 1;
  while (port <= 65535 && used.has(port)) port++;
  if (port > 65535) throw new Error("No Tailscale ports are available.");
  return port;
}
class TailscalePortConflictError extends Error {}
function registerPort(
  transport: "https" | "tcp" | "funnel",
  port: number,
  localPort: number,
  runner: TailscaleCommandRunner
): void {
  const mode = transport === "funnel" ? "funnel" : "serve";
  const protocol = transport === "tcp" ? "tcp" : "https";
  const target = `${transport === "tcp" ? "tcp" : "http"}://127.0.0.1:${localPort}`;
  const result = runner([mode, "--bg", "--yes", `--${protocol}=${port}`, target]);
  if (result.error) {
    if (transport === "funnel" && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
      throw new Error(
        "Tailscale Funnel registration timed out. Make sure Funnel is enabled on your tailnet, then run portless again."
      );
    throwCommandError(result.error, `register tailscale ${mode}`);
  }
  if (result.status !== 0) {
    const output = `${result.stderr}\n${result.stdout}`;
    if (transport === "funnel" && /funnel is not enabled on your tailnet/i.test(output)) {
      const details = normalizeSpace(output);
      throw new Error(
        "Tailscale Funnel is not enabled on your tailnet. Enable Funnel for this node, then run portless again." +
          (details ? ` Tailscale said: ${details}` : "")
      );
    }
    if (/already in use|already exists|port conflict|address already/i.test(output))
      throw new TailscalePortConflictError(`Tailscale port ${port} is already in use.`);
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(
      `Failed to register tailscale ${mode} on port ${port}: ${details || "unknown tailscale error"}`
    );
  }
}
/** Register a Tailscale share and return its URL and cleanup record. */
export function share(options: ShareTailscaleOptions): TailscaleShareResult {
  const runner = options.runner ?? defaultRunner;
  if (options.preferredPort !== undefined) validatePort(options.preferredPort, options.kind);
  const request: TailscaleShareRequest =
    options.kind === "service"
      ? {
          kind: "service",
          serviceName: normalizeServiceName(
            options.serviceName ??
              (options.ready?.request.kind === "service" ? options.ready.request.serviceName : "")
          ),
        }
      : { kind: options.kind, preferredPort: options.preferredPort };
  const ready = options.ready ?? ensureTailscaleReady(request, { runner });
  if (ready.request.kind !== options.kind)
    throw new Error("Tailscale readiness does not match the requested share kind.");
  switch (ready.transport) {
    case "service": {
      const record: TailscaleShareRecord = {
        kind: "service",
        serviceId: ready.serviceId!,
        serviceName: ready.serviceName!,
      };
      if (readServeStatus(runner).services.has(record.serviceId.toLowerCase()))
        throw new Error(
          `Tailscale service ${record.serviceId} is already in use. Stop the existing service serve or choose a different service name.`
        );
      const conflict = options.claimShare?.(record);
      if (conflict)
        throw new Error(`Tailscale service ${record.serviceId} is already in use by ${conflict}.`);
      try {
        const result = runner([
          "serve",
          "--yes",
          `--service=${record.serviceId}`,
          "--https=443",
          `http://127.0.0.1:${options.localPort}`,
        ]);
        const pendingApproval = /approval from an admin is required|approval required/i.test(
          `${result.stdout}\n${result.stderr}`
        );
        if (result.error)
          throwCommandError(result.error, `register tailscale service ${record.serviceId}`);
        if (result.status !== 0) {
          if (pendingApproval)
            throw new Error(
              `Tailscale service ${record.serviceId} requires admin approval in the Tailscale admin console.`
            );
          const details = normalizeSpace(result.stderr || result.stdout);
          throw new Error(
            `Failed to register tailscale service ${record.serviceId}: ${details || "unknown tailscale error"}`
          );
        }
        return {
          url: ready.baseUrl,
          record,
          ...(pendingApproval ? { pendingApproval: true } : {}),
        };
      } catch (error) {
        options.releaseShare?.();
        throw error;
      }
    }
    case "https":
    case "tcp":
    case "funnel": {
      const transport = ready.transport;
      const tried = new Set<number>();
      let lastConflict: Error | undefined;
      const maxAttempts = options.preferredPort === undefined ? 3 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const used = readServeStatus(runner).ports;
        if (options.preferredPort !== undefined && used.has(options.preferredPort))
          throw new Error(
            `Tailscale port ${options.preferredPort} is already in use. Stop the existing serve or choose a different port.`
          );
        for (const port of tried) used.add(port);
        const port = options.preferredPort ?? findAvailablePort(used, transport);
        const record: Extract<TailscaleShareRecord, { port: number }> = { kind: transport, port };
        const conflict = options.claimShare?.(record);
        if (conflict) {
          lastConflict = new Error(`Tailscale port ${port} is already in use by ${conflict}.`);
          if (options.preferredPort !== undefined) throw lastConflict;
          tried.add(port);
          continue;
        }
        try {
          registerPort(transport, port, options.localPort, runner);
        } catch (error) {
          options.releaseShare?.();
          if (error instanceof TailscalePortConflictError && attempt + 1 < maxAttempts) {
            lastConflict = error;
            tried.add(port);
            continue;
          }
          throw error;
        }
        const defaultPort =
          (ready.baseUrl.startsWith("https://") && port === 443) ||
          (ready.baseUrl.startsWith("http://") && port === 80);
        return { url: defaultPort ? ready.baseUrl : `${ready.baseUrl}:${port}`, record };
      }
      throw lastConflict ?? new Error("Could not find an available Tailscale port.");
    }
  }
}
/** Remove a Tailscale share described by a cleanup record. */
export function unshare(
  record: TailscaleShareRecord,
  options: { ignoreMissing?: boolean; runner?: TailscaleCommandRunner } = {}
): void {
  let args: string[];
  switch (record.kind) {
    case "https":
      args = ["serve", "--yes", `--https=${record.port}`, "off"];
      break;
    case "tcp":
      args = ["serve", "--yes", `--tcp=${record.port}`, "off"];
      break;
    case "funnel":
      args = ["funnel", "--yes", `--https=${record.port}`, "off"];
      break;
    case "service":
      args = ["serve", "--yes", `--service=${record.serviceId}`, "--https=443", "off"];
      break;
  }
  const result = (options.runner ?? defaultRunner)(args);
  const description = describeTailscaleShare(record);
  if (result.error) throwCommandError(result.error, `remove ${description}`);
  if (result.status !== 0) {
    const output = `${result.stderr}\n${result.stdout}`;
    if (
      options.ignoreMissing &&
      /not found|no serve config|nothing to remove|does not exist/i.test(output)
    )
      return;
    const details = normalizeSpace(result.stderr || result.stdout);
    throw new Error(`Failed to remove ${description}: ${details || "unknown tailscale error"}`);
  }
}
/** Read a Tailscale share record, including legacy route metadata. */
export function tailscaleShareFromRoute(route: {
  tailscaleShare?: TailscaleShareRecord;
  tailscaleHttpsPort?: number;
  tailscaleFunnel?: boolean;
}): TailscaleShareRecord | undefined {
  if (route.tailscaleShare) return route.tailscaleShare;
  if (route.tailscaleHttpsPort !== undefined)
    return { kind: route.tailscaleFunnel ? "funnel" : "https", port: route.tailscaleHttpsPort };
  return undefined;
}
/** Return a stable key for a Tailscale share. */
export function tailscaleShareKey(record: TailscaleShareRecord): string {
  return record.kind === "service" ? `service:${record.serviceId}` : `port:${record.port}`;
}
/** Describe a Tailscale share for display. */
export function describeTailscaleShare(record: TailscaleShareRecord): string {
  switch (record.kind) {
    case "https":
      return `tailscale serve on port ${record.port}`;
    case "tcp":
      return `tailscale tcp serve on port ${record.port}`;
    case "funnel":
      return `tailscale funnel on port ${record.port}`;
    case "service":
      return `tailscale service ${record.serviceId}`;
  }
}

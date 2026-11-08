#!/usr/bin/env node

declare const __VERSION__: string;

import colors from "./colors.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  type ComposeContainers,
  type ComposeModel,
  allocatePorts,
  buildUpArgs,
  composeGlobalError,
  explicitProject,
  isDetachedUp,
  isGlobalFlagSet,
  parseContainers,
  planCompose,
  projectLabel,
  readsComposeFromStdin,
  routePort,
  splitComposeArgs,
  staleAliases,
} from "./compose.js";
import { createSNICallback, ensureCerts, isCATrusted, trustCA, untrustCA } from "./certs.js";
import { createHttpRedirectServer, createProxyServer } from "./proxy.js";
import {
  generateHostsSyncToken,
  removeHostsSyncToken,
  writeHostsSyncToken,
} from "./hosts-sync-auth.js";
import {
  fixOwnership,
  formatUptime,
  formatUrl,
  isErrnoException,
  isProcessAlive as isPidAlive,
  parseHostname,
  parseHostnames,
  parsePort,
} from "./utils.js";
import {
  checkHostResolution,
  getManagedHostnames,
  syncHostsFile,
  cleanHostsFile,
  shouldAutoSyncHosts,
} from "./hosts.js";
import {
  FILE_MODE,
  RouteConflictError,
  RouteStore,
  isValidUpstream,
  type RouteMapping,
} from "./routes.js";
import type { RouteInfo } from "./types.js";
import {
  ensureTailscaleReady,
  findAvailableServePort,
  formatTailscaleUrl,
  getUsedServePorts,
  registerFunnel,
  registerServe,
  unregisterTailscale,
} from "./tailscale.js";
import { ensureNgrokAvailable, startNgrok, stopNgrokProcess, stopTunnelPid } from "./tunnel.js";
import { ensureCloudflaredAvailable, startCloudflare } from "./cloudflare.js";
import {
  inferProjectName,
  detectWorktreePrefix,
  applyWorktreePrefix,
  truncateLabel,
  sanitizeForHostname,
} from "./auto.js";
import type { WorktreePrefix, WorktreePrefixStyle } from "./auto.js";
import {
  buildProxyStartConfig,
  canBindProxyPort,
  DEFAULT_TLD,
  FALLBACK_PROXY_PORT,
  INTERNAL_LAN_IP_ENV,
  INTERNAL_LAN_IP_FLAG,
  PRIVILEGED_PORT_THRESHOLD,
  WAIT_FOR_PROXY_INTERVAL_MS,
  WAIT_FOR_PROXY_MAX_ATTEMPTS,
  discoverState,
  findFreePort,
  findPidOnPort,
  guardWindowsOrphans,
  findPidsOnPort,
  findSelfDaemonizedListener,
  killOrphanedProcessGroup,
  getProcessStartTime,
  getProcessCommand,
  getDefaultPort,
  getDefaultTlds,
  getProxyBindTargets,
  canBindWithoutRoot,
  isUnprivilegedEnvEnabled,
  readUnprivilegedMarker,
  writeUnprivilegedMarker,
  getRiskyTldReason,
  injectFrameworkFlags,
  injectPackageScriptFrameworkFlags,
  resolveFrameworkBasename,
  isHttpsEnvDisabled,
  isPortListening,
  isWildcardEnvEnabled,
  isLanEnvEnabled,
  isProxyRunning,
  isWindows,
  killTree,
  listenOnProxyInterface,
  parseTldList,
  readLanMarker,
  readCustomCertMarker,
  readPersistedProxyState,
  readTldsFromDir,
  readTlsMarker,
  resolveStateDir,
  spawnCommand,
  reportHostsSync,
  syncHostsWithWarning,
  augmentedPath,
  waitForProxy,
  writeCustomCertMarker,
  writeLanMarker,
  writeTldFile,
  writeTldsFile,
  writeTlsMarker,
} from "./cli-utils.js";
import {
  attemptCATrustRemovalForCleanup,
  collectStateDirsForCleanup,
  removePortlessStateFiles,
} from "./clean-utils.js";
import {
  getLocalNetworkIp,
  isMdnsSupported,
  publish,
  startLanIpMonitor,
  unpublish,
  cleanupAll as cleanupMdns,
} from "./mdns.js";
import {
  loadConfig,
  resolveAppConfig,
  resolveScriptCommand,
  hasScript,
  isServerCommand,
  splitCommand,
  detectPackageManager,
  loadPackagePortlessConfig,
  mergeWorktreeConfig,
  ConfigValidationError,
} from "./config.js";
import type { AppConfig, LoadedConfig, WorktreeConfig } from "./config.js";
import { findWorkspaceRoot, discoverWorkspacePackages } from "./workspace.js";
import type { WorkspacePackage } from "./workspace.js";
import {
  ensureEnvLoader,
  writeManifest,
  removeManifest,
  buildNodeOptions,
  hasTurboConfig,
} from "./turbo.js";
import type { ManifestEntry } from "./turbo.js";
import {
  buildServiceUninstallSudoArgs,
  handleService,
  printServiceHelp,
  tryUninstallService,
} from "./service.js";
import { runMcp } from "./mcp.js";
import { hasHelpFlag, isCommandName, suggestCommand, type CommandName } from "./commands.js";
import { parseCommandArgs, visitLeadingFlags, UsageError, type FlagKind } from "./args.js";

const chalk = colors;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Display-friendly hosts file path. */
const HOSTS_DISPLAY = isWindows ? "hosts file" : "/etc/hosts";

/** Debounce delay (ms) for reloading routes after a file change. */
const DEBOUNCE_MS = 100;

/** Polling interval (ms) when fs.watch is unavailable. */
const POLL_INTERVAL_MS = 3000;

/** Grace period (ms) for connections to drain before force-exiting the proxy. */
const EXIT_TIMEOUT_MS = 2000;

/** Timeout (ms) for the sudo spawn when auto-starting the proxy. */
const SUDO_SPAWN_TIMEOUT_MS = 30_000;

type ProxyConfigExplicitness = {
  useHttps: boolean;
  customCert: boolean;
  lanMode: boolean;
  lanIp: boolean;
  tlds: boolean;
  useWildcard: boolean;
  unprivileged: boolean;
};

type ProxyConfig = {
  useHttps: boolean;
  customCertPath: string | null;
  customKeyPath: string | null;
  lanMode: boolean;
  lanIp: string | null;
  lanIpExplicit: boolean;
  tld: string;
  tlds: string[];
  useWildcard: boolean;
  /** Bind the wildcard address, accept loopback peers only, never elevate. */
  unprivileged: boolean;
};

function normalizeTlds(tlds: readonly string[]): string[] {
  return [...new Set(tlds.length > 0 ? tlds : [DEFAULT_TLD])];
}

function primaryTld(tlds: readonly string[]): string {
  return tlds[0] ?? DEFAULT_TLD;
}

function formatTldList(tlds: readonly string[]): string {
  return tlds.map((tld) => `.${tld}`).join(", ");
}

function defaultProxyConfig(
  tlds: readonly string[],
  useHttps: boolean,
  lanMode: boolean
): ProxyConfig {
  const effectiveTlds = lanMode ? ["local"] : normalizeTlds(tlds);
  return {
    useHttps,
    customCertPath: null,
    customKeyPath: null,
    lanMode,
    lanIp: null,
    lanIpExplicit: false,
    tld: primaryTld(effectiveTlds),
    tlds: effectiveTlds,
    useWildcard: false,
    unprivileged: false,
  };
}

function resolveProxyConfig(options: {
  persistedLanMode: boolean;
  persistedUnprivileged: boolean;
  explicit: ProxyConfigExplicitness;
  defaultTlds: string[];
  useHttps: boolean;
  customCertPath: string | null;
  customKeyPath: string | null;
  lanMode: boolean;
  lanIp: string | null;
  tlds: string[];
  useWildcard: boolean;
  unprivileged: boolean;
}): ProxyConfig {
  const config = defaultProxyConfig(
    options.defaultTlds,
    options.useHttps,
    options.explicit.lanMode ? options.lanMode : options.persistedLanMode
  );

  if (options.explicit.useHttps) {
    config.useHttps = options.useHttps;
    if (!options.useHttps) {
      config.customCertPath = null;
      config.customKeyPath = null;
    }
  }

  if (options.explicit.customCert) {
    config.useHttps = true;
    config.customCertPath = options.customCertPath;
    config.customKeyPath = options.customKeyPath;
  }

  if (options.explicit.lanMode) {
    config.lanMode = options.lanMode;
    if (!options.lanMode) {
      config.lanIp = null;
      config.lanIpExplicit = false;
      if (!options.explicit.tlds) {
        config.tlds = normalizeTlds(options.defaultTlds);
        config.tld = primaryTld(config.tlds);
      }
    }
  }

  if (options.explicit.lanIp && options.lanIp) {
    config.lanMode = true;
    config.lanIp = options.lanIp;
    config.lanIpExplicit = true;
  }

  if (options.explicit.tlds) {
    config.tlds = normalizeTlds(options.tlds);
    config.tld = primaryTld(config.tlds);
  }

  if (options.explicit.useWildcard) {
    config.useWildcard = options.useWildcard;
  }

  // Like LAN mode, a stopped unprivileged proxy keeps its mode for the next
  // start through proxy.unprivileged unless PORTLESS_UNPRIVILEGED overrides it.
  config.unprivileged = options.explicit.unprivileged
    ? options.unprivileged
    : options.persistedUnprivileged;

  // Unprivileged mode promises no prompt of any kind, and trusting a
  // generated CA is one. So it serves plain HTTP unless HTTPS was asked for.
  if (config.unprivileged && !options.explicit.useHttps && !options.explicit.customCert) {
    config.useHttps = false;
  }

  if (!config.lanMode) {
    config.lanIp = null;
    config.lanIpExplicit = false;
  }

  if (config.lanMode) {
    config.tlds = ["local"];
    config.tld = "local";
    if (!config.lanIpExplicit) {
      config.lanIp = null;
    }
  }

  if (!config.useHttps) {
    config.customCertPath = null;
    config.customKeyPath = null;
  }

  return config;
}

function readCurrentProxyConfig(dir: string): ProxyConfig {
  const lanIp = readLanMarker(dir);
  const tlds = readTldsFromDir(dir);
  const tld = primaryTld(tlds);

  return {
    useHttps: readTlsMarker(dir),
    customCertPath: null,
    customKeyPath: null,
    lanMode: lanIp !== null,
    lanIp,
    lanIpExplicit: false,
    tld,
    tlds,
    useWildcard: false,
    unprivileged: readUnprivilegedMarker(dir),
  };
}

function getProxyConfigMismatchMessages(
  desiredConfig: ProxyConfig,
  actualConfig: ProxyConfig,
  explicit: ProxyConfigExplicitness
): string[] {
  const messages: string[] = [];

  if (explicit.lanMode && desiredConfig.lanMode !== actualConfig.lanMode) {
    messages.push(
      desiredConfig.lanMode
        ? "requested LAN mode, but the running proxy is not using LAN mode"
        : "requested non-LAN mode, but the running proxy is using LAN mode"
    );
  }

  if (explicit.lanIp && desiredConfig.lanIp !== actualConfig.lanIp) {
    messages.push(
      `requested LAN IP ${desiredConfig.lanIp}, but the running proxy is using ${actualConfig.lanIp ?? "auto-detected LAN mode"}`
    );
  }

  if (explicit.useHttps && desiredConfig.useHttps !== actualConfig.useHttps) {
    messages.push(
      desiredConfig.useHttps
        ? "requested HTTPS, but the running proxy is using HTTP"
        : "requested HTTP, but the running proxy is using HTTPS"
    );
  }

  if (explicit.unprivileged && desiredConfig.unprivileged !== actualConfig.unprivileged) {
    messages.push(
      desiredConfig.unprivileged
        ? "requested unprivileged mode, but the running proxy was started with elevation"
        : "requested elevated mode, but the running proxy is unprivileged"
    );
  }

  if (
    explicit.tlds &&
    (desiredConfig.tlds.length !== actualConfig.tlds.length ||
      desiredConfig.tlds.some((tld, index) => tld !== actualConfig.tlds[index]))
  ) {
    messages.push(
      `requested ${formatTldList(desiredConfig.tlds)}, but the running proxy is using ${formatTldList(actualConfig.tlds)}`
    );
  }

  return messages;
}

/**
 * Whether starting the proxy on `port` needs sudo. Ports below 1024 are only
 * elevated when a bind on the real listener targets fails with EACCES, so a
 * Linux `ip_unprivileged_port_start` sysctl or a wildcard bind on macOS skips
 * the prompt.
 */
async function proxyPortNeedsElevation(port: number, lanMode: boolean): Promise<boolean> {
  if (isWindows || port >= PRIVILEGED_PORT_THRESHOLD || (process.getuid?.() ?? -1) === 0) {
    return false;
  }
  const lanBind = lanMode && isMdnsSupported().supported;
  return !(await canBindProxyPort(port, getProxyBindTargets(lanBind)));
}

function formatProxyStartCommand(proxyPort: number, config: ProxyConfig): string {
  const needsSudo = !isWindows && proxyPort < PRIVILEGED_PORT_THRESHOLD && !config.unprivileged;
  const { args } = buildProxyStartConfig({
    useHttps: config.useHttps,
    customCertPath: config.customCertPath,
    customKeyPath: config.customKeyPath,
    lanMode: config.lanMode,
    lanIp: config.lanIpExplicit ? config.lanIp : null,
    lanIpExplicit: config.lanIpExplicit,
    tld: config.tld,
    tlds: config.tlds,
    useWildcard: config.useWildcard,
    unprivileged: config.unprivileged,
    includePort: proxyPort !== getDefaultPort(config.useHttps),
    proxyPort,
  });
  return `${needsSudo ? "sudo " : ""}portless proxy start${args.length > 0 ? ` ${args.join(" ")}` : ""}`;
}

function printProxyConfigMismatch(
  proxyPort: number,
  desiredConfig: ProxyConfig,
  messages: string[]
): never {
  const needsSudo =
    !isWindows && proxyPort < PRIVILEGED_PORT_THRESHOLD && !desiredConfig.unprivileged;
  const portFlag = proxyPort !== getDefaultPort(desiredConfig.useHttps) ? ` -p ${proxyPort}` : "";
  console.error(
    chalk.yellow(`Proxy is already running on port ${proxyPort} with a different config.`)
  );
  for (const message of messages) {
    console.error(chalk.yellow(`- ${message}`));
  }
  console.error(chalk.blue("Stop it first, then restart with the desired settings:"));
  console.error(chalk.cyan(`  ${needsSudo ? "sudo " : ""}portless proxy stop${portFlag}`));
  console.error(chalk.cyan(`  ${formatProxyStartCommand(proxyPort, desiredConfig)}`));
  process.exit(1);
}

/**
 * Return the path to the portless entry script. Guards against the
 * (unlikely) case where process.argv[1] is undefined.
 */
function getEntryScript(): string {
  const script = process.argv[1];
  if (!script) {
    throw new Error("Cannot determine portless entry script (process.argv[1] is undefined)");
  }
  return script;
}

/**
 * Check whether portless is installed as a project dependency by walking
 * up from cwd looking for node_modules/portless. Used to distinguish a
 * local `npx portless` (allowed) from a one-off download (blocked).
 */
function isLocallyInstalled(): boolean {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, "node_modules", "portless", "package.json"))) {
      return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Collect PORTLESS_* env vars as KEY=VALUE strings suitable for
 * `sudo env KEY=VAL ...` invocations (sudo may strip the environment).
 */
function collectPortlessEnvArgs(): string[] {
  const envArgs: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PORTLESS_") && process.env[key]) {
      envArgs.push(`${key}=${process.env[key]}`);
    }
  }
  return envArgs;
}

/**
 * Re-run `portless proxy stop` under sudo. Returns true if sudo succeeded.
 */
function sudoStop(port: number): boolean {
  const stopArgs = [process.execPath, getEntryScript(), "proxy", "stop", "-p", String(port)];
  console.log(colors.yellow("Proxy is running as root. Elevating with sudo to stop it..."));
  const result = spawnSync("sudo", ["env", ...collectPortlessEnvArgs(), ...stopArgs], {
    stdio: "inherit",
    timeout: SUDO_SPAWN_TIMEOUT_MS,
  });
  return result.status === 0;
}

function runCleanWithSudo(reason: string): boolean {
  console.log(colors.yellow(`${reason} Requesting sudo...`));
  const home = process.env.HOME;
  const result = spawnSync(
    "sudo",
    [
      "env",
      ...collectPortlessEnvArgs(),
      ...(home ? [`HOME=${home}`] : []),
      process.execPath,
      getEntryScript(),
      "clean",
    ],
    {
      stdio: "inherit",
      timeout: SUDO_SPAWN_TIMEOUT_MS,
    }
  );
  return result.status === 0;
}

function runServiceUninstallWithSudo(reason: string): boolean {
  console.log(colors.yellow(`${reason} Requesting sudo...`));
  const result = spawnSync("sudo", buildServiceUninstallSudoArgs(getEntryScript()), {
    stdio: "inherit",
    timeout: SUDO_SPAWN_TIMEOUT_MS,
  });
  return result.status === 0;
}

function isEnabledEnv(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/**
 * Whether the proxy should be accepted as already running. Shared with the
 * multi-app collision preflight so both agree on which TLDs are in effect.
 */
async function isProxyUp(proxyPort: number, tls: boolean): Promise<boolean> {
  if (await isProxyRunning(proxyPort, tls)) return true;
  return !!process.env.PORTLESS_STATE_DIR && (await isPortListening(proxyPort));
}

function formatProcessExitSuffix(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return ` (signal ${signal})`;
  if (code !== null) return ` (exit ${code})`;
  return "";
}

function buildHostnames(
  name: string,
  tlds: readonly string[],
  targetTlds?: readonly string[]
): string[] {
  return parseHostnames(name, normalizeTlds(tlds), targetTlds);
}

function formatUrls(hostnames: readonly string[], proxyPort: number, tls: boolean): string[] {
  return hostnames.map((hostname) => formatUrl(hostname, proxyPort, tls));
}

function formatViteAllowedHosts(tlds: readonly string[]): string {
  return tlds.map((configuredTld) => `.${configuredTld}`).join(",");
}

function formatBindEndpoint(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

type AliasUpstream = NonNullable<RouteInfo["upstream"]>;

function parseAliasUpstream(value: string): AliasUpstream {
  const usage = 'Use "https", "https://<host>[:<port>]", or "http://<host>[:<port>]".';
  let upstream: AliasUpstream;
  if (value === "https") {
    upstream = { tls: true };
  } else {
    const match = /^(https?):\/\/(.+)$/.exec(value);
    if (!match || match[0] !== value) throw new Error(usage);
    upstream = { tls: match[1] === "https", host: match[2]! };
  }

  if (!isValidUpstream(upstream)) {
    throw new Error(`${usage} The authority must be a hostname or IP with an optional port.`);
  }
  return upstream;
}

function isUnavailableIpv6Bind(err: NodeJS.ErrnoException, host: string): boolean {
  return host.includes(":") && (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL");
}

function addRoutes(
  store: RouteStore,
  hostnames: readonly string[],
  port: number,
  pid: number,
  force = false,
  upstream?: AliasUpstream
): number[] {
  const registered: string[] = [];
  const killedPids: number[] = [];
  try {
    for (const hostname of hostnames) {
      const killedPid = store.addRoute(hostname, port, pid, force, upstream);
      registered.push(hostname);
      if (killedPid !== undefined) {
        killedPids.push(killedPid);
      }
    }
  } catch (err) {
    for (const hostname of registered) {
      try {
        store.removeRoute(hostname, pid);
      } catch {
        // Non-fatal rollback cleanup.
      }
    }
    throw err;
  }
  return [...new Set(killedPids)];
}

/**
 * Stop dev servers left running by portless sessions that died without
 * cleanup (SIGKILL, crash). Their routes are about to be dropped as stale, and
 * the stored process group is the only remaining link to the orphaned tree.
 */
function stopOrphanedProcessGroups(store: RouteStore): void {
  const seen = new Set<number>();
  for (const route of store.loadRoutesRaw()) {
    if (route.pid === 0 || isPidAlive(route.pid)) continue;
    for (const t of stopRecordedTunnels(route, true)) {
      const message = `Stopped orphaned ${t.label} tunnel from a previous session (pid ${route[t.pidField]})`;
      console.log(colors.yellow(message));
    }
    const pgid = route.childPgid;
    if (!pgid || seen.has(pgid)) continue;
    seen.add(pgid);
    if (killOrphanedProcessGroup(pgid, route.childStartTime)) {
      console.log(
        colors.yellow(`Stopped orphaned dev server from a previous session (process group ${pgid})`)
      );
    }
  }
}

const PROCESS_TUNNELS = [
  {
    label: "ngrok",
    binary: "ngrok",
    env: "PORTLESS_NGROK",
    via: "ngrok",
    install: "https://ngrok.com/download",
    urlField: "ngrokUrl",
    pidField: "ngrokPid",
    ensure: ensureNgrokAvailable,
    start: startNgrok,
  },
  {
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
] as const;

type ProcessTunnel = (typeof PROCESS_TUNNELS)[number];

/** Stop the tunnel processes recorded on a route; `verify` skips pids not running the tunnel binary. */
function stopRecordedTunnels(route: RouteMapping, verify = false): ProcessTunnel[] {
  return PROCESS_TUNNELS.filter((t) => {
    const pid = route[t.pidField];
    if (!pid || (verify && getProcessCommand(pid) !== t.binary)) return false;
    stopTunnelPid(pid);
    return true;
  });
}

/** Print the install or auth hint that matches a tunnel error message. */
function printTunnelHint(t: ProcessTunnel, message: string): void {
  if (message.includes(`${t.binary} CLI not found`)) {
    console.error(colors.blue(`Install ${t.binary}: ${t.install}`));
  } else if (t.binary === "ngrok" && message.includes("authentication is not configured")) {
    console.error(colors.blue("Configure ngrok authentication:"));
    console.error(colors.cyan("  ngrok config add-authtoken <token>"));
  }
}

function removeRoutes(store: RouteStore, hostnames: readonly string[], ownerPid?: number): void {
  for (const hostname of hostnames) {
    try {
      store.removeRoute(hostname, ownerPid);
    } catch {
      // Non-fatal cleanup.
    }
  }
}

/**
 * Keep routes served when the command self-daemonized: its launcher exited
 * but a listener is still on the assigned port. The routes move to that
 * listener's pid, so the proxy keeps serving them and they drop on their own
 * once it exits. A listener that already held the port before the command
 * started is not the command's daemon, so its routes are left to cleanup.
 * Issue #411.
 */
async function transferRoutesToDaemon(
  store: RouteStore,
  hostnames: readonly string[],
  port: number,
  processGroupId: number | undefined,
  preexistingPid: number | null,
  exitedCleanly: boolean
): Promise<void> {
  const listenerPid = await findSelfDaemonizedListener(
    port,
    processGroupId,
    EXIT_TIMEOUT_MS,
    exitedCleanly
  );
  if (listenerPid === null || listenerPid === preexistingPid) return;
  let transferred = false;
  for (const hostname of hostnames) {
    try {
      transferred = store.transferRoute(hostname, process.pid, listenerPid) || transferred;
    } catch {
      // Lock acquisition may fail during cleanup; the exit cleanup removes the route.
    }
  }
  if (!transferred) return;
  console.warn(
    colors.yellow(
      `Command exited but PID ${listenerPid} is still serving port ${port}. Keeping ${hostnames[0]} routed to it. Stop it with: kill ${listenerPid}`
    )
  );
}

/** PID already listening on a port before a command is spawned, if any. */
async function findPreexistingListener(port: number): Promise<number | null> {
  return (await isPortListening(port)) ? findPidOnPort(port) : null;
}

/** Warn on this terminal if a route it registered will not resolve. Issue #364. */
function reportHostsSyncHere(
  hostnames: string[],
  port: number,
  tls: boolean,
  lanMode: boolean
): Promise<void> {
  return reportHostsSync(hostnames, port, tls, lanMode, (message) =>
    console.warn(colors.yellow(message))
  );
}

// ---------------------------------------------------------------------------
// Proxy server lifecycle
// ---------------------------------------------------------------------------

function startProxyServer(
  store: RouteStore,
  proxyPort: number,
  tld: string,
  tlds: string[],
  tlsOptions?: { cert: Buffer; key: Buffer },
  lanIp?: string | null,
  strict?: boolean,
  customCert = false,
  unprivileged = false
): void {
  store.ensureDir();

  const isTls = !!tlsOptions;
  const mdnsSupport = isMdnsSupported();
  let activeLanIp = lanIp && mdnsSupport.supported ? lanIp : null;
  const lanModeActive = activeLanIp !== null;
  const bindTargets = getProxyBindTargets(lanModeActive, unprivileged);
  const primaryBindTarget = bindTargets[0]!;
  // LAN mode wants remote peers; unprivileged mode binds the same addresses
  // only to get the port, so it keeps the proxy loopback-only itself.
  const loopbackOnly = unprivileged && !lanModeActive;
  const lanIpPinned = !!process.env.PORTLESS_LAN_IP;
  let lanMonitor: ReturnType<typeof startLanIpMonitor> | null = null;
  if (lanIp && !mdnsSupport.supported) {
    const reason = mdnsSupport.reason ?? "mDNS publishing is not supported on this platform.";
    console.warn(chalk.yellow(`LAN mode disabled: ${reason}`));
  }

  // Create empty routes file if it doesn't exist
  const routesPath = store.getRoutesPath();
  if (!fs.existsSync(routesPath)) {
    fs.writeFileSync(routesPath, "[]", { mode: FILE_MODE });
  }
  try {
    fs.chmodSync(routesPath, FILE_MODE);
  } catch {
    // May fail if file is owned by another user; non-fatal
  }
  fixOwnership(routesPath);

  // Cache routes in memory and reload on file change (debounced)
  let cachedRoutes = store.loadRoutes();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;
  let pollingInterval: ReturnType<typeof setInterval> | null = null;

  // Writing the hosts file needs root, which unprivileged mode never has, so
  // it does not try; `proxy start` refuses an explicit PORTLESS_SYNC_HOSTS=1.
  const autoSyncHosts = !unprivileged && shouldAutoSyncHosts(process.env.PORTLESS_SYNC_HOSTS);
  const hostsSyncToken = generateHostsSyncToken();

  const onMdnsError = (msg: string) => console.warn(chalk.yellow(msg));

  const publishCachedRoutes = () => {
    if (!activeLanIp) return;
    for (const route of cachedRoutes) {
      publish(route.hostname, proxyPort, activeLanIp, onMdnsError);
    }
  };

  const updateLanIp = (nextIp: string | null, previousIp = activeLanIp) => {
    if (nextIp === activeLanIp) return;

    if (activeLanIp) {
      cleanupMdns();
    }

    activeLanIp = nextIp;
    writeLanMarker(store.dir, activeLanIp);

    if (previousIp && nextIp) {
      console.log(chalk.green(`LAN IP changed: ${previousIp} -> ${nextIp}`));
    } else if (previousIp && !nextIp) {
      console.warn(chalk.yellow("LAN mode temporarily unavailable: no active LAN IP"));
    } else if (!previousIp && nextIp) {
      console.log(chalk.green(`LAN mode restored: ${nextIp}`));
    }

    publishCachedRoutes();
  };

  // Bounds proxy.log on repeated reloads. Not a user-facing channel: users are
  // warned by the CLI reading the resolver, so latching here silences nobody.
  let hostsSyncWarned = false;
  const syncHostsAndLatch = (hostnames: string[]): boolean => {
    let ok = true;
    hostsSyncWarned = syncHostsWithWarning(
      hostnames,
      hostsSyncWarned,
      () => console.warn(colors.yellow(`Could not write ${HOSTS_DISPLAY} for route hostnames.`)),
      (names) => {
        ok = syncHostsFile(names);
        return ok;
      }
    );
    return ok;
  };

  const onHostsSyncRequest = (): "acted" | "disabled" => {
    if (!autoSyncHosts) return "disabled";
    let hostnames: string[];
    try {
      hostnames = store.loadRoutes().map((route) => route.hostname);
    } catch {
      hostnames = cachedRoutes.map((route) => route.hostname);
    }
    syncHostsAndLatch(hostnames);
    return "acted";
  };

  const reloadRoutes = () => {
    try {
      const previousRoutes = new Map(cachedRoutes.map((r) => [r.hostname, r.port]));
      cachedRoutes = store.loadRoutes();
      if (autoSyncHosts) {
        syncHostsAndLatch(cachedRoutes.map((r) => r.hostname));
      }
      // Sync mDNS records with current routes
      if (activeLanIp) {
        const currentRoutes = new Map(cachedRoutes.map((r) => [r.hostname, r.port]));
        for (const route of cachedRoutes) {
          const previousPort = previousRoutes.get(route.hostname);
          if (previousPort === undefined) {
            publish(route.hostname, proxyPort, activeLanIp, onMdnsError);
          } else if (previousPort !== route.port) {
            unpublish(route.hostname);
            publish(route.hostname, proxyPort, activeLanIp, onMdnsError);
          }
        }
        for (const hostname of previousRoutes.keys()) {
          if (!currentRoutes.has(hostname)) {
            unpublish(hostname);
          }
        }
      }
    } catch {
      // File may be mid-write; keep existing cached routes
    }
  };

  try {
    watcher = fs.watch(store.dir, (_event, filename) => {
      if (filename && filename !== path.basename(routesPath)) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(reloadRoutes, DEBOUNCE_MS);
    });
  } catch {
    // fs.watch may not be supported; fall back to periodic polling
    console.warn(colors.yellow("fs.watch unavailable; falling back to polling for route changes"));
    pollingInterval = setInterval(reloadRoutes, POLL_INTERVAL_MS);
  }

  if (autoSyncHosts) {
    syncHostsAndLatch(cachedRoutes.map((r) => r.hostname));
  }

  // Publish mDNS for routes that already exist at startup
  publishCachedRoutes();

  const createServer = () =>
    createProxyServer({
      // A route handed to a self-daemonized server outlives the file's last
      // change, so a dead owner triggers a reload instead of serving it.
      getRoutes: () => {
        if (!cachedRoutes.every((route) => store.isRouteOwnerAlive(route))) reloadRoutes();
        return cachedRoutes;
      },
      proxyPort,
      tld,
      tlds,
      strict,
      loopbackOnly,
      onError: (msg) => console.error(colors.red(msg)),
      onHostsSyncRequest,
      hostsSyncToken,
      tls: tlsOptions,
    });
  const server = createServer();
  const additionalServers = new Set<ReturnType<typeof createProxyServer>>();
  const redirectServers = new Set<ReturnType<typeof createHttpRedirectServer>>();

  const closeAuxiliaryServers = () => {
    for (const auxiliaryServer of [...additionalServers, ...redirectServers]) {
      try {
        auxiliaryServer.close();
      } catch {
        // The listener may have failed before it started; nothing to close.
      }
    }
  };

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(colors.red(`Port ${proxyPort} is already in use.`));
      console.error(colors.blue("Stop the existing proxy first:"));
      console.error(colors.cyan("  portless proxy stop"));
      console.error(colors.blue("Or check what is using the port:"));
      console.error(
        colors.cyan(
          isWindows ? `  netstat -ano | findstr :${proxyPort}` : `  lsof -ti tcp:${proxyPort}`
        )
      );
    } else if (err.code === "EACCES") {
      console.error(colors.red(`Permission denied for port ${proxyPort}.`));
      console.error(colors.blue("Use an unprivileged port (no sudo needed):"));
      console.error(colors.cyan("  portless proxy start -p 1355"));
    } else {
      console.error(colors.red(`Proxy error: ${err.message}`));
    }
    closeAuxiliaryServers();
    process.exit(1);
  });

  const proto = isTls ? "HTTPS/2" : "HTTP";
  const tldLabel = tlds.length > 1 || tld !== DEFAULT_TLD ? ` (TLDs: ${formatTldList(tlds)})` : "";
  const modeLabel = `${strict === false ? " (wildcard)" : ""}${loopbackOnly ? " (unprivileged, loopback peers only)" : ""}`;

  for (const bindTarget of bindTargets.slice(1)) {
    const additionalServer = createServer();
    additionalServers.add(additionalServer);
    additionalServer.on("error", (err: NodeJS.ErrnoException) => {
      additionalServers.delete(additionalServer);
      if (!isUnavailableIpv6Bind(err, bindTarget.host)) {
        console.warn(
          colors.yellow(
            `Could not listen on ${formatBindEndpoint(bindTarget.host, proxyPort)}: ${err.message}`
          )
        );
      }
    });
    listenOnProxyInterface(additionalServer, proxyPort, bindTarget, () => {
      console.log(
        colors.green(
          `${proto} proxy listening on ${formatBindEndpoint(bindTarget.host, proxyPort)}${tldLabel}${modeLabel}`
        )
      );
    });
  }

  // When TLS is enabled, start a plain HTTP server on port 80 that redirects
  // to HTTPS. Best-effort: if port 80 is unavailable, skip silently (the main
  // proxy on 443 still works; users just won't get automatic redirects).
  if (isTls && proxyPort !== 80) {
    for (const bindTarget of bindTargets) {
      const redirectServer = createHttpRedirectServer(proxyPort, loopbackOnly);
      redirectServers.add(redirectServer);
      redirectServer.on("error", () => {
        redirectServers.delete(redirectServer);
      });
      listenOnProxyInterface(redirectServer, 80, bindTarget, () => {
        console.log(
          colors.green(
            `HTTP-to-HTTPS redirect listening on ${formatBindEndpoint(bindTarget.host, 80)}`
          )
        );
      });
    }
  }

  listenOnProxyInterface(server, proxyPort, primaryBindTarget, () => {
    if (!writeHostsSyncToken(store.dir, hostsSyncToken)) {
      console.warn(colors.yellow("Could not publish hosts sync authorization."));
    }
    // Save PID and port once the server is actually listening
    fs.writeFileSync(store.pidPath, process.pid.toString(), { mode: FILE_MODE });
    fs.writeFileSync(store.portFilePath, proxyPort.toString(), { mode: FILE_MODE });
    writeTlsMarker(store.dir, isTls);
    writeCustomCertMarker(store.dir, isTls && customCert);
    writeTldsFile(store.dir, tlds);
    writeLanMarker(store.dir, activeLanIp);
    writeUnprivilegedMarker(store.dir, unprivileged);
    fixOwnership(store.dir, store.pidPath, store.portFilePath);
    console.log(
      colors.green(
        `${proto} proxy listening on ${formatBindEndpoint(primaryBindTarget.host, proxyPort)}${tldLabel}${modeLabel}`
      )
    );
    if (activeLanIp) {
      console.log(chalk.green(`LAN mode: ${activeLanIp}`));
      console.log(chalk.gray("Services are discoverable as <name>.local on your network"));
      if (isTls && !customCert) {
        console.log(chalk.yellow("For HTTPS on devices, install the CA certificate:"));
        console.log(chalk.gray(`  ${path.join(store.dir, "ca.pem")}`));
      }
      if (!lanIpPinned) {
        lanMonitor = startLanIpMonitor({
          initialIp: activeLanIp,
          onChange: (nextIp, previousIp) => updateLanIp(nextIp, previousIp),
          onError: (error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(chalk.yellow(`Failed to refresh LAN IP: ${message}`));
          },
        });
      }
    }
  });

  // Cleanup on exit
  let exiting = false;
  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollingInterval) clearInterval(pollingInterval);
    if (lanMonitor) lanMonitor.stop();
    if (watcher) {
      watcher.close();
    }
    if (activeLanIp) cleanupMdns();
    closeAuxiliaryServers();
    try {
      fs.unlinkSync(store.pidPath);
    } catch {
      // PID file may already be removed; non-fatal
    }
    try {
      fs.unlinkSync(store.portFilePath);
    } catch {
      // Port file may already be removed; non-fatal
    }
    writeTlsMarker(store.dir, false);
    writeCustomCertMarker(store.dir, false);
    writeTldFile(store.dir, DEFAULT_TLD);
    writeLanMarker(store.dir, null);
    removeHostsSyncToken(store.dir);
    if (autoSyncHosts) cleanHostsFile();
    server.close(() => process.exit(0));
    // Force exit after a short timeout in case connections don't drain
    setTimeout(() => process.exit(0), EXIT_TIMEOUT_MS).unref();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(colors.cyan("\nProxy is running. Press Ctrl+C to stop.\n"));
  console.log(colors.gray(`Routes file: ${store.getRoutesPath()}`));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function sudoStopOrHint(port: number): void {
  if (!isWindows) {
    if (!sudoStop(port)) {
      console.error(colors.red("Failed to stop proxy with sudo."));
      console.error(colors.blue("Try manually:"));
      console.error(colors.cyan(`  portless proxy stop -p ${port}`));
    }
  } else {
    console.error(colors.red("Permission denied. The proxy was started with elevated privileges."));
    console.error(colors.blue("Stop it with:"));
    console.error(colors.cyan("  Run portless proxy stop as Administrator"));
  }
}

async function stopProxy(store: RouteStore, proxyPort: number, _tls: boolean): Promise<void> {
  const pidPath = store.pidPath;

  if (!fs.existsSync(pidPath)) {
    // PID file is missing; check whether something is still listening.
    // Use plain HTTP: the TLS proxy accepts it via byte-peeking, and this
    // avoids false negatives from TLS handshake timeouts.
    if (await isProxyRunning(proxyPort)) {
      console.log(colors.yellow(`PID file is missing but port ${proxyPort} is still in use.`));
      const pid = findPidOnPort(proxyPort);
      if (pid !== null) {
        try {
          process.kill(pid, "SIGTERM");
          try {
            fs.unlinkSync(store.portFilePath);
          } catch {
            // Port file may already be absent; non-fatal
          }
          writeTlsMarker(store.dir, false);
          writeCustomCertMarker(store.dir, false);
          writeTldFile(store.dir, DEFAULT_TLD);
          writeLanMarker(store.dir, null);
          console.log(colors.green(`Killed process ${pid}. Proxy stopped.`));
        } catch (err: unknown) {
          if (isErrnoException(err) && err.code === "EPERM") {
            sudoStopOrHint(proxyPort);
          } else {
            const message = err instanceof Error ? err.message : String(err);
            console.error(colors.red(`Failed to stop proxy: ${message}`));
            console.error(colors.blue("Check if the process is still running:"));
            console.error(
              colors.cyan(
                isWindows ? `  netstat -ano | findstr :${proxyPort}` : `  lsof -ti tcp:${proxyPort}`
              )
            );
          }
        }
      } else if (!isWindows && process.getuid?.() !== 0) {
        sudoStopOrHint(proxyPort);
      } else {
        console.error(colors.red(`Could not identify the process on port ${proxyPort}.`));
        console.error(colors.blue("Try manually:"));
        console.error(
          colors.cyan(
            isWindows ? "  taskkill /F /PID <pid>" : `  sudo kill "$(lsof -ti tcp:${proxyPort})"`
          )
        );
      }
    } else {
      console.log(colors.yellow("Proxy is not running."));
    }
    return;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8"), 10);
    if (isNaN(pid)) {
      console.error(colors.red("Corrupted PID file. Removing it."));
      fs.unlinkSync(pidPath);
      writeTlsMarker(store.dir, false);
      writeCustomCertMarker(store.dir, false);
      writeTldFile(store.dir, DEFAULT_TLD);
      writeLanMarker(store.dir, null);
      return;
    }

    // Check if the process is still alive before trying to kill it
    try {
      process.kill(pid, 0);
    } catch (err: unknown) {
      if (isErrnoException(err) && err.code === "EPERM") {
        sudoStopOrHint(proxyPort);
        return;
      }
      console.log(colors.yellow("Proxy process is no longer running. Cleaning up stale files."));
      fs.unlinkSync(pidPath);
      try {
        fs.unlinkSync(store.portFilePath);
      } catch {
        // Port file may already be absent; non-fatal
      }
      writeTlsMarker(store.dir, false);
      writeCustomCertMarker(store.dir, false);
      writeTldFile(store.dir, DEFAULT_TLD);
      writeLanMarker(store.dir, null);
      return;
    }

    // Verify the process is actually running a proxy on the expected port.
    // If the PID was recycled by an unrelated process, the port won't be listening.
    // Plain HTTP works for both TLS and non-TLS proxies (byte-peeking).
    if (!(await isProxyRunning(proxyPort))) {
      console.log(
        colors.yellow(
          `PID file exists but port ${proxyPort} is not listening. The PID may have been recycled.`
        )
      );
      console.log(colors.yellow("Removing stale PID file."));
      fs.unlinkSync(pidPath);
      writeTlsMarker(store.dir, false);
      writeCustomCertMarker(store.dir, false);
      writeTldFile(store.dir, DEFAULT_TLD);
      writeLanMarker(store.dir, null);
      return;
    }

    process.kill(pid, "SIGTERM");
    fs.unlinkSync(pidPath);
    try {
      fs.unlinkSync(store.portFilePath);
    } catch {
      // Port file may already be removed; non-fatal
    }
    writeTlsMarker(store.dir, false);
    writeCustomCertMarker(store.dir, false);
    writeTldFile(store.dir, DEFAULT_TLD);
    writeLanMarker(store.dir, null);
    console.log(colors.green("Proxy stopped."));
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "EPERM") {
      sudoStopOrHint(proxyPort);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(colors.red(`Failed to stop proxy: ${message}`));
      console.error(colors.blue("Check if the process is still running:"));
      console.error(
        colors.cyan(
          isWindows ? `  netstat -ano | findstr :${proxyPort}` : `  lsof -ti tcp:${proxyPort}`
        )
      );
    }
  }
}

function listRoutes(store: RouteStore, proxyPort: number, tls: boolean): void {
  const routes = store.loadRoutes();

  if (routes.length === 0) {
    console.log(colors.yellow("No active routes."));
    console.log(colors.gray("Start an app with: portless <name> <command>"));
    return;
  }

  console.log(colors.blue.bold("\nActive routes:\n"));
  for (const route of routes) {
    const url = formatUrl(route.hostname, proxyPort, tls);
    const upstream = route.upstream;
    const endpoint = upstream
      ? `${upstream.tls ? "https" : "http"}://localhost:${route.port}`
      : `localhost:${route.port}`;
    const label = route.pid === 0 ? "(alias)" : `(pid ${route.pid})`;
    const uptime = route.pid === 0 ? null : formatUptime(route.registeredAt, Date.now());
    console.log(
      `  ${colors.cyan(url)}  ${colors.gray("->")}  ${colors.white(endpoint)}  ${colors.gray(label)}${uptime ? ` ${colors.gray(`up ${uptime}`)}` : ""}`
    );
    if (upstream?.host) {
      console.log(`    ${colors.gray("Host:")} ${colors.white(upstream.host)}`);
    }
    if (route.tailscaleUrl) {
      const tsLabel = route.tailscaleFunnel ? "funnel" : "tailscale";
      console.log(`    ${colors.gray(tsLabel + ":")} ${colors.green(route.tailscaleUrl)}`);
    }
    for (const t of PROCESS_TUNNELS) {
      const tunnelUrl = route[t.urlField];
      if (tunnelUrl)
        console.log(`    ${colors.gray(t.label.toLowerCase() + ":")} ${colors.green(tunnelUrl)}`);
    }
  }
  console.log();
}

type EnsureProxyResult =
  | { started: true; state: Awaited<ReturnType<typeof discoverState>> }
  | { started: false };

interface ProxyDesiredState {
  explicit: ProxyConfigExplicitness;
  desiredConfig: ReturnType<typeof resolveProxyConfig>;
  envTld: string;
  envTlds: string[];
}

function resolveProxyDesiredState(lanMode: boolean): ProxyDesiredState {
  const envTlds = getDefaultTlds();
  const envTld = primaryTld(envTlds);
  const explicit: ProxyConfigExplicitness = {
    useHttps: process.env.PORTLESS_HTTPS !== undefined,
    customCert: false,
    lanMode: process.env.PORTLESS_LAN !== undefined,
    lanIp: process.env.PORTLESS_LAN_IP !== undefined,
    tlds: process.env.PORTLESS_TLD !== undefined,
    useWildcard: process.env.PORTLESS_WILDCARD !== undefined,
    unprivileged: process.env.PORTLESS_UNPRIVILEGED !== undefined,
  };
  const desiredConfig = resolveProxyConfig({
    persistedLanMode: lanMode,
    persistedUnprivileged: readUnprivilegedMarker(resolveStateDir()),
    explicit,
    defaultTlds: envTlds,
    useHttps: !isHttpsEnvDisabled(),
    customCertPath: null,
    customKeyPath: null,
    lanMode: isLanEnvEnabled(),
    lanIp: process.env.PORTLESS_LAN_IP || null,
    tlds: envTlds,
    useWildcard: isWildcardEnvEnabled(),
    unprivileged: isUnprivilegedEnvEnabled(),
  });
  return { explicit, desiredConfig, envTld, envTlds };
}

/**
 * Resolve the config and port a stopped proxy starts with, applying persisted
 * overrides unless the environment is explicit. Shared by the starter and the
 * multi-app collision preflight so both read the same effective TLDs.
 */
function resolveProxyStart(desired: ProxyDesiredState): {
  startConfig: ReturnType<typeof resolveProxyConfig>;
  startPort: number | undefined;
} {
  const { explicit, desiredConfig } = desired;
  const persisted = readPersistedProxyState();
  const startConfig = { ...desiredConfig };
  let startPort: number | undefined;

  if (persisted) {
    if (!explicit.useHttps && persisted.tls !== desiredConfig.useHttps) {
      startConfig.useHttps = persisted.tls;
    }
    if (
      !explicit.tlds &&
      (persisted.tlds.length !== desiredConfig.tlds.length ||
        persisted.tlds.some((tld, index) => tld !== desiredConfig.tlds[index]))
    ) {
      startConfig.tlds = persisted.tlds;
      startConfig.tld = primaryTld(persisted.tlds);
    }
    if (!explicit.lanMode && persisted.lanMode !== desiredConfig.lanMode) {
      startConfig.lanMode = persisted.lanMode;
    }
    if (!explicit.unprivileged && persisted.unprivileged !== desiredConfig.unprivileged) {
      startConfig.unprivileged = persisted.unprivileged;
    }
    const envPort = getDefaultPort(startConfig.useHttps);
    if (persisted.port !== envPort) {
      startPort = persisted.port;
    }
  }

  return { startConfig, startPort };
}

/**
 * Check if the proxy is running and auto-start it if needed.
 * Returns the discovered state after start, or `{ started: false }` when
 * the proxy was already up.
 */
async function ensureProxyRunning(
  proxyPort: number,
  tls: boolean,
  desired: ProxyDesiredState
): Promise<EnsureProxyResult> {
  if (await isProxyUp(proxyPort, tls)) {
    return { started: false };
  }

  const { startConfig, startPort } = resolveProxyStart(desired);

  const effectivePort = startPort ?? getDefaultPort(startConfig.useHttps);
  const needsSudo =
    !startConfig.unprivileged &&
    (await proxyPortNeedsElevation(effectivePort, startConfig.lanMode));
  const manualStartCommand = formatProxyStartCommand(effectivePort, startConfig);
  const fallbackStartCommand = formatProxyStartCommand(FALLBACK_PROXY_PORT, startConfig);

  const isInteractive = !!process.stdin.isTTY && !process.env.CI;

  if (needsSudo && !isInteractive) {
    console.error(colors.red("Proxy is not running and no TTY is available for sudo."));
    console.error(colors.blue("Option 1: start the proxy in a terminal (will prompt for sudo):"));
    console.error(colors.cyan(`  ${manualStartCommand}`));
    console.error(
      colors.blue(
        `Option 2: use an unprivileged port (no sudo needed, URLs will include :${FALLBACK_PROXY_PORT}):`
      )
    );
    console.error(colors.cyan(`  ${fallbackStartCommand}`));
    process.exit(1);
  }

  console.log(colors.gray("Starting proxy..."));
  const proxyStartConfig = buildProxyStartConfig({
    useHttps: startConfig.useHttps,
    customCertPath: startConfig.customCertPath,
    customKeyPath: startConfig.customKeyPath,
    lanMode: startConfig.lanMode,
    lanIp: startConfig.lanIpExplicit ? startConfig.lanIp : null,
    lanIpExplicit: startConfig.lanIpExplicit,
    tld: startConfig.tld,
    tlds: startConfig.tlds,
    useWildcard: startConfig.useWildcard,
    unprivileged: startConfig.unprivileged,
    includePort: startPort !== undefined,
    proxyPort: startPort,
  });
  const startArgs = [getEntryScript(), "proxy", "start", ...proxyStartConfig.args];

  const result = spawnSync(process.execPath, startArgs, {
    stdio: "inherit",
    timeout: SUDO_SPAWN_TIMEOUT_MS,
  });

  let discovered: Awaited<ReturnType<typeof discoverState>> | null = null;
  if (!result.signal) {
    for (let i = 0; i < WAIT_FOR_PROXY_MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, WAIT_FOR_PROXY_INTERVAL_MS));
      const state = await discoverState();
      if (await isProxyRunning(state.port)) {
        discovered = state;
        break;
      }
    }
  }

  if (!discovered) {
    console.error(colors.red("Failed to start proxy."));
    const fallbackDir = resolveStateDir(effectivePort);
    const logPath = path.join(fallbackDir, "proxy.log");
    console.error(colors.blue("Try starting it manually:"));
    console.error(colors.cyan(`  ${manualStartCommand}`));
    if (fs.existsSync(logPath)) {
      console.error(colors.gray(`Logs: ${logPath}`));
    }
    process.exit(1);
    return { started: false }; // unreachable; helps TypeScript narrow `discovered`
  }

  return { started: true, state: discovered };
}

async function runApp(
  initialStore: RouteStore,
  proxyPort: number,
  stateDir: string,
  name: string,
  commandArgs: string[],
  tls: boolean,
  tlds: string[],
  force: boolean,
  autoInfo?: { nameSource: string; baseName: string; prefix?: string; prefixSource?: string },
  desiredPort?: number,
  lanMode = false,
  lanIp?: string | null
) {
  let store = initialStore;
  console.log(chalk.blue.bold(`\nportless\n`));

  // Check tailscale readiness early, before auto-starting the proxy.
  // No point starting the proxy if tailscale will fail afterward.
  const wantsFunnel = isEnabledEnv(process.env.PORTLESS_FUNNEL);
  const wantsTailscale = wantsFunnel || isEnabledEnv(process.env.PORTLESS_TAILSCALE);
  const tunnels = PROCESS_TUNNELS.filter((t) => isEnabledEnv(process.env[t.env]));
  let tsBaseUrl: string | undefined;

  if (wantsTailscale) {
    try {
      const tsReady = ensureTailscaleReady({
        requireFunnel: wantsFunnel,
        requireHttps: true,
      });
      tsBaseUrl = tsReady.baseUrl;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(colors.red(`Error: ${message}`));
      if (message.includes("not found")) {
        console.error(colors.blue("Install Tailscale: https://tailscale.com/download"));
      } else if (!message.includes("not enabled on your tailnet")) {
        console.error(colors.blue("Make sure Tailscale is connected:"));
        console.error(colors.cyan("  tailscale up"));
      }
      process.exit(1);
    }
  }

  for (const t of tunnels) {
    try {
      t.ensure();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(colors.red(`Error: ${message}`));
      printTunnelHint(t, message);
      process.exit(1);
    }
  }

  let desired: ProxyDesiredState;
  try {
    desired = resolveProxyDesiredState(lanMode);
  } catch (err) {
    console.error(colors.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }

  // Validate the hostname before we try to auto-start the proxy.
  buildHostnames(name, tlds);

  const ensureResult = await ensureProxyRunning(proxyPort, tls, desired);

  if (ensureResult.started) {
    proxyPort = ensureResult.state.port;
    stateDir = ensureResult.state.dir;
    tlds = ensureResult.state.tlds;
    tls = ensureResult.state.tls;
    lanMode = ensureResult.state.lanMode;
    lanIp = ensureResult.state.lanIp;
    store = new RouteStore(stateDir, {
      onWarning: (msg: string) => console.warn(colors.yellow(msg)),
    });
    if (tls && !isCATrusted(stateDir)) {
      await handleTrust();
    }
  } else {
    const runningConfig = readCurrentProxyConfig(stateDir);

    const mismatchMessages = getProxyConfigMismatchMessages(
      desired.desiredConfig,
      runningConfig,
      desired.explicit
    );
    if (mismatchMessages.length > 0) {
      printProxyConfigMismatch(proxyPort, desired.desiredConfig, mismatchMessages);
    }
    lanMode = runningConfig.lanMode;
    lanIp = runningConfig.lanIp;
    tlds = runningConfig.tlds;
    console.log(chalk.gray("-- Proxy is running"));
  }

  // Compute hostnames after auto-start so TLDs reflect the running proxy.
  const hostnames = buildHostnames(name, tlds);
  const hostname = hostnames[0]!;

  if (
    desired.explicit.tlds &&
    (desired.envTlds.some((envConfiguredTld, index) => envConfiguredTld !== tlds[index]) ||
      desired.envTlds.length !== tlds.length)
  ) {
    console.warn(
      chalk.yellow(
        `Warning: PORTLESS_TLD=${desired.envTlds.join(",")} but the running proxy uses ${formatTldList(tlds)}.`
      )
    );
  }

  if (lanIp) {
    console.log(chalk.gray(`-- ${hostnames.join(", ")} (LAN: ${lanIp})`));
  } else {
    console.log(chalk.gray(`-- ${hostnames.join(", ")} (auto-resolves to 127.0.0.1)`));
  }
  if (autoInfo) {
    console.log(chalk.gray(`-- Name "${autoInfo.baseName}" (from ${autoInfo.nameSource})`));
    if (autoInfo.prefix) {
      console.log(chalk.gray(`-- Prefix "${autoInfo.prefix}" (from ${autoInfo.prefixSource})`));
    }
  }

  const port = desiredPort ?? (await findFreePort());
  if (desiredPort) {
    console.log(colors.green(`-- Using port ${port} (fixed)`));
  } else {
    console.log(colors.green(`-- Using port ${port}`));
  }

  stopOrphanedProcessGroups(store);

  // Register route (--force kills the existing owner if any)
  let killedPids: number[] = [];
  try {
    killedPids = addRoutes(store, hostnames, port, process.pid, force);
    await reportHostsSyncHere(hostnames, proxyPort, tls, lanMode);
  } catch (err) {
    if (err instanceof RouteConflictError) {
      console.error(colors.red(`Error: ${err.message}`));
      process.exit(1);
    }
    throw err;
  }
  if (killedPids.length > 0) {
    console.log(colors.yellow(`Killed existing process(es): ${killedPids.join(", ")}`));
  }

  const finalUrl = formatUrl(hostname, proxyPort, tls);
  const allUrls = formatUrls(hostnames, proxyPort, tls);
  console.log(chalk.cyan.bold(`\n  -> ${finalUrl}\n`));
  for (const extraUrl of allUrls.slice(1)) {
    console.log(chalk.cyan(`  also -> ${extraUrl}`));
  }
  if (allUrls.length > 1) {
    console.log("");
  }
  if (lanIp) {
    console.log(chalk.green(`  LAN -> ${finalUrl}`));
    console.log(chalk.gray("  (accessible from other devices on the same WiFi network)\n"));
  }

  // Tailscale sharing: register with tailscale serve (or funnel).
  // Readiness was already checked at the top of runApp().
  let tailscaleHttpsPort: number | undefined;
  let tailscaleUrl: string | undefined;
  type TunnelRun = {
    t: ProcessTunnel;
    proc?: Awaited<ReturnType<typeof startNgrok>>;
    ready?: boolean;
    handled?: boolean;
    pending?: () => void;
  };
  const tunnelRuns = tunnels.map((t): TunnelRun => ({ t }));
  let stoppingTunnels = false;

  const handleTunnelExit = (run: TunnelRun, code: number | null, signal: NodeJS.Signals | null) => {
    if (stoppingTunnels || run.handled) return;
    if (!run.ready) {
      run.pending = () => handleTunnelExit(run, code, signal);
      return;
    }
    run.handled = true;
    console.warn(
      colors.yellow(
        `Warning: ${run.t.label} tunnel for ${hostname} stopped${formatProcessExitSuffix(
          code,
          signal
        )}. Removing its public URL from the route list.`
      )
    );
    try {
      store.updateRoute(hostname, {
        [run.t.urlField]: null,
        [run.t.pidField]: null,
      });
    } catch {
      // Best-effort cleanup; non-fatal
    }
  };

  if (wantsTailscale && tsBaseUrl) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const usedPorts = getUsedServePorts();
      tailscaleHttpsPort = findAvailableServePort(usedPorts, wantsFunnel ? "funnel" : "serve");
      try {
        if (wantsFunnel) {
          registerFunnel(port, tailscaleHttpsPort);
        } else {
          registerServe(port, tailscaleHttpsPort);
        }
        break;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const isConflict = message.includes("already in use");
        if (isConflict && attempt < maxAttempts) continue;
        console.error(colors.red(`Error: ${message}`));
        process.exit(1);
      }
    }

    // tailscaleHttpsPort is always assigned: the loop either breaks after
    // a successful register or exits the process on final failure.
    tailscaleUrl = formatTailscaleUrl(tsBaseUrl, tailscaleHttpsPort!);
    const label = wantsFunnel ? "Funnel (public)" : "Tailscale";
    console.log(chalk.green(`  ${label} -> ${tailscaleUrl}`));
    if (wantsFunnel) {
      console.log(chalk.gray("  (accessible from the public internet via Tailscale Funnel)\n"));
    } else {
      console.log(chalk.gray("  (accessible from your tailnet)\n"));
    }

    try {
      store.updateRoute(hostname, {
        tailscaleUrl: tailscaleUrl,
        tailscaleHttpsPort,
        tailscaleFunnel: wantsFunnel || undefined,
      });
    } catch {
      // Non-fatal: the local hostname keeps routing without it, but the
      // proxy needs tailscaleUrl to route requests arriving with the
      // public .ts.net Host header (see findRoute), so the tailscale URL
      // may 404 until the route is re-registered.
    }
  }

  for (const run of tunnelRuns) {
    try {
      run.proc = await run.t.start(port, {
        hostHeader: hostname,
        onExit: (code, signal) => handleTunnelExit(run, code, signal),
        configPath: path.join(store.dir, "cloudflared.yml"),
      });
      console.log(chalk.green(`  ${run.t.label} -> ${run.proc.url}`));
      console.log(chalk.gray(`  (accessible from the public internet via ${run.t.via})\n`));

      try {
        store.updateRoute(hostname, {
          [run.t.urlField]: run.proc.url,
          [run.t.pidField]: run.proc.pid,
        });
      } catch {
        // Non-fatal: route display metadata only
      } finally {
        run.ready = true;
        run.pending?.();
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(colors.red(`Error: ${message}`));
      printTunnelHint(run.t, message);
      stoppingTunnels = true;
      for (const started of tunnelRuns) stopNgrokProcess(started.proc?.child);
      try {
        unregisterTailscale({
          tailscaleHttpsPort,
          tailscaleFunnel: wantsFunnel || undefined,
        });
      } catch {
        // Best-effort cleanup; non-fatal
      }
      try {
        removeRoutes(store, hostnames, process.pid);
      } catch {
        // Best-effort cleanup; non-fatal
      }
      process.exit(1);
    }
  }

  // Child servers always bind to localhost; the proxy handles cross-device LAN access.
  // Exception: Expo in LAN mode — Metro defaults to LAN and setting HOST=127.0.0.1
  // conflicts with its internal networking, causing HMR WebSocket degradation.
  // Resolve the framework the same way the flag injectors do, through package
  // runners and package scripts: `bun run dev` with `"dev": "expo start"` is
  // still Expo, and reading commandArgs[0] here would see only `bun`.
  const framework = resolveFrameworkBasename(commandArgs);
  const isExpoLan = framework === "expo" && (lanMode || isLanEnvEnabled());
  const hostBind = isExpoLan ? undefined : "127.0.0.1";

  // Ensure PORTLESS_LAN is propagated to child processes when the proxy
  // was started with --lan separately and discovered from the state marker,
  // not from the env var.
  if (lanMode && !process.env.PORTLESS_LAN) {
    process.env.PORTLESS_LAN = "1";
  }

  // Inject --port for frameworks that ignore the PORT env var (e.g. Vite)
  injectPackageScriptFrameworkFlags(commandArgs, port);
  injectFrameworkFlags(commandArgs, port);

  // Point Node.js at the portless CA so server-side fetches (e.g. Next.js
  // Server Components) trust portless-proxied HTTPS services. Node.js does
  // not use the system trust store, so without this env var it rejects the
  // portless CA as "self-signed certificate in certificate chain".
  // Respect any value the user already set. Note: we check process.env here
  // rather than the constructed child env because the child env inherits from
  // process.env via spread. If a future code path injects NODE_EXTRA_CA_CERTS
  // into the child env independently, this guard would need updating.
  const caEnv: Record<string, string> = {};
  if (tls && !process.env.NODE_EXTRA_CA_CERTS) {
    const caPath = path.join(stateDir, "ca.pem");
    if (fs.existsSync(caPath)) {
      caEnv.NODE_EXTRA_CA_CERTS = caPath;
    }
  }

  // Run the command
  const caFragment = caEnv.NODE_EXTRA_CA_CERTS
    ? ` NODE_EXTRA_CA_CERTS="${caEnv.NODE_EXTRA_CA_CERTS}"`
    : "";
  console.log(
    chalk.gray(
      `Running: PORT=${port}${hostBind ? ` HOST=${hostBind}` : ""} PORTLESS_URL=${finalUrl}${caFragment} ${commandArgs.join(" ")}\n`
    )
  );

  const preexistingListener = await findPreexistingListener(port);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => (stoppingTunnels = true));
  }

  spawnCommand(commandArgs, {
    env: {
      ...process.env,
      PORT: port.toString(),
      ...(hostBind ? { HOST: hostBind } : {}),
      PORTLESS_URL: finalUrl,
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: formatViteAllowedHosts(tlds),
      // Note: EXPO_PACKAGER_PROXY_URL is not used — expo-dev-client removed
      // baked-in pinging, making this env var ineffective. Expo handles its
      // own LAN discovery natively.
      ...(lanMode ? { PORTLESS_LAN: "1" } : {}),
      ...(tailscaleUrl ? { PORTLESS_TAILSCALE_URL: tailscaleUrl } : {}),
      ...Object.fromEntries(
        tunnelRuns.flatMap((r) => (r.proc && !r.handled ? [[`${r.t.env}_URL`, r.proc.url]] : []))
      ),
      ...caEnv,
    },
    onExit: (childPid, code) =>
      transferRoutesToDaemon(store, hostnames, port, childPid, preexistingListener, code === 0),
    onSpawn: (pid) => {
      const childStartTime = getProcessStartTime(pid) ?? undefined;
      for (const host of hostnames) {
        try {
          store.updateRoute(host, { childPgid: pid, childStartTime });
        } catch {
          // Without the pgid, prune falls back to the route port; non-fatal
        }
      }
    },
    onCleanup: () => {
      stoppingTunnels = true;
      for (const run of tunnelRuns) stopNgrokProcess(run.proc?.child);
      try {
        unregisterTailscale({
          tailscaleHttpsPort,
          tailscaleFunnel: wantsFunnel || undefined,
        });
      } catch {
        // Best-effort cleanup; non-fatal
      }
      try {
        removeRoutes(store, hostnames, process.pid);
      } catch {
        // Lock acquisition may fail during cleanup; non-fatal
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedRunArgs {
  force: boolean;
  /** Fixed app port (overrides automatic assignment). */
  appPort?: number;
  /** Override the inferred base name (from --name flag). */
  name?: string;
  /** Override the worktree label (from --prefix flag). Empty disables it. */
  prefix?: string;
  /** The child command and its arguments, passed through untouched. */
  commandArgs: string[];
}

interface ParsedAppArgs extends ParsedRunArgs {
  /** App name. */
  name: string;
}

function parseAppPort(value: string | undefined): number {
  if (!value || value.startsWith("--")) {
    throw new UsageError("--app-port requires a port number.");
  }
  const port = parsePort(value);
  if (port === null) {
    throw new UsageError(`Invalid app port "${value}". Must be 1-65535.`);
  }
  return port;
}

function appPortFromEnv(): number | undefined {
  const envVal = process.env.PORTLESS_APP_PORT;
  if (!envVal) return undefined;
  const port = parsePort(envVal);
  if (port === null) {
    console.error(colors.red(`Error: Invalid PORTLESS_APP_PORT="${envVal}". Must be 1-65535.`));
    process.exit(1);
  }
  return port;
}

const RUN_FLAG_SPEC: Readonly<Record<string, FlagKind>> = {
  "--name": "value",
  "--prefix": "text",
  "--force": "boolean",
  "--app-port": "value",
  "--tailscale": "boolean",
  "--funnel": "boolean",
  "--ngrok": "boolean",
  "--cloudflare": "boolean",
  "--help": "boolean",
  "-h": "boolean",
};

const APP_FLAG_SPEC: Readonly<Record<string, FlagKind>> = {
  "--force": "boolean",
  "--app-port": "value",
  "--tailscale": "boolean",
  "--funnel": "boolean",
  "--ngrok": "boolean",
  "--cloudflare": "boolean",
};

function enableSharingFlag(flag: string): void {
  if (flag === "--tailscale") process.env.PORTLESS_TAILSCALE = "1";
  else if (flag === "--funnel") {
    process.env.PORTLESS_FUNNEL = "1";
    process.env.PORTLESS_TAILSCALE = "1";
  } else if (flag === "--ngrok") process.env.PORTLESS_NGROK = "1";
  else if (flag === "--cloudflare") process.env.PORTLESS_CLOUDFLARE = "1";
}

function printRunHelp(): void {
  console.log(`
${colors.bold("portless run")} - Infer project name and run through the proxy.

${colors.bold("Usage:")}
  ${colors.cyan("portless run [options] [command...]")}

  When no command is given, runs the configured script (default: "dev")
  from package.json. Value flags accept both --flag <value> and --flag=<value>.

  Ctrl+C is forwarded to the command. Portless waits for its process tree to
  exit and terminates remaining descendants after a short grace period.

${colors.bold("Options:")}
  --name <name>          Override the inferred base name (worktree prefix still applies)
  --prefix <label>       Override the worktree label (an empty value disables it)
  --force                Kill the existing process and take over its route
  --app-port <number>    Use a fixed port for the app (skip auto-assignment)
  --tailscale            Share the app on your Tailscale network (tailnet)
  --funnel               Share the app publicly via Tailscale Funnel
  --ngrok                Share the app publicly via ngrok
  --cloudflare           Share the app publicly via a Cloudflare quick tunnel (requires cloudflared)
  --help, -h             Show this help

${colors.bold("Name inference (in order):")}
  1. portless.json "name" field
  2. package.json "name" field (walks up directories)
  3. Git repo root directory name
  4. Current directory basename

  In git worktrees the branch becomes a subdomain prefix (e.g.
  feature-auth.myapp.localhost); the default label is its last segment. Set
  "worktree.prefix" to "branch" for the whole branch, or
  "worktree.hostnameTemplate" with {worktree} and optional {name}. Templates
  must render valid DNS labels. --prefix and PORTLESS_PREFIX override detection;
  empty disables it. Template labels over 63 characters are hash-truncated.
  Duplicate proxied hostnames fail before apps start.

${colors.bold("Examples:")}
  portless run                        # Run dev script through proxy
  portless run next dev               # -> https://<project>.localhost
  portless run --name myapp next dev  # -> https://myapp.localhost
  portless run --prefix pr-42 next dev  # -> https://pr-42.<project>.localhost
  portless run vite dev               # -> https://<project>.localhost
  portless run --app-port 3000 pnpm start
`);
}

/**
 * Parse `run` subcommand arguments: `[--name <name>] [--prefix <label>] [--force] [--] <command...>`
 *
 * `--name`, `--prefix`, `--force`, and `--app-port` are recognized. `--`
 * stops flag parsing. Everything after the flag region is the child command,
 * passed through untouched.
 */
function parseRunArgs(args: string[]): ParsedRunArgs {
  let force = false;
  let appPort: number | undefined;
  let name: string | undefined;
  let prefix: string | undefined;

  const commandArgs = visitLeadingFlags("run", args, RUN_FLAG_SPEC, (flag, value) => {
    if (flag === "--help" || flag === "-h") {
      printRunHelp();
      process.exit(0);
    }
    switch (flag) {
      case "--force":
        force = true;
        break;
      case "--app-port":
        appPort = parseAppPort(value);
        break;
      case "--name":
        name = value;
        break;
      case "--prefix":
        prefix = value;
        break;
      default:
        enableSharingFlag(flag);
    }
  });

  return {
    force,
    appPort: appPort ?? appPortFromEnv(),
    name,
    prefix,
    commandArgs,
  };
}

/**
 * Parse named-mode arguments: `[--force] <name> [--force] [--] <command...>`
 *
 * `--force` is recognized before and after the name. `--` stops flag
 * parsing. Everything after the flag region is the child command.
 * Unrecognized `--` flags are rejected to catch typos.
 */
function parseAppArgs(args: string[]): ParsedAppArgs {
  let force = false;
  let appPort: number | undefined;

  const readFlag = (flag: string, value: string | undefined): void => {
    if (flag === "--force") force = true;
    else if (flag === "--app-port") appPort = parseAppPort(value);
    else enableSharingFlag(flag);
  };

  const afterLeading = visitLeadingFlags("", args, APP_FLAG_SPEC, readFlag);
  const name = afterLeading[0];
  let commandArgs = afterLeading.slice(1);

  // Allow flags immediately after name (e.g. `portless myapp --force next dev`)
  if (commandArgs.length > 0 && commandArgs[0].startsWith("--")) {
    commandArgs = visitLeadingFlags("", commandArgs, APP_FLAG_SPEC, readFlag);
  }

  return {
    force,
    appPort: appPort ?? appPortFromEnv(),
    name,
    commandArgs,
  };
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
${colors.bold("portless")} - Replace port numbers with stable, named .localhost URLs. For humans and agents.

Eliminates port conflicts, memorizing port numbers, and cookie/storage
clashes by giving each dev server a stable .localhost URL.

${colors.bold("Install:")}
  ${colors.cyan("npm install -g portless")}          Global (recommended)
  ${colors.cyan("npm install -D portless")}          Project dev dependency

${colors.bold("Requirements:")}
  Node.js 24+

${colors.bold("Usage:")}
  ${colors.cyan("portless")}                         Run dev script through proxy
  ${colors.cyan("portless")}                         From monorepo root: run all workspace packages
  ${colors.cyan("portless run")}                     Same as above
  ${colors.cyan("portless run <cmd>")}               Run a command through the proxy
  ${colors.cyan("portless <name> <cmd>")}            Run with an explicit app name
  ${colors.cyan("portless proxy start")}             Start the proxy (HTTPS on port 443, daemon); rarely needed since it auto-starts on first run
  ${colors.cyan("portless proxy stop")}              Stop the proxy
  ${colors.cyan("portless mcp [--tools <profiles>]")} Start the stdio MCP server
  ${colors.cyan("portless service install")}         Start proxy automatically when the OS starts
  ${colors.cyan("portless get <name>")}              Print URL for a service (for cross-service refs)
  ${colors.cyan("portless alias <name> <port>")}     Register a static route (e.g. for Docker)
  ${colors.cyan("portless alias --remove <name>")}   Remove a static route
  ${colors.cyan("portless compose up [args...]")}    Run a Docker Compose project with a route per service
  ${colors.cyan("portless list")}                    Show active routes and uptime
  ${colors.cyan("portless doctor")}                  Check local portless health
  ${colors.cyan("portless trust")}                   Add local CA to system trust store
  ${colors.cyan("portless clean")}                   Remove portless state, trust entry, and hosts block
  ${colors.cyan("portless prune")}                   Kill orphaned dev servers from crashed sessions
  ${colors.cyan("portless hosts sync")}              Reconcile routes with ${HOSTS_DISPLAY} (fixes Safari)
  ${colors.cyan("portless hosts clean")}             Remove portless entries from ${HOSTS_DISPLAY}

Every command accepts --help or -h, which only prints help. After run <cmd>,
compose <subcommand>, or --, they belong to the wrapped command.
Value flags for run and named apps accept both --flag <value> and --flag=<value>.

${colors.bold("Examples:")}
  portless                            # Run dev script through proxy
  portless                            # From monorepo root: start all apps
  portless --script start             # Run "start" script instead of "dev"
  portless myapp next dev             # -> https://myapp.localhost
  portless run next dev               # -> https://<project>.localhost
  portless run next dev               # in worktree -> https://<worktree>.<project>.localhost
  portless service install            # Start HTTPS proxy on OS startup
  portless service install --lan      # Persist LAN mode in the startup service
  portless service install --wildcard # Persist wildcard routing in the startup service
  portless get backend                # -> https://backend.localhost
  portless doctor                     # Check proxy, routes, DNS, and CA trust
  portless myapp --tailscale next dev # -> also https://<node>.ts.net (tailnet)
  portless myapp --funnel next dev    # -> also https://<node>.ts.net (public)
  portless myapp --ngrok next dev     # -> also https://<random>.ngrok.app (public)

${colors.bold("Configuration (portless.json):")}
  Optional. Portless works out of the box by running the "dev" script
  from package.json. Use portless.json to override defaults.

  Override name:   { "name": "myapp" }
  Override script: { "name": "myapp", "script": "start" }
  Monorepo:        { "apps": { "apps/web": { "name": "myapp" } } }
  Turborepo:       Workspace roots use Turbo when turbo.json or turbo.jsonc is readable
                   Set { "turbo": false } to use direct spawning

${colors.bold("In package.json:")}
  {
    "scripts": {
      "dev": "next dev"
    }
  }
  Then run: portless
  Or:       portless run
  Or:       portless run next dev

${colors.bold("How it works:")}
  1. Start the proxy once (HTTPS on port 443 by default, auto-elevates with sudo)
  2. Run your apps - they auto-start the proxy and register automatically
     (apps get a random port in the 4000-4999 range via PORT)
  3. Access via https://<name>.localhost
  4. .localhost domains auto-resolve to 127.0.0.1
  5. Frameworks that ignore PORT (Vite, VitePlus, VitePress, Astro, React
     Router, Angular, Expo, React Native, Wrangler) get --port and, when
     needed, --host flags injected automatically (--ip for Wrangler),
     including through a package script whose command starts with the
     framework. Only server commands (dev, serve, preview, start, a bare
     vite, or vite [root]) get them; build, optimize, test and the like
     reject them, and an invocation portless cannot classify is left alone
     too. Expo --localhost, --lan and --tunnel modes are preserved while
     the assigned port is still injected.
     Portless also leaves a script alone when it is
     compound (&&, |, ;), ends in a # comment, ends its own option list with
     --, is env-prefixed (NODE_ENV=production vite), delegates to another
     script, or is invoked with runner flags before the script name
     (bun run --bun dev); set the port in those yourself
  6. The proxy listens only on 127.0.0.1 and ::1 unless LAN mode is enabled
  7. Proxy errors (404, 421 misdirected, 502, 508) are an HTML page for browsers and JSON
     ({"error","upstream","message"}) for clients that do not accept text/html
  Elevated proxy processes keep the invoking user's ~/.portless state directory.

${colors.bold("HTTP/2 + HTTPS (default):")}
  HTTPS with HTTP/2 multiplexing is enabled by default (faster page loads).
  WebSockets work over both HTTP/1.1 (Upgrade) and HTTP/2 (RFC 8441
  extended CONNECT), so dev server HMR works through the proxy.
  On first use, portless generates a local CA and adds it to your
  system trust store. No browser warnings. Disable with --no-tls.
  On WSL, portless also adds the CA to the Windows user certificate store.
  Linux containers on a WSL2 host use only the Linux trust store.

${colors.bold("LAN mode:")}
  Use --lan to make services accessible from other devices (phones,
  tablets) on the same WiFi network via mDNS (.local domains).
  Normal mode binds only to 127.0.0.1 and ::1.
  LAN mode binds to 0.0.0.0 and ::.
  Useful for testing React Native / Expo apps on real devices.
  Expo keeps Metro's default LAN host behavior in this mode.
  Auto-detected LAN IPs follow network changes automatically.
  Stopped LAN proxies keep LAN mode for the next start via proxy.lan.
  All proxy settings are persisted and reused on auto-start unless
  overridden by explicit flags or env vars.
  Use PORTLESS_LAN=0 for one start to switch back to .localhost mode.
  If a proxy is already running with different explicit LAN/TLS/TLD settings,
  stop it first.
  ${colors.cyan("portless proxy start --lan")}
  ${colors.cyan("portless proxy start --lan --https")}
  ${colors.cyan("portless proxy start --lan --ip 192.168.1.42")}

${colors.bold("Tailscale sharing:")}
  Use --tailscale to share your dev server with teammates on your tailnet.
  Each app is root-mounted on its own Tailscale HTTPS port (443, then 8443,
  8444, etc.) so no basePath configuration is needed.
  Use --funnel to expose your dev server to the public internet via
  Tailscale Funnel. Requires Tailscale CLI to be installed and connected,
  with Tailscale HTTPS certificates enabled. Funnel must also be enabled
  on your tailnet.
  ${colors.cyan("portless myapp --tailscale next dev")}
  ${colors.cyan("portless myapp --funnel next dev")}

${colors.bold("ngrok sharing:")}
  Use --ngrok to expose your dev server to the public internet with ngrok.
  Requires the ngrok CLI to be installed and authenticated.
  ${colors.cyan("portless myapp --ngrok next dev")}

${colors.bold("Proxy connections:")}
  IPv4 and IPv6 loopback connect in parallel; the first success wins.
  Apps listening on both may see an extra connection close without a request.
  Connection errors include each loopback address and error code.

${colors.bold("Options:")}
  run [--name <name>] [--prefix <label>] <cmd>
                                Infer project name and add a worktree prefix
  --script <name>               Run a specific package.json script (default: dev)
  -p, --port <number>           Port for the proxy (default: 443, or 80 with --no-tls)
                                Standard ports auto-elevate with sudo when the bind needs root
                                Failed elevation exits nonzero without changing ports
                                unless --unprivileged is set
  --unprivileged                Take a port below 1024 without sudo: bind the wildcard
                                address and accept loopback peers only. Serves plain
                                HTTP on port 80 unless --https is also given, and
                                never writes the hosts file. Remembered after
                                stop; PORTLESS_UNPRIVILEGED=0 switches back
  --no-tls                      Disable HTTPS (use plain HTTP on port 80)
  --https                       Enable HTTPS (default, accepted for compatibility)
  --lan                         Enable LAN mode (mDNS .local, for real device testing)
  --ip <address>                Pin a specific LAN IP (disables auto-follow; use with --lan)
  --cert <path>                 Use a custom TLS certificate
  --key <path>                  Use a custom TLS private key
  --foreground                  Run proxy in foreground (for debugging)
  --tld <tld>                   Use a custom TLD instead of .localhost (e.g. test, dev.example.com); repeat for more
  --wildcard                    Allow unregistered subdomains to fall back to the most specific parent route
  --state-dir <path>            Use a custom state directory with service install
  --app-port <number>           Use a fixed port for the app (skip auto-assignment)
  --tailscale                   Share the app on your Tailscale network (tailnet)
  --funnel                      Share the app publicly via Tailscale Funnel
  --ngrok                       Share the app publicly via ngrok
  --cloudflare                  Share the app publicly via a Cloudflare quick tunnel (requires cloudflared)
  --force                       Kill the existing process and take over its route
  --name <name>                 Use <name> as the app name (bypasses subcommand dispatch)
  --                            Stop flag parsing; everything after is passed to the child

${colors.bold("Environment variables:")}
  PORTLESS_PORT=<number>        Override the default proxy port (e.g. in .bashrc)
  PORTLESS_APP_PORT=<number>    Use a fixed port for the app (same as --app-port)
  PORTLESS_HTTPS=0              Disable HTTPS (same as --no-tls)
  PORTLESS_LAN=1                Enable LAN mode when set to 1 (set in .bashrc / .zshrc)
  PORTLESS_LAN_IP=<address>     Pin a specific LAN IP for LAN mode
  PORTLESS_TLD=<tld>[,<tld>]    Use one or more TLDs (e.g. localhost,test,dev.example.com)
  PORTLESS_PREFIX=<label>       Override the worktree label; an empty value disables it
  PORTLESS_WILDCARD=1           Allow unregistered subdomains to fall back to the most specific parent route
  PORTLESS_UNPRIVILEGED=1       Take a port below 1024 without sudo (same as --unprivileged)
  PORTLESS_SYNC_HOSTS=0         Disable auto-sync of ${HOSTS_DISPLAY} (on by default)
  PORTLESS_TAILSCALE=1          Share apps on your Tailscale network (same as --tailscale)
  PORTLESS_FUNNEL=1             Share apps publicly via Tailscale Funnel (same as --funnel)
  PORTLESS_NGROK=1              Share apps publicly via ngrok (same as --ngrok)
  PORTLESS_CLOUDFLARE=1         Share apps publicly via Cloudflare (same as --cloudflare)
  PORTLESS_STATE_DIR=<path>     Override the state directory
  PORTLESS=0                    Run app commands directly without proxy

${colors.bold("Child process environment:")}
  PORT                          Ephemeral port the child should listen on
  HOST                          Usually 127.0.0.1 (omitted for Expo in LAN mode)
  PORTLESS_URL                  Primary public URL of the app
  PORTLESS_LAN                  Set to 1 when proxy is in LAN mode
  PORTLESS_TAILSCALE_URL        Tailscale URL of the app (when --tailscale is active)
  PORTLESS_NGROK_URL            ngrok URL of the app (when --ngrok is active)
  PORTLESS_CLOUDFLARE_URL       Cloudflare URL of the app (when --cloudflare is active)
  NODE_EXTRA_CA_CERTS           Path to the portless CA (set when HTTPS is active)

${colors.bold("Safari / DNS:")}
  .localhost subdomains auto-resolve in Chrome, Firefox, and Edge.
  Safari relies on the system DNS resolver, which may not handle them.
  Auto-syncs ${HOSTS_DISPLAY} for route hostnames by default (including .localhost,
  custom TLDs, and LAN .local). Set PORTLESS_SYNC_HOSTS=0 to disable. If a route
  hostname will not resolve, the command that registered it warns instead of
  failing silently. Manual sync reconciles the managed entries with current routes,
  removes stale entries when there are no routes, and requires a successful read
  before writing. Every write is verified; a failed verification uses the normal
  hosts sync failure path. To sync manually:
    ${colors.cyan("portless hosts sync")}
  Clean up later with:
    ${colors.cyan("portless hosts clean")}

${colors.bold("Skip portless:")}
  PORTLESS=0 pnpm dev           # Runs command directly without proxy

${colors.bold("Reserved names:")}
  run, get, alias, compose, hosts, list, doctor, trust, clean, prune, proxy, service, mcp are subcommands and
  cannot be used as app names directly. Use "portless run" to infer the name,
  or "portless --name <name>" to force any name including reserved ones.
`);
  process.exit(0);
}

function printVersion(): void {
  console.log(__VERSION__);
  process.exit(0);
}

function printTrustHelp(): void {
  console.log(`
${colors.bold("portless trust")} - Add the local CA to the system trust store.

Generates the local CA first if it does not exist yet. Browsers and other
clients then accept portless HTTPS certificates. The OS may ask for
authorization or sudo.

${colors.bold("Usage:")}
  ${colors.cyan("portless trust")}

${colors.bold("Options:")}
  --help, -h             Show this help
`);
}

async function handleTrust(args: string[] = []): Promise<void> {
  parseCommandArgs("trust", args.slice(1), {}, 0);
  const { dir, port, tls } = await discoverState();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const { caGenerated } = ensureCerts(dir);
  if (caGenerated) {
    console.log(colors.gray("Generated local CA certificate."));
    // A running proxy keeps the previous CA and the TLS contexts it already
    // built in memory, so it presents the old chain until it restarts.
    if (await isProxyRunning(port, tls)) {
      const portFlag = port !== getDefaultPort(tls) ? ` -p ${port}` : "";
      console.log(
        colors.yellow("The running proxy still serves certificates from the previous CA.")
      );
      console.log(
        colors.blue(`Restart it: portless proxy stop${portFlag} && portless proxy start${portFlag}`)
      );
    }
  }
  const result = trustCA(dir);
  if (result.trusted) {
    console.log(colors.green("Local CA added to system trust store."));
    console.log(colors.gray("Browsers will now trust portless HTTPS certificates."));
    return;
  }

  // Auto-elevate with sudo on macOS/Linux, but only for permission errors.
  // Non-permission failures (missing cert, unsupported platform, timeout) skip sudo.
  const isPermissionError =
    result.error?.includes("Permission denied") || result.error?.includes("EACCES");
  if (isPermissionError && !isWindows && process.getuid?.() !== 0) {
    console.log(colors.yellow("Trusting the CA requires elevated privileges. Requesting sudo..."));
    const sudoResult = spawnSync(
      "sudo",
      [
        "env",
        ...collectPortlessEnvArgs(),
        `PORTLESS_STATE_DIR=${dir}`,
        process.execPath,
        getEntryScript(),
        "trust",
      ],
      {
        stdio: "inherit",
        timeout: SUDO_SPAWN_TIMEOUT_MS,
      }
    );
    if (sudoResult.status === 0) return;
    console.error(colors.red("sudo elevation also failed."));
  }

  console.error(colors.red(`Failed to trust CA: ${result.error}`));
  process.exit(1);
}

function printCleanHelp(): void {
  console.log(`
${colors.bold("portless clean")} - Remove portless artifacts from this machine.

Stops the proxy if it is running, uninstalls the startup service if installed,
removes the local CA from the OS trust store when it was installed by portless,
deletes known files under state directories (~/.portless, the system state
directory, and PORTLESS_STATE_DIR when set), and removes the portless block
from ${HOSTS_DISPLAY}.

Only allowlisted filenames under each state directory are deleted. Custom
certificate paths from --cert and --key are never removed. If trust removal
fails, the CA certificate and key are retained so clean can safely retry.

macOS/Linux may prompt for sudo when the proxy, trust store, or ${HOSTS_DISPLAY}
require elevated privileges. On Windows, run as Administrator if needed.

${colors.bold("Usage:")}
  ${colors.cyan("portless clean")}

${colors.bold("Options:")}
  --help, -h             Show this help
`);
}

async function handleClean(args: string[]): Promise<void> {
  parseCommandArgs("clean", args.slice(1), {}, 0);

  const serviceResult = tryUninstallService(getEntryScript());
  if (serviceResult.removed) {
    console.log(colors.green("Removed startup service."));
  } else if (serviceResult.needsElevation && !isWindows && (process.getuid?.() ?? -1) !== 0) {
    if (
      !runServiceUninstallWithSudo("Removing the startup service requires elevated privileges.")
    ) {
      console.error(colors.red("Failed to remove startup service with sudo."));
      process.exit(1);
    }
  } else if (serviceResult.error) {
    const adminHint = isWindows ? " Run as Administrator and try again." : "";
    const message = `Could not remove startup service: ${serviceResult.error}${adminHint}`;
    if (serviceResult.installed) {
      console.error(colors.red(message));
      process.exit(1);
    }
    console.warn(colors.yellow(message));
  }

  console.log(colors.cyan("Stopping proxy if it is running..."));
  const { dir, port, tls } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });
  await stopProxy(store, port, tls);

  // Clean up any tailscale serve/funnel registrations tied to stale routes
  const routesForClean = store.loadRoutesRaw();
  for (const route of routesForClean) {
    if (route.tailscaleHttpsPort) {
      try {
        unregisterTailscale(route);
        console.log(colors.green(`Removed tailscale serve on port ${route.tailscaleHttpsPort}.`));
      } catch {
        // Tailscale may not be installed; non-fatal
      }
    }
    for (const t of stopRecordedTunnels(route)) {
      console.log(colors.green(`Stopped ${t.label} tunnel for ${route.hostname}.`));
    }
  }

  const stateDirs = collectStateDirsForCleanup();
  const failedCAStateDirs = new Set<string>();
  const caRemovalResults = attemptCATrustRemovalForCleanup(stateDirs, untrustCA);
  for (const [stateDir, untrustResult] of caRemovalResults) {
    if (untrustResult.removed) {
      console.log(colors.green("Removed local CA from the system trust store."));
    } else {
      failedCAStateDirs.add(stateDir);
      console.warn(
        colors.yellow(
          `Could not remove CA from trust store: ${untrustResult.error ?? "unknown error"}\n` +
            `Try: sudo portless clean (Linux), or delete the certificate manually.`
        )
      );
    }
  }

  for (const stateDir of stateDirs) {
    removePortlessStateFiles(stateDir, {
      preserveCAIdentity: failedCAStateDirs.has(stateDir),
    });
  }
  console.log(colors.green("Removed portless state files from known state directories."));
  if (failedCAStateDirs.size > 0) {
    console.warn(
      colors.yellow("Retained CA identity files so trust removal can be retried safely.")
    );
  }

  if (cleanHostsFile()) {
    console.log(colors.green(`Removed portless entries from ${HOSTS_DISPLAY}.`));
  } else if (!isWindows && process.getuid?.() !== 0) {
    if (!runCleanWithSudo(`Updating ${HOSTS_DISPLAY} requires elevated privileges.`)) {
      console.error(colors.red(`Failed to update ${HOSTS_DISPLAY}. Run: sudo portless clean`));
      process.exit(1);
    }
  } else {
    console.warn(
      colors.yellow(
        `Could not remove portless entries from ${HOSTS_DISPLAY}${isWindows ? " (run as Administrator)." : "."}`
      )
    );
  }

  console.log(colors.green("Clean finished."));
}

function printPruneHelp(): void {
  console.log(`
${colors.bold("portless prune")} - Kill orphaned dev servers left behind by crashed portless sessions.

When portless is killed with SIGKILL (kill -9) or crashes, child dev servers
may survive and continue holding their ports. This command finds those orphans
by checking routes whose owning CLI process is dead but whose port is still in
use, then terminates them and cleans up the stale route entries.

${colors.bold("Usage:")}
  ${colors.cyan("portless prune")}
  ${colors.cyan("portless prune --force")}     Send SIGKILL instead of SIGTERM

${colors.bold("Options:")}
  --force                Send SIGKILL instead of SIGTERM
  --help, -h             Show this help
`);
}

async function handlePrune(args: string[]): Promise<void> {
  const forceKill = parseCommandArgs("prune", args.slice(1), { "--force": "boolean" }, 0).has(
    "--force"
  );

  const { dir } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });

  const stale = store.pruneStaleRoutes();
  if (stale.length === 0) {
    console.log("No orphaned routes found.");
    return;
  }

  for (const route of stale) {
    if (route.tailscaleHttpsPort) {
      try {
        unregisterTailscale(route);
        console.log(
          `  ${route.hostname} - removed tailscale serve on port ${route.tailscaleHttpsPort}`
        );
      } catch {
        // Tailscale CLI may not be installed; non-fatal during prune
      }
    }
    for (const t of stopRecordedTunnels(route)) {
      console.log(`  ${route.hostname} - stopped ${t.label} tunnel`);
    }
  }

  let killed = 0;
  const signal = forceKill ? "SIGKILL" : "SIGTERM";
  const killedGroups = new Set<number>();
  for (const route of stale) {
    const pgid = route.childPgid;
    if (
      pgid &&
      !killedGroups.has(pgid) &&
      killOrphanedProcessGroup(pgid, route.childStartTime, signal)
    ) {
      killedGroups.add(pgid);
      killed++;
      console.log(`  ${route.hostname} - killed process group ${pgid} (${signal})`);
    }
  }

  for (const route of stale) {
    if (route.childPgid && killedGroups.has(route.childPgid)) continue;
    const pids = findPidsOnPort(route.port);
    if (pids.length === 0) {
      console.log(`  ${route.hostname} :${route.port} - route removed (port already free)`);
      continue;
    }
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
        killed++;
        console.log(`  ${route.hostname} :${route.port} - killed PID ${pid} (${signal})`);
      } catch {
        console.log(`  ${route.hostname} :${route.port} - PID ${pid} already exited`);
      }
    }
  }

  const routeWord = stale.length === 1 ? "route" : "routes";
  const procWord = killed === 1 ? "process" : "processes";
  console.log(
    colors.green(
      `\nPruned ${stale.length} stale ${routeWord}, killed ${killed} orphaned ${procWord}.`
    )
  );
}

async function handleList(args: string[]): Promise<void> {
  parseCommandArgs("list", args.slice(1), {}, 0);
  const { dir, port, tls } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });
  listRoutes(store, port, tls);
}

function printListHelp(): void {
  console.log(`
${colors.bold("portless list")} - Show active routes and their uptime.

${colors.bold("Usage:")}
  ${colors.cyan("portless list")}

${colors.bold("Options:")}
  --help, -h             Show this help
`);
}

function printGetHelp(): void {
  console.log(`
${colors.bold("portless get")} - Print the URL for a service.

${colors.bold("Usage:")}
  ${colors.cyan("portless get <name>")}

Uses the worktree config in the current directory, including workspace defaults,
not the named app's package. Run from the target package for its per-app options.
Invalid config fails instead of printing a guessed URL.
PORTLESS_PREFIX="" skips worktree naming.

  BACKEND_URL=$(portless get backend)

${colors.bold("Options:")}
  --no-worktree          Skip config loading and worktree naming
  --help, -h             Show this help

${colors.bold("Examples:")}
  portless get backend                  # -> https://backend.localhost
  portless get backend                  # in worktree -> https://auth.backend.localhost
  portless get backend --no-worktree    # -> https://backend.localhost (skip worktree)
`);
}

async function handleGet(args: string[]): Promise<void> {
  const parsed = parseCommandArgs("get", args.slice(1), { "--no-worktree": "boolean" }, 1);
  const name = parsed.positionals[0];
  if (!name) {
    throw new UsageError("Missing service name.", [
      "Usage:",
      "  portless get <name>",
      "Example:",
      "  portless get backend",
    ]);
  }

  const skipWorktree = parsed.has("--no-worktree");
  const appConfig = skipWorktree ? null : loadAppConfig();
  const worktree = skipWorktree
    ? null
    : detectWorktreePrefix(process.cwd(), appConfig?.worktree?.prefix);
  const effectiveName = applyWorktreePrefix(name, worktree, appConfig?.worktree?.hostnameTemplate);

  const { port, tls, tlds } = await discoverState();
  const hostname = buildHostnames(effectiveName, tlds)[0]!;
  const url = formatUrl(hostname, port, tls);
  // Print bare URL to stdout so it works in $(portless get <name>)
  process.stdout.write(url + "\n");
}

function printAliasHelp(): void {
  console.log(`
${colors.bold("portless alias")} - Register a static route for services not managed by portless.

${colors.bold("Usage:")}
  ${colors.cyan("portless alias <name> <port>")}                 Register a route
  ${colors.cyan("portless alias <name> <port> --upstream https")}  Use HTTPS to the local backend
  ${colors.cyan("portless alias --remove <name>")}               Remove static routes, preserve process-owned routes
  ${colors.cyan("portless alias <name> <port> --force")}          Override an existing route

${colors.bold("Options:")}
  --force                   Override a route; stop a conflicting app if any
  --tld <tld>               Only these configured TLDs (repeatable, comma-separated)
  --upstream <value>        https, https://<host>[:<port>], or http://<host>[:<port>]
  --help, -h                Show this help

The positional port always dials loopback. The value "https" enables TLS and
preserves Host. An "https://" authority enables TLS and overrides Host with the full
authority, including its optional port. SNI uses a DNS hostname without the port;
IP addresses are not sent as SNI. An "http://" authority overrides Host without TLS.
Upstream TLS connects only to an
HTTP/1.1 backend on loopback. Certificate verification is disabled, so backend
identity is not authenticated, including through an SSH tunnel. This does not change
client-facing proxy TLS. Authorities accept only a hostname or IP with an optional
port, without credentials, paths, queries, fragments, or whitespace. Restart the
proxy daemon after upgrading.

${colors.bold("Examples:")}
  portless alias my-postgres 5432      # -> https://my-postgres.localhost
  portless alias redis 6379            # -> https://redis.localhost
  portless alias redis 6379 --tld test # -> https://redis.test only
  portless alias api 8080 --upstream https://api.internal
  portless alias --remove my-postgres  # Remove the alias
`);
}

async function handleAlias(args: string[]): Promise<void> {
  const helpIsUpstreamValue = args.some(
    (arg, index) => arg === "--upstream" && ["--help", "-h"].includes(args[index + 1] ?? "")
  );
  if (hasHelpFlag(args) && !helpIsUpstreamValue) {
    printAliasHelp();
    return;
  }
  const parsed = parseCommandArgs(
    "alias",
    args.slice(1),
    {
      "--remove": "value",
      "--force": "boolean",
      "--tld": "value",
      "--upstream": "value",
    },
    2
  );
  const isRemove = parsed.has("--remove");
  const removeName = parsed.value("--remove");
  const [aliasName, aliasPortValue] = parsed.positionals;
  const usageHints = [
    "Usage:",
    "  portless alias <name> <port>",
    "  portless alias --remove <name>",
    "Example:",
    "  portless alias my-postgres 5432",
  ];
  if (isRemove && parsed.has("--force")) {
    throw new UsageError("--force cannot be used with --remove.", usageHints);
  }
  if (isRemove && parsed.positionals.length > 0) {
    throw new UsageError(`Unexpected argument "${parsed.positionals[0]}" for portless alias.`, [
      "See: portless alias --help",
    ]);
  }
  if (!isRemove && !aliasName) throw new UsageError("Missing alias name.", usageHints);
  if (!isRemove && !aliasPortValue) throw new UsageError("Missing port.", usageHints);
  if (args.slice(1).some((arg) => arg.startsWith("--upstream="))) {
    throw new UsageError("Use --upstream followed by a separate value.", [
      "See: portless alias --help",
    ]);
  }
  const upstreamValues = parsed.values("--upstream");
  if (upstreamValues.length > 1) {
    throw new UsageError("--upstream may be specified only once.", ["See: portless alias --help"]);
  }
  if (isRemove && upstreamValues.length > 0) {
    throw new UsageError("--upstream can only be used when adding an alias.", [
      "See: portless alias --help",
    ]);
  }
  let upstream: AliasUpstream | undefined;
  if (upstreamValues.length === 1) {
    try {
      upstream = parseAliasUpstream(upstreamValues[0]!);
    } catch (err) {
      throw new UsageError(`Invalid --upstream value. ${(err as Error).message}`, [
        "See: portless alias --help",
      ]);
    }
  }

  const tldFlagValues = parsed.values("--tld");
  if (tldFlagValues.some((value) => !value.trim())) {
    throw new UsageError("--tld requires a TLD value.", ["See: portless alias --help"]);
  }
  let targetTlds: string[] | undefined;
  if (tldFlagValues.length > 0) {
    try {
      targetTlds = [...new Set(tldFlagValues.flatMap((value) => parseTldList(value)))];
    } catch (err) {
      throw new UsageError((err as Error).message, ["See: portless alias --help"]);
    }
  }
  const port = aliasPortValue ? parsePort(aliasPortValue) : null;
  if (!isRemove && port === null) {
    throw new UsageError(`Invalid port "${aliasPortValue}". Must be 1-65535.`, usageHints);
  }

  const { dir, tlds, port: proxyPort, tls, lanMode } = await discoverState();
  if (targetTlds) {
    const unconfigured = targetTlds.find((tld) => !tlds.includes(tld));
    if (unconfigured) {
      console.error(
        colors.red(`Error: TLD "${unconfigured}" is not configured (${tlds.join(", ")}).`)
      );
      process.exit(1);
    }
  }
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });

  if (isRemove) {
    const hostnames = buildHostnames(removeName!, tlds, targetTlds);
    const routes = store.loadRoutes();
    const aliases = hostnames.filter((hostname) =>
      routes.some((route) => route.hostname === hostname && route.pid === 0)
    );
    if (aliases.length === 0) {
      console.error(colors.red(`Error: No alias found for "${hostnames.join(", ")}".`));
      process.exit(1);
    }
    // Owner pid 0: a hostname re-registered by a live app since loadRoutes survives.
    removeRoutes(store, aliases, 0);
    console.log(colors.green(`Removed alias: ${aliases.join(", ")}`));
    return;
  }

  const hostnames = buildHostnames(aliasName!, tlds, targetTlds);
  addRoutes(store, hostnames, port!, 0, parsed.has("--force"), upstream);
  console.log(colors.green(`Alias registered: ${hostnames.join(", ")} -> 127.0.0.1:${port}`));
  // Awaited: this command exits, and a warning printed after exit reaches nobody.
  await reportHostsSyncHere(hostnames, proxyPort, tls, lanMode);
}

function printHostsHelp(): void {
  console.log(`
${colors.bold("portless hosts")} - Manage ${HOSTS_DISPLAY} entries for .localhost subdomains.

Safari relies on the system DNS resolver, which may not handle .localhost
subdomains. This command reconciles portless-managed entries in ${HOSTS_DISPLAY}.

${colors.bold("Usage:")}
  ${colors.cyan("portless hosts sync")}    Reconcile current routes with ${HOSTS_DISPLAY}
  ${colors.cyan("portless hosts clean")}   Remove portless entries from ${HOSTS_DISPLAY}

${colors.bold("Auto-sync:")}
  The proxy updates ${HOSTS_DISPLAY} for route hostnames by default. Disable with
  PORTLESS_SYNC_HOSTS=0. If a route hostname will not resolve, the command that
  registered it warns instead of failing silently.

${colors.bold("Safety:")}
  Sync removes stale entries when there are no routes. It requires a successful
  hosts-file read before writing and verifies every write. Read or verification
  failures use the normal elevated privileges or error path.
`);
}

async function handleHosts(args: string[]): Promise<void> {
  if (!args[1]) {
    printHostsHelp();
    return;
  }

  if (args[1] !== "sync" && args[1] !== "clean") {
    throw new UsageError(`Unknown hosts subcommand "${args[1]}".`, ["See: portless hosts --help"]);
  }
  parseCommandArgs(`hosts ${args[1]}`, args.slice(2), {}, 0);

  if (args[1] === "clean") {
    if (cleanHostsFile()) {
      console.log(colors.green(`Removed portless entries from ${HOSTS_DISPLAY}.`));
      return;
    }

    if (!isWindows && process.getuid?.() !== 0) {
      console.log(
        colors.yellow(
          `Writing to ${HOSTS_DISPLAY} requires elevated privileges. Requesting sudo...`
        )
      );
      const result = spawnSync(
        "sudo",
        ["env", ...collectPortlessEnvArgs(), process.execPath, getEntryScript(), "hosts", "clean"],
        {
          stdio: "inherit",
          timeout: SUDO_SPAWN_TIMEOUT_MS,
        }
      );
      if (result.status === 0) return;
    }

    console.error(
      colors.red(`Failed to update ${HOSTS_DISPLAY}${isWindows ? " (run as Administrator)." : "."}`)
    );
    process.exit(1);
    return;
  }

  const { dir } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });

  const routes = store.loadRoutes();
  const hostnames = routes.map((r) => r.hostname);
  if (syncHostsFile(hostnames)) {
    if (hostnames.length === 0) {
      console.log(colors.green(`No stale portless entries remain in ${HOSTS_DISPLAY}.`));
      return;
    }
    console.log(colors.green(`Synced ${hostnames.length} hostname(s) to ${HOSTS_DISPLAY}:`));
    for (const h of hostnames) {
      console.log(colors.cyan(`  127.0.0.1 ${h}`));
    }
    return;
  }

  if (!isWindows && process.getuid?.() !== 0) {
    console.log(
      colors.yellow(`Writing to ${HOSTS_DISPLAY} requires elevated privileges. Requesting sudo...`)
    );
    const result = spawnSync(
      "sudo",
      ["env", ...collectPortlessEnvArgs(), process.execPath, getEntryScript(), "hosts", "sync"],
      {
        stdio: "inherit",
        timeout: SUDO_SPAWN_TIMEOUT_MS,
      }
    );
    if (result.status === 0) return;
  }

  console.error(
    colors.red(`Failed to update ${HOSTS_DISPLAY}${isWindows ? " (run as Administrator)." : "."}`)
  );
  process.exit(1);
}

type DoctorStatus = "ok" | "warn" | "fail" | "info";

type DoctorFinding = {
  status: DoctorStatus;
  message: string;
  hint?: string;
};

function colorDoctorStatus(status: DoctorStatus): (value: string) => string {
  if (status === "fail") return colors.red;
  if (status === "warn") return colors.yellow;
  if (status === "ok") return colors.green;
  return colors.gray;
}

function printDoctorFinding(finding: DoctorFinding): void {
  const status = finding.status.padEnd(5);
  console.log(`${colorDoctorStatus(finding.status)(status)} ${finding.message}`);
  if (finding.hint) {
    console.log(colors.gray(`      ${finding.hint}`));
  }
}

function isProcessAliveForDoctor(pid: number): boolean {
  if (pid <= 0) return true;
  return isPidAlive(pid);
}

function checkPathWritable(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function findExistingAncestor(targetPath: string): string | null {
  let current = targetPath;
  for (;;) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function checkCommandAvailable(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    stdio: "ignore",
    timeout: 3000,
    windowsHide: true,
  });
  return !result.error && (result.status === 0 || result.status === null);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function isValidTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function doctorProxyStartHint(proxyPort: number, tls: boolean): string {
  const defaultPort = getDefaultPort(tls);
  const portArgs = proxyPort === defaultPort ? "" : ` -p ${proxyPort}`;
  const tlsArgs = tls ? "" : " --no-tls";
  return `Run: portless proxy start${portArgs}${tlsArgs}`;
}

function printDoctorHelp(): void {
  console.log(`
${colors.bold("portless doctor")} - Check local portless health and print suggested fixes.

${colors.bold("Usage:")}
  ${colors.cyan("portless doctor")}

Checks Node.js, the state directory, proxy liveness, route entries, HTTPS CA
trust, hostname resolution, and LAN mode prerequisites. It does not start,
stop, clean, prune, trust, or modify portless state.

${colors.bold("Options:")}
  --help, -h             Show this help
`);
}

async function handleDoctor(args: string[]): Promise<void> {
  parseCommandArgs("doctor", args.slice(1), {}, 0);

  const findings: DoctorFinding[] = [];
  const add = (status: DoctorStatus, message: string, hint?: string) => {
    findings.push({ status, message, hint });
  };

  let state: Awaited<ReturnType<typeof discoverState>>;
  try {
    state = await discoverState();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    add("fail", `Could not discover portless state: ${message}`);
    state = {
      dir: resolveStateDir(),
      port: getDefaultPort(!isHttpsEnvDisabled()),
      tls: !isHttpsEnvDisabled(),
      tld: DEFAULT_TLD,
      tlds: [DEFAULT_TLD],
      lanMode: isLanEnvEnabled(),
      lanIp: null,
    };
  }

  const store = new RouteStore(state.dir, {
    onWarning: (msg) => add("warn", msg),
  });
  const hasPortFile = fs.existsSync(store.portFilePath);
  const configuredTls = hasPortFile ? state.tls : !isHttpsEnvDisabled();
  const configuredPort = hasPortFile ? state.port : getDefaultPort(configuredTls);
  const initialProxyRunning = await isProxyRunning(state.port, state.tls);
  const probePort = initialProxyRunning || hasPortFile ? state.port : configuredPort;
  const probeTls = initialProxyRunning || hasPortFile ? state.tls : configuredTls;
  const proxyRunning =
    initialProxyRunning && probePort === state.port
      ? true
      : await isProxyRunning(probePort, probeTls);
  const portListening = proxyRunning ? true : await isPortListening(probePort);
  const proxyPort = proxyRunning || portListening || hasPortFile ? probePort : configuredPort;
  const proxyTls = proxyRunning || portListening || hasPortFile ? probeTls : configuredTls;
  const currentProxyStateIsHttp = (proxyRunning || portListening || hasPortFile) && !proxyTls;
  const proxyUsesCustomCert = proxyTls && readCustomCertMarker(state.dir);
  const stateExists = fs.existsSync(state.dir);

  console.log(colors.blue.bold("\nportless doctor\n"));
  console.log(`Version: ${__VERSION__}`);
  console.log(`Node.js: ${process.versions.node}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`State dir: ${state.dir}`);
  console.log(`Proxy target: ${formatUrl("127.0.0.1", proxyPort, proxyTls)}`);
  console.log(
    `Mode: ${proxyTls ? "HTTPS" : "HTTP"}, ${formatTldList(state.tlds)}${state.lanMode ? ", LAN" : ""}`
  );
  console.log("");

  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor >= 24) {
    add("ok", `Node.js ${process.versions.node} satisfies portless requirements.`);
  } else {
    add("fail", `Node.js ${process.versions.node} is unsupported.`, "Install Node.js 24 or newer.");
  }

  if (stateExists) {
    try {
      const stat = fs.statSync(state.dir);
      if (!stat.isDirectory()) {
        add("fail", `State path exists but is not a directory: ${state.dir}`);
      } else if (checkPathWritable(state.dir)) {
        add("ok", `State directory is writable: ${state.dir}`);
      } else {
        add("fail", `State directory is not writable: ${state.dir}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      add("fail", `Could not inspect state directory: ${message}`);
    }
  } else {
    const ancestor = findExistingAncestor(path.dirname(state.dir));
    if (!ancestor) {
      add(
        "fail",
        `State directory does not exist and no writable ancestor was found: ${state.dir}`
      );
    } else {
      const ancestorStat = fs.statSync(ancestor);
      if (!ancestorStat.isDirectory()) {
        add("fail", `State directory does not exist and ancestor is not a directory: ${ancestor}`);
      } else if (checkPathWritable(ancestor)) {
        add("info", `State directory has not been created yet: ${state.dir}`);
      } else {
        add("fail", `State directory does not exist and ancestor is not writable: ${ancestor}`);
      }
    }
  }

  if (proxyRunning) {
    add("ok", `Proxy is responding on port ${proxyPort}.`);
  } else if (portListening) {
    const pid = findPidOnPort(proxyPort);
    add(
      "fail",
      `Port ${proxyPort} is in use, but it is not a portless proxy.`,
      pid ? `Process on port: PID ${pid}` : "Could not identify the process holding the port."
    );
  } else {
    add(
      "warn",
      `Proxy is not running on port ${proxyPort}.`,
      doctorProxyStartHint(proxyPort, proxyTls)
    );
  }

  if (fs.existsSync(store.pidPath)) {
    try {
      const rawPid = fs.readFileSync(store.pidPath, "utf-8").trim();
      const pid = parseInt(rawPid, 10);
      if (isNaN(pid) || pid <= 0) {
        add("fail", `Proxy PID file is invalid: ${store.pidPath}`);
      } else if (!isProcessAliveForDoctor(pid)) {
        add("warn", `Proxy PID file is stale: ${pid}`, "Run: portless proxy stop");
      } else if (!proxyRunning) {
        add(
          "warn",
          `Proxy PID file points to PID ${pid}, but no portless proxy is responding on port ${proxyPort}.`,
          "Run: portless proxy stop"
        );
      } else {
        const portPid = findPidOnPort(proxyPort);
        if (portPid !== null && portPid !== pid) {
          add(
            "warn",
            `Proxy PID file points to PID ${pid}, but port ${proxyPort} is owned by PID ${portPid}.`,
            "Run: portless proxy stop"
          );
        } else {
          add("ok", `Proxy PID file points to the responding proxy process: ${pid}`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      add("fail", `Could not read proxy PID file: ${message}`);
    }
  } else if (proxyRunning) {
    add("warn", `Proxy is running but the PID file is missing: ${store.pidPath}`);
  }

  if (proxyUsesCustomCert) {
    add("ok", "Proxy is configured with a custom TLS certificate.");
  } else if (proxyTls || (!currentProxyStateIsHttp && !isHttpsEnvDisabled())) {
    if (checkCommandAvailable("openssl", ["version"])) {
      add("ok", "OpenSSL is available for certificate generation.");
    } else {
      add(
        "fail",
        "OpenSSL is not available on PATH.",
        isWindows
          ? "Install OpenSSL or add Git for Windows OpenSSL to PATH."
          : "Install OpenSSL with your system package manager."
      );
    }
  } else {
    add("info", "HTTPS is disabled, so OpenSSL is not required for this run.");
  }

  if (proxyTls && proxyUsesCustomCert) {
    add("info", "Generated local CA is not required for custom TLS certificates.");
  } else if (proxyTls) {
    const caPath = path.join(state.dir, "ca.pem");
    if (fs.existsSync(caPath)) {
      if (isCATrusted(state.dir)) {
        add("ok", "Local CA is trusted by the OS trust store.");
      } else {
        add(
          "warn",
          "Local CA exists but is not trusted by the OS trust store.",
          "Run: portless trust"
        );
      }
    } else if (proxyRunning) {
      add("warn", `Generated CA file is missing: ${caPath}`);
    } else {
      add("info", "Local CA has not been generated yet.");
    }
  } else {
    add("info", "HTTPS is disabled for the current proxy state.");
  }

  let rawRoutes: ReturnType<RouteStore["loadRoutesRaw"]> = [];
  try {
    rawRoutes = store.loadRoutesRaw();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    add("fail", `Could not read routes: ${message}`);
  }

  const liveRoutes = rawRoutes.filter(
    (route) => route.pid === 0 || isProcessAliveForDoctor(route.pid)
  );
  const staleRoutes = rawRoutes.filter(
    (route) => route.pid !== 0 && !isProcessAliveForDoctor(route.pid)
  );
  if (rawRoutes.length === 0) {
    add("info", "No routes are registered.");
  } else if (staleRoutes.length === 0) {
    add("ok", `Routes: ${pluralize(liveRoutes.length, "active route")}.`);
  } else {
    add(
      "warn",
      `Routes: ${pluralize(liveRoutes.length, "active route")}, ${pluralize(staleRoutes.length, "stale route")}.`,
      "Run: portless prune"
    );
  }

  for (const route of staleRoutes.slice(0, 5)) {
    add("warn", `Stale route ${route.hostname} is owned by exited PID ${route.pid}.`);
  }
  if (staleRoutes.length > 5) {
    add("warn", `${staleRoutes.length - 5} additional stale routes hidden.`);
  }

  const routePortChecks = await Promise.all(
    liveRoutes.map(async (route) => {
      const validPort = isValidTcpPort(route.port);
      return {
        route,
        invalidPort: !validPort,
        listening: validPort ? await isPortListening(route.port) : false,
      };
    })
  );
  for (const { route, invalidPort, listening } of routePortChecks) {
    if (invalidPort) {
      add(
        "warn",
        `Route ${route.hostname} has invalid port ${route.port}.`,
        route.pid === 0 ? "Remove or recreate the alias." : "Run: portless prune"
      );
      continue;
    }
    if (listening) continue;
    add(
      "warn",
      `Route ${route.hostname} points to port ${route.port}, but nothing is listening there.`,
      route.pid === 0 ? "Remove the alias or start that service." : "The app may still be starting."
    );
  }

  if (state.lanMode || isLanEnvEnabled()) {
    const mdns = isMdnsSupported();
    if (mdns.supported) {
      add("ok", "mDNS publishing support is available for LAN mode.");
    } else {
      add("fail", `LAN mode is enabled but mDNS publishing is unavailable: ${mdns.reason}`);
    }
    if (state.lanIp) {
      add("ok", `LAN IP is recorded: ${state.lanIp}`);
    } else {
      add("warn", "LAN mode is enabled but no LAN IP is recorded.");
    }
  } else if (liveRoutes.length > 0) {
    const managedHosts = new Set(getManagedHostnames());
    const resolutionChecks = await Promise.all(
      liveRoutes.map(async (route) => ({
        hostname: route.hostname,
        resolves: await checkHostResolution(route.hostname),
        managed: managedHosts.has(route.hostname),
      }))
    );
    const unresolved = resolutionChecks.filter((result) => !result.resolves);
    if (unresolved.length === 0) {
      add("ok", "Registered hostnames resolve through the system resolver.");
    } else {
      add(
        "warn",
        `${pluralize(unresolved.length, "hostname")} did not resolve through the system resolver.`,
        "Run: portless hosts sync"
      );
      for (const result of unresolved.slice(0, 5)) {
        const hostState = result.managed ? "present in hosts block" : "missing from hosts block";
        add("warn", `${result.hostname} is ${hostState}.`);
      }
    }
  }

  for (const finding of findings) {
    printDoctorFinding(finding);
  }

  const failures = findings.filter((finding) => finding.status === "fail").length;
  const warnings = findings.filter((finding) => finding.status === "warn").length;
  console.log("");
  if (failures > 0) {
    console.log(
      colors.red(`Summary: ${pluralize(failures, "failure")}, ${pluralize(warnings, "warning")}.`)
    );
    process.exit(1);
  }
  console.log(colors.green(`Summary: 0 failures, ${pluralize(warnings, "warning")}.`));
}

function printProxyHelp(): void {
  console.log(`
${colors.bold("portless proxy")} - Manage the portless proxy server.

${colors.bold("Usage:")}
  ${colors.cyan("portless proxy start")}                Start the HTTPS proxy on port 443 (daemon)
  ${colors.cyan("portless proxy start --no-tls")}       Start without HTTPS (port 80)
  ${colors.cyan("portless proxy start --lan")}          Enable LAN mode (mDNS, .local TLD)
  ${colors.cyan("portless proxy start --foreground")}   Start in foreground (for debugging)
  ${colors.cyan("portless proxy start -p 1355")}        Start on a custom port (no sudo)
  ${colors.cyan("portless proxy start --unprivileged")}  Plain HTTP on port 80, no sudo, nothing installed
  ${colors.cyan("portless proxy start --tld test")}     Use .test instead of .localhost
  ${colors.cyan("portless proxy start --tld localhost --tld test")}  Serve both TLDs
  ${colors.cyan("portless proxy start --tld dev.example.com")}  Use a multi-segment TLD (production parity)
  ${colors.cyan("portless proxy start --wildcard")}     Allow unregistered subdomains to fall back to parent
  ${colors.cyan("portless proxy stop")}                 Stop the proxy

${colors.bold("LAN mode (--lan):")}
  Without LAN mode, the proxy listens only on 127.0.0.1 and ::1.
  LAN mode explicitly binds the proxy to 0.0.0.0 and ::.
  Makes services accessible from other devices on the same WiFi network
  via mDNS (.local domains). Useful for testing on real mobile devices.
  Auto-detects your LAN IP and follows changes automatically, or use
  --ip to pin one.
  Stopped LAN proxies keep LAN mode for the next start via proxy.lan.
  Use PORTLESS_LAN=0 for one start to switch back to .localhost mode.
`);
}

async function handleProxy(args: string[]): Promise<void> {
  if (args[1] && args[1] !== "start" && args[1] !== "stop") {
    throw new UsageError(`Unknown proxy subcommand "${args[1]}".`, ["See: portless proxy --help"]);
  }
  if (!args[1]) {
    printProxyHelp();
    return;
  }

  if (args[1] === "stop") {
    const parsed = parseCommandArgs(
      "proxy stop",
      args.slice(2),
      { "--port": "value", "-p": "value" },
      0
    );
    for (const value of [...parsed.values("--port"), ...parsed.values("-p")]) {
      if (parsePort(value) === null) {
        throw new UsageError(`Invalid port number: ${value}`, [
          "Port must be between 1 and 65535.",
        ]);
      }
    }
    const portValue = parsed.value("--port") ?? parsed.value("-p");
    const explicitPort = portValue === undefined ? undefined : parsePort(portValue)!;

    if (explicitPort !== undefined) {
      const dir = resolveStateDir(explicitPort);
      const store = new RouteStore(dir, {
        onWarning: (msg) => console.warn(colors.yellow(msg)),
      });
      await stopProxy(store, explicitPort, false);
    } else {
      const { dir, port, tls } = await discoverState();
      const store = new RouteStore(dir, {
        onWarning: (msg) => console.warn(colors.yellow(msg)),
      });
      await stopProxy(store, port, tls);
    }
    return;
  }

  const startFlags = parseCommandArgs(
    "proxy start",
    args.slice(2),
    {
      "--foreground": "boolean",
      "--skip-trust": "boolean",
      "--unprivileged": "boolean",
      "--https": "boolean",
      "--no-tls": "boolean",
      "--wildcard": "boolean",
      "--cert": "value",
      "--key": "value",
      "--port": "value",
      "-p": "value",
      "--tld": "value",
    },
    0
  );
  const isForeground = startFlags.has("--foreground");
  const skipTrust = startFlags.has("--skip-trust");
  const hasUnprivilegedFlag = startFlags.has("--unprivileged");

  // HTTPS is on by default. Disable with --no-tls or PORTLESS_HTTPS=0.
  const hasHttpsFlag = startFlags.has("--https");
  const hasNoTls = startFlags.has("--no-tls") || isHttpsEnvDisabled();
  const wantHttps = !hasNoTls;

  let customCertPath = startFlags.value("--cert") ?? null;
  let customKeyPath = startFlags.value("--key") ?? null;
  if (!customCertPath !== !customKeyPath) {
    throw new UsageError("--cert and --key must be used together.");
  }

  // Custom cert/key implies HTTPS
  let useHttps = wantHttps || !!(customCertPath && customKeyPath);

  // Parse --port / -p flag. When not set, default to the protocol-standard
  // port (443 for HTTPS, 80 for HTTP) so URLs are clean.
  let hasExplicitPort = false;
  let proxyPort = getDefaultPort(useHttps);
  const portValue = startFlags.value("--port") ?? startFlags.value("-p");
  if (portValue !== undefined) {
    const parsed = parsePort(portValue);
    if (parsed === null) {
      throw new UsageError(`Invalid port number: ${portValue}`, [
        "Port must be between 1 and 65535.",
      ]);
    }
    proxyPort = parsed;
    hasExplicitPort = true;
  }

  // Parse --tld flags
  let tlds: string[];
  try {
    tlds = getDefaultTlds();
  } catch (err) {
    console.error(colors.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
  const tldFlagValues = startFlags.values("--tld");
  if (tldFlagValues.length > 0) {
    try {
      tlds = normalizeTlds(tldFlagValues.flatMap((value) => parseTldList(value)));
    } catch (err) {
      throw new UsageError((err as Error).message, ["See: portless proxy start --help"]);
    }
  }
  let tld = primaryTld(tlds);
  // Parse --wildcard flag (disables the default strict subdomain matching)
  const useWildcard = startFlags.has("--wildcard") || isWildcardEnvEnabled();

  const explicit: ProxyConfigExplicitness = {
    useHttps:
      hasHttpsFlag ||
      hasNoTls ||
      customCertPath !== null ||
      customKeyPath !== null ||
      process.env.PORTLESS_HTTPS !== undefined,
    customCert: customCertPath !== null || customKeyPath !== null,
    lanMode: process.env.PORTLESS_LAN !== undefined,
    lanIp: process.env.PORTLESS_LAN_IP !== undefined,
    tlds: tldFlagValues.length > 0 || process.env.PORTLESS_TLD !== undefined,
    useWildcard: startFlags.has("--wildcard") || process.env.PORTLESS_WILDCARD !== undefined,
    unprivileged: hasUnprivilegedFlag || process.env.PORTLESS_UNPRIVILEGED !== undefined,
  };

  // Resolve state directory based on the port
  let stateDir = resolveStateDir(proxyPort);
  let persistedLanMode = readLanMarker(stateDir) !== null;
  let runningPort: number | null = null;
  if (!hasExplicitPort) {
    const currentState = await discoverState();
    persistedLanMode = currentState.lanMode;
    if (
      (await isProxyRunning(currentState.port)) ||
      (!!process.env.PORTLESS_STATE_DIR && (await isPortListening(currentState.port)))
    ) {
      runningPort = currentState.port;
      proxyPort = currentState.port;
      stateDir = currentState.dir;
    }
  }
  const desiredConfig = resolveProxyConfig({
    persistedLanMode,
    persistedUnprivileged: readUnprivilegedMarker(stateDir),
    explicit,
    defaultTlds: getDefaultTlds(),
    useHttps: wantHttps || !!(customCertPath && customKeyPath),
    customCertPath,
    customKeyPath,
    lanMode: isLanEnvEnabled(),
    lanIp: process.env.PORTLESS_LAN_IP || null,
    tlds,
    useWildcard,
    unprivileged: hasUnprivilegedFlag || isUnprivilegedEnvEnabled(),
  });
  const lanMode = desiredConfig.lanMode;
  useHttps = desiredConfig.useHttps;
  customCertPath = desiredConfig.customCertPath;
  customKeyPath = desiredConfig.customKeyPath;
  tld = desiredConfig.tld;
  tlds = desiredConfig.tlds;
  const desiredWildcard = desiredConfig.useWildcard;
  const desiredUnprivileged = desiredConfig.unprivileged;
  let lanIp: string | null = desiredConfig.lanIpExplicit ? desiredConfig.lanIp : null;

  if (!hasExplicitPort && runningPort === null) {
    proxyPort = getDefaultPort(useHttps);
    stateDir = resolveStateDir(proxyPort);
  }

  if (lanMode && tldFlagValues.length > 0) {
    const userTlds = tldFlagValues.join(", ");
    if (userTlds !== "local") {
      console.warn(
        chalk.yellow(
          `Warning: --lan forces .local TLD (mDNS requirement). Ignoring --tld ${userTlds}.`
        )
      );
    }
  }

  for (const configuredTld of tlds) {
    const riskyReason = getRiskyTldReason(configuredTld);
    if (riskyReason && !lanMode) {
      console.warn(colors.yellow(`Warning: .${configuredTld}: ${riskyReason}`));
    }
  }

  const syncExplicitlyOn =
    process.env.PORTLESS_SYNC_HOSTS === "1" || process.env.PORTLESS_SYNC_HOSTS === "true";
  if (desiredUnprivileged && syncExplicitlyOn) {
    console.error(
      colors.red("Error: PORTLESS_SYNC_HOSTS=1 cannot be combined with unprivileged mode.")
    );
    console.error(
      colors.blue(`Writing ${HOSTS_DISPLAY} needs root, which unprivileged mode never asks for.`)
    );
    console.error(
      colors.blue(
        "Unset PORTLESS_SYNC_HOSTS, or start without --unprivileged. To add entries once:"
      )
    );
    console.error(colors.cyan("  portless hosts sync"));
    process.exit(1);
  }

  const syncDisabled =
    desiredUnprivileged ||
    process.env.PORTLESS_SYNC_HOSTS === "0" ||
    process.env.PORTLESS_SYNC_HOSTS === "false";
  const nonDefaultTlds = tlds.filter((configuredTld) => configuredTld !== DEFAULT_TLD);
  if (nonDefaultTlds.length > 0 && !lanMode && syncDisabled) {
    console.warn(
      colors.yellow(
        `Warning: ${formatTldList(nonDefaultTlds)} domains require ${HOSTS_DISPLAY} entries to resolve to 127.0.0.1.`
      )
    );
    console.warn(colors.yellow("Hosts sync is disabled. To add entries manually, run:"));
    console.warn(colors.cyan("  portless hosts sync"));
  }

  const store = new RouteStore(stateDir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });

  // Check if already running. Plain HTTP check detects both TLS and non-TLS
  // proxies because the TLS-enabled proxy accepts plain HTTP via byte-peeking.
  const proxyRunning = runningPort !== null || (await isProxyRunning(proxyPort));
  if (proxyRunning) {
    const runningConfig = readCurrentProxyConfig(stateDir);
    const mismatchMessages = getProxyConfigMismatchMessages(desiredConfig, runningConfig, explicit);
    if (mismatchMessages.length > 0) {
      printProxyConfigMismatch(proxyPort, desiredConfig, mismatchMessages);
    }
    if (isForeground) {
      return;
    }
    const portFlag = proxyPort !== getDefaultPort(useHttps) ? ` -p ${proxyPort}` : "";
    console.log(colors.yellow(`Proxy is already running on port ${proxyPort}.`));
    console.log(
      colors.blue(`To restart: portless proxy stop${portFlag} && portless proxy start${portFlag}`)
    );
    return;
  }

  if (lanMode) {
    const mdnsSupport = isMdnsSupported();
    if (!mdnsSupport.supported) {
      console.error(
        colors.red(
          "Error: LAN mode requires mDNS publishing, which is not supported on this platform."
        )
      );
      if (mdnsSupport.reason) {
        console.error(colors.gray(mdnsSupport.reason));
      }
      process.exit(1);
    }

    const inheritedLanIp = process.env[INTERNAL_LAN_IP_ENV] || null;
    delete process.env[INTERNAL_LAN_IP_ENV];

    // Use an explicit pinned IP if configured, otherwise reuse the parent
    // daemon's auto-detected value for the first boot and fall back to a fresh
    // network probe.
    if (!lanIp) {
      lanIp = inheritedLanIp || (await getLocalNetworkIp());
    }

    if (!lanIp) {
      console.error(colors.red("Error: Could not detect LAN IP. Are you connected to a network?"));
      console.error(colors.blue("Specify manually:"));
      console.error(colors.cyan("  portless proxy start --lan --ip 192.168.1.42"));
      process.exit(1);
    }
  } else {
    delete process.env[INTERNAL_LAN_IP_ENV];
  }

  const resolvedConfig: ProxyConfig = {
    ...desiredConfig,
    useHttps,
    customCertPath,
    customKeyPath,
    lanMode,
    lanIp: desiredConfig.lanIpExplicit ? lanIp : null,
    lanIpExplicit: desiredConfig.lanIpExplicit,
    tld,
    tlds,
    useWildcard: desiredWildcard,
    unprivileged: desiredUnprivileged,
  };

  const isRoot = (process.getuid?.() ?? -1) === 0;

  // Unprivileged mode never elevates and never falls back to another port:
  // either the platform lets this process bind the port, or we say exactly
  // what to change and stop (scripted runs must not get a different URL).
  if (desiredUnprivileged && !isWindows && !isRoot) {
    const check = canBindWithoutRoot(proxyPort);
    if (!check.ok) {
      console.error(colors.red(`Error: ${check.reason}`));
      if (process.platform === "linux") {
        console.error(colors.blue("Allow it once per machine:"));
        console.error(
          colors.cyan(`  sudo sysctl -w net.ipv4.ip_unprivileged_port_start=${proxyPort}`)
        );
      }
      console.error(colors.blue("Or start without --unprivileged to elevate with sudo."));
      process.exit(1);
    }
  }

  // Privileged ports require root on Unix unless the platform grants the bind.
  // Auto-elevate with sudo only when a probe bind fails with EACCES.
  if (!desiredUnprivileged && (await proxyPortNeedsElevation(proxyPort, lanMode))) {
    const startArgs = [
      process.execPath,
      getEntryScript(),
      "proxy",
      "start",
      ...buildProxyStartConfig({
        useHttps,
        customCertPath,
        customKeyPath,
        lanMode,
        lanIp: desiredConfig.lanIpExplicit ? lanIp : null,
        lanIpExplicit: desiredConfig.lanIpExplicit,
        tld,
        tlds,
        useWildcard: desiredWildcard,
        foreground: isForeground,
        includePort: true,
        proxyPort,
      }).args,
    ];
    const recoveryCommand = formatProxyStartCommand(proxyPort, resolvedConfig);

    console.log(
      colors.yellow(`Port ${proxyPort} requires elevated privileges. Requesting sudo...`)
    );
    const result = spawnSync("sudo", ["env", ...collectPortlessEnvArgs(), ...startArgs], {
      stdio: "inherit",
      timeout: SUDO_SPAWN_TIMEOUT_MS,
    });

    if (result.status === 0) {
      if (!isForeground) {
        if (await waitForProxy(proxyPort)) {
          console.log(colors.green(`Proxy started on port ${proxyPort}.`));
        } else {
          console.error(colors.red("Proxy process started but is not responding."));
          const logPath = path.join(resolveStateDir(proxyPort), "proxy.log");
          if (fs.existsSync(logPath)) {
            console.error(colors.gray(`Logs: ${logPath}`));
          }
        }
      }
      return;
    }

    // Never fall back to another port: scripted callers would continue with
    // URLs that point at a port nothing listens on.
    const failure = result.error
      ? result.error.message
      : result.signal
        ? `terminated by signal ${result.signal}`
        : `exited with status ${result.status}`;
    console.error(
      colors.red(
        `Error: Port ${proxyPort} requires elevated privileges, but sudo elevation failed: ${failure}.`
      )
    );
    console.error(colors.blue("Resolve the sudo error, then rerun the requested startup:"));
    console.error(colors.cyan(`  ${recoveryCommand}`));
    process.exit(1);
  }

  // Prepare TLS options if HTTPS is requested
  let tlsOptions: import("./types.js").ProxyServerOptions["tls"];
  if (useHttps) {
    store.ensureDir();
    if (customCertPath && customKeyPath) {
      try {
        const cert = fs.readFileSync(customCertPath);
        const key = fs.readFileSync(customKeyPath);

        const certStr = cert.toString("utf-8");
        const keyStr = key.toString("utf-8");
        if (!certStr.includes("-----BEGIN CERTIFICATE-----")) {
          console.error(colors.red(`Error: ${customCertPath} is not a valid PEM certificate.`));
          console.error(colors.gray("Expected a file starting with -----BEGIN CERTIFICATE-----"));
          process.exit(1);
        }
        if (!keyStr.match(/-----BEGIN [\w\s]*PRIVATE KEY-----/)) {
          console.error(colors.red(`Error: ${customKeyPath} is not a valid PEM private key.`));
          console.error(
            colors.gray("Expected a file starting with -----BEGIN ...PRIVATE KEY-----")
          );
          process.exit(1);
        }

        tlsOptions = { cert, key };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(colors.red(`Error reading certificate files: ${message}`));
        process.exit(1);
      }
    } else {
      console.log(colors.gray("Ensuring TLS certificates..."));
      const certs = ensureCerts(stateDir);
      if (certs.caGenerated) {
        console.log(colors.green("Generated local CA certificate."));
      }

      if (desiredUnprivileged && !isCATrusted(stateDir)) {
        // Installing the CA elevates, which this mode never does.
        console.warn(colors.yellow("The portless CA is not in the system trust store."));
        console.warn(
          colors.yellow(
            "Browsers will show certificate warnings. Trust it once (asks for admin rights):"
          )
        );
        console.warn(colors.cyan("  portless trust"));
      } else if (!skipTrust && !isCATrusted(stateDir)) {
        console.log(colors.yellow("Adding CA to system trust store..."));
        const trustResult = trustCA(stateDir);
        if (trustResult.trusted) {
          console.log(
            colors.green("CA added to system trust store. Browsers will trust portless certs.")
          );
        } else {
          console.warn(colors.yellow("Could not add CA to system trust store."));
          if (trustResult.error) {
            console.warn(colors.gray(trustResult.error));
          }
          console.warn(
            colors.yellow("Browsers will show certificate warnings. To fix this later, run:")
          );
          console.warn(colors.cyan("  portless trust"));
        }
      }

      const cert = fs.readFileSync(certs.certPath);
      const key = fs.readFileSync(certs.keyPath);
      const ca = fs.readFileSync(certs.caPath);
      tlsOptions = {
        cert,
        key,
        ca,
        SNICallback: createSNICallback(stateDir, cert, key, tlds, ca),
      };
    }
  }

  // Foreground mode: run the proxy directly in this process
  if (isForeground) {
    console.log(chalk.blue.bold("\nportless proxy\n"));
    startProxyServer(
      store,
      proxyPort,
      tld,
      tlds,
      tlsOptions,
      lanIp,
      desiredWildcard ? false : undefined,
      !!(customCertPath && customKeyPath),
      desiredUnprivileged
    );
    return;
  }

  // Daemon mode (default): fork and detach, logging to file
  store.ensureDir();
  const logPath = path.join(stateDir, "proxy.log");
  const logFd = fs.openSync(logPath, "a");
  try {
    try {
      fs.chmodSync(logPath, FILE_MODE);
    } catch {
      // May fail if file is owned by another user; non-fatal
    }
    fixOwnership(logPath);

    const daemonArgs = [
      getEntryScript(),
      "proxy",
      "start",
      ...buildProxyStartConfig({
        useHttps,
        customCertPath,
        customKeyPath,
        lanMode,
        lanIp: desiredConfig.lanIpExplicit ? lanIp : null,
        lanIpExplicit: desiredConfig.lanIpExplicit,
        tld,
        tlds,
        useWildcard: desiredWildcard,
        unprivileged: desiredUnprivileged,
        foreground: true,
        includePort: true,
        proxyPort,
        skipTrust: true,
      }).args,
    ];

    const child = spawn(process.execPath, daemonArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      windowsHide: true,
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  // Wait for proxy to be ready
  if (!(await waitForProxy(proxyPort, undefined, undefined, useHttps))) {
    console.error(colors.red("Proxy failed to start (timed out waiting for it to listen)."));
    console.error(colors.blue("Try starting the proxy in the foreground to see the error:"));
    console.error(colors.cyan("  portless proxy start --foreground"));
    if (fs.existsSync(logPath)) {
      console.error(colors.gray(`Logs: ${logPath}`));
    }
    process.exit(1);
  }

  const proto = useHttps ? "HTTPS/2" : "HTTP";
  console.log(chalk.green(`${proto} proxy started on port ${proxyPort}`));
  // The daemon syncs the routes that were already persisted; its own output only
  // reaches proxy.log, so report here where the user is.
  const persistedHostnames = store.loadRoutes().map((route) => route.hostname);
  await reportHostsSyncHere(persistedHostnames, proxyPort, useHttps, lanMode);
  if (lanMode && lanIp) {
    console.log(chalk.green(`LAN mode active. IP: ${lanIp}`));
    console.log(chalk.gray("Services will be discoverable as <name>.local on your network."));
  }
}

type AppConfigWithSource = AppConfig & { source: LoadedConfig["source"] };

/**
 * Load the effective AppConfig for the current directory from portless.json or
 * the package.json "portless" key, tagged with the file it came from.
 * Handles both single-app (top-level fields) and monorepo (apps map) configs.
 */
function loadAppConfig(cwd: string = process.cwd()): AppConfigWithSource | null {
  try {
    const loaded = loadConfig(cwd);
    const root = findWorkspaceRoot(cwd);
    const rootConfig = root && root !== cwd ? loadConfig(root) : null;
    const rootWorktree = mergeWorktreeConfig(
      rootConfig
        ? resolveAppConfig(rootConfig.config, rootConfig.configDir, cwd).worktree
        : undefined
    );
    if (!loaded) {
      return rootConfig && rootWorktree
        ? { worktree: rootWorktree, source: rootConfig.source }
        : null;
    }
    const local = resolveAppConfig(loaded.config, loaded.configDir, cwd);
    const worktree = mergeWorktreeConfig(rootWorktree, local.worktree);
    return worktree
      ? { ...local, worktree, source: loaded.source }
      : { ...local, source: loaded.source };
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(colors.red(`Error: ${err.message}`));
      process.exit(1);
    }
    throw err;
  }
}

/**
 * Zero-arg dispatch: `portless` with no arguments.
 * Returns true if handled, false to fall through to help text.
 *
 * Activates when:
 * - At a workspace root (pnpm, npm, yarn, or bun) -> multi-app mode
 * - In any directory with a package.json that has the target script -> single-app mode
 * Config (portless.json / package.json "portless" key) is loaded for overrides
 * but is not required.
 */
async function handleDefaultMode(
  globalScript?: string,
  extraArgs: string[] = []
): Promise<boolean> {
  const cwd = process.cwd();

  // Workspace root: multi-app mode, but only when at least one package
  // has the target script. Otherwise fall through to single-app mode so
  // a workspace root with its own dev script still works.
  const wsRoot = findWorkspaceRoot(cwd);
  if (wsRoot === cwd) {
    const packages = discoverWorkspacePackages(cwd);
    let wsScriptName: string;
    try {
      wsScriptName = globalScript ?? loadConfig(cwd)?.config.script ?? "dev";
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        console.error(colors.red(`Error: ${err.message}`));
        process.exit(1);
      }
      throw err;
    }
    const hasMatchingPackages = packages.some((p) => p.scripts[wsScriptName]);
    if (hasMatchingPackages) {
      await handleDefaultMulti(cwd, globalScript, extraArgs);
      return true;
    }
  }

  const appConfig = loadAppConfig(cwd);
  const scriptName = globalScript ?? appConfig?.script ?? "dev";
  if (hasScript(scriptName, cwd)) {
    await handleDefaultSingle(cwd, scriptName, appConfig);
    return true;
  }

  return false;
}

/**
 * Single-app mode: run one package through the proxy.
 */
async function handleDefaultSingle(
  cwd: string,
  scriptName: string,
  appConfig: AppConfigWithSource | null
): Promise<void> {
  const resolved = resolveScriptCommand(scriptName, cwd);
  if (!resolved) {
    console.error(colors.red(`Error: No "${scriptName}" script found in package.json.`));
    process.exit(1);
  }

  let baseName: string;
  let nameSource: string;

  if (appConfig?.name) {
    baseName = appConfig.name
      .split(".")
      .map((label) => truncateLabel(label))
      .join(".");
    nameSource = appConfig.source;
  } else {
    const inferred = inferProjectName(cwd);
    baseName = inferred.name;
    nameSource = inferred.source;
  }

  const worktree = detectWorktreePrefix(cwd, appConfig?.worktree?.prefix);
  const effectiveName = applyWorktreePrefix(
    baseName,
    worktree,
    appConfig?.worktree?.hostnameTemplate
  );

  const { dir, port, tls, tlds, lanMode, lanIp } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });
  await runApp(
    store,
    port,
    dir,
    effectiveName,
    resolved,
    tls,
    tlds,
    false,
    { nameSource, baseName, prefix: worktree?.prefix, prefixSource: worktree?.source },
    appConfig?.appPort,
    lanMode,
    lanIp
  );
}

/**
 * Multi-app mode: discover workspace packages and run all that have
 * the target script through the proxy concurrently.
 */
interface MultiAppEntry {
  pkg: WorkspacePackage;
  /** Portless hostname (e.g. "web.json-render") */
  name: string;
  /** Human-readable package label for display (e.g. "web") */
  label: string;
  commandArgs: string[];
  appPort?: number;
  proxied: boolean;
}

function spawnChildProcess(
  commandArgs: string[],
  env: Record<string, string | undefined>,
  cwd: string
): ReturnType<typeof spawn> {
  return spawn(commandArgs[0], commandArgs.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env,
    cwd,
    ...(isWindows ? {} : { detached: true }),
  });
}

function prefixStream(
  stream: NodeJS.ReadableStream | null,
  output: NodeJS.WritableStream,
  prefix: string
): void {
  if (!stream) return;
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (data: Buffer) => {
    buffer += decoder.write(data);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      output.write(`${prefix} ${line}\n`);
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) output.write(`${prefix} ${buffer}\n`);
  });
}

function pipeOutput(child: ReturnType<typeof spawn>, prefix: string): void {
  prefixStream(child.stdout, process.stdout, prefix);
  prefixStream(child.stderr, process.stderr, prefix);
}

async function spawnProxiedApp(
  app: MultiAppEntry,
  stateDir: string,
  proxyPort: number,
  tls: boolean,
  tlds: string[],
  lanMode: boolean,
  exitCodes: Map<MultiAppEntry, number | null>
): Promise<{
  child: ReturnType<typeof spawn>;
  displayUrl: string;
  route: { store: RouteStore; hostnames: string[] } | null;
  settled: Promise<void>;
}> {
  const usesPortless = app.commandArgs[0] === "portless";

  const pkgEnv: Record<string, string | undefined> = { ...process.env };
  pkgEnv.PATH = augmentedPath(pkgEnv, app.pkg.dir);

  let env: Record<string, string | undefined>;
  let store: RouteStore | null = null;
  let hostnames: string[] = [];
  let displayUrl: string;
  let appPort: number | undefined;

  if (usesPortless) {
    env = pkgEnv;
    displayUrl = "(managed by portless)";
  } else {
    store = new RouteStore(stateDir, {
      onWarning: (msg) => console.warn(colors.yellow(`[${app.name}] ${msg}`)),
    });

    appPort = app.appPort ?? (await findFreePort());
    hostnames = buildHostnames(app.name, tlds);
    const urls = formatUrls(hostnames, proxyPort, tls);
    const url = urls[0]!;
    displayUrl = url;

    addRoutes(store, hostnames, appPort, process.pid);
    await reportHostsSyncHere(hostnames, proxyPort, tls, lanMode);

    env = {
      ...pkgEnv,
      PORT: String(appPort),
      HOST: "127.0.0.1",
      PORTLESS_URL: url,
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: formatViteAllowedHosts(tlds),
    };

    if (tls) {
      const caPath = path.join(stateDir, "ca.pem");
      if (fs.existsSync(caPath)) {
        env.NODE_EXTRA_CA_CERTS = caPath;
      }
    }
  }

  const preexistingListener = appPort === undefined ? null : await findPreexistingListener(appPort);
  const child = spawnChildProcess(app.commandArgs, env, app.pkg.dir);
  pipeOutput(child, chalk.cyan(`[${app.name}]`));

  const capturedStore = store;
  const capturedHostnames = hostnames;
  const capturedPort = appPort;
  const settled = new Promise<void>((resolve) => {
    child.on("exit", (code, signal) => {
      exitCodes.set(app, code);
      if (code !== 0 && code !== null) {
        console.error(colors.red(`[${app.name}] exited with code ${code}`));
      } else if (signal) {
        console.error(colors.yellow(`[${app.name}] killed by ${signal}`));
      }
      if (!capturedStore || capturedHostnames.length === 0 || capturedPort === undefined) {
        resolve();
        return;
      }
      const transfer = signal
        ? Promise.resolve()
        : transferRoutesToDaemon(
            capturedStore,
            capturedHostnames,
            capturedPort,
            child.pid,
            preexistingListener,
            code === 0
          );
      transfer
        .catch(() => {
          // Best-effort; the routes are removed below.
        })
        .finally(() => {
          removeRoutes(capturedStore, capturedHostnames, process.pid);
          resolve();
        });
    });
  });

  const route = store && hostnames.length > 0 ? { store, hostnames } : null;
  return { child, displayUrl, route, settled };
}

function spawnTaskApp(
  app: MultiAppEntry,
  exitCodes: Map<MultiAppEntry, number | null>
): ReturnType<typeof spawn> {
  const pkgEnv: Record<string, string | undefined> = { ...process.env };
  pkgEnv.PATH = augmentedPath(pkgEnv, app.pkg.dir);

  const child = spawnChildProcess(app.commandArgs, pkgEnv, app.pkg.dir);
  pipeOutput(child, chalk.gray(`[${app.name}]`));

  child.on("exit", (code, signal) => {
    exitCodes.set(app, code);
    if (code !== 0 && code !== null) {
      console.error(colors.red(`[${app.name}] exited with code ${code}`));
    } else if (signal) {
      console.error(colors.yellow(`[${app.name}] killed by ${signal}`));
    }
  });

  return child;
}

async function handleDefaultMulti(
  wsRoot: string,
  globalScript?: string,
  extraArgs: string[] = []
): Promise<void> {
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(wsRoot);
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(colors.red(`Error: ${err.message}`));
      process.exit(1);
    }
    throw err;
  }
  const packages = discoverWorkspacePackages(wsRoot);

  if (packages.length === 0) {
    console.error(colors.red("Error: No workspace packages found."));
    process.exit(1);
  }

  const scriptName = globalScript ?? loaded?.config.script ?? "dev";

  // Infer the monorepo project name for use as the base domain.
  // Config name > common npm scope > workspace root inference.
  let projectName: string;
  if (loaded?.config.name) {
    projectName = loaded.config.name
      .split(".")
      .map((label) => truncateLabel(label))
      .join(".");
  } else {
    const scopeCounts = new Map<string, number>();
    for (const p of packages) {
      if (p.scope) scopeCounts.set(p.scope, (scopeCounts.get(p.scope) ?? 0) + 1);
    }
    let commonScope: string | undefined;
    let maxCount = 0;
    for (const [scope, count] of scopeCounts) {
      if (count > maxCount) {
        commonScope = scope;
        maxCount = count;
      }
    }
    if (commonScope) {
      projectName = sanitizeForHostname(commonScope) || inferProjectName(wsRoot).name;
    } else {
      projectName = inferProjectName(wsRoot).name;
    }
  }

  const apps: MultiAppEntry[] = [];

  const detectedWorktrees = new Map<WorktreePrefixStyle, WorktreePrefix | null>();
  const worktreeFor = (worktreeConfig: WorktreeConfig | undefined): WorktreePrefix | null => {
    const style = worktreeConfig?.prefix ?? "last-segment";
    if (!detectedWorktrees.has(style)) {
      detectedWorktrees.set(style, detectWorktreePrefix(wsRoot, style));
    }
    return detectedWorktrees.get(style)!;
  };

  for (const pkg of packages) {
    const rel = path.relative(wsRoot, pkg.dir).replace(/\\/g, "/");
    const rootOverride = loaded ? resolveAppConfig(loaded.config, loaded.configDir, pkg.dir) : null;
    let pkgConfig: AppConfig | null;
    // Worktree config matches default mode: the leaf portless.json (or its
    // package.json "portless" fallback) wins over the workspace root config.
    let leafWorktree: WorktreeConfig | undefined;
    try {
      pkgConfig = loadPackagePortlessConfig(pkg.dir);
      const leaf = loadConfig(pkg.dir);
      leafWorktree = leaf
        ? resolveAppConfig(leaf.config, leaf.configDir, pkg.dir).worktree
        : undefined;
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        console.error(colors.red(`Error: ${err.message}`));
        process.exit(1);
      }
      throw err;
    }

    const appOverride: AppConfig = {
      ...Object.fromEntries(Object.entries(rootOverride ?? {}).filter(([, v]) => v !== undefined)),
      ...Object.fromEntries(Object.entries(pkgConfig ?? {}).filter(([, v]) => v !== undefined)),
      worktree: mergeWorktreeConfig(rootOverride?.worktree, leafWorktree),
    };

    const effectiveScript = appOverride.script ?? scriptName;
    const scriptValue = pkg.scripts[effectiveScript];
    if (!scriptValue) continue;

    const rawScript = splitCommand(scriptValue);
    if (rawScript.length === 0) continue;

    const pm = detectPackageManager(pkg.dir);
    const commandArgs = [pm, "run", effectiveScript];

    const proxied = appOverride.proxy ?? isServerCommand(rawScript);

    let name: string;
    let label: string;
    if (appOverride.name) {
      name = appOverride.name
        .split(".")
        .map((l) => truncateLabel(l))
        .join(".");
      label = appOverride.name;
    } else {
      let pkgLabel: string;
      if (pkg.name) {
        const sanitized = sanitizeForHostname(pkg.name);
        pkgLabel = sanitized || rel.replace(/\//g, "-");
      } else {
        pkgLabel = rel.replace(/\//g, "-");
      }
      name = pkgLabel === projectName ? projectName : `${pkgLabel}.${projectName}`;
      label = pkg.scope ? `@${pkg.scope}/${pkg.name}` : (pkg.name ?? rel);
    }

    name = applyWorktreePrefix(
      name,
      worktreeFor(appOverride.worktree),
      appOverride.worktree?.hostnameTemplate
    );

    apps.push({ pkg, name, label, commandArgs, appPort: appOverride.appPort, proxied });
  }

  if (apps.length === 0) {
    console.error(colors.yellow(`No workspace packages have a "${scriptName}" script.`));
    process.exit(1);
  }

  apps.sort((a, b) => a.label.localeCompare(b.label));
  const proxiedApps = apps.filter((a) => a.proxied);
  const taskApps = apps.filter((a) => !a.proxied);

  console.log(chalk.blue.bold(`\nportless\n`));

  let { dir, port, tls, tlds, lanMode } = await discoverState();

  if (proxiedApps.length > 0) {
    let multiDesired: ProxyDesiredState;
    try {
      multiDesired = resolveProxyDesiredState(false);
    } catch (err) {
      console.error(colors.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }

    // Check hostname collisions before starting the proxy so a config mistake
    // cannot leave a proxy or app children behind. A running proxy keeps its
    // own TLDs; otherwise an explicit env override decides a fresh start.
    const where = (app: MultiAppEntry) =>
      `"${app.label}" (${path.relative(wsRoot, app.pkg.dir).replace(/\\/g, "/") || "."})`;
    const checkHostnameCollisions = (tldsForCheck: readonly string[]) => {
      const seen = new Map<string, MultiAppEntry>();
      for (const app of proxiedApps) {
        for (const hostname of buildHostnames(app.name, tldsForCheck)) {
          const existing = seen.get(hostname);
          if (existing) {
            throw new Error(
              `Duplicate hostname "${hostname}" for ${where(existing)} and ${where(app)}. Set unique "name" overrides; if using worktree.hostnameTemplate, include {name}.`
            );
          }
          seen.set(hostname, app);
        }
      }
    };
    // A running proxy keeps its own TLDs; a stopped one starts with the same
    // persisted/env merge ensureProxyRunning uses, with LAN normalized to .local.
    let preflightTlds = tlds;
    if (!(await isProxyUp(port, tls))) {
      const { startConfig } = resolveProxyStart(multiDesired);
      preflightTlds = startConfig.lanMode ? ["local"] : startConfig.tlds;
    }
    checkHostnameCollisions(preflightTlds);

    const ensureResult = await ensureProxyRunning(port, tls, multiDesired);
    if (ensureResult.started) {
      dir = ensureResult.state.dir;
      port = ensureResult.state.port;
      tls = ensureResult.state.tls;
      tlds = ensureResult.state.tlds;
      lanMode = ensureResult.state.lanMode;
    } else {
      // Proxy was already running; re-discover to pick up current state.
      ({ dir, port, tls, tlds, lanMode } = await discoverState());
    }

    // Recheck if the proxy settled on different TLDs than the preflight read.
    if (tlds.join("\u0000") !== preflightTlds.join("\u0000")) {
      checkHostnameCollisions(tlds);
    }

    if (tls && !isCATrusted(dir)) {
      await handleTrust();
    }
  }

  const useTurbo = loaded?.config.turbo !== false && hasTurboConfig(wsRoot);

  if (useTurbo) {
    await runWithTurbo(
      wsRoot,
      dir,
      port,
      tls,
      tlds,
      lanMode,
      scriptName,
      proxiedApps,
      taskApps,
      extraArgs
    );
  } else {
    await runWithDirectSpawn(dir, port, tls, tlds, lanMode, proxiedApps, taskApps);
  }
}

async function runWithTurbo(
  wsRoot: string,
  stateDir: string,
  proxyPort: number,
  tls: boolean,
  tlds: string[],
  lanMode: boolean,
  scriptName: string,
  proxiedApps: MultiAppEntry[],
  taskApps: MultiAppEntry[],
  extraArgs: string[] = []
): Promise<void> {
  const store = new RouteStore(stateDir, {
    onWarning: (msg: string) => console.warn(colors.yellow(msg)),
  });

  const manifest: Record<string, ManifestEntry> = {};
  const routes: { hostnames: string[] }[] = [];
  const appUrls: { label: string; url: string }[] = [];

  for (const app of proxiedApps) {
    const usesPortless = app.commandArgs[0] === "portless";
    if (usesPortless) {
      appUrls.push({ label: app.label, url: "(managed by portless)" });
      continue;
    }

    const appPort = app.appPort ?? (await findFreePort());
    const hostnames = buildHostnames(app.name, tlds);
    const urls = formatUrls(hostnames, proxyPort, tls);
    const url = urls[0]!;
    appUrls.push({ label: app.label, url });

    addRoutes(store, hostnames, appPort, process.pid);
    await reportHostsSyncHere(hostnames, proxyPort, tls, lanMode);
    routes.push({ hostnames });

    const entry: ManifestEntry = {
      PORT: String(appPort),
      HOST: "127.0.0.1",
      PORTLESS_URL: url,
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: formatViteAllowedHosts(tlds),
    };
    if (tls) {
      const caPath = path.join(stateDir, "ca.pem");
      if (fs.existsSync(caPath)) {
        entry.NODE_EXTRA_CA_CERTS = caPath;
      }
    }
    manifest[app.pkg.dir] = entry;
  }

  ensureEnvLoader();
  writeManifest(manifest);

  if (appUrls.length > 0) {
    const maxLabel = Math.max(...appUrls.map((a) => a.label.length));
    for (const { label, url } of appUrls) {
      const pad = " ".repeat(maxLabel - label.length);
      console.log(`  ${label}${pad}  ${chalk.dim(url)}`);
    }
  }
  console.log("");

  const pm = detectPackageManager(wsRoot);
  const useRootScript = hasScript(scriptName, wsRoot);
  const turboArgs = useRootScript
    ? [pm, "run", scriptName, ...extraArgs]
    : pm === "npm"
      ? ["npx", "turbo", "run", scriptName, ...extraArgs]
      : pm === "bun"
        ? ["bunx", "turbo", "run", scriptName, ...extraArgs]
        : [pm, "exec", "turbo", "run", scriptName, ...extraArgs];

  const turboSpawnedAt = Date.now();
  const turboChild = spawn(turboArgs[0], turboArgs.slice(1), {
    stdio: "inherit",
    cwd: wsRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: buildNodeOptions(),
    },
    ...(isWindows ? {} : { detached: true }),
  });
  guardWindowsOrphans(turboChild, turboSpawnedAt);

  const SIGKILL_TIMEOUT_MS = 5_000;

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;

    killTree(turboChild, "SIGTERM");
    setTimeout(() => {
      if (turboChild.exitCode === null && !turboChild.killed) {
        killTree(turboChild, "SIGKILL");
      }
    }, SIGKILL_TIMEOUT_MS).unref();

    for (const { hostnames } of routes) {
      removeRoutes(store, hostnames, process.pid);
    }
    removeManifest();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  const exitCode = await new Promise<number | null>((resolve) => {
    turboChild.on("exit", (code) => resolve(code));
  });

  cleanup();

  if (exitCode !== 0 && exitCode !== null) {
    process.exit(exitCode);
  }
}

async function runWithDirectSpawn(
  stateDir: string,
  proxyPort: number,
  tls: boolean,
  tlds: string[],
  lanMode: boolean,
  proxiedApps: MultiAppEntry[],
  taskApps: MultiAppEntry[]
): Promise<void> {
  const children: ReturnType<typeof spawn>[] = [];
  const exitCodes = new Map<MultiAppEntry, number | null>();
  const appUrls: { label: string; url: string }[] = [];
  const routeEntries: { store: RouteStore; hostnames: string[] }[] = [];
  const routeSettlements: Promise<void>[] = [];

  // Sequential: each spawnProxiedApp calls findFreePort() which binds/releases
  // a port, so parallel spawning could cause port collisions.
  for (const app of proxiedApps) {
    const { child, displayUrl, route, settled } = await spawnProxiedApp(
      app,
      stateDir,
      proxyPort,
      tls,
      tlds,
      lanMode,
      exitCodes
    );
    children.push(child);
    routeSettlements.push(settled);
    if (route) routeEntries.push(route);
    appUrls.push({ label: app.label, url: displayUrl });
  }

  const taskLabels: string[] = [];
  for (const app of taskApps) {
    children.push(spawnTaskApp(app, exitCodes));
    taskLabels.push(app.label);
  }

  // Print a clean summary after all processes are spawned.
  if (appUrls.length > 0) {
    const maxLabel = Math.max(...appUrls.map((a) => a.label.length));
    for (const { label, url } of appUrls) {
      const pad = " ".repeat(maxLabel - label.length);
      console.log(`  ${label}${pad}  ${chalk.dim(url)}`);
    }
  }
  console.log("");

  const SIGKILL_TIMEOUT_MS = 5_000;

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;

    for (const child of children) {
      killTree(child, "SIGTERM");
    }
    setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && !child.killed) {
          killTree(child, "SIGKILL");
        }
      }
    }, SIGKILL_TIMEOUT_MS).unref();

    for (const { store, hostnames } of routeEntries) {
      removeRoutes(store, hostnames, process.pid);
    }
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          child.on("exit", () => resolve());
        })
    )
  );
  await Promise.all(routeSettlements);

  const failed = [...exitCodes.entries()].filter(([, code]) => code !== 0 && code !== null);
  if (failed.length > 0) {
    console.error(
      colors.red(
        `\n${failed.length} app${failed.length === 1 ? "" : "s"} exited with errors: ${failed.map(([app, code]) => `${app.label} (${code})`).join(", ")}`
      )
    );
    process.exit(1);
  }
}

async function handleRunMode(args: string[], globalScript?: string): Promise<void> {
  const parsed = parseRunArgs(args);

  if (parsed.prefix !== undefined) process.env.PORTLESS_PREFIX = parsed.prefix;

  const appConfig = loadAppConfig();

  if (parsed.commandArgs.length === 0) {
    const scriptName = globalScript ?? appConfig?.script ?? "dev";
    const resolved = resolveScriptCommand(scriptName, process.cwd());
    if (resolved) {
      parsed.commandArgs = resolved;
    }
  }

  if (parsed.commandArgs.length === 0) {
    throw new UsageError("No command provided.", [
      "Usage:",
      "  portless run <command...>",
      "Example:",
      "  portless run next dev",
    ]);
  }

  let baseName: string;
  let nameSource: string;

  if (parsed.name) {
    // Truncate individual labels that exceed the DNS limit. Dots are preserved
    // as intentional subdomain separators (e.g. --name local.myapp).
    baseName = parsed.name
      .split(".")
      .map((label) => truncateLabel(label))
      .join(".");
    nameSource = "--name flag";
  } else if (appConfig?.name) {
    baseName = appConfig.name
      .split(".")
      .map((label) => truncateLabel(label))
      .join(".");
    nameSource = appConfig.source;
  } else {
    const inferred = inferProjectName();
    baseName = inferred.name;
    nameSource = inferred.source;
  }

  if (!parsed.appPort && appConfig?.appPort) {
    parsed.appPort = appConfig.appPort;
  }

  const worktree = detectWorktreePrefix(process.cwd(), appConfig?.worktree?.prefix);
  const effectiveName = applyWorktreePrefix(
    baseName,
    worktree,
    appConfig?.worktree?.hostnameTemplate
  );

  const { dir, port, tls, tlds, lanMode, lanIp } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });
  await runApp(
    store,
    port,
    dir,
    effectiveName,
    parsed.commandArgs,
    tls,
    tlds,
    parsed.force,
    { nameSource, baseName, prefix: worktree?.prefix, prefixSource: worktree?.source },
    parsed.appPort,
    lanMode,
    lanIp
  );
}

async function handleNamedMode(args: string[], explicitName: boolean): Promise<void> {
  const parsed = parseAppArgs(args);

  if (parsed.commandArgs.length === 0) {
    const suggestion = explicitName ? undefined : suggestCommand(parsed.name);
    throw new UsageError("No command provided.", [
      ...(suggestion
        ? [`"${parsed.name}" is not a portless command. Did you mean:`, `  portless ${suggestion}`]
        : []),
      "Usage:",
      "  portless <name> <command...>",
      "Example:",
      "  portless myapp next dev",
    ]);
  }

  if (!parsed.appPort) {
    const appConfig = loadAppConfig();
    if (appConfig?.appPort) {
      parsed.appPort = appConfig.appPort;
    }
  }

  // Truncate individual labels that exceed the DNS limit, same as handleRunMode.
  const safeName = parsed.name
    .split(".")
    .map((label) => truncateLabel(label))
    .join(".");
  parseHostname(safeName, DEFAULT_TLD);

  const { dir, port, tls, tlds, lanMode, lanIp } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });
  await runApp(
    store,
    port,
    dir,
    safeName,
    parsed.commandArgs,
    tls,
    tlds,
    parsed.force,
    undefined,
    parsed.appPort,
    lanMode,
    lanIp
  );
}

// ---------------------------------------------------------------------------
// Docker Compose
// ---------------------------------------------------------------------------

function printComposeHelp(): void {
  console.log(`
${colors.bold("portless compose")} - Run a Docker Compose project behind portless.

Each service that publishes an HTTP port gets ${colors.cyan("<service>.<project>.localhost")}.
Database and cache ports such as 5432, 3306, 6379, and 27017 keep their
published port.

${colors.bold("Usage:")}
  ${colors.cyan("portless compose up [args...]")}       Start the project and register routes
  ${colors.cyan("portless compose up -d [args...]")}    Start detached; routes stay until down
  ${colors.cyan("portless compose down [args...]")}     Stop the project and remove its routes
  ${colors.cyan("portless compose <command> [args]")}   Any other compose command, unchanged

Global compose flags (-f, -p, --profile, --env-file, --project-directory) go
before the command, as with docker compose.

${colors.bold("Examples:")}
  portless compose up                  # -> https://web.myapp.localhost
  portless compose -f compose.dev.yml up -d
  portless compose down

${colors.bold("Service labels:")}
  portless.enable: "false"     Leave the service and its ports unchanged
  portless.name: <name>        Use <name> instead of the service name
  portless.ports: 3000,9229    Route only these container ports

${colors.bold("Notes:")}
  portless picks a free port on 127.0.0.1 for each HTTP port and reuses it,
  so routes keep working after restart, after stop and start, and when Docker
  restarts the container. A routed service can't scale past one container.
  A service with several HTTP ports also gets <port>.<service>.<project>.
  Each routed service gets __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS, so a Vite
  dev server in a container accepts its portless hostname.
  Start the project with portless compose up, because a plain docker compose
  up recreates the containers with their original ports.
`);
}

/** Host ports for compose routes. Separate from the 4000-4999 range of portless run. */
const COMPOSE_MIN_PORT = 14000;
const COMPOSE_MAX_PORT = 14999;

/** Run docker compose and capture its output. */
function dockerCompose(
  args: string[],
  input?: string
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("docker", ["compose", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) throw new Error(`could not run docker compose: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Run docker compose attached to this terminal. */
function spawnDockerCompose(
  args: string[],
  input?: string
): {
  child: ReturnType<typeof spawn>;
  exited: Promise<number>;
} {
  const child = spawn("docker", ["compose", ...args], {
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (input !== undefined) child.stdin?.end(input);
  const exited = new Promise<number>((resolve) => {
    child.on("error", (err) => {
      console.error(colors.red(`Error: could not run docker compose: ${err.message}`));
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  return { child, exited };
}

/** Running containers of a compose invocation, or null when `ps` fails. */
function readComposeContainers(
  globals: string[],
  opts: { all?: boolean; input?: string } = {}
): ComposeContainers | null {
  const result = dockerCompose(
    [...globals, "ps", "--format", "json", ...(opts.all ? ["--all"] : [])],
    opts.input
  );
  if (result.status !== 0) return null;
  try {
    return parseContainers(result.stdout);
  } catch {
    return null;
  }
}

/** Project name from the compose file, or undefined when there is none to read. */
function readComposeProjectName(globals: string[], input?: string): string | undefined {
  const config = dockerCompose([...globals, "config", "--format", "json"], input);
  if (config.status !== 0) return undefined;
  try {
    return (JSON.parse(config.stdout) as ComposeModel).name;
  } catch {
    return undefined;
  }
}

/** Files portless keeps per compose project: the resolved model and its fixed ports. */
function composeStatePaths(stateDir: string, project: string): { model: string; ports: string } {
  const dir = path.join(stateDir, "compose");
  return {
    model: path.join(dir, `${project}.json`),
    ports: path.join(dir, `${project}.ports.json`),
  };
}

async function composeDown(args: string[], globals: string[], input?: string): Promise<never> {
  // An explicit name wins. Otherwise read it from the containers, so down
  // works without the compose file and after services were renamed, and
  // fall back to the file when no container is left.
  const project =
    explicitProject(globals) ??
    process.env.COMPOSE_PROJECT_NAME ??
    readComposeContainers(globals, { all: true, input })?.projects[0] ??
    readComposeProjectName(globals, input);
  const code = await spawnDockerCompose(args, input).exited;
  // A failed down leaves the containers running, so their routes stay.
  if (code !== 0 || !project) process.exit(code);
  const after = readComposeContainers(["-p", project]);
  if (!after) {
    console.warn(
      colors.yellow("Could not read the project's containers. Routes were left in place.")
    );
    process.exit(code);
  }
  const { dir, tlds } = await discoverState();
  const store = new RouteStore(dir, { onWarning: (msg) => console.warn(colors.yellow(msg)) });
  const aliases = store.loadRoutes().filter((r) => r.pid === 0);
  removeRoutes(store, staleAliases(aliases, project, tlds, after));
  if (after.ports.size === 0) {
    // The resolved model can hold env_file values; drop it with the project.
    const files = composeStatePaths(dir, project);
    fs.rmSync(files.model, { force: true });
    fs.rmSync(files.ports, { force: true });
  }
  process.exit(code);
}

/** Reject a compose invocation whose own global flags do not parse. */
function assertComposeGlobals(globals: readonly string[]): void {
  const error = composeGlobalError(globals);
  if (error) throw new UsageError(error, ["See: portless compose --help"]);
}

async function handleCompose(args: string[]): Promise<void> {
  const composeArgs = args.slice(1);
  const { globals, subcommand, rest } = splitComposeArgs(composeArgs);
  const childHelp = rest.includes("--help") || rest.includes("-h");
  const globalHelp = isGlobalFlagSet(globals, ["--help", "-h"]);

  if (!subcommand) {
    if (!globalHelp) assertComposeGlobals(globals);
    printComposeHelp();
    process.exit(0);
  }

  if (isPortlessSkipped()) process.exit(await spawnDockerCompose(composeArgs).exited);

  if (!globalHelp) assertComposeGlobals(globals);

  if (globalHelp || childHelp || (subcommand !== "up" && subcommand !== "down")) {
    process.exit(await spawnDockerCompose(composeArgs).exited);
  }

  try {
    // stdin can be read once; keep it for every compose call that needs the file.
    const input = readsComposeFromStdin(globals) ? fs.readFileSync(0, "utf8") : undefined;
    if (subcommand === "down") await composeDown(composeArgs, globals, input);

    // Include every profile so `up <service>` can start a service from an
    // inactive profile; compose still applies the user's --profile flags at up.
    const config = dockerCompose(
      [...globals, "--profile", "*", "config", "--format", "json"],
      input
    );
    if (config.status !== 0) {
      process.stderr.write(config.stderr);
      throw new Error("docker compose config failed.");
    }
    await composeUp(JSON.parse(config.stdout) as ComposeModel, globals, rest);
  } catch (err) {
    console.error(colors.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
}

/** Refuse a project whose hostnames would collide with another project's, like fd_x and fd-x. */
function assertUniqueProjectLabel(stateDir: string, project: string): void {
  const dir = path.join(stateDir, "compose");
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json") || file.endsWith(".ports.json")) continue;
    // Compare the project name stored in the model, not the file name: older
    // versions named the file after the hostname label (my-app.json for my_app).
    let other: string;
    try {
      other = (JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as ComposeModel).name;
    } catch {
      continue;
    }
    if (other !== project && projectLabel(other) === projectLabel(project)) {
      throw new Error(
        `Projects "${other}" and "${project}" share the hostname suffix ${projectLabel(project)}. Run portless compose -p ${other} down, or rename one project.`
      );
    }
  }
}

function isPortFree(port: number): Promise<boolean> {
  return findFreePort(port, port).then(
    () => true,
    () => false
  );
}

/** Ports saved by every other compose project in the state dir. */
function reservedComposePorts(stateDir: string, project: string): Set<number> {
  const dir = path.join(stateDir, "compose");
  const reserved = new Set<number>();
  if (!fs.existsSync(dir)) return reserved;
  const own = path.basename(composeStatePaths(stateDir, project).ports);
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".ports.json") || file === own) continue;
    try {
      const ports = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<
        string,
        number
      >;
      for (const port of Object.values(ports)) if (typeof port === "number") reserved.add(port);
    } catch {
      // Unreadable file: nothing to reserve.
    }
  }
  return reserved;
}

/** Fixed host ports for the project's routed container ports, saved for the next up. */
async function allocateComposePorts(
  stateDir: string,
  project: string,
  keys: string[]
): Promise<Map<string, number>> {
  const portsPath = composeStatePaths(stateDir, project).ports;
  let stored: Record<string, number> = {};
  try {
    stored = JSON.parse(fs.readFileSync(portsPath, "utf8")) as Record<string, number>;
  } catch {
    // First run, or an unreadable file: allocate fresh ports.
  }
  const ports = await allocatePorts(keys, stored, {
    min: COMPOSE_MIN_PORT,
    max: COMPOSE_MAX_PORT,
    ours: new Set(readComposeContainers(["-p", project])?.ports.values() ?? []),
    reserved: reservedComposePorts(stateDir, project),
    isFree: isPortFree,
  });
  fs.writeFileSync(portsPath, JSON.stringify(Object.fromEntries(ports), null, 2), { mode: 0o600 });
  return ports;
}

async function composeUp(source: ComposeModel, globals: string[], rest: string[]): Promise<never> {
  let state = await discoverState();
  const ensured = await ensureProxyRunning(
    state.port,
    state.tls,
    resolveProxyDesiredState(state.lanMode)
  );
  if (ensured.started) {
    state = ensured.state;
    if (state.tls && !isCATrusted(state.dir)) await handleTrust();
  } else {
    const running = readCurrentProxyConfig(state.dir);
    state = { ...state, tlds: running.tlds, lanMode: running.lanMode, lanIp: running.lanIp };
  }
  const { dir, port: proxyPort, tls, tlds, lanMode } = state;
  const store = new RouteStore(dir, { onWarning: (msg) => console.warn(colors.yellow(msg)) });

  const project = source.name;
  const files = composeStatePaths(dir, project);
  fs.mkdirSync(path.dirname(files.model), { recursive: true });
  fixOwnership(path.dirname(files.model));
  assertUniqueProjectLabel(dir, project);

  const planOpts = {
    hostnamesFor: (name: string) => buildHostnames(name, tlds),
    urlFor: (hostname: string) => formatUrl(hostname, proxyPort, tls),
    viteAllowedHosts: formatViteAllowedHosts(tlds),
  };
  // Plan once to learn the routed ports, then again with their fixed host ports.
  const keyOf = (service: string, target: number): string => `${service}:${target}`;
  const keys = [
    ...new Set(planCompose(source, planOpts).routes.map((r) => keyOf(r.service, r.target))),
  ];
  const ports = await allocateComposePorts(dir, project, keys);
  const plan = planCompose(source, {
    ...planOpts,
    portFor: (service, target) => ports.get(keyOf(service, target)),
  });

  fs.writeFileSync(files.model, JSON.stringify(plan.model, null, 2), { mode: 0o600 });
  fixOwnership(files.model, files.ports);

  console.log(colors.bold(`\nportless compose ${plan.project}\n`));
  for (const k of plan.kept) {
    const where = k.published ? `host port ${k.published}` : "an ephemeral port";
    const verb = k.dropped ? "drops" : "keeps";
    console.log(colors.gray(`-- ${k.service}:${k.target} ${verb} ${where} (${k.reason})`));
  }
  if (plan.routes.length === 0) {
    console.log(colors.yellow("No published HTTP ports found. Nothing to route."));
  }

  const upArgs = buildUpArgs({
    globals,
    rest,
    project: plan.project,
    modelPath: files.model,
    cwd: process.cwd(),
    composeFileEnv: process.env.COMPOSE_FILE,
    pathSeparator: process.env.COMPOSE_PATH_SEPARATOR,
  });
  const detached = isDetachedUp(rest);
  const ownerPid = detached ? 0 : process.pid;
  const registered = new Map<string, number>();
  // Conflicts are retried on every sync (the owner may exit) but reported once.
  const conflicts = new Set<string>();

  // Register the routes of running services. Ports are fixed, so this only
  // picks up services as they start.
  const sync = (): boolean => {
    const containers = readComposeContainers(["-p", plan.project]);
    if (!containers) return false;
    for (const route of plan.routes) {
      const port = routePort(route, containers);
      const primary = route.hostnames[0]!;
      if (port === undefined || registered.get(primary) === port) continue;
      try {
        // Aliases from an earlier up -d are ours to replace; a live process is not.
        addRoutes(store, route.hostnames, port, ownerPid, isAliasConflict(store, primary));
      } catch (err) {
        if (!(err instanceof RouteConflictError)) throw err;
        if (!conflicts.has(primary)) {
          console.error(
            colors.red(
              `Error: ${primary} is already registered by another process (PID ${err.existingPid}). Stop it, or rename the service with portless.name.`
            )
          );
        }
        conflicts.add(primary);
        continue;
      }
      conflicts.delete(primary);
      registered.set(primary, port);
      console.log(colors.cyan(`  -> ${route.url}  (${route.service}:${route.target})`));
    }
    return true;
  };

  if (detached) {
    const code = await spawnDockerCompose(upArgs).exited;
    if (code === 0) {
      console.log("");
      if (!sync()) {
        console.warn(
          colors.yellow(
            "Could not read the project's containers, so no routes were registered. Run portless compose up -d again."
          )
        );
      }
      if (registered.size > 0)
        await reportHostsSyncHere([...registered.keys()], proxyPort, tls, lanMode);
    }
    process.exit(code !== 0 ? code : conflicts.size > 0 ? 1 : 0);
  }

  // Foreground: compose owns the terminal. portless registers routes as
  // services start and drops them when compose exits.
  const { child, exited } = spawnDockerCompose(upArgs);
  let reported = false;
  const timer = setInterval(() => {
    sync();
    if (!reported && registered.size > 0) {
      reported = true;
      void reportHostsSyncHere([...registered.keys()], proxyPort, tls, lanMode);
    }
  }, 1000);
  // Ctrl+C reaches compose through the process group; wait for it to stop.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  const code = await exited;
  clearInterval(timer);
  for (const route of plan.routes) removeRoutes(store, route.hostnames, process.pid);
  fs.rmSync(files.model, { force: true });
  process.exit(code);
}

function isAliasConflict(store: RouteStore, hostname: string): boolean {
  return store.loadRoutes().some((r) => r.hostname === hostname && r.pid === 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** True when PORTLESS=0 (or false/skip) asks portless to run commands directly. */
function isPortlessSkipped(): boolean {
  const value = process.env.PORTLESS;
  return value === "0" || value === "false" || value === "skip";
}

interface CommandEntry {
  run: (args: string[], context: { globalScript?: string }) => Promise<void>;
  help?: () => void;
}

const COMMANDS: Record<CommandName, CommandEntry> = {
  run: {
    run: (args, { globalScript }) => handleRunMode(args.slice(1), globalScript),
  },
  get: { run: handleGet, help: printGetHelp },
  list: { run: handleList, help: printListHelp },
  alias: { run: handleAlias },
  compose: { run: handleCompose },
  proxy: { run: handleProxy, help: printProxyHelp },
  service: {
    run: (args) => handleService(args, { entryScript: getEntryScript() }),
    help: printServiceHelp,
  },
  hosts: { run: handleHosts, help: printHostsHelp },
  doctor: { run: handleDoctor, help: printDoctorHelp },
  trust: { run: handleTrust, help: printTrustHelp },
  clean: { run: handleClean, help: printCleanHelp },
  prune: { run: handlePrune, help: printPruneHelp },
  mcp: { run: (args) => runMcp(args.slice(1)) },
};

async function main() {
  if (process.stdin.isTTY) {
    process.on("exit", () => {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // stdin may already be destroyed; non-fatal
      }
    });
  }

  const args = process.argv.slice(2);

  // Block one-off npx / pnpm dlx downloads. Running "sudo npx" is unsafe
  // because it performs package resolution and downloads as root. When
  // portless is installed as a project dependency the env vars still fire,
  // so skip the block if we can find a local installation.
  const isNpx = process.env.npm_command === "exec" && !process.env.npm_lifecycle_event;
  const isPnpmDlx = !!process.env.PNPM_SCRIPT_SRC_DIR && !process.env.npm_lifecycle_event;
  if ((isNpx || isPnpmDlx) && !isLocallyInstalled()) {
    console.error(colors.red("Error: portless should not be run via npx or pnpm dlx."));
    console.error(colors.blue("Install globally or as a project dependency:"));
    console.error(colors.cyan("  npm install -g portless"));
    console.error(colors.cyan("  npm install -D portless"));
    process.exit(1);
  }

  const globalBooleanFlags = new Set([
    "--lan",
    "--tailscale",
    "--funnel",
    "--ngrok",
    "--cloudflare",
  ]);
  const globalValueFlags = new Set(["--ip", INTERNAL_LAN_IP_FLAG, "--script"]);

  const advancePortlessFlag = (index: number, localValueFlags: Set<string>): number | null => {
    const arg = args[index];
    const equalsIndex = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if (globalBooleanFlags.has(flag) || flag === "--force" || flag === "--help" || flag === "-h") {
      return index + 1;
    }
    if (globalValueFlags.has(flag) || localValueFlags.has(flag)) {
      return index + (equalsIndex === -1 ? 2 : 1);
    }
    return null;
  };

  const globalFlagEnd = (): number => {
    const separator = args.indexOf("--");
    const limit = separator === -1 ? args.length : separator;
    const leadingValueFlags = new Set(["--app-port"]);
    let index = 0;

    while (index < limit) {
      const next = advancePortlessFlag(index, leadingValueFlags);
      if (next === null) break;
      index = next;
    }

    if (index >= limit) return limit;
    const mode = args[index];
    if (mode === "mcp") return index;
    if (mode === "run") {
      index++;
      const runValueFlags = new Set(["--name", "--prefix", "--app-port"]);
      while (index < limit) {
        const next = advancePortlessFlag(index, runValueFlags);
        if (next === null) break;
        index = next;
      }
      return index;
    }
    if (isCommandName(mode) || mode === "--version" || mode === "-v") return limit;

    if (mode === "--name" || mode.startsWith("--name=")) {
      index += mode === "--name" ? 2 : 1;
    } else {
      index++;
    }

    const namedValueFlags = new Set(["--app-port"]);
    while (index < limit) {
      const next = advancePortlessFlag(index, namedValueFlags);
      if (next === null) break;
      index = next;
    }
    return index;
  };

  const stripGlobalFlag = (flag: string, hasValue: boolean): string | boolean | null => {
    const end = globalFlagEnd();
    const idx = args.findIndex(
      (arg, index) => index < end && (arg === flag || (hasValue && arg.startsWith(`${flag}=`)))
    );
    if (idx === -1) return null;
    if (!hasValue) {
      args.splice(idx, 1);
      return true;
    }
    const equalsIndex = args[idx].indexOf("=");
    const value = equalsIndex === -1 ? args[idx + 1] : args[idx].slice(equalsIndex + 1);
    if (!value || value.startsWith("-")) return false;
    args.splice(idx, equalsIndex === -1 ? 2 : 1);
    return value;
  };

  if (stripGlobalFlag("--lan", false)) {
    process.env.PORTLESS_LAN = "1";
  }

  const ipResult = stripGlobalFlag("--ip", true);
  if (ipResult === false) {
    throw new UsageError("--ip requires an IP address.", [
      "  portless --lan --ip 192.168.1.42 run <command>",
    ]);
  } else if (typeof ipResult === "string") {
    process.env.PORTLESS_LAN_IP = ipResult;
    process.env.PORTLESS_LAN = "1";
  }

  const autoIpResult = stripGlobalFlag(INTERNAL_LAN_IP_FLAG, true);
  if (autoIpResult === false) {
    throw new UsageError(`${INTERNAL_LAN_IP_FLAG} requires an IP address.`);
  } else if (typeof autoIpResult === "string") {
    process.env[INTERNAL_LAN_IP_ENV] = autoIpResult;
    process.env.PORTLESS_LAN = "1";
  }

  if (stripGlobalFlag("--tailscale", false)) {
    process.env.PORTLESS_TAILSCALE = "1";
  }
  if (stripGlobalFlag("--funnel", false)) {
    process.env.PORTLESS_FUNNEL = "1";
    process.env.PORTLESS_TAILSCALE = "1";
  }
  if (stripGlobalFlag("--ngrok", false)) {
    process.env.PORTLESS_NGROK = "1";
  }
  if (stripGlobalFlag("--cloudflare", false)) {
    process.env.PORTLESS_CLOUDFLARE = "1";
  }

  // --script flag: override the default "dev" script for zero-arg mode.
  const scriptResult = stripGlobalFlag("--script", true);
  if (scriptResult === false) {
    throw new UsageError("--script requires a script name.", ["  portless --script start"]);
  }
  const globalScript = typeof scriptResult === "string" ? scriptResult : undefined;

  // --name flag: treat the next arg as an explicit app name, bypassing
  // subcommand dispatch. Useful when the app name collides with a reserved
  // subcommand (see COMMAND_NAMES).
  if (args[0]?.startsWith("--name=")) {
    args.splice(0, 1, "--name", args[0].slice("--name=".length));
  }
  const explicitName = args[0] === "--name";
  if (explicitName) {
    args.shift();
    if (!args[0]) {
      throw new UsageError("--name requires an app name.", [
        "  portless --name <name> <command...>",
      ]);
    }
  }
  const command = explicitName || !isCommandName(args[0]) ? undefined : COMMANDS[args[0]];
  const isRunCommand = command === COMMANDS.run;

  if (
    isPortlessSkipped() &&
    (isRunCommand || args.length === 0 || (args.length >= 2 && !command))
  ) {
    const parsed = isRunCommand ? parseRunArgs(args.slice(1)) : parseAppArgs(args);
    let commandArgs = parsed.commandArgs;
    if (commandArgs.length === 0 && (isRunCommand || args.length === 0)) {
      const appConfig = loadAppConfig();
      const scriptName = globalScript ?? appConfig?.script ?? "dev";
      const resolved = resolveScriptCommand(scriptName, process.cwd());
      if (resolved) commandArgs = resolved;
    }
    if (commandArgs.length === 0) throw new UsageError("No command provided.");
    spawnCommand(commandArgs);
    return;
  }

  if (command) {
    if (command.help && hasHelpFlag(args)) {
      command.help();
      return;
    }
    await command.run(args, { globalScript });
    return;
  }
  if (!explicitName) {
    if (args[0] === "--help" || args[0] === "-h") {
      printHelp();
      return;
    }
    if (args.length === 0 || args[0] === "--") {
      const extraArgs = args[0] === "--" ? args.slice(1) : [];
      const handled = await handleDefaultMode(globalScript, extraArgs);
      if (handled) return;
      printHelp();
      return;
    }
    if (args[0] === "--version" || args[0] === "-v") {
      printVersion();
      return;
    }
  }

  await handleNamedMode(args, explicitName);
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(colors.red(`Error: ${err.message}`));
    for (const hint of err.hints) console.error(colors.blue(hint));
    process.exit(2);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(colors.red("Error:"), message);
  process.exit(1);
});

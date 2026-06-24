#!/usr/bin/env node

declare const __VERSION__: string;

import colors from "./colors.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createSNICallback, ensureCerts, isCATrusted, trustCA, untrustCA } from "./certs.js";
import { createHttpRedirectServer, createProxyServer } from "./proxy.js";
import {
  fixOwnership,
  formatUrl,
  isErrnoException,
  isProcessAlive as isPidAlive,
  parseHostname,
} from "./utils.js";
import {
  checkHostResolution,
  getManagedHostnames,
  syncHostsFile,
  cleanHostsFile,
  shouldAutoSyncHosts,
} from "./hosts.js";
import { FILE_MODE, RouteConflictError, RouteStore } from "./routes.js";
import {
  ensureTailscaleReady,
  findAvailableServePort,
  formatTailscaleUrl,
  getUsedServePorts,
  registerFunnel,
  registerServe,
  unregisterTailscale,
} from "./tailscale.js";
import { ensureNgrokAvailable, startNgrok, stopNgrok, stopNgrokProcess } from "./ngrok.js";
import {
  inferProjectName,
  detectWorktreePrefix,
  truncateLabel,
  sanitizeForHostname,
} from "./auto.js";
import {
  buildProxyStartConfig,
  DEFAULT_TLD,
  FALLBACK_PROXY_PORT,
  INTERNAL_LAN_IP_ENV,
  INTERNAL_LAN_IP_FLAG,
  PRIVILEGED_PORT_THRESHOLD,
  RISKY_TLDS,
  WAIT_FOR_PROXY_INTERVAL_MS,
  WAIT_FOR_PROXY_MAX_ATTEMPTS,
  discoverState,
  findFreePort,
  findPidOnPort,
  findPidsOnPort,
  getDefaultPort,
  getDefaultTld,
  injectFrameworkFlags,
  isHttpsEnvDisabled,
  isPortListening,
  isWildcardEnvEnabled,
  isLanEnvEnabled,
  isProxyRunning,
  isWindows,
  killTree,
  readLanMarker,
  readCustomCertMarker,
  readPersistedProxyState,
  readTldFromDir,
  readTlsMarker,
  resolveStateDir,
  spawnCommand,
  augmentedPath,
  validateTld,
  waitForProxy,
  writeCustomCertMarker,
  writeLanMarker,
  writeTldFile,
  writeTlsMarker,
} from "./cli-utils.js";
import { collectStateDirsForCleanup, removePortlessStateFiles } from "./clean-utils.js";
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
  ConfigValidationError,
} from "./config.js";
import type { AppConfig } from "./config.js";
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
import { buildServiceUninstallSudoArgs, handleService, tryUninstallService } from "./service.js";

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
  tld: boolean;
  useWildcard: boolean;
};

type ProxyConfig = {
  useHttps: boolean;
  customCertPath: string | null;
  customKeyPath: string | null;
  lanMode: boolean;
  lanIp: string | null;
  lanIpExplicit: boolean;
  tld: string;
  useWildcard: boolean;
};

function defaultProxyConfig(tld: string, useHttps: boolean, lanMode: boolean): ProxyConfig {
  return {
    useHttps,
    customCertPath: null,
    customKeyPath: null,
    lanMode,
    lanIp: null,
    lanIpExplicit: false,
    tld: lanMode ? "local" : tld,
    useWildcard: false,
  };
}

function resolveProxyConfig(options: {
  persistedLanMode: boolean;
  explicit: ProxyConfigExplicitness;
  defaultTld: string;
  useHttps: boolean;
  customCertPath: string | null;
  customKeyPath: string | null;
  lanMode: boolean;
  lanIp: string | null;
  tld: string;
  useWildcard: boolean;
}): ProxyConfig {
  const config = defaultProxyConfig(
    options.defaultTld,
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
      if (!options.explicit.tld) {
        config.tld = options.defaultTld;
      }
    }
  }

  if (options.explicit.lanIp && options.lanIp) {
    config.lanMode = true;
    config.lanIp = options.lanIp;
    config.lanIpExplicit = true;
  }

  if (options.explicit.tld) {
    config.tld = options.tld;
  }

  if (options.explicit.useWildcard) {
    config.useWildcard = options.useWildcard;
  }

  if (!config.lanMode) {
    config.lanIp = null;
    config.lanIpExplicit = false;
  }

  if (config.lanMode) {
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
  const tld = readTldFromDir(dir);

  return {
    useHttps: readTlsMarker(dir),
    customCertPath: null,
    customKeyPath: null,
    lanMode: lanIp !== null || tld === "local",
    lanIp,
    lanIpExplicit: false,
    tld,
    useWildcard: false,
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

  if (explicit.tld && desiredConfig.tld !== actualConfig.tld) {
    messages.push(
      `requested .${desiredConfig.tld}, but the running proxy is using .${actualConfig.tld}`
    );
  }

  return messages;
}

function formatProxyStartCommand(proxyPort: number, config: ProxyConfig): string {
  const needsSudo = !isWindows && proxyPort < PRIVILEGED_PORT_THRESHOLD;
  const { args } = buildProxyStartConfig({
    useHttps: config.useHttps,
    customCertPath: config.customCertPath,
    customKeyPath: config.customKeyPath,
    lanMode: config.lanMode,
    lanIp: config.lanIpExplicit ? config.lanIp : null,
    lanIpExplicit: config.lanIpExplicit,
    tld: config.tld,
    useWildcard: config.useWildcard,
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
  const needsSudo = !isWindows && proxyPort < PRIVILEGED_PORT_THRESHOLD;
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

function formatProcessExitSuffix(code: number | null, signal: NodeJS.Signals | null): string {
  if (signal) return ` (signal ${signal})`;
  if (code !== null) return ` (exit ${code})`;
  return "";
}

// ---------------------------------------------------------------------------
// Proxy server lifecycle
// ---------------------------------------------------------------------------

function startProxyServer(
  store: RouteStore,
  proxyPort: number,
  tld: string,
  tlsOptions?: { cert: Buffer; key: Buffer },
  lanIp?: string | null,
  strict?: boolean,
  customCert = false
): void {
  store.ensureDir();

  const isTls = !!tlsOptions;
  const mdnsSupport = isMdnsSupported();
  let activeLanIp = lanIp && mdnsSupport.supported ? lanIp : null;
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

  const autoSyncHosts = shouldAutoSyncHosts(process.env.PORTLESS_SYNC_HOSTS);

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

  const reloadRoutes = () => {
    try {
      const previousRoutes = new Map(cachedRoutes.map((r) => [r.hostname, r.port]));
      cachedRoutes = store.loadRoutes();
      if (autoSyncHosts) {
        syncHostsFile(cachedRoutes.map((r) => r.hostname));
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
    watcher = fs.watch(routesPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(reloadRoutes, DEBOUNCE_MS);
    });
  } catch {
    // fs.watch may not be supported; fall back to periodic polling
    console.warn(colors.yellow("fs.watch unavailable; falling back to polling for route changes"));
    pollingInterval = setInterval(reloadRoutes, POLL_INTERVAL_MS);
  }

  if (autoSyncHosts) {
    syncHostsFile(cachedRoutes.map((r) => r.hostname));
  }

  // Publish mDNS for routes that already exist at startup
  publishCachedRoutes();

  const server = createProxyServer({
    getRoutes: () => cachedRoutes,
    proxyPort,
    tld,
    strict,
    onError: (msg) => console.error(colors.red(msg)),
    tls: tlsOptions,
  });

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
    if (redirectServer) redirectServer.close();
    process.exit(1);
  });

  // When TLS is enabled, start a plain HTTP server on port 80 that redirects
  // to HTTPS. Best-effort: if port 80 is unavailable, skip silently (the main
  // proxy on 443 still works; users just won't get automatic redirects).
  let redirectServer: ReturnType<typeof createHttpRedirectServer> | null = null;
  if (isTls && proxyPort !== 80) {
    redirectServer = createHttpRedirectServer(proxyPort);
    redirectServer.on("error", () => {
      redirectServer = null;
    });
    redirectServer.listen(80);
  }

  server.listen(proxyPort, () => {
    // Save PID and port once the server is actually listening
    fs.writeFileSync(store.pidPath, process.pid.toString(), { mode: FILE_MODE });
    fs.writeFileSync(store.portFilePath, proxyPort.toString(), { mode: FILE_MODE });
    writeTlsMarker(store.dir, isTls);
    writeCustomCertMarker(store.dir, isTls && customCert);
    writeTldFile(store.dir, tld);
    writeLanMarker(store.dir, activeLanIp);
    fixOwnership(store.dir, store.pidPath, store.portFilePath);
    const proto = isTls ? "HTTPS/2" : "HTTP";
    const tldLabel = tld !== DEFAULT_TLD ? ` (TLD: .${tld})` : "";
    const modeLabel = strict === false ? " (wildcard)" : "";
    console.log(
      colors.green(`${proto} proxy listening on port ${proxyPort}${tldLabel}${modeLabel}`)
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
    if (redirectServer) {
      console.log(colors.green("HTTP-to-HTTPS redirect listening on port 80"));
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
    if (redirectServer) {
      redirectServer.close();
    }
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
    const label = route.pid === 0 ? "(alias)" : `(pid ${route.pid})`;
    console.log(
      `  ${colors.cyan(url)}  ${colors.gray("->")}  ${colors.white(`localhost:${route.port}`)}  ${colors.gray(label)}`
    );
    if (route.tailscaleUrl) {
      const tsLabel = route.tailscaleFunnel ? "funnel" : "tailscale";
      console.log(`    ${colors.gray(tsLabel + ":")} ${colors.green(route.tailscaleUrl)}`);
    }
    if (route.ngrokUrl) {
      console.log(`    ${colors.gray("ngrok:")} ${colors.green(route.ngrokUrl)}`);
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
}

function resolveProxyDesiredState(lanMode: boolean): ProxyDesiredState {
  const envTld = getDefaultTld();
  const explicit: ProxyConfigExplicitness = {
    useHttps: process.env.PORTLESS_HTTPS !== undefined,
    customCert: false,
    lanMode: process.env.PORTLESS_LAN !== undefined,
    lanIp: process.env.PORTLESS_LAN_IP !== undefined,
    tld: process.env.PORTLESS_TLD !== undefined,
    useWildcard: process.env.PORTLESS_WILDCARD !== undefined,
  };
  const desiredConfig = resolveProxyConfig({
    persistedLanMode: lanMode,
    explicit,
    defaultTld: envTld,
    useHttps: !isHttpsEnvDisabled(),
    customCertPath: null,
    customKeyPath: null,
    lanMode: isLanEnvEnabled(),
    lanIp: process.env.PORTLESS_LAN_IP || null,
    tld: envTld,
    useWildcard: isWildcardEnvEnabled(),
  });
  return { explicit, desiredConfig, envTld };
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
  const { explicit, desiredConfig } = desired;

  const proxyResponsive = await isProxyRunning(proxyPort, tls);
  const proxyListeningFromStateDir =
    !!process.env.PORTLESS_STATE_DIR && (await isPortListening(proxyPort));

  if (proxyResponsive || proxyListeningFromStateDir) {
    return { started: false };
  }

  const persisted = readPersistedProxyState();
  const startConfig = { ...desiredConfig };
  let startPort: number | undefined;

  if (persisted) {
    if (!explicit.useHttps && persisted.tls !== desiredConfig.useHttps) {
      startConfig.useHttps = persisted.tls;
    }
    if (!explicit.tld && persisted.tld !== desiredConfig.tld) {
      startConfig.tld = persisted.tld;
    }
    if (!explicit.lanMode && persisted.lanMode !== desiredConfig.lanMode) {
      startConfig.lanMode = persisted.lanMode;
    }
    const envPort = getDefaultPort(startConfig.useHttps);
    if (persisted.port !== envPort) {
      startPort = persisted.port;
    }
  }

  const effectivePort = startPort ?? getDefaultPort(startConfig.useHttps);
  const needsSudo = !isWindows && effectivePort < PRIVILEGED_PORT_THRESHOLD;
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
    useWildcard: startConfig.useWildcard,
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
  tld: string,
  force: boolean,
  autoInfo?: { nameSource: string; prefix?: string; prefixSource?: string },
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
  const wantsNgrok = isEnabledEnv(process.env.PORTLESS_NGROK);
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

  if (wantsNgrok) {
    try {
      ensureNgrokAvailable();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(colors.red(`Error: ${message}`));
      if (message.includes("not found")) {
        console.error(colors.blue("Install ngrok: https://ngrok.com/download"));
      }
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
  parseHostname(name, tld);

  const ensureResult = await ensureProxyRunning(proxyPort, tls, desired);

  if (ensureResult.started) {
    proxyPort = ensureResult.state.port;
    stateDir = ensureResult.state.dir;
    tld = ensureResult.state.tld;
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
    console.log(chalk.gray("-- Proxy is running"));
  }

  // Compute hostname after auto-start so tld reflects the running proxy
  // (e.g. --lan changes tld from "localhost" to "local")
  const hostname = parseHostname(name, tld);

  if (desired.envTld !== DEFAULT_TLD && desired.envTld !== tld) {
    console.warn(
      chalk.yellow(
        `Warning: PORTLESS_TLD=${desired.envTld} but the running proxy uses .${tld}. Using .${tld}.`
      )
    );
  }

  if (lanIp) {
    console.log(chalk.gray(`-- ${hostname} (LAN: ${lanIp})`));
  } else {
    console.log(chalk.gray(`-- ${hostname} (auto-resolves to 127.0.0.1)`));
  }
  if (autoInfo) {
    const baseName = autoInfo.prefix ? name.slice(autoInfo.prefix.length + 1) : name;
    console.log(chalk.gray(`-- Name "${baseName}" (from ${autoInfo.nameSource})`));
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

  // Register route (--force kills the existing owner if any)
  let killedPid: number | undefined;
  try {
    killedPid = store.addRoute(hostname, port, process.pid, force);
  } catch (err) {
    if (err instanceof RouteConflictError) {
      console.error(colors.red(`Error: ${err.message}`));
      process.exit(1);
    }
    throw err;
  }
  if (killedPid !== undefined) {
    console.log(colors.yellow(`Killed existing process (PID ${killedPid})`));
  }

  const finalUrl = formatUrl(hostname, proxyPort, tls);
  console.log(chalk.cyan.bold(`\n  -> ${finalUrl}\n`));
  if (lanIp) {
    console.log(chalk.green(`  LAN -> ${finalUrl}`));
    console.log(chalk.gray("  (accessible from other devices on the same WiFi network)\n"));
  }

  // Tailscale sharing: register with tailscale serve (or funnel).
  // Readiness was already checked at the top of runApp().
  let tailscaleHttpsPort: number | undefined;
  let tailscaleUrl: string | undefined;
  let ngrokUrl: string | undefined;
  let ngrokProcess: Awaited<ReturnType<typeof startNgrok>> | undefined;
  let stoppingNgrok = false;
  let ngrokRouteReady = false;
  let ngrokExitHandled = false;
  let pendingNgrokExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const handleNgrokExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (stoppingNgrok || ngrokExitHandled) return;
    if (!ngrokRouteReady) {
      pendingNgrokExit = { code, signal };
      return;
    }
    ngrokExitHandled = true;
    ngrokUrl = undefined;
    console.warn(
      colors.yellow(
        `Warning: ngrok tunnel for ${hostname} stopped${formatProcessExitSuffix(
          code,
          signal
        )}. Removing its public URL from the route list.`
      )
    );
    try {
      store.updateRoute(hostname, {
        ngrokUrl: null,
        ngrokPid: null,
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
      // Non-fatal: route display metadata only
    }
  }

  if (wantsNgrok) {
    try {
      ngrokProcess = await startNgrok(port, {
        hostHeader: hostname,
        onExit: handleNgrokExit,
      });
      ngrokUrl = ngrokProcess.url;
      console.log(chalk.green(`  ngrok -> ${ngrokUrl}`));
      console.log(chalk.gray("  (accessible from the public internet via ngrok)\n"));

      try {
        store.updateRoute(hostname, {
          ngrokUrl,
          ngrokPid: ngrokProcess.pid,
        });
      } catch {
        // Non-fatal: route display metadata only
      } finally {
        ngrokRouteReady = true;
        if (pendingNgrokExit) {
          handleNgrokExit(pendingNgrokExit.code, pendingNgrokExit.signal);
          pendingNgrokExit = undefined;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(colors.red(`Error: ${message}`));
      if (message.includes("not found")) {
        console.error(colors.blue("Install ngrok: https://ngrok.com/download"));
      } else if (message.includes("authentication")) {
        console.error(colors.blue("Configure ngrok authentication:"));
        console.error(colors.cyan("  ngrok config add-authtoken <token>"));
      }
      try {
        unregisterTailscale({
          tailscaleHttpsPort,
          tailscaleFunnel: wantsFunnel || undefined,
        });
      } catch {
        // Best-effort cleanup; non-fatal
      }
      try {
        store.removeRoute(hostname, process.pid);
      } catch {
        // Best-effort cleanup; non-fatal
      }
      process.exit(1);
    }
  }

  // Child servers always bind to localhost; the proxy handles cross-device LAN access.
  // Exception: Expo in LAN mode — Metro defaults to LAN and setting HOST=127.0.0.1
  // conflicts with its internal networking, causing HMR WebSocket degradation.
  const basename = path.basename(commandArgs[0]);
  const isExpo = basename === "expo";
  const isExpoLan = isExpo && (lanMode || isLanEnvEnabled());
  const hostBind = isExpoLan ? undefined : "127.0.0.1";

  // Ensure PORTLESS_LAN is propagated to child processes when the proxy
  // was started with --lan separately and discovered from the state marker,
  // not from the env var.
  if (lanMode && !process.env.PORTLESS_LAN) {
    process.env.PORTLESS_LAN = "1";
  }

  // Inject --port for frameworks that ignore the PORT env var (e.g. Vite)
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

  spawnCommand(commandArgs, {
    env: {
      ...process.env,
      PORT: port.toString(),
      ...(hostBind ? { HOST: hostBind } : {}),
      PORTLESS_URL: finalUrl,
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `.${tld}`,
      // Note: EXPO_PACKAGER_PROXY_URL is not used — expo-dev-client removed
      // baked-in pinging, making this env var ineffective. Expo handles its
      // own LAN discovery natively.
      ...(lanMode ? { PORTLESS_LAN: "1" } : {}),
      ...(tailscaleUrl ? { PORTLESS_TAILSCALE_URL: tailscaleUrl } : {}),
      ...(ngrokUrl ? { PORTLESS_NGROK_URL: ngrokUrl } : {}),
      ...caEnv,
    },
    onCleanup: () => {
      stoppingNgrok = true;
      stopNgrokProcess(ngrokProcess?.child);
      try {
        unregisterTailscale({
          tailscaleHttpsPort,
          tailscaleFunnel: wantsFunnel || undefined,
        });
      } catch {
        // Best-effort cleanup; non-fatal
      }
      try {
        store.removeRoute(hostname, process.pid);
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
  /** The child command and its arguments, passed through untouched. */
  commandArgs: string[];
}

interface ParsedAppArgs extends ParsedRunArgs {
  /** App name. */
  name: string;
}

function parseAppPort(value: string | undefined): number {
  if (!value || value.startsWith("--")) {
    console.error(colors.red("Error: --app-port requires a port number."));
    process.exit(1);
  }
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(colors.red(`Error: Invalid app port "${value}". Must be 1-65535.`));
    process.exit(1);
  }
  return port;
}

function appPortFromEnv(): number | undefined {
  const envVal = process.env.PORTLESS_APP_PORT;
  if (!envVal) return undefined;
  const port = parseInt(envVal, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(colors.red(`Error: Invalid PORTLESS_APP_PORT="${envVal}". Must be 1-65535.`));
    process.exit(1);
  }
  return port;
}

function applySharingFlag(flag: string): boolean {
  if (flag === "--tailscale") {
    process.env.PORTLESS_TAILSCALE = "1";
    return true;
  }
  if (flag === "--funnel") {
    process.env.PORTLESS_FUNNEL = "1";
    process.env.PORTLESS_TAILSCALE = "1";
    return true;
  }
  if (flag === "--ngrok") {
    process.env.PORTLESS_NGROK = "1";
    return true;
  }
  return false;
}

/**
 * Parse `run` subcommand arguments: `[--name <name>] [--force] [--] <command...>`
 *
 * `--name`, `--force`, and `--app-port` are recognized. `--` stops flag
 * parsing. Everything after the flag region is the child command, passed
 * through untouched.
 */
function parseRunArgs(args: string[]): ParsedRunArgs {
  let force = false;
  let appPort: number | undefined;
  let name: string | undefined;
  let i = 0;

  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "--") {
      i++;
      break;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
${colors.bold("portless run")} - Infer project name and run through the proxy.

${colors.bold("Usage:")}
  ${colors.cyan("portless run [options] [command...]")}

  When no command is given, runs the configured script (default: "dev")
  from package.json.

${colors.bold("Options:")}
  --name <name>          Override the inferred base name (worktree prefix still applies)
  --force                Kill the existing process and take over its route
  --app-port <number>    Use a fixed port for the app (skip auto-assignment)
  --tailscale            Share the app on your Tailscale network (tailnet)
  --funnel               Share the app publicly via Tailscale Funnel
  --ngrok                Share the app publicly via ngrok
  --help, -h             Show this help

${colors.bold("Name inference (in order):")}
  1. portless.json "name" field
  2. package.json "name" field (walks up directories)
  3. Git repo root directory name
  4. Current directory basename

  Use --name to override the inferred name while keeping worktree prefixes.
  In git worktrees, the branch name is prepended as a subdomain prefix
  (e.g. feature-auth.myapp.localhost).

${colors.bold("Examples:")}
  portless run                        # Run dev script through proxy
  portless run next dev               # -> https://<project>.localhost
  portless run --name myapp next dev  # -> https://myapp.localhost
  portless run vite dev               # -> https://<project>.localhost
  portless run --app-port 3000 pnpm start
`);
      process.exit(0);
    } else if (args[i] === "--force") {
      force = true;
    } else if (args[i] === "--app-port") {
      i++;
      appPort = parseAppPort(args[i]);
    } else if (args[i] === "--name") {
      i++;
      if (!args[i] || args[i].startsWith("-")) {
        console.error(colors.red("Error: --name requires a name value."));
        console.error(colors.cyan("  portless run --name <name> <command...>"));
        process.exit(1);
      }
      name = args[i];
    } else if (applySharingFlag(args[i])) {
      // handled
    } else {
      console.error(colors.red(`Error: Unknown flag "${args[i]}".`));
      console.error(
        colors.blue(
          "Known flags: --name, --force, --app-port, --tailscale, --funnel, --ngrok, --help"
        )
      );
      process.exit(1);
    }
    i++;
  }

  if (!appPort) appPort = appPortFromEnv();

  return { force, appPort, name, commandArgs: args.slice(i) };
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
  let i = 0;

  // Consume leading flags before name
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "--") {
      i++;
      break;
    } else if (args[i] === "--force") {
      force = true;
    } else if (args[i] === "--app-port") {
      i++;
      appPort = parseAppPort(args[i]);
    } else if (applySharingFlag(args[i])) {
      // handled
    } else {
      console.error(colors.red(`Error: Unknown flag "${args[i]}".`));
      console.error(
        colors.blue("Known flags: --force, --app-port, --tailscale, --funnel, --ngrok")
      );
      process.exit(1);
    }
    i++;
  }

  // Next token is the app name
  const name = args[i];
  i++;

  // Allow flags immediately after name (e.g. `portless myapp --force next dev`)
  while (i < args.length && args[i].startsWith("--")) {
    if (args[i] === "--") {
      i++;
      break;
    } else if (args[i] === "--force") {
      force = true;
    } else if (args[i] === "--app-port") {
      i++;
      appPort = parseAppPort(args[i]);
    } else if (applySharingFlag(args[i])) {
      // handled
    } else {
      console.error(colors.red(`Error: Unknown flag "${args[i]}".`));
      console.error(
        colors.blue("Known flags: --force, --app-port, --tailscale, --funnel, --ngrok")
      );
      process.exit(1);
    }
    i++;
  }

  if (!appPort) appPort = appPortFromEnv();

  return { force, appPort, name, commandArgs: args.slice(i) };
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
  ${colors.cyan("portless service install")}         Start proxy automatically when the OS starts
  ${colors.cyan("portless get <name>")}              Print URL for a service (for cross-service refs)
  ${colors.cyan("portless alias <name> <port>")}     Register a static route (e.g. for Docker)
  ${colors.cyan("portless alias --remove <name>")}   Remove a static route
  ${colors.cyan("portless list")}                    Show active routes
  ${colors.cyan("portless doctor")}                  Check local portless health
  ${colors.cyan("portless trust")}                   Add local CA to system trust store
  ${colors.cyan("portless clean")}                   Remove portless state, trust entry, and hosts block
  ${colors.cyan("portless prune")}                   Kill orphaned dev servers from crashed sessions
  ${colors.cyan("portless hosts sync")}              Add routes to ${HOSTS_DISPLAY} (fixes Safari)
  ${colors.cyan("portless hosts clean")}             Remove portless entries from ${HOSTS_DISPLAY}

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
  5. Frameworks that ignore PORT (Vite, VitePlus, Astro, React Router, Angular,
     Expo, React Native) get --port and, when needed, --host flags
     injected automatically

${colors.bold("HTTP/2 + HTTPS (default):")}
  HTTPS with HTTP/2 multiplexing is enabled by default (faster page loads).
  On first use, portless generates a local CA and adds it to your
  system trust store. No browser warnings. Disable with --no-tls.

${colors.bold("LAN mode:")}
  Use --lan to make services accessible from other devices (phones,
  tablets) on the same WiFi network via mDNS (.local domains).
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

${colors.bold("Options:")}
  run [--name <name>] <cmd>      Infer project name (or override with --name)
                                Adds worktree prefix in git worktrees
  --script <name>               Run a specific package.json script (default: dev)
  -p, --port <number>           Port for the proxy (default: 443, or 80 with --no-tls)
                                Standard ports auto-elevate with sudo on macOS/Linux
  --no-tls                      Disable HTTPS (use plain HTTP on port 80)
  --https                       Enable HTTPS (default, accepted for compatibility)
  --lan                         Enable LAN mode (mDNS .local, for real device testing)
  --ip <address>                Pin a specific LAN IP (disables auto-follow; use with --lan)
  --cert <path>                 Use a custom TLS certificate
  --key <path>                  Use a custom TLS private key
  --foreground                  Run proxy in foreground (for debugging)
  --tld <tld>                   Use a custom TLD instead of .localhost (e.g. test, dev)
  --wildcard                    Allow unregistered subdomains to fall back to parent route
  --state-dir <path>            Use a custom state directory with service install
  --app-port <number>           Use a fixed port for the app (skip auto-assignment)
  --tailscale                   Share the app on your Tailscale network (tailnet)
  --funnel                      Share the app publicly via Tailscale Funnel
  --ngrok                       Share the app publicly via ngrok
  --force                       Kill the existing process and take over its route
  --name <name>                 Use <name> as the app name (bypasses subcommand dispatch)
  --                            Stop flag parsing; everything after is passed to the child

${colors.bold("Environment variables:")}
  PORTLESS_PORT=<number>        Override the default proxy port (e.g. in .bashrc)
  PORTLESS_APP_PORT=<number>    Use a fixed port for the app (same as --app-port)
  PORTLESS_HTTPS=0              Disable HTTPS (same as --no-tls)
  PORTLESS_LAN=1                Enable LAN mode when set to 1 (set in .bashrc / .zshrc)
  PORTLESS_LAN_IP=<address>     Pin a specific LAN IP for LAN mode
  PORTLESS_TLD=<tld>            Use a custom TLD (e.g. test, dev; default: localhost)
  PORTLESS_WILDCARD=1           Allow unregistered subdomains to fall back to parent route
  PORTLESS_SYNC_HOSTS=0         Disable auto-sync of ${HOSTS_DISPLAY} (on by default)
  PORTLESS_TAILSCALE=1          Share apps on your Tailscale network (same as --tailscale)
  PORTLESS_FUNNEL=1             Share apps publicly via Tailscale Funnel (same as --funnel)
  PORTLESS_NGROK=1              Share apps publicly via ngrok (same as --ngrok)
  PORTLESS_STATE_DIR=<path>     Override the state directory
  PORTLESS=0                    Run command directly without proxy

${colors.bold("Child process environment:")}
  PORT                          Ephemeral port the child should listen on
  HOST                          Usually 127.0.0.1 (omitted for Expo in LAN mode)
  PORTLESS_URL                  Public URL of the app (e.g. https://myapp.localhost)
  PORTLESS_LAN                  Set to 1 when proxy is in LAN mode
  PORTLESS_TAILSCALE_URL        Tailscale URL of the app (when --tailscale is active)
  PORTLESS_NGROK_URL            ngrok URL of the app (when --ngrok is active)
  NODE_EXTRA_CA_CERTS           Path to the portless CA (set when HTTPS is active)

${colors.bold("Safari / DNS:")}
  .localhost subdomains auto-resolve in Chrome, Firefox, and Edge.
  Safari relies on the system DNS resolver, which may not handle them.
  Auto-syncs ${HOSTS_DISPLAY} for route hostnames by default (including .localhost,
  custom TLDs, and LAN .local). Set PORTLESS_SYNC_HOSTS=0 to disable. To manually sync:
    ${colors.cyan("portless hosts sync")}
  Clean up later with:
    ${colors.cyan("portless hosts clean")}

${colors.bold("Skip portless:")}
  PORTLESS=0 pnpm dev           # Runs command directly without proxy

${colors.bold("Reserved names:")}
  run, get, alias, hosts, list, doctor, trust, clean, prune, proxy, service are subcommands and
  cannot be used as app names directly. Use "portless run" to infer the name,
  or "portless --name <name>" to force any name including reserved ones.
`);
  process.exit(0);
}

function printVersion(): void {
  console.log(__VERSION__);
  process.exit(0);
}

async function handleTrust(): Promise<void> {
  const { dir } = await discoverState();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const { caGenerated } = ensureCerts(dir);
  if (caGenerated) {
    console.log(colors.gray("Generated local CA certificate."));
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

async function handleClean(args: string[]): Promise<void> {
  if (args[1] === "--help" || args[1] === "-h") {
    console.log(`
${colors.bold("portless clean")} - Remove portless artifacts from this machine.

Stops the proxy if it is running, uninstalls the startup service if installed,
removes the local CA from the OS trust store when it was installed by portless,
deletes known files under state directories (~/.portless, the system state
directory, and PORTLESS_STATE_DIR when set), and removes the portless block
from ${HOSTS_DISPLAY}.

Only allowlisted filenames under each state directory are deleted. Custom
certificate paths from --cert and --key are never removed.

macOS/Linux may prompt for sudo when the proxy, trust store, or ${HOSTS_DISPLAY}
require elevated privileges. On Windows, run as Administrator if needed.

${colors.bold("Usage:")}
  ${colors.cyan("portless clean")}

${colors.bold("Options:")}
  --help, -h             Show this help
`);
    process.exit(0);
  }

  if (args.length > 1) {
    console.error(colors.red(`Error: Unknown argument "${args[1]}".`));
    console.error(colors.cyan("  portless clean --help"));
    process.exit(1);
  }

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
    if (route.ngrokPid) {
      stopNgrok(route);
      console.log(colors.green(`Stopped ngrok tunnel for ${route.hostname}.`));
    }
  }

  const stateDirs = collectStateDirsForCleanup();
  for (const stateDir of stateDirs) {
    const caPath = path.join(stateDir, "ca.pem");
    if (!fs.existsSync(caPath)) continue;
    const wasTrusted = isCATrusted(stateDir);
    if (!wasTrusted) continue;
    const untrustResult = untrustCA(stateDir);
    if (untrustResult.removed) {
      console.log(colors.green("Removed local CA from the system trust store."));
    } else if (untrustResult.error) {
      console.warn(
        colors.yellow(
          `Could not remove CA from trust store: ${untrustResult.error}\n` +
            `Try: sudo portless clean (Linux), or delete the certificate manually.`
        )
      );
    }
  }

  for (const stateDir of stateDirs) {
    removePortlessStateFiles(stateDir);
  }
  console.log(colors.green("Removed portless state files from known state directories."));

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

async function handlePrune(args: string[]): Promise<void> {
  if (args[1] === "--help" || args[1] === "-h") {
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
    process.exit(0);
  }

  const forceKill = args.includes("--force");

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
    if (route.ngrokPid) {
      stopNgrok(route);
      console.log(`  ${route.hostname} - stopped ngrok tunnel`);
    }
  }

  let killed = 0;
  for (const route of stale) {
    const pids = findPidsOnPort(route.port);
    if (pids.length === 0) {
      console.log(`  ${route.hostname} :${route.port} - route removed (port already free)`);
      continue;
    }
    const signal = forceKill ? "SIGKILL" : "SIGTERM";
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

async function handleList(): Promise<void> {
  const { dir, port, tls } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });
  listRoutes(store, port, tls);
}

async function handleGet(args: string[]): Promise<void> {
  if (args[1] === "--help" || args[1] === "-h") {
    console.log(`
${colors.bold("portless get")} - Print the URL for a service.

${colors.bold("Usage:")}
  ${colors.cyan("portless get <name>")}

Constructs the URL using the same hostname and worktree logic as
"portless run", then prints it to stdout. Useful for wiring services
together:

  BACKEND_URL=$(portless get backend)

${colors.bold("Options:")}
  --no-worktree          Skip worktree prefix detection
  --help, -h             Show this help

${colors.bold("Examples:")}
  portless get backend                  # -> https://backend.localhost
  portless get backend                  # in worktree -> https://auth.backend.localhost
  portless get backend --no-worktree    # -> https://backend.localhost (skip worktree)
`);
    process.exit(0);
  }

  let skipWorktree = false;
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--no-worktree") {
      skipWorktree = true;
    } else if (args[i].startsWith("-")) {
      console.error(colors.red(`Error: Unknown flag "${args[i]}".`));
      console.error(colors.blue("Known flags: --no-worktree, --help"));
      process.exit(1);
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length === 0) {
    console.error(colors.red("Error: Missing service name."));
    console.error(colors.blue("Usage:"));
    console.error(colors.cyan("  portless get <name>"));
    console.error(colors.blue("Example:"));
    console.error(colors.cyan("  portless get backend"));
    process.exit(1);
  }

  const name = positional[0];
  const worktree = skipWorktree ? null : detectWorktreePrefix();
  const effectiveName = worktree ? `${worktree.prefix}.${name}` : name;

  const { port, tls, tld } = await discoverState();
  const hostname = parseHostname(effectiveName, tld);
  const url = formatUrl(hostname, port, tls);
  // Print bare URL to stdout so it works in $(portless get <name>)
  process.stdout.write(url + "\n");
}

async function handleAlias(args: string[]): Promise<void> {
  if (args[1] === "--help" || args[1] === "-h") {
    console.log(`
${colors.bold("portless alias")} - Register a static route for services not managed by portless.

${colors.bold("Usage:")}
  ${colors.cyan("portless alias <name> <port>")}        Register a route
  ${colors.cyan("portless alias --remove <name>")}      Remove a route
  ${colors.cyan("portless alias <name> <port> --force")} Override existing route

${colors.bold("Examples:")}
  portless alias my-postgres 5432     # -> https://my-postgres.localhost
  portless alias redis 6379           # -> https://redis.localhost
  portless alias --remove my-postgres # Remove the alias
`);
    process.exit(0);
  }

  const { dir, tld } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });

  if (args[1] === "--remove") {
    const aliasName = args[2];
    if (!aliasName) {
      console.error(colors.red("Error: No alias name provided."));
      console.error(colors.cyan("  portless alias --remove <name>"));
      process.exit(1);
    }
    const hostname = parseHostname(aliasName, tld);
    const routes = store.loadRoutes();
    const existing = routes.find((r) => r.hostname === hostname && r.pid === 0);
    if (!existing) {
      console.error(colors.red(`Error: No alias found for "${hostname}".`));
      process.exit(1);
    }
    store.removeRoute(hostname);
    console.log(colors.green(`Removed alias: ${hostname}`));
    return;
  }

  const aliasName = args[1];
  const aliasPort = args[2];
  if (!aliasName || !aliasPort) {
    console.error(colors.red("Error: Missing arguments."));
    console.error(colors.blue("Usage:"));
    console.error(colors.cyan("  portless alias <name> <port>"));
    console.error(colors.cyan("  portless alias --remove <name>"));
    console.error(colors.blue("Example:"));
    console.error(colors.cyan("  portless alias my-postgres 5432"));
    process.exit(1);
  }

  const hostname = parseHostname(aliasName, tld);
  const port = parseInt(aliasPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(colors.red(`Error: Invalid port "${aliasPort}". Must be 1-65535.`));
    process.exit(1);
  }

  const force = args.includes("--force");
  store.addRoute(hostname, port, 0, force);
  console.log(colors.green(`Alias registered: ${hostname} -> 127.0.0.1:${port}`));
}

async function handleHosts(args: string[]): Promise<void> {
  if (args[1] === "--help" || args[1] === "-h") {
    console.log(`
${colors.bold("portless hosts")} - Manage ${HOSTS_DISPLAY} entries for .localhost subdomains.

Safari relies on the system DNS resolver, which may not handle .localhost
subdomains. This command adds entries to ${HOSTS_DISPLAY} as a workaround.

${colors.bold("Usage:")}
  ${colors.cyan("portless hosts sync")}    Add current routes to ${HOSTS_DISPLAY}
  ${colors.cyan("portless hosts clean")}   Remove portless entries from ${HOSTS_DISPLAY}

${colors.bold("Auto-sync:")}
  The proxy updates ${HOSTS_DISPLAY} for route hostnames by default. Disable with
  PORTLESS_SYNC_HOSTS=0.
`);
    process.exit(0);
  }

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

  if (!args[1]) {
    console.log(`
${colors.bold("Usage: portless hosts <command>")}

  ${colors.cyan("portless hosts sync")}    Add current routes to ${HOSTS_DISPLAY}
  ${colors.cyan("portless hosts clean")}   Remove portless entries from ${HOSTS_DISPLAY}
`);
    process.exit(0);
  }

  if (args[1] !== "sync") {
    console.error(colors.red(`Error: Unknown hosts subcommand "${args[1]}".`));
    console.error(colors.blue("Usage:"));
    console.error(colors.cyan(`  portless hosts sync    # Add routes to ${HOSTS_DISPLAY}`));
    console.error(colors.cyan("  portless hosts clean   # Remove portless entries"));
    process.exit(1);
  }

  const { dir } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(colors.yellow(msg)),
  });

  const routes = store.loadRoutes();
  if (routes.length === 0) {
    console.log(colors.yellow("No active routes to sync."));
    return;
  }
  const hostnames = routes.map((r) => r.hostname);
  if (syncHostsFile(hostnames)) {
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

async function handleDoctor(args: string[]): Promise<void> {
  if (args[1] === "--help" || args[1] === "-h") {
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
    process.exit(0);
  }

  if (args.length > 1) {
    console.error(colors.red(`Error: Unknown argument "${args[1]}".`));
    console.error(colors.cyan("  portless doctor --help"));
    process.exit(1);
  }

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
  console.log(`Mode: ${proxyTls ? "HTTPS" : "HTTP"}, .${state.tld}${state.lanMode ? ", LAN" : ""}`);
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

async function handleProxy(args: string[]): Promise<void> {
  if (args[1] === "stop") {
    let explicitPort: number | undefined;
    const portIdx = args.indexOf("--port") !== -1 ? args.indexOf("--port") : args.indexOf("-p");
    if (portIdx !== -1) {
      const portValue = args[portIdx + 1];
      if (portValue && !portValue.startsWith("-")) {
        const parsed = parseInt(portValue, 10);
        if (!isNaN(parsed) && parsed >= 1 && parsed <= 65535) {
          explicitPort = parsed;
        }
      }
    }

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

  const isProxyHelp = args[1] === "--help" || args[1] === "-h";
  if (isProxyHelp || args[1] !== "start") {
    console.log(`
${colors.bold("portless proxy")} - Manage the portless proxy server.

${colors.bold("Usage:")}
  ${colors.cyan("portless proxy start")}                Start the HTTPS proxy on port 443 (daemon)
  ${colors.cyan("portless proxy start --no-tls")}       Start without HTTPS (port 80)
  ${colors.cyan("portless proxy start --lan")}          Enable LAN mode (mDNS, .local TLD)
  ${colors.cyan("portless proxy start --foreground")}   Start in foreground (for debugging)
  ${colors.cyan("portless proxy start -p 1355")}        Start on a custom port (no sudo)
  ${colors.cyan("portless proxy start --tld test")}     Use .test instead of .localhost
  ${colors.cyan("portless proxy start --wildcard")}     Allow unregistered subdomains to fall back to parent
  ${colors.cyan("portless proxy stop")}                 Stop the proxy

${colors.bold("LAN mode (--lan):")}
  Makes services accessible from other devices on the same WiFi network
  via mDNS (.local domains). Useful for testing on real mobile devices.
  Auto-detects your LAN IP and follows changes automatically, or use
  --ip to pin one.
  Stopped LAN proxies keep LAN mode for the next start via proxy.lan.
  Use PORTLESS_LAN=0 for one start to switch back to .localhost mode.
`);
    process.exit(isProxyHelp || !args[1] ? 0 : 1);
  }

  const isForeground = args.includes("--foreground");
  const skipTrust = args.includes("--skip-trust");

  // HTTPS is on by default. Disable with --no-tls or PORTLESS_HTTPS=0.
  const hasHttpsFlag = args.includes("--https");
  const hasNoTls = args.includes("--no-tls") || isHttpsEnvDisabled();
  const wantHttps = !hasNoTls;

  // Parse optional --cert / --key for custom certificates
  let customCertPath: string | null = null;
  let customKeyPath: string | null = null;
  const certIdx = args.indexOf("--cert");
  if (certIdx !== -1) {
    customCertPath = args[certIdx + 1] || null;
    if (!customCertPath || customCertPath.startsWith("-")) {
      console.error(colors.red("Error: --cert requires a file path."));
      process.exit(1);
    }
  }
  const keyIdx = args.indexOf("--key");
  if (keyIdx !== -1) {
    customKeyPath = args[keyIdx + 1] || null;
    if (!customKeyPath || customKeyPath.startsWith("-")) {
      console.error(colors.red("Error: --key requires a file path."));
      process.exit(1);
    }
  }
  if ((customCertPath && !customKeyPath) || (!customCertPath && customKeyPath)) {
    console.error(colors.red("Error: --cert and --key must be used together."));
    process.exit(1);
  }

  // Custom cert/key implies HTTPS
  let useHttps = wantHttps || !!(customCertPath && customKeyPath);

  // Parse --port / -p flag. When not set, default to the protocol-standard
  // port (443 for HTTPS, 80 for HTTP) so URLs are clean.
  let hasExplicitPort = false;
  let proxyPort = getDefaultPort(useHttps);
  let portFlagIndex = args.indexOf("--port");
  if (portFlagIndex === -1) portFlagIndex = args.indexOf("-p");
  if (portFlagIndex !== -1) {
    const portValue = args[portFlagIndex + 1];
    if (!portValue || portValue.startsWith("-")) {
      console.error(colors.red("Error: --port / -p requires a port number."));
      console.error(colors.blue("Usage:"));
      console.error(colors.cyan("  portless proxy start -p 8080"));
      process.exit(1);
    }
    proxyPort = parseInt(portValue, 10);
    if (isNaN(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      console.error(colors.red(`Error: Invalid port number: ${portValue}`));
      console.error(colors.blue("Port must be between 1 and 65535."));
      process.exit(1);
    }
    hasExplicitPort = true;
  }

  // Parse --tld flag
  let tld: string;
  try {
    tld = getDefaultTld();
  } catch (err) {
    console.error(colors.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
  const tldIdx = args.indexOf("--tld");
  if (tldIdx !== -1) {
    const tldValue = args[tldIdx + 1];
    if (!tldValue || tldValue.startsWith("-")) {
      console.error(colors.red("Error: --tld requires a TLD value (e.g. test, localhost)."));
      process.exit(1);
    }
    tld = tldValue.trim().toLowerCase();
    const tldErr = validateTld(tld);
    if (tldErr) {
      console.error(colors.red(`Error: ${tldErr}`));
      process.exit(1);
    }
  }
  // Parse --wildcard flag (disables the default strict subdomain matching)
  const useWildcard = args.includes("--wildcard") || isWildcardEnvEnabled();

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
    tld: tldIdx !== -1 || process.env.PORTLESS_TLD !== undefined,
    useWildcard: args.includes("--wildcard") || process.env.PORTLESS_WILDCARD !== undefined,
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
    explicit,
    defaultTld: getDefaultTld(),
    useHttps: wantHttps || !!(customCertPath && customKeyPath),
    customCertPath,
    customKeyPath,
    lanMode: isLanEnvEnabled(),
    lanIp: process.env.PORTLESS_LAN_IP || null,
    tld,
    useWildcard,
  });
  const lanMode = desiredConfig.lanMode;
  useHttps = desiredConfig.useHttps;
  customCertPath = desiredConfig.customCertPath;
  customKeyPath = desiredConfig.customKeyPath;
  tld = desiredConfig.tld;
  const desiredWildcard = desiredConfig.useWildcard;
  let lanIp: string | null = desiredConfig.lanIpExplicit ? desiredConfig.lanIp : null;

  if (!hasExplicitPort && runningPort === null) {
    proxyPort = getDefaultPort(useHttps);
    stateDir = resolveStateDir(proxyPort);
  }

  if (lanMode && tldIdx !== -1) {
    const userTld = args[tldIdx + 1];
    if (userTld && userTld !== "local") {
      console.warn(
        chalk.yellow(
          `Warning: --lan forces .local TLD (mDNS requirement). Ignoring --tld ${userTld}.`
        )
      );
    }
  }

  const riskyReason = RISKY_TLDS.get(tld);
  if (riskyReason && !lanMode) {
    console.warn(colors.yellow(`Warning: .${tld}: ${riskyReason}`));
  }

  const syncDisabled =
    process.env.PORTLESS_SYNC_HOSTS === "0" || process.env.PORTLESS_SYNC_HOSTS === "false";
  if (tld !== DEFAULT_TLD && !lanMode && syncDisabled) {
    console.warn(
      colors.yellow(
        `Warning: .${tld} domains require ${HOSTS_DISPLAY} entries to resolve to 127.0.0.1.`
      )
    );
    console.warn(colors.yellow("Hosts sync is disabled. To add entries manually, run:"));
    console.warn(colors.cyan("  portless hosts sync"));
  }

  let store = new RouteStore(stateDir, {
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
    useWildcard: desiredWildcard,
  };

  // Privileged ports require root on Unix. Auto-elevate with sudo when
  // possible, falling back to the unprivileged port when sudo is unavailable.
  if (!isWindows && proxyPort < PRIVILEGED_PORT_THRESHOLD && (process.getuid?.() ?? -1) !== 0) {
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
        useWildcard: desiredWildcard,
        foreground: isForeground,
        includePort: true,
        proxyPort,
      }).args,
    ];
    const fallbackCommand = formatProxyStartCommand(FALLBACK_PROXY_PORT, resolvedConfig);
    const currentCommand = formatProxyStartCommand(proxyPort, resolvedConfig);

    console.log(
      colors.yellow(`Port ${proxyPort} requires elevated privileges. Requesting sudo...`)
    );
    if (!hasExplicitPort) {
      console.log(colors.gray(`(To skip sudo, use an unprivileged port: ${fallbackCommand})`));
    }
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

    if (result.signal) {
      process.exit(1);
    }

    // sudo failed: fall back to the unprivileged port if the user didn't
    // explicitly request a privileged one.
    if (!hasExplicitPort) {
      proxyPort = FALLBACK_PROXY_PORT;
      console.log(colors.yellow(`Falling back to port ${proxyPort}.`));
      console.log(
        colors.blue(`For clean URLs without port numbers, re-run and accept the sudo prompt:`)
      );
      console.log(colors.cyan(`  ${fallbackCommand}`));

      if (await isProxyRunning(proxyPort)) {
        console.log(colors.yellow(`Proxy is already running on port ${proxyPort}.`));
        return;
      }

      // Re-initialize state for the fallback port and fall through to the
      // normal startup path below.
      stateDir = resolveStateDir(proxyPort);
      store = new RouteStore(stateDir, {
        onWarning: (msg: string) => console.warn(colors.yellow(msg)),
      });
    } else {
      // Explicit port was requested but sudo failed; error out.
      console.error(
        colors.red(`Error: Port ${proxyPort} requires elevated privileges and sudo failed.`)
      );
      console.error(colors.blue("Try again (portless will prompt for sudo):"));
      console.error(colors.cyan(`  ${currentCommand}`));
      process.exit(1);
    }
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

      if (!skipTrust && !isCATrusted(stateDir)) {
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
        SNICallback: createSNICallback(stateDir, cert, key, tld, ca),
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
      tlsOptions,
      lanIp,
      desiredWildcard ? false : undefined,
      !!(customCertPath && customKeyPath)
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
        useWildcard: desiredWildcard,
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
  if (lanMode && lanIp) {
    console.log(chalk.green(`LAN mode active. IP: ${lanIp}`));
    console.log(chalk.gray("Services will be discoverable as <name>.local on your network."));
  }
}

/**
 * Load the effective AppConfig for the current directory from portless.json.
 * Handles both single-app (top-level fields) and monorepo (apps map) configs.
 */
function loadAppConfig(cwd: string = process.cwd()): AppConfig | null {
  try {
    const loaded = loadConfig(cwd);
    if (!loaded) return null;
    return resolveAppConfig(loaded.config, loaded.configDir, cwd);
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
  appConfig: AppConfig | null
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
    nameSource = "portless.json";
  } else {
    const inferred = inferProjectName(cwd);
    baseName = inferred.name;
    nameSource = inferred.source;
  }

  const worktree = detectWorktreePrefix(cwd);
  const effectiveName = worktree ? `${worktree.prefix}.${baseName}` : baseName;

  const { dir, port, tls, tld, lanMode, lanIp } = await discoverState();
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
    tld,
    false,
    { nameSource, prefix: worktree?.prefix, prefixSource: worktree?.source },
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
  tld: string,
  exitCodes: Map<string, number | null>
): Promise<{
  child: ReturnType<typeof spawn>;
  displayUrl: string;
  route: { store: RouteStore; hostname: string } | null;
}> {
  const usesPortless = app.commandArgs[0] === "portless";

  const pkgEnv: Record<string, string | undefined> = { ...process.env };
  pkgEnv.PATH = augmentedPath(pkgEnv, app.pkg.dir);

  let env: Record<string, string | undefined>;
  let store: RouteStore | null = null;
  let hostname: string | null = null;
  let displayUrl: string;

  if (usesPortless) {
    env = pkgEnv;
    displayUrl = "(managed by portless)";
  } else {
    store = new RouteStore(stateDir, {
      onWarning: (msg) => console.warn(colors.yellow(`[${app.name}] ${msg}`)),
    });

    const appPort = app.appPort ?? (await findFreePort());
    const protocol = tls ? "https" : "http";
    const portSuffix =
      (tls && proxyPort === 443) || (!tls && proxyPort === 80) ? "" : `:${proxyPort}`;
    const url = `${protocol}://${app.name}.${tld}${portSuffix}`;
    displayUrl = url;

    hostname = parseHostname(app.name, tld);
    store.addRoute(hostname, appPort, process.pid);

    env = {
      ...pkgEnv,
      PORT: String(appPort),
      HOST: "127.0.0.1",
      PORTLESS_URL: url,
    };

    if (tls) {
      const caPath = path.join(stateDir, "ca.pem");
      if (fs.existsSync(caPath)) {
        env.NODE_EXTRA_CA_CERTS = caPath;
      }
    }
  }

  const child = spawnChildProcess(app.commandArgs, env, app.pkg.dir);
  pipeOutput(child, chalk.cyan(`[${app.name}]`));

  const capturedStore = store;
  const capturedHostname = hostname;
  child.on("exit", (code, signal) => {
    exitCodes.set(app.name, code);
    if (code !== 0 && code !== null) {
      console.error(colors.red(`[${app.name}] exited with code ${code}`));
    } else if (signal) {
      console.error(colors.yellow(`[${app.name}] killed by ${signal}`));
    }
    if (capturedStore && capturedHostname) {
      try {
        capturedStore.removeRoute(capturedHostname, process.pid);
      } catch {
        // non-fatal
      }
    }
  });

  const route = store && hostname ? { store, hostname } : null;
  return { child, displayUrl, route };
}

function spawnTaskApp(
  app: MultiAppEntry,
  exitCodes: Map<string, number | null>
): ReturnType<typeof spawn> {
  const pkgEnv: Record<string, string | undefined> = { ...process.env };
  pkgEnv.PATH = augmentedPath(pkgEnv, app.pkg.dir);

  const child = spawnChildProcess(app.commandArgs, pkgEnv, app.pkg.dir);
  pipeOutput(child, chalk.gray(`[${app.name}]`));

  child.on("exit", (code, signal) => {
    exitCodes.set(app.name, code);
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

  for (const pkg of packages) {
    const rel = path.relative(wsRoot, pkg.dir).replace(/\\/g, "/");
    const rootOverride = loaded ? resolveAppConfig(loaded.config, loaded.configDir, pkg.dir) : null;
    let pkgConfig: AppConfig | null;
    try {
      pkgConfig = loadPackagePortlessConfig(pkg.dir);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        console.error(colors.red(`Error: ${err.message}`));
        process.exit(1);
      }
      throw err;
    }

    // Merge (closest wins): package.json "portless" > portless.json app entry > defaults
    const appOverride: AppConfig = {
      ...Object.fromEntries(Object.entries(rootOverride ?? {}).filter(([, v]) => v !== undefined)),
      ...Object.fromEntries(Object.entries(pkgConfig ?? {}).filter(([, v]) => v !== undefined)),
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

  let { dir, port, tls, tld } = await discoverState();

  if (proxiedApps.length > 0) {
    let multiDesired: ProxyDesiredState;
    try {
      multiDesired = resolveProxyDesiredState(false);
    } catch (err) {
      console.error(colors.red(`Error: ${(err as Error).message}`));
      process.exit(1);
    }
    const ensureResult = await ensureProxyRunning(port, tls, multiDesired);
    if (ensureResult.started) {
      dir = ensureResult.state.dir;
      port = ensureResult.state.port;
      tls = ensureResult.state.tls;
      tld = ensureResult.state.tld;
    } else {
      // Proxy was already running; re-discover to pick up current state.
      ({ dir, port, tls, tld } = await discoverState());
    }

    if (tls && !isCATrusted(dir)) {
      await handleTrust();
    }
  }

  const useTurbo = loaded?.config.turbo !== false && hasTurboConfig(wsRoot);

  if (useTurbo) {
    await runWithTurbo(wsRoot, dir, port, tls, tld, scriptName, proxiedApps, taskApps, extraArgs);
  } else {
    await runWithDirectSpawn(dir, port, tls, tld, proxiedApps, taskApps);
  }
}

async function runWithTurbo(
  wsRoot: string,
  stateDir: string,
  proxyPort: number,
  tls: boolean,
  tld: string,
  scriptName: string,
  proxiedApps: MultiAppEntry[],
  taskApps: MultiAppEntry[],
  extraArgs: string[] = []
): Promise<void> {
  const store = new RouteStore(stateDir, {
    onWarning: (msg: string) => console.warn(colors.yellow(msg)),
  });

  const manifest: Record<string, ManifestEntry> = {};
  const routes: { hostname: string }[] = [];
  const appUrls: { label: string; url: string }[] = [];

  for (const app of proxiedApps) {
    const usesPortless = app.commandArgs[0] === "portless";
    if (usesPortless) {
      appUrls.push({ label: app.label, url: "(managed by portless)" });
      continue;
    }

    const appPort = app.appPort ?? (await findFreePort());
    const protocol = tls ? "https" : "http";
    const portSuffix =
      (tls && proxyPort === 443) || (!tls && proxyPort === 80) ? "" : `:${proxyPort}`;
    const url = `${protocol}://${app.name}.${tld}${portSuffix}`;
    appUrls.push({ label: app.label, url });

    const hostname = parseHostname(app.name, tld);
    store.addRoute(hostname, appPort, process.pid);
    routes.push({ hostname });

    const entry: ManifestEntry = {
      PORT: String(appPort),
      HOST: "127.0.0.1",
      PORTLESS_URL: url,
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

  const turboChild = spawn(turboArgs[0], turboArgs.slice(1), {
    stdio: "inherit",
    cwd: wsRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: buildNodeOptions(),
    },
    ...(isWindows ? {} : { detached: true }),
  });

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

    for (const { hostname } of routes) {
      try {
        store.removeRoute(hostname, process.pid);
      } catch {
        // non-fatal
      }
    }
    removeManifest();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

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
  tld: string,
  proxiedApps: MultiAppEntry[],
  taskApps: MultiAppEntry[]
): Promise<void> {
  const children: ReturnType<typeof spawn>[] = [];
  const exitCodes = new Map<string, number | null>();
  const appUrls: { label: string; url: string }[] = [];
  const routeEntries: { store: RouteStore; hostname: string }[] = [];

  // Sequential: each spawnProxiedApp calls findFreePort() which binds/releases
  // a port, so parallel spawning could cause port collisions.
  for (const app of proxiedApps) {
    const { child, displayUrl, route } = await spawnProxiedApp(
      app,
      stateDir,
      proxyPort,
      tls,
      tld,
      exitCodes
    );
    children.push(child);
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

    for (const { store, hostname } of routeEntries) {
      try {
        store.removeRoute(hostname, process.pid);
      } catch {
        // non-fatal
      }
    }
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          child.on("exit", () => resolve());
        })
    )
  );

  const failed = [...exitCodes.entries()].filter(([, code]) => code !== 0 && code !== null);
  if (failed.length > 0) {
    console.error(
      colors.red(
        `\n${failed.length} app${failed.length === 1 ? "" : "s"} exited with errors: ${failed.map(([name, code]) => `${name} (${code})`).join(", ")}`
      )
    );
    process.exit(1);
  }
}

async function handleRunMode(args: string[], globalScript?: string): Promise<void> {
  const parsed = parseRunArgs(args);

  const appConfig = loadAppConfig();

  if (parsed.commandArgs.length === 0) {
    const scriptName = globalScript ?? appConfig?.script ?? "dev";
    const resolved = resolveScriptCommand(scriptName, process.cwd());
    if (resolved) {
      parsed.commandArgs = resolved;
    }
  }

  if (parsed.commandArgs.length === 0) {
    console.error(colors.red("Error: No command provided."));
    console.error(colors.blue("Usage:"));
    console.error(colors.cyan("  portless run <command...>"));
    console.error(colors.blue("Example:"));
    console.error(colors.cyan("  portless run next dev"));
    process.exit(1);
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
    nameSource = "portless.json";
  } else {
    const inferred = inferProjectName();
    baseName = inferred.name;
    nameSource = inferred.source;
  }

  if (!parsed.appPort && appConfig?.appPort) {
    parsed.appPort = appConfig.appPort;
  }

  const worktree = detectWorktreePrefix();
  const effectiveName = worktree ? `${worktree.prefix}.${baseName}` : baseName;

  const { dir, port, tls, tld, lanMode, lanIp } = await discoverState();
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
    tld,
    parsed.force,
    { nameSource, prefix: worktree?.prefix, prefixSource: worktree?.source },
    parsed.appPort,
    lanMode,
    lanIp
  );
}

async function handleNamedMode(args: string[]): Promise<void> {
  const parsed = parseAppArgs(args);

  if (parsed.commandArgs.length === 0) {
    console.error(colors.red("Error: No command provided."));
    console.error(colors.blue("Usage:"));
    console.error(colors.cyan("  portless <name> <command...>"));
    console.error(colors.blue("Example:"));
    console.error(colors.cyan("  portless myapp next dev"));
    process.exit(1);
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

  const { dir, port, tls, tld, lanMode, lanIp } = await discoverState();
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
    tld,
    parsed.force,
    undefined,
    parsed.appPort,
    lanMode,
    lanIp
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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

  // --lan / --ip / --lan-ip-auto: global flags that enable LAN mode.
  // Strip from args and convert to env vars so all downstream code paths
  // see them regardless of where the user placed them (e.g.
  // `portless --lan run ...`, `portless proxy start --lan`).
  // Only scan before the `--` separator to avoid consuming flags meant
  // for the child command (e.g. `portless run tool -- --ip 0.0.0.0`).
  //
  // Helper: find a flag before `--`, strip it (and optionally its value)
  // from args, and return the value (or true for boolean flags).
  const stripGlobalFlag = (flag: string, hasValue: boolean): string | boolean | null => {
    const sep = args.indexOf("--");
    const end = sep === -1 ? args.length : sep;
    const idx = args.indexOf(flag);
    if (idx === -1 || idx >= end) return null;
    if (!hasValue) {
      args.splice(idx, 1);
      return true;
    }
    const value = args[idx + 1];
    if (!value || value.startsWith("-")) return false; // present but missing value
    args.splice(idx, 2);
    return value;
  };

  if (stripGlobalFlag("--lan", false)) {
    process.env.PORTLESS_LAN = "1";
  }

  const ipResult = stripGlobalFlag("--ip", true);
  if (ipResult === false) {
    console.error(chalk.red("Error: --ip requires an IP address."));
    console.error(chalk.cyan("  portless --lan --ip 192.168.1.42 run <command>"));
    process.exit(1);
  } else if (typeof ipResult === "string") {
    process.env.PORTLESS_LAN_IP = ipResult;
    process.env.PORTLESS_LAN = "1";
  }

  const autoIpResult = stripGlobalFlag(INTERNAL_LAN_IP_FLAG, true);
  if (autoIpResult === false) {
    console.error(chalk.red(`Error: ${INTERNAL_LAN_IP_FLAG} requires an IP address.`));
    process.exit(1);
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

  // --script flag: override the default "dev" script for zero-arg mode.
  const scriptResult = stripGlobalFlag("--script", true);
  if (scriptResult === false) {
    console.error(colors.red("Error: --script requires a script name."));
    console.error(colors.cyan("  portless --script start"));
    process.exit(1);
  }
  const globalScript = typeof scriptResult === "string" ? scriptResult : undefined;

  // --name flag: treat the next arg as an explicit app name, bypassing
  // subcommand dispatch. Useful when the app name collides with a reserved
  // subcommand (run, alias, hosts, list, doctor, trust, clean, prune, proxy, service).
  if (args[0] === "--name") {
    args.shift();
    if (!args[0]) {
      console.error(colors.red("Error: --name requires an app name."));
      console.error(colors.cyan("  portless --name <name> <command...>"));
      process.exit(1);
    }
    const skipPortless =
      process.env.PORTLESS === "0" ||
      process.env.PORTLESS === "false" ||
      process.env.PORTLESS === "skip";
    if (skipPortless) {
      const { commandArgs } = parseAppArgs(args);
      if (commandArgs.length === 0) {
        console.error(colors.red("Error: No command provided."));
        process.exit(1);
      }
      spawnCommand(commandArgs);
      return;
    }
    await handleNamedMode(args);
    return;
  }

  // `run` subcommand: strip it, rest is parsed as run-mode args
  const isRunCommand = args[0] === "run";
  if (isRunCommand) {
    args.shift();
  }

  const skipPortless =
    process.env.PORTLESS === "0" ||
    process.env.PORTLESS === "false" ||
    process.env.PORTLESS === "skip";
  if (
    skipPortless &&
    (isRunCommand ||
      args.length === 0 ||
      (args.length >= 2 &&
        args[0] !== "proxy" &&
        args[0] !== "clean" &&
        args[0] !== "doctor" &&
        args[0] !== "service"))
  ) {
    const parsed = isRunCommand ? parseRunArgs(args) : parseAppArgs(args);
    let commandArgs = parsed.commandArgs;
    if (commandArgs.length === 0 && (isRunCommand || args.length === 0)) {
      const appConfig = loadAppConfig();
      const scriptName = globalScript ?? appConfig?.script ?? "dev";
      const resolved = resolveScriptCommand(scriptName, process.cwd());
      if (resolved) commandArgs = resolved;
    }
    if (commandArgs.length === 0) {
      console.error(colors.red("Error: No command provided."));
      process.exit(1);
    }
    spawnCommand(commandArgs);
    return;
  }

  // Global dispatch: help, version, trust, clean, prune, list, doctor, alias, hosts, proxy, service
  // When `run` is used, skip these so args like "list" or "--help" are treated
  // as child-command tokens, not portless subcommands.
  if (!isRunCommand) {
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
    if (args[0] === "trust") {
      await handleTrust();
      return;
    }
    if (args[0] === "clean") {
      await handleClean(args);
      return;
    }
    if (args[0] === "prune") {
      await handlePrune(args);
      return;
    }
    if (args[0] === "list") {
      await handleList();
      return;
    }
    if (args[0] === "doctor") {
      await handleDoctor(args);
      return;
    }
    if (args[0] === "get") {
      await handleGet(args);
      return;
    }
    if (args[0] === "alias") {
      await handleAlias(args);
      return;
    }
    if (args[0] === "hosts") {
      await handleHosts(args);
      return;
    }
    if (args[0] === "proxy") {
      await handleProxy(args);
      return;
    }
    if (args[0] === "service") {
      await handleService(args, { entryScript: getEntryScript() });
      return;
    }
  }

  // Run app (either `portless run <cmd>` or `portless <name> <cmd>`)
  if (isRunCommand) {
    await handleRunMode(args, globalScript);
  } else {
    await handleNamedMode(args);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(colors.red("Error:"), message);
  process.exit(1);
});

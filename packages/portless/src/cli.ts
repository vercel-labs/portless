#!/usr/bin/env node

declare const __VERSION__: string;

import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createSNICallback, ensureCerts, isCATrusted, trustCA } from "./certs.js";
import { createProxyServer } from "./proxy.js";
import { fixOwnership, formatUrl, isErrnoException, parseHostname } from "./utils.js";
import { syncHostsFile, cleanHostsFile } from "./hosts.js";
import { FILE_MODE, RouteConflictError, RouteStore } from "./routes.js";
import { inferProjectName, detectWorktreePrefix } from "./auto.js";
import {
  DEFAULT_TLD,
  PRIVILEGED_PORT_THRESHOLD,
  RISKY_TLDS,
  discoverState,
  findFreePort,
  findPidOnPort,
  getDefaultPort,
  getDefaultTld,
  injectFrameworkFlags,
  isHttpsEnvEnabled,
  isProxyRunning,
  prompt,
  readTldFromDir,
  readTlsMarker,
  resolveStateDir,
  spawnCommand,
  validateTld,
  waitForProxy,
  writeTldFile,
  writeTlsMarker,
} from "./cli-utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce delay (ms) for reloading routes after a file change. */
const DEBOUNCE_MS = 100;

/** Polling interval (ms) when fs.watch is unavailable. */
const POLL_INTERVAL_MS = 3000;

/** Grace period (ms) for connections to drain before force-exiting the proxy. */
const EXIT_TIMEOUT_MS = 2000;

/** Timeout (ms) for the sudo spawn when auto-starting the proxy. */
const SUDO_SPAWN_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Proxy server lifecycle
// ---------------------------------------------------------------------------

function startProxyServer(
  store: RouteStore,
  proxyPort: number,
  tld: string,
  tlsOptions?: { cert: Buffer; key: Buffer }
): void {
  store.ensureDir();

  const isTls = !!tlsOptions;

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

  const syncVal = process.env.PORTLESS_SYNC_HOSTS;
  const autoSyncHosts =
    syncVal === "1" ||
    syncVal === "true" ||
    (tld !== DEFAULT_TLD && syncVal !== "0" && syncVal !== "false");

  const reloadRoutes = () => {
    try {
      cachedRoutes = store.loadRoutes();
      if (autoSyncHosts) {
        syncHostsFile(cachedRoutes.map((r) => r.hostname));
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
    console.warn(chalk.yellow("fs.watch unavailable; falling back to polling for route changes"));
    pollingInterval = setInterval(reloadRoutes, POLL_INTERVAL_MS);
  }

  if (autoSyncHosts) {
    syncHostsFile(cachedRoutes.map((r) => r.hostname));
  }

  const server = createProxyServer({
    getRoutes: () => cachedRoutes,
    proxyPort,
    tld,
    onError: (msg) => console.error(chalk.red(msg)),
    tls: tlsOptions,
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(chalk.red(`Port ${proxyPort} is already in use.`));
      console.error(chalk.blue("Stop the existing proxy first:"));
      console.error(chalk.cyan("  portless proxy stop"));
      console.error(chalk.blue("Or check what is using the port:"));
      console.error(chalk.cyan(`  lsof -ti tcp:${proxyPort}`));
    } else if (err.code === "EACCES") {
      console.error(chalk.red(`Permission denied for port ${proxyPort}.`));
      console.error(chalk.blue("Either run with sudo:"));
      console.error(chalk.cyan("  sudo portless proxy start -p 80"));
      console.error(chalk.blue("Or use a non-privileged port (no sudo needed):"));
      console.error(chalk.cyan("  portless proxy start"));
    } else {
      console.error(chalk.red(`Proxy error: ${err.message}`));
    }
    process.exit(1);
  });

  server.listen(proxyPort, () => {
    // Save PID and port once the server is actually listening
    fs.writeFileSync(store.pidPath, process.pid.toString(), { mode: FILE_MODE });
    fs.writeFileSync(store.portFilePath, proxyPort.toString(), { mode: FILE_MODE });
    writeTlsMarker(store.dir, isTls);
    writeTldFile(store.dir, tld);
    fixOwnership(store.dir, store.pidPath, store.portFilePath);
    const proto = isTls ? "HTTPS/2" : "HTTP";
    const tldLabel = tld !== DEFAULT_TLD ? ` (TLD: .${tld})` : "";
    console.log(chalk.green(`${proto} proxy listening on port ${proxyPort}${tldLabel}`));
  });

  // Cleanup on exit
  let exiting = false;
  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pollingInterval) clearInterval(pollingInterval);
    if (watcher) {
      watcher.close();
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
    writeTldFile(store.dir, DEFAULT_TLD);
    if (autoSyncHosts) cleanHostsFile();
    server.close(() => process.exit(0));
    // Force exit after a short timeout in case connections don't drain
    setTimeout(() => process.exit(0), EXIT_TIMEOUT_MS).unref();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(chalk.cyan("\nProxy is running. Press Ctrl+C to stop.\n"));
  console.log(chalk.gray(`Routes file: ${store.getRoutesPath()}`));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function stopProxy(store: RouteStore, proxyPort: number, _tls: boolean): Promise<void> {
  const pidPath = store.pidPath;
  const needsSudo = proxyPort < PRIVILEGED_PORT_THRESHOLD;
  const sudoHint = needsSudo ? "sudo " : "";

  if (!fs.existsSync(pidPath)) {
    // PID file is missing -- check whether something is still listening.
    // Use plain HTTP: the TLS proxy accepts it via byte-peeking, and this
    // avoids false negatives from TLS handshake timeouts.
    if (await isProxyRunning(proxyPort)) {
      console.log(chalk.yellow(`PID file is missing but port ${proxyPort} is still in use.`));
      const pid = findPidOnPort(proxyPort);
      if (pid !== null) {
        try {
          process.kill(pid, "SIGTERM");
          try {
            fs.unlinkSync(store.portFilePath);
          } catch {
            // Port file may already be absent; non-fatal
          }
          console.log(chalk.green(`Killed process ${pid}. Proxy stopped.`));
        } catch (err: unknown) {
          if (isErrnoException(err) && err.code === "EPERM") {
            console.error(chalk.red("Permission denied. The proxy was started with sudo."));
            console.error(chalk.blue("Stop it with:"));
            console.error(chalk.cyan("  sudo portless proxy stop"));
          } else {
            const message = err instanceof Error ? err.message : String(err);
            console.error(chalk.red(`Failed to stop proxy: ${message}`));
            console.error(chalk.blue("Check if the process is still running:"));
            console.error(chalk.cyan(`  lsof -ti tcp:${proxyPort}`));
          }
        }
      } else if (process.getuid?.() !== 0) {
        // Not running as root -- lsof likely cannot see root-owned processes
        console.error(chalk.red("Cannot identify the process. It may be running as root."));
        console.error(chalk.blue("Try stopping with sudo:"));
        console.error(chalk.cyan("  sudo portless proxy stop"));
      } else {
        console.error(chalk.red(`Could not identify the process on port ${proxyPort}.`));
        console.error(chalk.blue("Try manually:"));
        console.error(chalk.cyan(`  sudo kill "$(lsof -ti tcp:${proxyPort})"`));
      }
    } else {
      console.log(chalk.yellow("Proxy is not running."));
    }
    return;
  }

  try {
    const pid = parseInt(fs.readFileSync(pidPath, "utf-8"), 10);
    if (isNaN(pid)) {
      console.error(chalk.red("Corrupted PID file. Removing it."));
      fs.unlinkSync(pidPath);
      return;
    }

    // Check if the process is still alive before trying to kill it
    try {
      process.kill(pid, 0);
    } catch {
      console.log(chalk.yellow("Proxy process is no longer running. Cleaning up stale files."));
      fs.unlinkSync(pidPath);
      try {
        fs.unlinkSync(store.portFilePath);
      } catch {
        // Port file may already be absent; non-fatal
      }
      return;
    }

    // Verify the process is actually running a proxy on the expected port.
    // If the PID was recycled by an unrelated process, the port won't be listening.
    // Plain HTTP works for both TLS and non-TLS proxies (byte-peeking).
    if (!(await isProxyRunning(proxyPort))) {
      console.log(
        chalk.yellow(
          `PID file exists but port ${proxyPort} is not listening. The PID may have been recycled.`
        )
      );
      console.log(chalk.yellow("Removing stale PID file."));
      fs.unlinkSync(pidPath);
      return;
    }

    process.kill(pid, "SIGTERM");
    fs.unlinkSync(pidPath);
    try {
      fs.unlinkSync(store.portFilePath);
    } catch {
      // Port file may already be removed; non-fatal
    }
    console.log(chalk.green("Proxy stopped."));
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "EPERM") {
      console.error(chalk.red("Permission denied. The proxy was started with sudo."));
      console.error(chalk.blue("Stop it with:"));
      console.error(chalk.cyan(`  ${sudoHint}portless proxy stop`));
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Failed to stop proxy: ${message}`));
      console.error(chalk.blue("Check if the process is still running:"));
      console.error(chalk.cyan(`  lsof -ti tcp:${proxyPort}`));
    }
  }
}

function listRoutes(store: RouteStore, proxyPort: number, tls: boolean): void {
  const routes = store.loadRoutes();

  if (routes.length === 0) {
    console.log(chalk.yellow("No active routes."));
    console.log(chalk.gray("Start an app with: portless <name> <command>"));
    return;
  }

  console.log(chalk.blue.bold("\nActive routes:\n"));
  for (const route of routes) {
    const url = formatUrl(route.hostname, proxyPort, tls);
    const label = route.pid === 0 ? "(alias)" : `(pid ${route.pid})`;
    console.log(
      `  ${chalk.cyan(url)}  ${chalk.gray("->")}  ${chalk.white(`localhost:${route.port}`)}  ${chalk.gray(label)}`
    );
  }
  console.log();
}

async function runApp(
  store: RouteStore,
  proxyPort: number,
  stateDir: string,
  name: string,
  commandArgs: string[],
  tls: boolean,
  tld: string,
  force: boolean,
  autoInfo?: { nameSource: string; prefix?: string; prefixSource?: string },
  desiredPort?: number
) {
  const hostname = parseHostname(name, tld);

  let envTld: string;
  try {
    envTld = getDefaultTld();
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
  if (envTld !== DEFAULT_TLD && envTld !== tld) {
    console.warn(
      chalk.yellow(
        `Warning: PORTLESS_TLD=${envTld} but the running proxy uses .${tld}. Using .${tld}.`
      )
    );
  }

  console.log(chalk.blue.bold(`\nportless\n`));
  console.log(chalk.gray(`-- ${hostname} (auto-resolves to 127.0.0.1)`));
  if (autoInfo) {
    const baseName = autoInfo.prefix ? name.slice(autoInfo.prefix.length + 1) : name;
    console.log(chalk.gray(`-- Name "${baseName}" (from ${autoInfo.nameSource})`));
    if (autoInfo.prefix) {
      console.log(chalk.gray(`-- Prefix "${autoInfo.prefix}" (from ${autoInfo.prefixSource})`));
    }
  }

  // Check if proxy is running, auto-start if possible
  if (!(await isProxyRunning(proxyPort, tls))) {
    const defaultPort = getDefaultPort();
    const needsSudo = defaultPort < PRIVILEGED_PORT_THRESHOLD;
    const wantHttps = isHttpsEnvEnabled();

    if (needsSudo) {
      // Privileged port requires sudo -- must prompt interactively
      if (!process.stdin.isTTY) {
        console.error(chalk.red("Proxy is not running."));
        console.error(chalk.blue("Start the proxy first (requires sudo for this port):"));
        console.error(chalk.cyan("  sudo portless proxy start -p 80"));
        console.error(chalk.blue("Or use the default port (no sudo needed):"));
        console.error(chalk.cyan("  portless proxy start"));
        process.exit(1);
      }

      const answer = await prompt(chalk.yellow("Proxy not running. Start it? [Y/n/skip] "));

      if (answer === "n" || answer === "no") {
        console.log(chalk.gray("Cancelled."));
        process.exit(0);
      }

      if (answer === "s" || answer === "skip") {
        console.log(chalk.gray("Skipping proxy, running command directly...\n"));
        spawnCommand(commandArgs);
        return;
      }

      console.log(chalk.yellow("Starting proxy (requires sudo)..."));
      const startArgs = [process.execPath, process.argv[1], "proxy", "start"];
      if (wantHttps) startArgs.push("--https");
      if (tld !== DEFAULT_TLD) startArgs.push("--tld", tld);
      const result = spawnSync("sudo", startArgs, {
        stdio: "inherit",
        timeout: SUDO_SPAWN_TIMEOUT_MS,
      });
      if (result.status !== 0) {
        console.error(chalk.red("Failed to start proxy."));
        console.error(chalk.blue("Try starting it manually:"));
        console.error(chalk.cyan("  sudo portless proxy start"));
        process.exit(1);
      }
    } else {
      // Non-privileged port -- auto-start silently, no prompt needed
      console.log(chalk.yellow("Starting proxy..."));
      const startArgs = [process.argv[1], "proxy", "start"];
      if (wantHttps) startArgs.push("--https");
      if (tld !== DEFAULT_TLD) startArgs.push("--tld", tld);
      const result = spawnSync(process.execPath, startArgs, {
        stdio: "inherit",
        timeout: SUDO_SPAWN_TIMEOUT_MS,
      });
      if (result.status !== 0) {
        console.error(chalk.red("Failed to start proxy."));
        console.error(chalk.blue("Try starting it manually:"));
        console.error(chalk.cyan("  portless proxy start"));
        process.exit(1);
      }
    }

    // Re-read TLS/TLD state after auto-start
    const autoTls = readTlsMarker(stateDir);
    tld = readTldFromDir(stateDir);

    // Wait for proxy to be ready
    if (!(await waitForProxy(defaultPort, undefined, undefined, autoTls))) {
      console.error(chalk.red("Proxy failed to start (timed out waiting for it to listen)."));
      const logPath = path.join(stateDir, "proxy.log");
      console.error(chalk.blue("Try starting the proxy manually to see the error:"));
      console.error(chalk.cyan(`  ${needsSudo ? "sudo " : ""}portless proxy start`));
      if (fs.existsSync(logPath)) {
        console.error(chalk.gray(`Logs: ${logPath}`));
      }
      process.exit(1);
    }

    // Update tls/URL for newly started proxy
    tls = autoTls;
    console.log(chalk.green("Proxy started in background"));
  } else {
    console.log(chalk.gray("-- Proxy is running"));
  }

  const port = desiredPort ?? (await findFreePort());
  if (desiredPort) {
    console.log(chalk.green(`-- Using port ${port} (fixed)`));
  } else {
    console.log(chalk.green(`-- Using port ${port}`));
  }

  // Register route
  try {
    store.addRoute(hostname, port, process.pid, force);
  } catch (err) {
    if (err instanceof RouteConflictError) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
    throw err;
  }

  const finalUrl = formatUrl(hostname, proxyPort, tls);
  console.log(chalk.cyan.bold(`\n  -> ${finalUrl}\n`));

  // Inject --port for frameworks that ignore the PORT env var (e.g. Vite)
  injectFrameworkFlags(commandArgs, port);

  // Run the command
  console.log(
    chalk.gray(
      `Running: PORT=${port} HOST=127.0.0.1 PORTLESS_URL=${finalUrl} ${commandArgs.join(" ")}\n`
    )
  );

  spawnCommand(commandArgs, {
    env: {
      ...process.env,
      PORT: port.toString(),
      HOST: "127.0.0.1",
      PORTLESS_URL: finalUrl,
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: `.${tld}`,
    },
    onCleanup: () => {
      try {
        store.removeRoute(hostname);
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
    console.error(chalk.red("Error: --app-port requires a port number."));
    process.exit(1);
  }
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(chalk.red(`Error: Invalid app port "${value}". Must be 1-65535.`));
    process.exit(1);
  }
  return port;
}

function appPortFromEnv(): number | undefined {
  const envVal = process.env.PORTLESS_APP_PORT;
  if (!envVal) return undefined;
  const port = parseInt(envVal, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(chalk.red(`Error: Invalid PORTLESS_APP_PORT="${envVal}". Must be 1-65535.`));
    process.exit(1);
  }
  return port;
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
${chalk.bold("portless run")} - Infer project name and run through the proxy.

${chalk.bold("Usage:")}
  ${chalk.cyan("portless run [options] <command...>")}

${chalk.bold("Options:")}
  --name <name>          Override the inferred base name (worktree prefix still applies)
  --force                Override an existing route registered by another process
  --app-port <number>    Use a fixed port for the app (skip auto-assignment)
  --help, -h             Show this help

${chalk.bold("Name inference (in order):")}
  1. package.json "name" field (walks up directories)
  2. Git repo root directory name
  3. Current directory basename

  Use --name to override the inferred name while keeping worktree prefixes.
  In git worktrees, the branch name is prepended as a subdomain prefix
  (e.g. feature-auth.myapp.localhost).

${chalk.bold("Examples:")}
  portless run next dev               # -> http://<project>.localhost:1355
  portless run --name myapp next dev  # -> http://myapp.localhost:1355
  portless run vite dev               # -> http://<project>.localhost:1355
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
        console.error(chalk.red("Error: --name requires a name value."));
        console.error(chalk.cyan("  portless run --name <name> <command...>"));
        process.exit(1);
      }
      name = args[i];
    } else {
      console.error(chalk.red(`Error: Unknown flag "${args[i]}".`));
      console.error(chalk.blue("Known flags: --name, --force, --app-port, --help"));
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
    } else {
      console.error(chalk.red(`Error: Unknown flag "${args[i]}".`));
      console.error(chalk.blue("Known flags: --force, --app-port"));
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
    } else {
      console.error(chalk.red(`Error: Unknown flag "${args[i]}".`));
      console.error(chalk.blue("Known flags: --force, --app-port"));
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
${chalk.bold("portless")} - Replace port numbers with stable, named .localhost URLs. For humans and agents.

Eliminates port conflicts, memorizing port numbers, and cookie/storage
clashes by giving each dev server a stable .localhost URL.

${chalk.bold("Install:")}
  ${chalk.cyan("npm install -g portless")}
  Do NOT add portless as a project dependency.

${chalk.bold("Usage:")}
  ${chalk.cyan("portless proxy start")}             Start the proxy (background daemon)
  ${chalk.cyan("portless proxy start --https")}     Start with HTTP/2 + TLS (auto-generates certs)
  ${chalk.cyan("portless proxy start -p 80")}       Start on port 80 (requires sudo)
  ${chalk.cyan("portless proxy stop")}              Stop the proxy
  ${chalk.cyan("portless <name> <cmd>")}            Run your app through the proxy
  ${chalk.cyan("portless run <cmd>")}               Infer name from project, run through proxy
  ${chalk.cyan("portless get <name>")}              Print URL for a service (for cross-service refs)
  ${chalk.cyan("portless alias <name> <port>")}     Register a static route (e.g. for Docker)
  ${chalk.cyan("portless alias --remove <name>")}   Remove a static route
  ${chalk.cyan("portless list")}                    Show active routes
  ${chalk.cyan("portless trust")}                   Add local CA to system trust store
  ${chalk.cyan("portless hosts sync")}              Add routes to /etc/hosts (fixes Safari)
  ${chalk.cyan("portless hosts clean")}             Remove portless entries from /etc/hosts

${chalk.bold("Examples:")}
  portless proxy start                # Start proxy on port 1355
  portless proxy start --https        # Start with HTTPS/2 (faster page loads)
  portless myapp next dev             # -> http://myapp.localhost:1355
  portless myapp vite dev             # -> http://myapp.localhost:1355
  portless api.myapp pnpm start       # -> http://api.myapp.localhost:1355
  portless run next dev               # -> http://<project>.localhost:1355
  portless run next dev               # in worktree -> http://<worktree>.<project>.localhost:1355
  portless get backend                 # -> http://backend.localhost:1355 (for cross-service refs)
  # Wildcard subdomains: tenant.myapp.localhost also routes to myapp

${chalk.bold("In package.json:")}
  {
    "scripts": {
      "dev": "portless run next dev"
    }
  }

${chalk.bold("How it works:")}
  1. Start the proxy once (listens on port 1355 by default, no sudo needed)
  2. Run your apps - they auto-start the proxy and register automatically
     (apps get a random port in the 4000-4999 range via PORT)
  3. Access via http://<name>.localhost:1355
  4. .localhost domains auto-resolve to 127.0.0.1
  5. Frameworks that ignore PORT (Vite, Astro, React Router, Angular,
     Expo, React Native) get --port and --host flags injected automatically

${chalk.bold("HTTP/2 + HTTPS:")}
  Use --https for HTTP/2 multiplexing (faster dev server page loads).
  On first use, portless generates a local CA and adds it to your
  system trust store. No browser warnings. No sudo required on macOS.

${chalk.bold("Options:")}
  run [--name <name>] <cmd>      Infer project name (or override with --name)
                                Adds worktree prefix in git worktrees
  -p, --port <number>           Port for the proxy to listen on (default: 1355)
                                Ports < 1024 require sudo
  --https                       Enable HTTP/2 + TLS with auto-generated certs
  --cert <path>                 Use a custom TLS certificate (implies --https)
  --key <path>                  Use a custom TLS private key (implies --https)
  --no-tls                      Disable HTTPS (overrides PORTLESS_HTTPS)
  --foreground                  Run proxy in foreground (for debugging)
  --tld <tld>                   Use a custom TLD instead of .localhost (e.g. test, dev)
  --app-port <number>           Use a fixed port for the app (skip auto-assignment)
  --force                       Override an existing route registered by another process
  --name <name>                 Use <name> as the app name (bypasses subcommand dispatch)
  --                            Stop flag parsing; everything after is passed to the child

${chalk.bold("Environment variables:")}
  PORTLESS_PORT=<number>        Override the default proxy port (e.g. in .bashrc)
  PORTLESS_APP_PORT=<number>    Use a fixed port for the app (same as --app-port)
  PORTLESS_HTTPS=1              Always enable HTTPS (set in .bashrc / .zshrc)
  PORTLESS_TLD=<tld>            Use a custom TLD (e.g. test, dev; default: localhost)
  PORTLESS_SYNC_HOSTS=1         Auto-sync /etc/hosts (auto-enabled for custom TLDs)
  PORTLESS_STATE_DIR=<path>     Override the state directory
  PORTLESS=0                    Run command directly without proxy

${chalk.bold("Child process environment:")}
  PORT                          Ephemeral port the child should listen on
  HOST                          Always 127.0.0.1
  PORTLESS_URL                  Public URL of the app (e.g. http://myapp.localhost:1355)

${chalk.bold("Safari / DNS:")}
  .localhost subdomains auto-resolve in Chrome, Firefox, and Edge.
  Safari relies on the system DNS resolver, which may not handle them.
  Auto-syncs /etc/hosts for custom TLDs (e.g. --tld test). For .localhost,
  set PORTLESS_SYNC_HOSTS=1 to enable. To manually sync:
    ${chalk.cyan("sudo portless hosts sync")}
  Clean up later with:
    ${chalk.cyan("sudo portless hosts clean")}

${chalk.bold("Skip portless:")}
  PORTLESS=0 pnpm dev           # Runs command directly without proxy

${chalk.bold("Reserved names:")}
  run, get, alias, hosts, list, trust, proxy are subcommands and cannot
  be used as app names directly. Use "portless run" to infer the name,
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
  const result = trustCA(dir);
  if (result.trusted) {
    console.log(chalk.green("Local CA added to system trust store."));
    console.log(chalk.gray("Browsers will now trust portless HTTPS certificates."));
  } else {
    console.error(chalk.red(`Failed to trust CA: ${result.error}`));
    if (result.error?.includes("sudo")) {
      console.error(chalk.blue("Run with sudo:"));
      console.error(chalk.cyan("  sudo portless trust"));
    }
    process.exit(1);
  }
}

async function handleList(): Promise<void> {
  const { dir, port, tls } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(chalk.yellow(msg)),
  });
  listRoutes(store, port, tls);
}

async function handleGet(args: string[]): Promise<void> {
  if (args[1] === "--help" || args[1] === "-h") {
    console.log(`
${chalk.bold("portless get")} - Print the URL for a service.

${chalk.bold("Usage:")}
  ${chalk.cyan("portless get <name>")}

Constructs the URL using the same hostname and worktree logic as
"portless run", then prints it to stdout. Useful for wiring services
together:

  BACKEND_URL=$(portless get backend)

${chalk.bold("Options:")}
  --no-worktree          Skip worktree prefix detection
  --help, -h             Show this help

${chalk.bold("Examples:")}
  portless get backend                  # -> http://backend.localhost:1355
  portless get backend                  # in worktree -> http://auth.backend.localhost:1355
  portless get backend --no-worktree    # -> http://backend.localhost:1355 (skip worktree)
`);
    process.exit(0);
  }

  let skipWorktree = false;
  const positional: string[] = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--no-worktree") {
      skipWorktree = true;
    } else if (args[i].startsWith("-")) {
      console.error(chalk.red(`Error: Unknown flag "${args[i]}".`));
      console.error(chalk.blue("Known flags: --no-worktree, --help"));
      process.exit(1);
    } else {
      positional.push(args[i]);
    }
  }

  if (positional.length === 0) {
    console.error(chalk.red("Error: Missing service name."));
    console.error(chalk.blue("Usage:"));
    console.error(chalk.cyan("  portless get <name>"));
    console.error(chalk.blue("Example:"));
    console.error(chalk.cyan("  portless get backend"));
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
${chalk.bold("portless alias")} - Register a static route for services not managed by portless.

${chalk.bold("Usage:")}
  ${chalk.cyan("portless alias <name> <port>")}        Register a route
  ${chalk.cyan("portless alias --remove <name>")}      Remove a route
  ${chalk.cyan("portless alias <name> <port> --force")} Override existing route

${chalk.bold("Examples:")}
  portless alias my-postgres 5432     # -> http://my-postgres.localhost:1355
  portless alias redis 6379           # -> http://redis.localhost:1355
  portless alias --remove my-postgres # Remove the alias
`);
    process.exit(0);
  }

  const { dir, tld } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(chalk.yellow(msg)),
  });

  if (args[1] === "--remove") {
    const aliasName = args[2];
    if (!aliasName) {
      console.error(chalk.red("Error: No alias name provided."));
      console.error(chalk.cyan("  portless alias --remove <name>"));
      process.exit(1);
    }
    const hostname = parseHostname(aliasName, tld);
    const routes = store.loadRoutes();
    const existing = routes.find((r) => r.hostname === hostname && r.pid === 0);
    if (!existing) {
      console.error(chalk.red(`Error: No alias found for "${hostname}".`));
      process.exit(1);
    }
    store.removeRoute(hostname);
    console.log(chalk.green(`Removed alias: ${hostname}`));
    return;
  }

  const aliasName = args[1];
  const aliasPort = args[2];
  if (!aliasName || !aliasPort) {
    console.error(chalk.red("Error: Missing arguments."));
    console.error(chalk.blue("Usage:"));
    console.error(chalk.cyan("  portless alias <name> <port>"));
    console.error(chalk.cyan("  portless alias --remove <name>"));
    console.error(chalk.blue("Example:"));
    console.error(chalk.cyan("  portless alias my-postgres 5432"));
    process.exit(1);
  }

  const hostname = parseHostname(aliasName, tld);
  const port = parseInt(aliasPort, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(chalk.red(`Error: Invalid port "${aliasPort}". Must be 1-65535.`));
    process.exit(1);
  }

  const force = args.includes("--force");
  store.addRoute(hostname, port, 0, force);
  console.log(chalk.green(`Alias registered: ${hostname} -> 127.0.0.1:${port}`));
}

async function handleHosts(args: string[]): Promise<void> {
  if (args[1] === "--help" || args[1] === "-h") {
    console.log(`
${chalk.bold("portless hosts")} - Manage /etc/hosts entries for .localhost subdomains.

Safari relies on the system DNS resolver, which may not handle .localhost
subdomains. This command adds entries to /etc/hosts as a workaround.

${chalk.bold("Usage:")}
  ${chalk.cyan("sudo portless hosts sync")}    Add current routes to /etc/hosts
  ${chalk.cyan("sudo portless hosts clean")}   Remove portless entries from /etc/hosts

${chalk.bold("Auto-sync:")}
  Auto-enabled for custom TLDs (e.g. --tld test). For .localhost, set
  PORTLESS_SYNC_HOSTS=1 to enable. Disable with PORTLESS_SYNC_HOSTS=0.
`);
    process.exit(0);
  }

  if (args[1] === "clean") {
    if (cleanHostsFile()) {
      console.log(chalk.green("Removed portless entries from /etc/hosts."));
    } else {
      console.error(chalk.red("Failed to update /etc/hosts (requires sudo)."));
      console.error(chalk.cyan("  sudo portless hosts clean"));
      process.exit(1);
    }
    return;
  }

  if (!args[1]) {
    console.log(`
${chalk.bold("Usage: portless hosts <command>")}

  ${chalk.cyan("sudo portless hosts sync")}    Add current routes to /etc/hosts
  ${chalk.cyan("sudo portless hosts clean")}   Remove portless entries from /etc/hosts
`);
    process.exit(0);
  }

  if (args[1] !== "sync") {
    console.error(chalk.red(`Error: Unknown hosts subcommand "${args[1]}".`));
    console.error(chalk.blue("Usage:"));
    console.error(chalk.cyan("  portless hosts sync    # Add routes to /etc/hosts"));
    console.error(chalk.cyan("  portless hosts clean   # Remove portless entries"));
    process.exit(1);
  }

  const { dir } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(chalk.yellow(msg)),
  });

  const routes = store.loadRoutes();
  if (routes.length === 0) {
    console.log(chalk.yellow("No active routes to sync."));
    return;
  }
  const hostnames = routes.map((r) => r.hostname);
  if (syncHostsFile(hostnames)) {
    console.log(chalk.green(`Synced ${hostnames.length} hostname(s) to /etc/hosts:`));
    for (const h of hostnames) {
      console.log(chalk.cyan(`  127.0.0.1 ${h}`));
    }
  } else {
    console.error(chalk.red("Failed to update /etc/hosts (requires sudo)."));
    console.error(chalk.cyan("  sudo portless hosts sync"));
    process.exit(1);
  }
}

async function handleProxy(args: string[]): Promise<void> {
  if (args[1] === "stop") {
    const { dir, port, tls } = await discoverState();
    const store = new RouteStore(dir, {
      onWarning: (msg) => console.warn(chalk.yellow(msg)),
    });
    await stopProxy(store, port, tls);
    return;
  }

  const isProxyHelp = args[1] === "--help" || args[1] === "-h";
  if (isProxyHelp || args[1] !== "start") {
    console.log(`
${chalk.bold("portless proxy")} - Manage the portless proxy server.

${chalk.bold("Usage:")}
  ${chalk.cyan("portless proxy start")}                Start the proxy (daemon)
  ${chalk.cyan("portless proxy start --https")}        Start with HTTP/2 + TLS
  ${chalk.cyan("portless proxy start --foreground")}   Start in foreground (for debugging)
  ${chalk.cyan("portless proxy start -p 80")}          Start on port 80 (requires sudo)
  ${chalk.cyan("portless proxy start --tld test")}     Use .test instead of .localhost
  ${chalk.cyan("portless proxy stop")}                 Stop the proxy
`);
    process.exit(isProxyHelp || !args[1] ? 0 : 1);
  }

  const isForeground = args.includes("--foreground");

  // Parse --port / -p flag
  let proxyPort = getDefaultPort();
  let portFlagIndex = args.indexOf("--port");
  if (portFlagIndex === -1) portFlagIndex = args.indexOf("-p");
  if (portFlagIndex !== -1) {
    const portValue = args[portFlagIndex + 1];
    if (!portValue || portValue.startsWith("-")) {
      console.error(chalk.red("Error: --port / -p requires a port number."));
      console.error(chalk.blue("Usage:"));
      console.error(chalk.cyan("  portless proxy start -p 8080"));
      process.exit(1);
    }
    proxyPort = parseInt(portValue, 10);
    if (isNaN(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      console.error(chalk.red(`Error: Invalid port number: ${portValue}`));
      console.error(chalk.blue("Port must be between 1 and 65535."));
      process.exit(1);
    }
  }

  // Parse HTTPS / TLS flags
  const hasNoTls = args.includes("--no-tls");
  const hasHttpsFlag = args.includes("--https");
  const wantHttps = !hasNoTls && (hasHttpsFlag || isHttpsEnvEnabled());

  // Parse optional --cert / --key for custom certificates
  let customCertPath: string | null = null;
  let customKeyPath: string | null = null;
  const certIdx = args.indexOf("--cert");
  if (certIdx !== -1) {
    customCertPath = args[certIdx + 1] || null;
    if (!customCertPath || customCertPath.startsWith("-")) {
      console.error(chalk.red("Error: --cert requires a file path."));
      process.exit(1);
    }
  }
  const keyIdx = args.indexOf("--key");
  if (keyIdx !== -1) {
    customKeyPath = args[keyIdx + 1] || null;
    if (!customKeyPath || customKeyPath.startsWith("-")) {
      console.error(chalk.red("Error: --key requires a file path."));
      process.exit(1);
    }
  }
  if ((customCertPath && !customKeyPath) || (!customCertPath && customKeyPath)) {
    console.error(chalk.red("Error: --cert and --key must be used together."));
    process.exit(1);
  }

  // Parse --tld flag
  let tld: string;
  try {
    tld = getDefaultTld();
  } catch (err) {
    console.error(chalk.red(`Error: ${(err as Error).message}`));
    process.exit(1);
  }
  const tldIdx = args.indexOf("--tld");
  if (tldIdx !== -1) {
    const tldValue = args[tldIdx + 1];
    if (!tldValue || tldValue.startsWith("-")) {
      console.error(chalk.red("Error: --tld requires a TLD value (e.g. test, localhost)."));
      process.exit(1);
    }
    tld = tldValue.trim().toLowerCase();
    const tldErr = validateTld(tld);
    if (tldErr) {
      console.error(chalk.red(`Error: ${tldErr}`));
      process.exit(1);
    }
  }
  const riskyReason = RISKY_TLDS.get(tld);
  if (riskyReason) {
    console.warn(chalk.yellow(`Warning: .${tld} -- ${riskyReason}`));
  }

  const syncDisabled =
    process.env.PORTLESS_SYNC_HOSTS === "0" || process.env.PORTLESS_SYNC_HOSTS === "false";
  if (tld !== DEFAULT_TLD && syncDisabled) {
    console.warn(
      chalk.yellow(`Warning: .${tld} domains require /etc/hosts entries to resolve to 127.0.0.1.`)
    );
    console.warn(chalk.yellow("Hosts sync is disabled. To add entries manually, run:"));
    console.warn(chalk.cyan("  sudo portless hosts sync"));
  }

  // Custom cert/key implies HTTPS
  const useHttps = wantHttps || !!(customCertPath && customKeyPath);

  // Resolve state directory based on the port
  const stateDir = resolveStateDir(proxyPort);
  const store = new RouteStore(stateDir, {
    onWarning: (msg) => console.warn(chalk.yellow(msg)),
  });

  // Check if already running. Plain HTTP check detects both TLS and non-TLS
  // proxies because the TLS-enabled proxy accepts plain HTTP via byte-peeking.
  if (await isProxyRunning(proxyPort)) {
    if (isForeground) {
      return;
    }
    const needsSudo = proxyPort < PRIVILEGED_PORT_THRESHOLD;
    const sudoPrefix = needsSudo ? "sudo " : "";
    const portFlag = proxyPort !== getDefaultPort() ? ` -p ${proxyPort}` : "";
    console.log(chalk.yellow(`Proxy is already running on port ${proxyPort}.`));
    console.log(
      chalk.blue(
        `To restart: ${sudoPrefix}portless proxy stop${portFlag} && ${sudoPrefix}portless proxy start${portFlag}`
      )
    );
    return;
  }

  // Check if running as root (only required for privileged ports)
  if (proxyPort < PRIVILEGED_PORT_THRESHOLD && (process.getuid?.() ?? -1) !== 0) {
    console.error(chalk.red(`Error: Port ${proxyPort} requires sudo.`));
    console.error(chalk.blue("Either run with sudo:"));
    console.error(chalk.cyan("  sudo portless proxy start -p 80"));
    console.error(chalk.blue("Or use the default port (no sudo needed):"));
    console.error(chalk.cyan("  portless proxy start"));
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
          console.error(chalk.red(`Error: ${customCertPath} is not a valid PEM certificate.`));
          console.error(chalk.gray("Expected a file starting with -----BEGIN CERTIFICATE-----"));
          process.exit(1);
        }
        if (!keyStr.match(/-----BEGIN [\w\s]*PRIVATE KEY-----/)) {
          console.error(chalk.red(`Error: ${customKeyPath} is not a valid PEM private key.`));
          console.error(chalk.gray("Expected a file starting with -----BEGIN ...PRIVATE KEY-----"));
          process.exit(1);
        }

        tlsOptions = { cert, key };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Error reading certificate files: ${message}`));
        process.exit(1);
      }
    } else {
      console.log(chalk.gray("Ensuring TLS certificates..."));
      const certs = ensureCerts(stateDir);
      if (certs.caGenerated) {
        console.log(chalk.green("Generated local CA certificate."));
      }

      if (!isCATrusted(stateDir)) {
        console.log(chalk.yellow("Adding CA to system trust store..."));
        const trustResult = trustCA(stateDir);
        if (trustResult.trusted) {
          console.log(
            chalk.green("CA added to system trust store. Browsers will trust portless certs.")
          );
        } else {
          console.warn(chalk.yellow("Could not add CA to system trust store."));
          if (trustResult.error) {
            console.warn(chalk.gray(trustResult.error));
          }
          console.warn(
            chalk.yellow("Browsers will show certificate warnings. To fix this later, run:")
          );
          console.warn(chalk.cyan("  portless trust"));
        }
      }

      const cert = fs.readFileSync(certs.certPath);
      const key = fs.readFileSync(certs.keyPath);
      tlsOptions = {
        cert,
        key,
        SNICallback: createSNICallback(stateDir, cert, key, tld),
      };
    }
  }

  // Foreground mode: run the proxy directly in this process
  if (isForeground) {
    console.log(chalk.blue.bold("\nportless proxy\n"));
    startProxyServer(store, proxyPort, tld, tlsOptions);
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

    const daemonArgs = [process.argv[1], "proxy", "start", "--foreground"];
    if (portFlagIndex !== -1) {
      daemonArgs.push("--port", proxyPort.toString());
    }
    if (useHttps) {
      if (customCertPath && customKeyPath) {
        daemonArgs.push("--cert", customCertPath, "--key", customKeyPath);
      } else {
        daemonArgs.push("--https");
      }
    }
    if (tld !== DEFAULT_TLD) {
      daemonArgs.push("--tld", tld);
    }

    const child = spawn(process.execPath, daemonArgs, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }

  // Wait for proxy to be ready
  if (!(await waitForProxy(proxyPort, undefined, undefined, useHttps))) {
    console.error(chalk.red("Proxy failed to start (timed out waiting for it to listen)."));
    console.error(chalk.blue("Try starting the proxy in the foreground to see the error:"));
    const needsSudo = proxyPort < PRIVILEGED_PORT_THRESHOLD;
    console.error(chalk.cyan(`  ${needsSudo ? "sudo " : ""}portless proxy start --foreground`));
    if (fs.existsSync(logPath)) {
      console.error(chalk.gray(`Logs: ${logPath}`));
    }
    process.exit(1);
  }

  const proto = useHttps ? "HTTPS/2" : "HTTP";
  console.log(chalk.green(`${proto} proxy started on port ${proxyPort}`));
}

async function handleRunMode(args: string[]): Promise<void> {
  const parsed = parseRunArgs(args);

  if (parsed.commandArgs.length === 0) {
    console.error(chalk.red("Error: No command provided."));
    console.error(chalk.blue("Usage:"));
    console.error(chalk.cyan("  portless run <command...>"));
    console.error(chalk.blue("Example:"));
    console.error(chalk.cyan("  portless run next dev"));
    process.exit(1);
  }

  let baseName: string;
  let nameSource: string;

  if (parsed.name) {
    baseName = parsed.name;
    nameSource = "--name flag";
  } else {
    const inferred = inferProjectName();
    baseName = inferred.name;
    nameSource = inferred.source;
  }

  const worktree = detectWorktreePrefix();
  const effectiveName = worktree ? `${worktree.prefix}.${baseName}` : baseName;

  const { dir, port, tls, tld } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(chalk.yellow(msg)),
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
    parsed.appPort
  );
}

async function handleNamedMode(args: string[]): Promise<void> {
  const parsed = parseAppArgs(args);

  if (parsed.commandArgs.length === 0) {
    console.error(chalk.red("Error: No command provided."));
    console.error(chalk.blue("Usage:"));
    console.error(chalk.cyan("  portless <name> <command...>"));
    console.error(chalk.blue("Example:"));
    console.error(chalk.cyan("  portless myapp next dev"));
    process.exit(1);
  }

  const { dir, port, tls, tld } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(chalk.yellow(msg)),
  });
  await runApp(
    store,
    port,
    dir,
    parsed.name,
    parsed.commandArgs,
    tls,
    tld,
    parsed.force,
    undefined,
    parsed.appPort
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

  // Block npx / pnpm dlx -- portless should be installed globally, not run
  // via npx. Running "sudo npx" is unsafe because it performs package
  // resolution and downloads as root.
  const isNpx = process.env.npm_command === "exec" && !process.env.npm_lifecycle_event;
  const isPnpmDlx = !!process.env.PNPM_SCRIPT_SRC_DIR && !process.env.npm_lifecycle_event;
  if (isNpx || isPnpmDlx) {
    console.error(chalk.red("Error: portless should not be run via npx or pnpm dlx."));
    console.error(chalk.blue("Install globally instead:"));
    console.error(chalk.cyan("  npm install -g portless"));
    process.exit(1);
  }

  // --name flag: treat the next arg as an explicit app name, bypassing
  // subcommand dispatch. Useful when the app name collides with a reserved
  // subcommand (run, alias, hosts, list, trust, proxy).
  if (args[0] === "--name") {
    args.shift();
    if (!args[0]) {
      console.error(chalk.red("Error: --name requires an app name."));
      console.error(chalk.cyan("  portless --name <name> <command...>"));
      process.exit(1);
    }
    const skipPortless =
      process.env.PORTLESS === "0" ||
      process.env.PORTLESS === "false" ||
      process.env.PORTLESS === "skip";
    if (skipPortless) {
      const { commandArgs } = parseAppArgs(args);
      if (commandArgs.length === 0) {
        console.error(chalk.red("Error: No command provided."));
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
  if (skipPortless && (isRunCommand || (args.length >= 2 && args[0] !== "proxy"))) {
    const { commandArgs } = isRunCommand ? parseRunArgs(args) : parseAppArgs(args);
    if (commandArgs.length === 0) {
      console.error(chalk.red("Error: No command provided."));
      process.exit(1);
    }
    spawnCommand(commandArgs);
    return;
  }

  // Global dispatch: help, version, trust, list, alias, hosts, proxy
  // When `run` is used, skip these so args like "list" or "--help" are treated
  // as child-command tokens, not portless subcommands.
  if (!isRunCommand) {
    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
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
    if (args[0] === "list") {
      await handleList();
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
  }

  // Run app (either `portless run <cmd>` or `portless <name> <cmd>`)
  if (isRunCommand) {
    await handleRunMode(args);
  } else {
    await handleNamedMode(args);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red("Error:"), message);
  process.exit(1);
});

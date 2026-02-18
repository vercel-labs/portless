#!/usr/bin/env node

declare const __VERSION__: string;

import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createProxyServer } from "./proxy.js";
import { formatUrl, isErrnoException, parseHostname, resolveAppName } from "./utils.js";
import { FILE_MODE, RouteStore } from "./routes.js";
import {
  PRIVILEGED_PORT_THRESHOLD,
  discoverState,
  findFreePort,
  findPidOnPort,
  getDefaultPort,
  isProxyRunning,
  prompt,
  resolveStateDir,
  spawnCommand,
  waitForProxy,
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

function startProxyServer(store: RouteStore, proxyPort: number): void {
  store.ensureDir();

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

  // Cache routes in memory and reload on file change (debounced)
  let cachedRoutes = store.loadRoutes();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;
  let pollingInterval: ReturnType<typeof setInterval> | null = null;

  const reloadRoutes = () => {
    try {
      cachedRoutes = store.loadRoutes();
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

  const server = createProxyServer({
    getRoutes: () => cachedRoutes,
    proxyPort,
    onError: (msg) => console.error(chalk.red(msg)),
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
    console.log(chalk.green(`HTTP proxy listening on port ${proxyPort}`));
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

async function stopProxy(store: RouteStore, proxyPort: number): Promise<void> {
  const pidPath = store.pidPath;
  const needsSudo = proxyPort < PRIVILEGED_PORT_THRESHOLD;
  const sudoHint = needsSudo ? "sudo " : "";

  if (!fs.existsSync(pidPath)) {
    // PID file is missing -- check whether something is still listening
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

function listRoutes(store: RouteStore, proxyPort: number): void {
  const routes = store.loadRoutes();

  if (routes.length === 0) {
    console.log(chalk.yellow("No active routes."));
    console.log(chalk.gray("Start an app with: portless <name> <command>"));
    return;
  }

  console.log(chalk.blue.bold("\nActive routes:\n"));
  for (const route of routes) {
    const url = formatUrl(route.hostname, proxyPort);
    console.log(
      `  ${chalk.cyan(url)}  ${chalk.gray("->")}  ${chalk.white(`localhost:${route.port}`)}  ${chalk.gray(`(pid ${route.pid})`)}`
    );
  }
  console.log();
}

async function runApp(
  store: RouteStore,
  proxyPort: number,
  stateDir: string,
  name: string,
  commandArgs: string[]
) {
  const hostname = parseHostname(name);
  const appUrl = formatUrl(hostname, proxyPort);

  console.log(chalk.blue.bold(`\nportless\n`));
  console.log(chalk.gray(`-- ${hostname} (auto-resolves to 127.0.0.1)`));

  // Check if proxy is running, auto-start if possible
  if (!(await isProxyRunning(proxyPort))) {
    const defaultPort = getDefaultPort();
    const needsSudo = defaultPort < PRIVILEGED_PORT_THRESHOLD;

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
      const result = spawnSync("sudo", [process.execPath, process.argv[1], "proxy", "start"], {
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
      const result = spawnSync(process.execPath, [process.argv[1], "proxy", "start"], {
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

    // Wait for proxy to be ready
    if (!(await waitForProxy(defaultPort))) {
      console.error(chalk.red("Proxy failed to start (timed out waiting for it to listen)."));
      const logPath = path.join(stateDir, "proxy.log");
      console.error(chalk.blue("Try starting the proxy manually to see the error:"));
      console.error(chalk.cyan(`  ${needsSudo ? "sudo " : ""}portless proxy start`));
      if (fs.existsSync(logPath)) {
        console.error(chalk.gray(`Logs: ${logPath}`));
      }
      process.exit(1);
    }

    console.log(chalk.green("Proxy started in background"));
  } else {
    console.log(chalk.gray("-- Proxy is running"));
  }

  // Find a free port
  const port = await findFreePort();
  console.log(chalk.green(`-- Using port ${port}`));

  // Register route
  store.addRoute(hostname, port, process.pid);

  console.log(chalk.cyan.bold(`\n  -> ${appUrl}\n`));

  // Run the command
  console.log(chalk.gray(`Running: PORT=${port} ${commandArgs.join(" ")}\n`));

  spawnCommand(commandArgs, {
    env: { ...process.env, PORT: port.toString() },
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
// Main
// ---------------------------------------------------------------------------

async function main() {
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

  // Skip portless if PORTLESS=0 or PORTLESS=skip
  const skipPortless = process.env.PORTLESS === "0" || process.env.PORTLESS === "skip";
  if (skipPortless && args.length >= 2 && args[0] !== "proxy") {
    if (args[0] === "run") {
      const cmdArgs = args.slice(1);
      if (cmdArgs[0] === "--") cmdArgs.shift();
      spawnCommand(cmdArgs);
    } else {
      spawnCommand(args.slice(1));
    }
    return;
  }

  // Help
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
${chalk.bold("portless")} - Replace port numbers with stable, named .localhost URLs. For humans and agents.

Eliminates port conflicts, memorizing port numbers, and cookie/storage
clashes by giving each dev server a stable .localhost URL.

${chalk.bold("Install:")}
  ${chalk.cyan("npm install -g portless")}
  Do NOT add portless as a project dependency.

${chalk.bold("Usage:")}
  ${chalk.cyan("portless proxy start")}             Start the proxy (background daemon)
  ${chalk.cyan("portless proxy start -p 80")}       Start on port 80 (requires sudo)
  ${chalk.cyan("portless proxy stop")}              Stop the proxy
  ${chalk.cyan("portless <name> <cmd>")}            Run your app through the proxy
  ${chalk.cyan("portless run <cmd>")}              Auto-name from package.json and run
  ${chalk.cyan("portless list")}                    Show active routes

${chalk.bold("Examples:")}
  portless proxy start                # Start proxy on port 1355
  portless myapp next dev             # -> http://myapp.localhost:1355
  portless api.myapp pnpm start       # -> http://api.myapp.localhost:1355
  portless run next dev                 # Auto-name from package.json

${chalk.bold("In package.json:")}
  {
    "scripts": {
      "dev": "portless myapp next dev"
    }
  }

${chalk.bold("How it works:")}
  1. Start the proxy once (listens on port 1355 by default, no sudo needed)
  2. Run your apps - they auto-start the proxy and register automatically
  3. Access via http://<name>.localhost:1355
  4. .localhost domains auto-resolve to 127.0.0.1

${chalk.bold("Options:")}
  -p, --port <number>           Port for the proxy to listen on (default: 1355)
                                Ports < 1024 require sudo
  --foreground                  Run proxy in foreground (for debugging)

${chalk.bold("Environment variables:")}
  PORTLESS_PORT=<number>        Override the default proxy port (e.g. in .bashrc)
  PORTLESS_STATE_DIR=<path>     Override the state directory
  PORTLESS=0 | PORTLESS=skip    Run command directly without proxy

${chalk.bold("Config file (.portlessrc.json):")}
  Place a .portlessrc.json in your repo root to customize app names:
  {
    "names": {
      "@acme/web": "web",
      "@acme/api": "api"
    }
  }

${chalk.bold("Skip portless:")}
  PORTLESS=0 pnpm dev           # Runs command directly without proxy
  PORTLESS=skip pnpm dev        # Same as above
`);
    process.exit(0);
  }

  if (args[0] === "--version" || args[0] === "-v") {
    console.log(__VERSION__);
    process.exit(0);
  }

  // List routes
  if (args[0] === "list") {
    const { dir, port } = await discoverState();
    const store = new RouteStore(dir, {
      onWarning: (msg) => console.warn(chalk.yellow(msg)),
    });
    listRoutes(store, port);
    return;
  }

  // Proxy commands
  if (args[0] === "proxy") {
    if (args[1] === "stop") {
      const { dir, port } = await discoverState();
      const store = new RouteStore(dir, {
        onWarning: (msg) => console.warn(chalk.yellow(msg)),
      });
      await stopProxy(store, port);
      return;
    }

    if (args[1] !== "start") {
      // Bare "portless proxy" or unknown subcommand -- show usage hint
      console.log(`
${chalk.bold("Usage: portless proxy <command>")}

  ${chalk.cyan("portless proxy start")}                Start the proxy (daemon)
  ${chalk.cyan("portless proxy start --foreground")}   Start in foreground (for debugging)
  ${chalk.cyan("portless proxy start -p 80")}          Start on port 80 (requires sudo)
  ${chalk.cyan("portless proxy stop")}                 Stop the proxy
`);
      process.exit(args[1] ? 1 : 0);
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

    // Resolve state directory based on the port
    const stateDir = resolveStateDir(proxyPort);
    const store = new RouteStore(stateDir, {
      onWarning: (msg) => console.warn(chalk.yellow(msg)),
    });

    // Check if already running
    if (await isProxyRunning(proxyPort)) {
      if (isForeground) {
        // Foreground mode is used internally by the daemon fork; exit silently
        return;
      }
      const needsSudo = proxyPort < PRIVILEGED_PORT_THRESHOLD;
      const sudoPrefix = needsSudo ? "sudo " : "";
      console.log(chalk.yellow(`Proxy is already running on port ${proxyPort}.`));
      console.log(
        chalk.blue(`To restart: portless proxy stop && ${sudoPrefix}portless proxy start`)
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

    // Foreground mode: run the proxy directly in this process
    if (isForeground) {
      console.log(chalk.blue.bold("\nportless proxy\n"));
      startProxyServer(store, proxyPort);
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

      const daemonArgs = [process.argv[1], "proxy", "start", "--foreground"];
      if (portFlagIndex !== -1) {
        daemonArgs.push("--port", proxyPort.toString());
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
    if (!(await waitForProxy(proxyPort))) {
      console.error(chalk.red("Proxy failed to start (timed out waiting for it to listen)."));
      console.error(chalk.blue("Try starting the proxy in the foreground to see the error:"));
      const needsSudo = proxyPort < PRIVILEGED_PORT_THRESHOLD;
      console.error(chalk.cyan(`  ${needsSudo ? "sudo " : ""}portless proxy start --foreground`));
      if (fs.existsSync(logPath)) {
        console.error(chalk.gray(`Logs: ${logPath}`));
      }
      process.exit(1);
    }

    console.log(chalk.green(`Proxy started on port ${proxyPort}`));
    return;
  }

  // Run with auto-derived name
  if (args[0] === "run") {
    const commandArgs = args.slice(1);
    // Support optional -- separator: `portless run -- next dev`
    if (commandArgs[0] === "--") {
      commandArgs.shift();
    }

    if (commandArgs.length === 0) {
      console.error(chalk.red("Error: No command provided."));
      console.error(chalk.blue("Usage:"));
      console.error(chalk.cyan("  portless run <command...>"));
      console.error(chalk.blue("Example:"));
      console.error(chalk.cyan("  portless run next dev"));
      process.exit(1);
    }

    let name: string;
    try {
      name = resolveAppName(process.cwd());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`Error: ${message}`));
      process.exit(1);
    }

    const { dir, port } = await discoverState();
    const store = new RouteStore(dir, {
      onWarning: (msg) => console.warn(chalk.yellow(msg)),
    });
    await runApp(store, port, dir, name, commandArgs);
    return;
  }

  // Run app
  const name = args[0];
  const commandArgs = args.slice(1);

  if (commandArgs.length === 0) {
    console.error(chalk.red("Error: No command provided."));
    console.error(chalk.blue("Usage:"));
    console.error(chalk.cyan("  portless <name> <command...>"));
    console.error(chalk.blue("Example:"));
    console.error(chalk.cyan("  portless myapp next dev"));
    process.exit(1);
  }

  const { dir, port } = await discoverState();
  const store = new RouteStore(dir, {
    onWarning: (msg) => console.warn(chalk.yellow(msg)),
  });
  await runApp(store, port, dir, name, commandArgs);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red("Error:"), message);
  process.exit(1);
});

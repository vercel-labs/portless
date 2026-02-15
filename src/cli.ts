#!/usr/bin/env node

declare const __VERSION__: string;

import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { execSync, spawn, spawnSync } from "node:child_process";
import { createProxyServer } from "./proxy.js";
import { isErrnoException, parseHostname } from "./utils.js";
import { RouteStore } from "./routes.js";
import { findFreePort, isProxyRunning } from "./cli-utils.js";

/** Signal name to signal number mapping for exit code calculation. */
const SIGNAL_CODES: Record<string, number> = { SIGINT: 2, SIGTERM: 15 };

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.on("close", () => resolve(""));
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// Use /tmp for shared state so both sudo and non-sudo processes can access
const PORTLESS_DIR = "/tmp/portless";
const PROXY_PORT_PATH = path.join(PORTLESS_DIR, "proxy.port");
const DEFAULT_PROXY_PORT = 80;
const store = new RouteStore(PORTLESS_DIR, {
  onWarning: (msg) => console.warn(chalk.yellow(msg)),
});

/** Read the proxy port from the port file, falling back to 80. */
function readProxyPort(): number {
  try {
    const raw = fs.readFileSync(PROXY_PORT_PATH, "utf-8").trim();
    const port = parseInt(raw, 10);
    return isNaN(port) ? DEFAULT_PROXY_PORT : port;
  } catch {
    return DEFAULT_PROXY_PORT;
  }
}

/**
 * Try to find the PID of a process listening on the given TCP port.
 * Uses lsof, which is available on macOS and most Linux distributions.
 * Returns null if the PID cannot be determined.
 */
function findPidOnPort(port: number): number | null {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    // lsof may return multiple PIDs (one per line); take the first
    const pid = parseInt(output.trim().split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Poll until the proxy is listening or the timeout is reached.
 * Returns true if the proxy became ready, false on timeout.
 */
async function waitForProxy(
  proxyPort?: number,
  maxAttempts = 20,
  intervalMs = 250
): Promise<boolean> {
  const port = proxyPort ?? readProxyPort();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    if (await isProxyRunning(port)) {
      return true;
    }
  }
  return false;
}

/**
 * Spawn a command with proper signal forwarding, error handling, and exit
 * code propagation. Optionally runs a cleanup callback on exit/error/signal.
 */
function spawnCommand(
  commandArgs: string[],
  options?: {
    env?: NodeJS.ProcessEnv;
    onCleanup?: () => void;
  }
): void {
  const child = spawn(commandArgs[0], commandArgs.slice(1), {
    stdio: "inherit",
    env: options?.env,
  });

  let exiting = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (exiting) return;
    exiting = true;
    child.kill(signal);
    options?.onCleanup?.();
    process.exit(128 + (SIGNAL_CODES[signal] || 15));
  };

  process.on("SIGINT", () => handleSignal("SIGINT"));
  process.on("SIGTERM", () => handleSignal("SIGTERM"));

  child.on("error", (err) => {
    if (exiting) return;
    exiting = true;
    console.error(chalk.red(`Failed to run command: ${err.message}`));
    options?.onCleanup?.();
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (exiting) return;
    exiting = true;
    options?.onCleanup?.();
    if (signal) {
      process.exit(128 + (SIGNAL_CODES[signal] || 1));
    }
    process.exit(code ?? 1);
  });
}

function startProxyServer(proxyPort: number): void {
  store.ensureDir();

  // Create empty routes file if it doesn't exist
  const routesPath = store.getRoutesPath();
  if (!fs.existsSync(routesPath)) {
    fs.writeFileSync(routesPath, "[]", { mode: 0o644 });
  }
  try {
    fs.chmodSync(routesPath, 0o644);
  } catch {
    // May fail if file is owned by another user; non-fatal
  }

  // Cache routes in memory and reload on file change (debounced)
  let cachedRoutes = store.loadRoutes();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;

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
      debounceTimer = setTimeout(reloadRoutes, 100);
    });
  } catch {
    // fs.watch may not be supported; fall back to periodic polling
    console.warn(chalk.yellow("fs.watch unavailable; falling back to polling for route changes"));
    setInterval(reloadRoutes, 3000);
  }

  const server = createProxyServer({
    getRoutes: () => cachedRoutes,
    onError: (msg) => console.error(chalk.red(msg)),
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(chalk.red(`Port ${proxyPort} is already in use`));
    } else if (err.code === "EACCES") {
      console.error(chalk.red("Permission denied. Use: sudo portless proxy"));
    } else {
      console.error(chalk.red(`Proxy error: ${err.message}`));
    }
    process.exit(1);
  });

  server.listen(proxyPort, () => {
    // Save PID and port once the server is actually listening
    fs.writeFileSync(store.pidPath, process.pid.toString(), { mode: 0o644 });
    fs.writeFileSync(PROXY_PORT_PATH, proxyPort.toString(), { mode: 0o644 });
    console.log(chalk.green(`HTTP proxy listening on port ${proxyPort}`));
  });

  // Cleanup on exit
  let exiting = false;
  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    if (watcher) {
      watcher.close();
    }
    try {
      fs.unlinkSync(store.pidPath);
    } catch {
      // PID file may already be removed; non-fatal
    }
    try {
      fs.unlinkSync(PROXY_PORT_PATH);
    } catch {
      // Port file may already be removed; non-fatal
    }
    server.close(() => process.exit(0));
    // Force exit after a short timeout in case connections don't drain
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(chalk.cyan("\nProxy is running. Press Ctrl+C to stop.\n"));
  console.log(chalk.gray(`Routes file: ${store.getRoutesPath()}`));
}

async function stopProxy(): Promise<void> {
  const pidPath = store.pidPath;
  const proxyPort = readProxyPort();

  if (!fs.existsSync(pidPath)) {
    // PID file is missing -- check whether something is still listening
    if (await isProxyRunning(proxyPort)) {
      console.log(chalk.yellow(`PID file is missing but port ${proxyPort} is still in use.`));
      const pid = findPidOnPort(proxyPort);
      if (pid !== null) {
        try {
          process.kill(pid, "SIGTERM");
          try {
            fs.unlinkSync(PROXY_PORT_PATH);
          } catch {
            // Port file may already be absent; non-fatal
          }
          console.log(chalk.green(`Killed process ${pid}. Proxy stopped.`));
        } catch (err: unknown) {
          if (isErrnoException(err) && err.code === "EPERM") {
            console.error(chalk.red("Permission denied. The proxy runs as root."));
            console.log(chalk.blue("Use: sudo portless proxy stop"));
          } else {
            const message = err instanceof Error ? err.message : String(err);
            console.error(chalk.red("Failed to stop proxy:"), message);
          }
        }
      } else if (process.getuid?.() !== 0) {
        // Not running as root -- lsof likely cannot see root-owned processes
        console.error(chalk.red("Permission denied. The proxy likely runs as root."));
        console.log(chalk.blue("Use: sudo portless proxy stop"));
      } else {
        console.error(chalk.red(`Could not identify the process on port ${proxyPort}.`));
        console.log(chalk.blue(`Try: sudo kill "$(lsof -ti tcp:${proxyPort})"`));
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
      console.log(chalk.yellow("Proxy process is no longer running. Cleaning up."));
      fs.unlinkSync(pidPath);
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
      fs.unlinkSync(PROXY_PORT_PATH);
    } catch {
      // Port file may already be removed; non-fatal
    }
    console.log(chalk.green("Proxy stopped."));
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "EPERM") {
      console.error(chalk.red("Permission denied. The proxy runs as root."));
      console.log(chalk.blue("Use: sudo portless proxy stop"));
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red("Failed to stop proxy:"), message);
    }
  }
}

function listRoutes(): void {
  const routes = store.loadRoutes();

  if (routes.length === 0) {
    console.log(chalk.yellow("No active routes."));
    console.log(chalk.gray("Start an app with: portless <name> <command>"));
    return;
  }

  console.log(chalk.blue.bold("\nActive routes:\n"));
  for (const route of routes) {
    console.log(
      `  ${chalk.cyan(`http://${route.hostname}`)}  ${chalk.gray("->")}  ${chalk.white(`localhost:${route.port}`)}  ${chalk.gray(`(pid ${route.pid})`)}`
    );
  }
  console.log();
}

async function runApp(name: string, commandArgs: string[]) {
  const hostname = parseHostname(name);
  const proxyPort = readProxyPort();

  console.log(chalk.blue.bold(`\nportless\n`));
  console.log(chalk.gray(`-- ${hostname} (auto-resolves to 127.0.0.1)`));

  // Check if proxy is running, auto-start if possible
  if (!(await isProxyRunning(proxyPort))) {
    if (process.stdin.isTTY) {
      // Ask user if they want to start the proxy
      const answer = await prompt(chalk.yellow("Proxy not running. Start it? [Y/n/skip] "));

      if (answer === "n" || answer === "no") {
        console.log(chalk.gray("Cancelled."));
        process.exit(0);
      }

      if (answer === "s" || answer === "skip") {
        // Run command directly without proxy
        console.log(chalk.gray("Skipping proxy, running command directly...\n"));
        spawnCommand(commandArgs);
        return;
      }

      // Start the proxy
      console.log(chalk.yellow("Starting proxy (requires sudo)..."));

      // Use spawnSync so sudo can prompt for password (30s timeout)
      const result = spawnSync("sudo", [process.execPath, process.argv[1], "proxy", "--daemon"], {
        stdio: "inherit",
        timeout: 30_000,
      });

      if (result.status !== 0) {
        console.log(chalk.red("\nFailed to start proxy"));
        process.exit(1);
      }

      // Wait for proxy to be ready
      if (!(await waitForProxy())) {
        console.log(chalk.red("\nProxy failed to start"));
        const logPath = path.join(PORTLESS_DIR, "proxy.log");
        if (fs.existsSync(logPath)) {
          console.log(chalk.gray(`Check logs: ${logPath}`));
        }
        process.exit(1);
      }

      console.log(chalk.green("Proxy started in background"));
    } else {
      // No terminal, can't prompt
      console.log(chalk.red("\nProxy is not running!"));
      console.log(chalk.blue("\nStart the proxy first (one time):"));
      console.log(chalk.cyan("  sudo portless proxy\n"));
      process.exit(1);
    }
  } else {
    console.log(chalk.gray("-- Proxy is running"));
  }

  // Find a free port
  const port = await findFreePort();
  console.log(chalk.green(`-- Using port ${port}`));

  // Register route
  store.addRoute(hostname, port, process.pid);

  console.log(chalk.cyan.bold(`\n  -> http://${hostname}\n`));

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

async function main() {
  const args = process.argv.slice(2);

  // Block npx / pnpm dlx -- portless should be installed globally, not run
  // via npx. Running "sudo npx" is unsafe because it performs package
  // resolution and downloads as root.
  const isNpx = process.env.npm_command === "exec" && !process.env.npm_lifecycle_event;
  const isPnpmDlx = !!process.env.PNPM_SCRIPT_SRC_DIR && !process.env.npm_lifecycle_event;
  if (isNpx || isPnpmDlx) {
    console.error(chalk.red("Error: portless should not be run via npx or pnpm dlx."));
    console.log(chalk.blue("Install globally: npm install -g portless"));
    process.exit(1);
  }

  // Skip portless if PORTLESS=0 or PORTLESS=skip
  const skipPortless = process.env.PORTLESS === "0" || process.env.PORTLESS === "skip";
  if (skipPortless && args.length >= 2 && args[0] !== "proxy") {
    // Just run the command directly, skipping the first arg (the name)
    spawnCommand(args.slice(1));
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
  ${chalk.cyan("sudo portless proxy")}              Start the proxy (run once, keep open)
  ${chalk.cyan("sudo portless proxy --port 8080")}  Start the proxy on a custom port
  ${chalk.cyan("sudo portless proxy stop")}         Stop the proxy
  ${chalk.cyan("portless <name> <cmd>")}            Run your app through the proxy
  ${chalk.cyan("portless list")}                    Show active routes

${chalk.bold("Examples:")}
  sudo portless proxy               # Start proxy in terminal 1
  portless myapp next dev           # Terminal 2 -> http://myapp.localhost
  portless api.myapp pnpm start     # Terminal 3 -> http://api.myapp.localhost

${chalk.bold("In package.json:")}
  {
    "scripts": {
      "dev": "portless myapp next dev"
    }
  }

${chalk.bold("How it works:")}
  1. Start the proxy once with sudo (listens on port 80 by default)
  2. Run your apps - they register automatically  
  3. Access via http://<name>.localhost
  4. .localhost domains auto-resolve to 127.0.0.1

${chalk.bold("Options:")}
  --port <number>               Port for the proxy to listen on (default: 80)
                                Ports >= 1024 do not require sudo

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
    listRoutes();
    return;
  }

  // Proxy commands
  if (args[0] === "proxy") {
    if (args[1] === "stop") {
      await stopProxy();
      return;
    }

    const isDaemon = args.includes("--daemon");

    // Parse --port flag
    let proxyPort = DEFAULT_PROXY_PORT;
    const portFlagIndex = args.indexOf("--port");
    if (portFlagIndex !== -1) {
      const portValue = args[portFlagIndex + 1];
      if (!portValue || portValue.startsWith("-")) {
        console.error(chalk.red("Error: --port requires a port number"));
        console.log(chalk.blue("Usage: portless proxy --port 8080"));
        process.exit(1);
      }
      proxyPort = parseInt(portValue, 10);
      if (isNaN(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
        console.error(chalk.red(`Error: Invalid port number: ${portValue}`));
        console.log(chalk.blue("Port must be between 1 and 65535"));
        process.exit(1);
      }
    }

    // Check if already running
    if (await isProxyRunning(proxyPort)) {
      if (!isDaemon) {
        console.log(chalk.yellow("Proxy is already running."));
        console.log(chalk.blue("To restart: portless proxy stop && sudo portless proxy"));
      }
      return;
    }

    // Check if running as root (only required for privileged ports)
    if (proxyPort < 1024 && process.getuid!() !== 0) {
      console.error(chalk.red(`Error: Proxy requires sudo for port ${proxyPort}`));
      console.log(chalk.blue("Usage: sudo portless proxy"));
      process.exit(1);
    }

    // Daemon mode: fork and detach, logging to file
    if (isDaemon) {
      store.ensureDir();
      const logPath = path.join(PORTLESS_DIR, "proxy.log");
      const logFd = fs.openSync(logPath, "a");
      try {
        fs.chmodSync(logPath, 0o644);
      } catch {
        // May fail if file is owned by another user; non-fatal
      }

      const daemonArgs = [process.argv[1], "proxy"];
      if (portFlagIndex !== -1) {
        daemonArgs.push("--port", proxyPort.toString());
      }

      const child = spawn(process.execPath, daemonArgs, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      });
      child.unref();
      fs.closeSync(logFd);

      // Wait for proxy to be ready
      if (!(await waitForProxy(proxyPort))) {
        console.error(chalk.red("Proxy failed to start"));
        if (fs.existsSync(logPath)) {
          console.log(chalk.gray(`Check logs: ${logPath}`));
        }
        process.exit(1);
      }
      return;
    }

    console.log(chalk.blue.bold("\nportless proxy\n"));
    startProxyServer(proxyPort);
    return;
  }

  // Run app
  const name = args[0];
  const commandArgs = args.slice(1);

  if (commandArgs.length === 0) {
    console.error(chalk.red("Error: No command provided"));
    console.log(chalk.blue("Usage: portless <name> <command...>"));
    console.log(chalk.blue("Example: portless myapp next dev"));
    process.exit(1);
  }

  await runApp(name, commandArgs);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(chalk.red("Error:"), message);
  process.exit(1);
});

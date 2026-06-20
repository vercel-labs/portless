import colors from "./colors.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { formatUrl, parseHostname } from "./utils.js";
import { RouteStore, type RouteMapping, FILE_MODE, DIR_MODE } from "./routes.js";
import { inferProjectName, detectWorktreePrefix, truncateLabel } from "./auto.js";
import { ConfigValidationError, loadConfig, resolveAppConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { discoverWorkspacePackages, findWorkspaceRoot } from "./workspace.js";
import { discoverState, findPidsOnPort, isWindows } from "./cli-utils.js";
import { unregisterTailscale } from "./tailscale.js";
import { stopNgrok } from "./ngrok.js";

const MAX_LOG_SIZE = 1 * 1024 * 1024;
const KEEP_LOG_SIZE = 512 * 1024;
const DEFAULT_WAIT_SECONDS = 30;
const DEFAULT_TAIL_LINES = 100;
const STOP_WAIT_MS = 5_000;

type BgStartIntent = {
  name: string;
  appPort?: number;
  tailscale?: boolean;
  funnel?: boolean;
  ngrok?: boolean;
  routeForce?: boolean;
  commandArgs: string[];
  explicitCommand: boolean;
};

type BgProcessEntry = {
  name: string;
  pid: number;
  cwd: string;
  startedAt: string;
  intent: BgStartIntent;
};

type BgRegistry = Record<string, BgProcessEntry>;

type BgPaths = {
  rootDir: string;
  registryPath: string;
  logsDir: string;
};

type LogPaths = {
  stdout: string;
  stderr: string;
  bg: string;
};

type BgStartOptions = {
  name?: string;
  explicitName: boolean;
  appPort?: number;
  force: boolean;
  tailscale: boolean;
  funnel: boolean;
  ngrok: boolean;
  waitSeconds?: number;
  keep: boolean;
  json: boolean;
  commandArgs: string[];
  explicitCommand: boolean;
};

type BgRestartOptions = {
  waitSeconds?: number;
  keep: boolean;
  json: boolean;
  force: boolean;
};

type BgStopOptions = {
  force: boolean;
  json: boolean;
};

type BgStatus = {
  name: string;
  pid: number;
  running: boolean;
  cwd: string;
  startedAt: string;
  uptime: string | null;
  command: string;
  url: string | null;
  route: "registered" | "missing";
  logs: LogPaths;
};

function ensureSupportedPlatform(): void {
  if (isWindows) {
    console.error(colors.red("Error: portless bg is currently supported on macOS and Linux only."));
    process.exit(1);
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommand(pid: number): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
    encoding: "utf-8",
    timeout: 1000,
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function isManagedProcessRunning(entry: BgProcessEntry): boolean {
  if (!isProcessRunning(entry.pid)) return false;
  const command = readProcessCommand(entry.pid);
  if (!command) return false;
  const expectedNameFlag = `--name ${entry.name}`;
  return command.includes(" run ") && command.includes(expectedNameFlag);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Fall back to the process itself when the group is already gone.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already stopped.
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessRunning(pid);
}

async function getBgPaths(): Promise<BgPaths> {
  const state = await discoverState();
  const rootDir = path.join(state.dir, "bg");
  return {
    rootDir,
    registryPath: path.join(rootDir, "registry.json"),
    logsDir: path.join(rootDir, "logs"),
  };
}

function ensureBgDirs(paths: BgPaths): void {
  fs.mkdirSync(paths.logsDir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(paths.rootDir, DIR_MODE);
    fs.chmodSync(paths.logsDir, DIR_MODE);
  } catch {
    // Best effort.
  }
}

function getLogPaths(paths: BgPaths, name: string): LogPaths {
  return {
    stdout: path.join(paths.logsDir, `${name}.stdout.log`),
    stderr: path.join(paths.logsDir, `${name}.stderr.log`),
    bg: path.join(paths.logsDir, `${name}.bg.log`),
  };
}

function truncateLogFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_LOG_SIZE) return;
    const content = fs.readFileSync(filePath);
    const kept = content.slice(-KEEP_LOG_SIZE);
    const newlineIndex = kept.indexOf(10);
    const trimmed = newlineIndex > 0 ? kept.slice(newlineIndex + 1) : kept;
    fs.writeFileSync(filePath, trimmed, { mode: FILE_MODE });
  } catch {
    // Log capping must never fail the command.
  }
}

function appendBgLog(paths: BgPaths, name: string, message: string): void {
  ensureBgDirs(paths);
  const logPath = getLogPaths(paths, name).bg;
  truncateLogFile(logPath);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  fs.appendFileSync(logPath, line, { mode: FILE_MODE });
  truncateLogFile(logPath);
}

function clearRunLogs(paths: BgPaths, name: string): void {
  ensureBgDirs(paths);
  const logs = getLogPaths(paths, name);
  fs.writeFileSync(logs.stdout, "", { mode: FILE_MODE });
  fs.writeFileSync(logs.stderr, "", { mode: FILE_MODE });
}

function removeLogs(paths: BgPaths, name: string): void {
  const logs = getLogPaths(paths, name);
  for (const filePath of [logs.stdout, logs.stderr, logs.bg]) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already absent.
    }
  }
}

function readRegistry(paths: BgPaths): BgRegistry {
  ensureBgDirs(paths);
  if (!fs.existsSync(paths.registryPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.registryPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as BgRegistry;
  } catch {
    return {};
  }
}

function writeRegistry(paths: BgPaths, registry: BgRegistry): void {
  ensureBgDirs(paths);
  fs.writeFileSync(paths.registryPath, JSON.stringify(registry, null, 2), { mode: FILE_MODE });
}

function normalizeBgName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .split(".")
    .map((label) => truncateLabel(label))
    .join(".");
  const hostname = parseHostname(normalized, "localhost");
  return hostname.slice(0, -".localhost".length);
}

function loadAppConfig(cwd: string): AppConfig | null {
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

function isAmbiguousWorkspaceRoot(cwd: string, scriptName: string): boolean {
  const workspaceRoot = findWorkspaceRoot(cwd);
  if (!workspaceRoot || path.resolve(workspaceRoot) !== path.resolve(cwd)) return false;
  const packages = discoverWorkspacePackages(workspaceRoot);
  return packages.filter((pkg) => typeof pkg.scripts[scriptName] === "string").length > 1;
}

function inferBgName(cwd: string, explicitName?: string, allowAmbiguousRoot = false): string {
  if (explicitName) return normalizeBgName(explicitName);

  const appConfig = loadAppConfig(cwd);
  const scriptName = appConfig?.script ?? "dev";
  if (!allowAmbiguousRoot && isAmbiguousWorkspaceRoot(cwd, scriptName)) {
    console.error(colors.red("Error: portless bg does not support monorepo root mode yet."));
    console.error(
      colors.blue("Run from a workspace package directory or pass --name with a single command.")
    );
    process.exit(1);
  }

  const baseName = appConfig?.name
    ? appConfig.name
        .split(".")
        .map((label) => truncateLabel(label))
        .join(".")
    : inferProjectName(cwd).name;
  const worktree = detectWorktreePrefix(cwd);
  return normalizeBgName(worktree ? `${worktree.prefix}.${baseName}` : baseName);
}

function formatUptime(startedAt: string): string | null {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function shellCommandForDisplay(intent: BgStartIntent): string {
  const parts = ["portless", "run", ...buildRunArgs(intent)];
  return parts.join(" ");
}

function buildRunArgs(intent: BgStartIntent): string[] {
  const args = ["--name", intent.name];
  if (intent.routeForce) args.push("--force");
  if (intent.appPort !== undefined) args.push("--app-port", String(intent.appPort));
  if (intent.tailscale) args.push("--tailscale");
  if (intent.funnel) args.push("--funnel");
  if (intent.ngrok) args.push("--ngrok");
  if (intent.commandArgs.length > 0) args.push("--", ...intent.commandArgs);
  return args;
}

function parseOptionalSeconds(value: string | undefined, flag: string): number {
  if (value === undefined) return DEFAULT_WAIT_SECONDS;
  const seconds = parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(colors.red(`Error: ${flag} must be a positive number of seconds.`));
    process.exit(1);
  }
  return seconds;
}

function parseStartArgs(tokens: string[]): BgStartOptions {
  let name: string | undefined;
  let explicitName = false;
  let appPort: number | undefined;
  let force = false;
  let tailscale = false;
  let funnel = false;
  let ngrok = false;
  let waitSeconds: number | undefined;
  let keep = false;
  let json = false;
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "--") {
      i += 1;
      break;
    }
    if (!token.startsWith("-")) break;
    if (token === "--help" || token === "-h") {
      printBgStartHelp();
      process.exit(0);
    }
    if (token === "--name") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(colors.red("Error: --name requires a value."));
        process.exit(1);
      }
      name = value;
      explicitName = true;
      i += 2;
      continue;
    }
    if (token === "--force") {
      force = true;
      i += 1;
      continue;
    }
    if (token === "--app-port") {
      const value = tokens[i + 1];
      const port = parseInt(value ?? "", 10);
      if (!value || value.startsWith("-") || !Number.isFinite(port) || port < 1 || port > 65535) {
        console.error(colors.red("Error: --app-port requires a port between 1 and 65535."));
        process.exit(1);
      }
      appPort = port;
      i += 2;
      continue;
    }
    if (token === "--tailscale") {
      tailscale = true;
      i += 1;
      continue;
    }
    if (token === "--funnel") {
      funnel = true;
      tailscale = true;
      i += 1;
      continue;
    }
    if (token === "--ngrok") {
      ngrok = true;
      i += 1;
      continue;
    }
    if (token === "--wait" || token === "-w") {
      const next = tokens[i + 1];
      if (next && !next.startsWith("-") && /^\d+$/.test(next)) {
        waitSeconds = parseOptionalSeconds(next, token);
        i += 2;
      } else {
        waitSeconds = DEFAULT_WAIT_SECONDS;
        i += 1;
      }
      continue;
    }
    if (token === "--keep") {
      keep = true;
      i += 1;
      continue;
    }
    if (token === "--json") {
      json = true;
      i += 1;
      continue;
    }
    console.error(colors.red(`Error: Unknown flag "${token}".`));
    process.exit(1);
  }

  if (keep && waitSeconds === undefined) {
    console.error(colors.red("Error: --keep requires --wait."));
    process.exit(1);
  }

  const commandArgs = tokens.slice(i);
  return {
    name,
    explicitName,
    appPort,
    force,
    tailscale,
    funnel,
    ngrok,
    waitSeconds,
    keep,
    json,
    commandArgs,
    explicitCommand: commandArgs.length > 0,
  };
}

function parseNameCommand(
  tokens: string[],
  options: { allowForce?: boolean } = {}
): {
  name?: string;
  force: boolean;
  json: boolean;
} {
  let name: string | undefined;
  let force = false;
  let json = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--json") {
      json = true;
    } else if (token === "--force" || token === "-f") {
      if (!options.allowForce) {
        console.error(colors.red(`Error: Unknown flag "${token}".`));
        process.exit(1);
      }
      force = true;
    } else if (token === "--name" || token === "-n") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(colors.red(`Error: ${token} requires a value.`));
        process.exit(1);
      }
      name = value;
      i += 1;
    } else if (token.startsWith("-")) {
      console.error(colors.red(`Error: Unknown flag "${token}".`));
      process.exit(1);
    } else if (!name) {
      name = token;
    } else {
      console.error(colors.red(`Error: Unexpected argument "${token}".`));
      process.exit(1);
    }
  }
  return { name, force, json };
}

function parseRestartArgs(tokens: string[]): { name?: string; options: BgRestartOptions } {
  let name: string | undefined;
  let waitSeconds: number | undefined;
  let keep = false;
  let json = false;
  let force = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--wait" || token === "-w") {
      const next = tokens[i + 1];
      if (next && !next.startsWith("-") && /^\d+$/.test(next)) {
        waitSeconds = parseOptionalSeconds(next, token);
        i += 1;
      } else {
        waitSeconds = DEFAULT_WAIT_SECONDS;
      }
    } else if (token === "--keep") {
      keep = true;
    } else if (token === "--json") {
      json = true;
    } else if (token === "--force" || token === "-f") {
      force = true;
    } else if (token === "--name" || token === "-n") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(colors.red(`Error: ${token} requires a value.`));
        process.exit(1);
      }
      name = value;
      i += 1;
    } else if (token.startsWith("-")) {
      console.error(colors.red(`Error: Unknown flag "${token}".`));
      process.exit(1);
    } else if (!name) {
      name = token;
    } else {
      console.error(colors.red(`Error: Unexpected argument "${token}".`));
      process.exit(1);
    }
  }
  if (keep && waitSeconds === undefined) {
    console.error(colors.red("Error: --keep requires --wait."));
    process.exit(1);
  }
  return { name, options: { waitSeconds, keep, json, force } };
}

function readLastLines(filePath: string, count: number): string[] {
  if (count <= 0) return [];
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-count);
  } catch {
    return [];
  }
}

function readLog(filePath: string): string {
  if (!fs.existsSync(filePath)) return "";
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function findUrlInLog(filePath: string): string | null {
  const content = readLog(filePath);
  const match = content.match(/->\s+(https?:\/\/\S+)/);
  return match ? match[1] : null;
}

async function waitForUrl(
  entry: BgProcessEntry,
  stdoutPath: string,
  timeoutSeconds: number,
  keep: boolean
): Promise<string> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const url = findUrlInLog(stdoutPath);
    if (url) return url;
    if (!isManagedProcessRunning(entry)) {
      throw new Error(`Process ${entry.pid} exited before Portless printed a URL.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!keep && isManagedProcessRunning(entry)) {
    signalProcessGroup(entry.pid, "SIGTERM");
  }
  throw new Error(
    `Timeout: no Portless URL detected after ${timeoutSeconds}s${keep ? " (process still running)" : " (process killed)"}.`
  );
}

async function getRouteForEntry(
  entry: BgProcessEntry
): Promise<{ route: RouteMapping | null; url: string | null }> {
  const state = await discoverState();
  const store = new RouteStore(state.dir);
  const routes = store.loadRoutesRaw();
  const byPid = routes.find((route) => route.pid === entry.pid) ?? null;
  let byName: RouteMapping | null = null;
  try {
    const hostname = parseHostname(entry.name, state.tld);
    byName = routes.find((route) => route.hostname === hostname) ?? null;
  } catch {
    byName = null;
  }
  const route = byPid ?? byName;
  return { route, url: route ? formatUrl(route.hostname, state.port, state.tls) : null };
}

function buildStatus(
  entry: BgProcessEntry,
  paths: BgPaths,
  route: RouteMapping | null,
  url: string | null
): BgStatus {
  const running = isManagedProcessRunning(entry);
  return {
    name: entry.name,
    pid: entry.pid,
    running,
    cwd: entry.cwd,
    startedAt: entry.startedAt,
    uptime: running ? formatUptime(entry.startedAt) : null,
    command: shellCommandForDisplay(entry.intent),
    url,
    route: route ? "registered" : "missing",
    logs: getLogPaths(paths, entry.name),
  };
}

function printStatus(status: BgStatus): void {
  console.log(colors.bold(`${status.name} ${status.running ? "running" : "stopped"}`));
  console.log(`  PID: ${status.pid}`);
  if (status.url) console.log(`  URL: ${status.url}`);
  console.log(`  Route: ${status.route}`);
  console.log(`  Command: ${status.command}`);
  console.log(`  CWD: ${status.cwd}`);
  console.log(`  Started: ${status.startedAt}${status.uptime ? ` (${status.uptime})` : ""}`);
  console.log(`  Logs: ${status.logs.stdout}`);
  console.log(`  Error logs: ${status.logs.stderr}`);
  console.log(`  Bg logs: ${status.logs.bg}`);
  if (!status.running) {
    console.log(colors.gray(`  Clean: portless bg clean ${status.name}`));
  }
}

function spawnBgProcess(
  entryScript: string,
  cwd: string,
  intent: BgStartIntent,
  paths: BgPaths
): BgProcessEntry {
  ensureBgDirs(paths);
  const logs = getLogPaths(paths, intent.name);
  truncateLogFile(logs.bg);
  const stdoutFd = fs.openSync(logs.stdout, "a");
  const stderrFd = fs.openSync(logs.stderr, "a");
  const args = [entryScript, "run", ...buildRunArgs(intent)];

  try {
    const child = spawn(process.execPath, args, {
      cwd,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: process.env,
      windowsHide: true,
    });
    child.unref();
    const pid = child.pid;
    if (!pid) throw new Error("Failed to start background process.");
    return {
      name: intent.name,
      pid,
      cwd,
      startedAt: new Date().toISOString(),
      intent,
    };
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

async function scopedForceCleanup(
  entry: BgProcessEntry,
  paths: BgPaths
): Promise<{ killed: number[]; routeRemoved: boolean }> {
  const state = await discoverState();
  const store = new RouteStore(state.dir);
  const routes = store.loadRoutesRaw();
  const route = routes.find((candidate) => candidate.pid === entry.pid) ?? null;
  const killed: number[] = [];
  let routeRemoved = false;

  if (route) {
    try {
      unregisterTailscale(route);
    } catch {
      // Optional sharing cleanup.
    }
    try {
      stopNgrok(route);
    } catch {
      // Optional sharing cleanup.
    }
    for (const pid of findPidsOnPort(route.port)) {
      try {
        process.kill(pid, "SIGKILL");
        killed.push(pid);
      } catch {
        // Already gone.
      }
    }
    try {
      store.removeRoute(route.hostname, entry.pid);
      routeRemoved = true;
    } catch {
      // Best effort.
    }
  }

  appendBgLog(
    paths,
    entry.name,
    `force cleanup routeRemoved=${routeRemoved} killedPids=${killed.join(",") || "none"}`
  );
  return { killed, routeRemoved };
}

async function stopEntry(
  entry: BgProcessEntry,
  paths: BgPaths,
  options: BgStopOptions
): Promise<{
  name: string;
  pid: number;
  stopped: boolean;
  wasRunning: boolean;
  signal: NodeJS.Signals | null;
  forceCleanup?: { killed: number[]; routeRemoved: boolean };
}> {
  const wasRunning = isManagedProcessRunning(entry);
  const signal: NodeJS.Signals | null = wasRunning ? (options.force ? "SIGKILL" : "SIGTERM") : null;
  appendBgLog(paths, entry.name, `stop requested force=${options.force} wasRunning=${wasRunning}`);
  if (wasRunning && signal) {
    signalProcessGroup(entry.pid, signal);
    if (!options.force) await waitForExit(entry.pid, STOP_WAIT_MS);
  }
  let forceCleanup: { killed: number[]; routeRemoved: boolean } | undefined;
  if (options.force) {
    forceCleanup = await scopedForceCleanup(entry, paths);
  }
  return { name: entry.name, pid: entry.pid, stopped: true, wasRunning, signal, forceCleanup };
}

async function handleStart(tokens: string[], entryScript: string): Promise<void> {
  const options = parseStartArgs(tokens);
  const cwd = process.cwd();
  const name = inferBgName(cwd, options.name, options.explicitCommand || options.explicitName);
  const paths = await getBgPaths();
  const registry = readRegistry(paths);
  const existing = registry[name];

  if (existing && isManagedProcessRunning(existing)) {
    if (!options.force) {
      console.error(
        colors.red(
          `Error: ${name} is already running (PID ${existing.pid}). Use --force to restart.`
        )
      );
      process.exit(1);
    }
    await stopEntry(existing, paths, { force: false, json: options.json });
  } else if (existing) {
    appendBgLog(paths, name, `auto-clean dead entry pid=${existing.pid}`);
    removeLogs(paths, name);
  }

  clearRunLogs(paths, name);
  const intent: BgStartIntent = {
    name,
    appPort: options.appPort,
    tailscale: options.tailscale || undefined,
    funnel: options.funnel || undefined,
    ngrok: options.ngrok || undefined,
    routeForce: options.force || undefined,
    commandArgs: options.commandArgs,
    explicitCommand: options.explicitCommand,
  };
  appendBgLog(paths, name, `start command=${shellCommandForDisplay(intent)} cwd=${cwd}`);
  const entry = spawnBgProcess(entryScript, cwd, intent, paths);
  registry[name] = entry;
  writeRegistry(paths, registry);
  appendBgLog(paths, name, `started pid=${entry.pid}`);

  let url: string | null = null;
  if (options.waitSeconds !== undefined) {
    try {
      url = await waitForUrl(
        entry,
        getLogPaths(paths, name).stdout,
        options.waitSeconds,
        options.keep
      );
      appendBgLog(paths, name, `wait ready url=${url}`);
    } catch (err) {
      appendBgLog(paths, name, `wait failed message=${(err as Error).message}`);
      if (!options.keep) {
        delete registry[name];
        writeRegistry(paths, registry);
      }
      console.error(colors.red((err as Error).message));
      process.exit(1);
    }
  }

  if (options.json) {
    printJson({ name, pid: entry.pid, running: true, url, cwd, logs: getLogPaths(paths, name) });
    return;
  }
  console.log(colors.green(`Started ${name} in background.`));
  if (url) console.log(`URL: ${url}`);
  console.log(`PID: ${entry.pid}`);
  console.log(`Logs: ${getLogPaths(paths, name).stdout}`);
}

async function resolveExistingEntry(
  nameArg: string | undefined,
  paths: BgPaths
): Promise<{ name: string; entry: BgProcessEntry }> {
  const name = inferBgName(process.cwd(), nameArg);
  const registry = readRegistry(paths);
  const entry = registry[name];
  if (!entry) {
    console.error(colors.red(`Error: No background process named ${name}.`));
    process.exit(1);
  }
  return { name, entry };
}

async function handleStop(tokens: string[]): Promise<void> {
  const parsed = parseNameCommand(tokens, { allowForce: true });
  const paths = await getBgPaths();
  const { name, entry } = await resolveExistingEntry(parsed.name, paths);
  const registry = readRegistry(paths);
  const result = await stopEntry(entry, paths, { force: parsed.force, json: parsed.json });
  delete registry[name];
  writeRegistry(paths, registry);
  appendBgLog(paths, name, `stopped signal=${result.signal ?? "none"}`);

  if (parsed.json) {
    printJson(result);
    return;
  }
  console.log(colors.green(`Stopped ${name}.`));
  if (result.signal) console.log(`Signal: ${result.signal}`);
}

async function handleRestart(tokens: string[], entryScript: string): Promise<void> {
  const { name: nameArg, options } = parseRestartArgs(tokens);
  const paths = await getBgPaths();
  const { name, entry } = await resolveExistingEntry(nameArg, paths);
  const registry = readRegistry(paths);
  await stopEntry(entry, paths, { force: options.force, json: options.json });
  clearRunLogs(paths, name);
  const nextIntent = { ...entry.intent, routeForce: options.force || entry.intent.routeForce };
  appendBgLog(
    paths,
    name,
    `restart command=${shellCommandForDisplay(nextIntent)} cwd=${entry.cwd}`
  );
  const nextEntry = spawnBgProcess(entryScript, entry.cwd, nextIntent, paths);
  registry[name] = nextEntry;
  writeRegistry(paths, registry);
  appendBgLog(paths, name, `restarted pid=${nextEntry.pid}`);

  let url: string | null = null;
  if (options.waitSeconds !== undefined) {
    try {
      url = await waitForUrl(
        nextEntry,
        getLogPaths(paths, name).stdout,
        options.waitSeconds,
        options.keep
      );
      appendBgLog(paths, name, `wait ready url=${url}`);
    } catch (err) {
      appendBgLog(paths, name, `wait failed message=${(err as Error).message}`);
      if (!options.keep) {
        delete registry[name];
        writeRegistry(paths, registry);
      }
      console.error(colors.red((err as Error).message));
      process.exit(1);
    }
  }

  if (options.json) {
    printJson({
      name,
      pid: nextEntry.pid,
      restarted: true,
      running: true,
      url,
      cwd: nextEntry.cwd,
      logs: getLogPaths(paths, name),
    });
    return;
  }
  console.log(colors.green(`Restarted ${name}.`));
  if (url) console.log(`URL: ${url}`);
  console.log(`PID: ${nextEntry.pid}`);
}

async function handleStatus(tokens: string[]): Promise<void> {
  const parsed = parseNameCommand(tokens);
  const paths = await getBgPaths();
  const { entry } = await resolveExistingEntry(parsed.name, paths);
  const { route, url } = await getRouteForEntry(entry);
  const status = buildStatus(entry, paths, route, url);
  if (parsed.json) printJson(status);
  else printStatus(status);
}

async function handleList(tokens: string[]): Promise<void> {
  const parsed = parseNameCommand(tokens);
  if (parsed.name) {
    console.error(colors.red("Error: portless bg list does not accept a process name."));
    process.exit(1);
  }
  const paths = await getBgPaths();
  const registry = readRegistry(paths);
  const entries = Object.values(registry).sort((a, b) => a.name.localeCompare(b.name));
  const statuses: BgStatus[] = [];
  for (const entry of entries) {
    const { route, url } = await getRouteForEntry(entry);
    statuses.push(buildStatus(entry, paths, route, url));
  }
  if (parsed.json) {
    printJson(statuses);
    return;
  }
  if (statuses.length === 0) {
    console.log(colors.yellow("No background processes."));
    console.log(colors.gray("Start one with: portless bg start --wait"));
    return;
  }
  console.log(colors.blue.bold("\nBackground processes:\n"));
  for (const status of statuses) {
    const state = status.running ? colors.green("running") : colors.yellow("stopped");
    console.log(`  ${colors.cyan(status.name)}  ${state}  pid ${status.pid}`);
    if (status.url) console.log(`    ${status.url}`);
    console.log(`    cwd: ${status.cwd}`);
  }
  console.log();
}

function parseLogsArgs(tokens: string[]): {
  name?: string;
  tail: number;
  follow: boolean;
  errors: boolean;
  all: boolean;
  bg: boolean;
} {
  let name: string | undefined;
  let tail = DEFAULT_TAIL_LINES;
  let follow = false;
  let errors = false;
  let all = false;
  let bg = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--tail" || token === "-t") {
      const value = tokens[i + 1];
      const parsed = parseInt(value ?? "", 10);
      if (!value || value.startsWith("-") || !Number.isFinite(parsed) || parsed < 0) {
        console.error(colors.red(`Error: ${token} requires a non-negative line count.`));
        process.exit(1);
      }
      tail = parsed;
      i += 1;
    } else if (token === "--follow" || token === "-f") {
      follow = true;
    } else if (token === "--errors" || token === "-e") {
      errors = true;
    } else if (token === "--all" || token === "-a") {
      all = true;
    } else if (token === "--bg") {
      bg = true;
    } else if (token === "--name" || token === "-n") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(colors.red(`Error: ${token} requires a value.`));
        process.exit(1);
      }
      name = value;
      i += 1;
    } else if (token.startsWith("-")) {
      console.error(colors.red(`Error: Unknown flag "${token}".`));
      process.exit(1);
    } else if (!name) {
      name = token;
    } else {
      console.error(colors.red(`Error: Unexpected argument "${token}".`));
      process.exit(1);
    }
  }
  if (errors && bg) {
    console.error(colors.red("Error: --errors and --bg cannot be used together."));
    process.exit(1);
  }
  return { name, tail, follow, errors, all, bg };
}

async function handleLogs(tokens: string[]): Promise<void> {
  const parsed = parseLogsArgs(tokens);
  const paths = await getBgPaths();
  const { name } = await resolveExistingEntry(parsed.name, paths);
  const logs = getLogPaths(paths, name);
  const logPath = parsed.bg ? logs.bg : parsed.errors ? logs.stderr : logs.stdout;
  if (!fs.existsSync(logPath)) {
    console.error(colors.red(`Error: No logs found for ${name}.`));
    process.exit(1);
  }
  truncateLogFile(logPath);
  if (parsed.follow) {
    const tail = spawn("tail", ["-f", logPath], { stdio: "inherit" });
    process.on("SIGINT", () => {
      tail.kill();
      process.exit(0);
    });
    return;
  }
  if (parsed.all) {
    process.stdout.write(readLog(logPath));
    return;
  }
  const lines = readLastLines(logPath, parsed.tail);
  if (lines.length > 0) console.log(lines.join("\n"));
}

async function handleClean(tokens: string[]): Promise<void> {
  let all = false;
  let json = false;
  let nameArg: string | undefined;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--all" || token === "-a") all = true;
    else if (token === "--json") json = true;
    else if (token === "--name" || token === "-n") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(colors.red(`Error: ${token} requires a value.`));
        process.exit(1);
      }
      nameArg = value;
      i += 1;
    } else if (token.startsWith("-")) {
      console.error(colors.red(`Error: Unknown flag "${token}".`));
      process.exit(1);
    } else if (!nameArg) nameArg = token;
    else {
      console.error(colors.red(`Error: Unexpected argument "${token}".`));
      process.exit(1);
    }
  }
  const paths = await getBgPaths();
  const registry = readRegistry(paths);
  const names = all ? Object.keys(registry) : [inferBgName(process.cwd(), nameArg)];
  const cleaned: string[] = [];
  for (const name of names) {
    const entry = registry[name];
    if (!entry) continue;
    if (isManagedProcessRunning(entry)) continue;
    delete registry[name];
    removeLogs(paths, name);
    cleaned.push(name);
  }
  writeRegistry(paths, registry);
  if (json) {
    printJson({ cleaned });
    return;
  }
  if (cleaned.length === 0) console.log("No dead background processes found.");
  else
    console.log(
      colors.green(
        `Cleaned ${cleaned.length} background process${cleaned.length === 1 ? "" : "es"}.`
      )
    );
}

function printBgHelp(): void {
  console.log(`
${colors.bold("portless bg")} - Manage Portless apps in the background.

${colors.bold("Usage:")}
  ${colors.cyan("portless bg start [options] [command...]")}
  ${colors.cyan("portless bg stop [name]")}
  ${colors.cyan("portless bg restart [name]")}
  ${colors.cyan("portless bg status [name]")}
  ${colors.cyan("portless bg list")}
  ${colors.cyan("portless bg logs [name]")}
  ${colors.cyan("portless bg clean [name]")}
  ${colors.cyan("portless bg clean --all")}

${colors.bold("Examples:")}
  portless bg start --wait
  portless bg start --name web --wait pnpm dev
  portless bg logs web --tail 200
  portless bg restart web --wait
  portless bg stop web
`);
}

function printBgStartHelp(): void {
  console.log(`
${colors.bold("portless bg start")} - Start a Portless app in the background.

${colors.bold("Usage:")}
  ${colors.cyan("portless bg start [options] [command...]")}

${colors.bold("Options:")}
  --name <name>          Use <name> as the app and background process name
  --force                Stop an existing bg process and pass --force to portless run
  --app-port <number>    Use a fixed app port
  --tailscale            Share on your Tailscale network
  --funnel               Share publicly via Tailscale Funnel
  --ngrok                Share publicly via ngrok
  --wait [seconds]       Wait for the Portless URL (default: 30 seconds)
  --keep                 Keep the process running if --wait times out
  --json                 Print machine-readable output
`);
}

export async function handleBg(args: string[], options: { entryScript: string }): Promise<void> {
  const subcommand = args[1];
  const tokens = args.slice(2);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printBgHelp();
    return;
  }

  ensureSupportedPlatform();

  if (subcommand === "start") {
    await handleStart(tokens, options.entryScript);
    return;
  }
  if (subcommand === "stop") {
    await handleStop(tokens);
    return;
  }
  if (subcommand === "restart") {
    await handleRestart(tokens, options.entryScript);
    return;
  }
  if (subcommand === "status") {
    await handleStatus(tokens);
    return;
  }
  if (subcommand === "list") {
    await handleList(tokens);
    return;
  }
  if (subcommand === "logs") {
    await handleLogs(tokens);
    return;
  }
  if (subcommand === "clean") {
    await handleClean(tokens);
    return;
  }

  console.error(colors.red(`Error: Unknown bg subcommand "${subcommand}".`));
  printBgHelp();
  process.exit(1);
}

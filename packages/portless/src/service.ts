import colors from "./colors.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureCerts, isCATrusted, trustCA } from "./certs.js";
import {
  buildProxyStartConfig,
  DEFAULT_TLD,
  getProtocolPort,
  isProxyRunning,
} from "./cli-utils.js";
import { fixOwnership } from "./utils.js";

const SERVICE_PORT = getProtocolPort(true);
const SERVICE_LABEL = "sh.portless.proxy";
const SYSTEMD_SERVICE = "portless.service";
const WINDOWS_TASK_NAME = "Portless Proxy";
const INTERNAL_ELEVATED_ENV = "PORTLESS_INTERNAL_SERVICE_ELEVATED";

type SupportedPlatform = "darwin" | "linux" | "win32";

type CommandRunner = (
  command: string,
  args: string[],
  options?: { stdio?: "pipe" | "inherit" }
) => {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
};

type UserContext = {
  home: string;
  uid?: string;
  gid?: string;
  username?: string;
};

type ServiceContext = {
  platform: SupportedPlatform;
  nodePath: string;
  entryScript: string;
  stateDir: string;
  user: UserContext;
  pathEnv: string;
  programData: string;
};

export type ServiceSpec =
  | {
      platform: "darwin";
      label: string;
      plistPath: string;
      plist: string;
      stateDir: string;
      programArguments: string[];
    }
  | {
      platform: "linux";
      serviceName: string;
      unitPath: string;
      unit: string;
      stateDir: string;
      execStart: string[];
    }
  | {
      platform: "win32";
      taskName: string;
      stateDir: string;
      scriptDir: string;
      scriptPath: string;
      script: string;
      taskRun: string;
      createArgs: string[];
      runArgs: string[];
      deleteArgs: string[];
      queryArgs: string[];
    };

type ServiceStatus = {
  installed: boolean;
  managerState: string;
  proxyRunning: boolean;
  details?: string;
};

export type ServiceUninstallResult = {
  removed: boolean;
  installed: boolean;
  error?: string;
  needsElevation?: boolean;
};

function defaultRunner(command: string, args: string[], options?: { stdio?: "pipe" | "inherit" }) {
  return spawnSync(command, args, {
    encoding: "utf-8",
    stdio: options?.stdio ?? "pipe",
  });
}

function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function systemdEscape(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function windowsQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function readPasswdHome(username: string): string | null {
  try {
    const passwd = fs.readFileSync("/etc/passwd", "utf-8");
    for (const line of passwd.split("\n")) {
      const fields = line.split(":");
      if (fields[0] === username && fields[5]) {
        return fields[5];
      }
    }
  } catch {
    // Ignore and fall back to platform conventions.
  }
  return null;
}

function resolveUserContext(platform: SupportedPlatform): UserContext {
  if (platform === "win32") {
    const home = process.env.USERPROFILE || os.homedir();
    return { home, username: process.env.USERNAME };
  }

  const sudoUser = process.env.SUDO_USER;
  const sudoUid = process.env.SUDO_UID;
  const sudoGid = process.env.SUDO_GID;
  if (sudoUser && sudoUser !== "root") {
    const home =
      process.env.HOME && process.env.HOME !== "/var/root" && process.env.HOME !== "/root"
        ? process.env.HOME
        : readPasswdHome(sudoUser) ||
          (platform === "darwin"
            ? path.posix.join("/Users", sudoUser)
            : path.posix.join("/home", sudoUser));
    return { home, uid: sudoUid, gid: sudoGid, username: sudoUser };
  }

  const userInfo = os.userInfo();
  return {
    home: os.homedir(),
    uid: process.getuid?.()?.toString(),
    gid: process.getgid?.()?.toString(),
    username: userInfo.username,
  };
}

function buildProxyCommand(entryScript: string): string[] {
  const config = buildProxyStartConfig({
    useHttps: true,
    lanMode: false,
    tld: DEFAULT_TLD,
    foreground: true,
    includePort: true,
    proxyPort: SERVICE_PORT,
    skipTrust: true,
  });
  return [entryScript, "proxy", "start", ...config.args];
}

function buildServiceEnv(ctx: ServiceContext): Record<string, string> {
  const env: Record<string, string> = {
    PORTLESS_STATE_DIR: ctx.stateDir,
  };

  if (ctx.platform === "win32") {
    env.USERPROFILE = ctx.user.home;
    env.PATH = ctx.pathEnv;
  } else {
    env.HOME = ctx.user.home;
    if (ctx.user.uid) env.SUDO_UID = ctx.user.uid;
    if (ctx.user.gid) env.SUDO_GID = ctx.user.gid;
  }

  return env;
}

function defaultStateDir(platform: SupportedPlatform, userHome: string): string {
  return platform === "win32"
    ? path.win32.join(userHome, ".portless")
    : path.posix.join(userHome, ".portless");
}

function buildLaunchdPlist(ctx: ServiceContext, programArguments: string[]): string {
  const env = buildServiceEnv(ctx);
  const envEntries = Object.entries(env)
    .map(
      ([key, value]) => `    <key>${xmlEscape(key)}</key>
    <string>${xmlEscape(value)}</string>`
    )
    .join("\n");
  const args = programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.posix.join(ctx.stateDir, "service.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.posix.join(ctx.stateDir, "service.log"))}</string>
</dict>
</plist>
`;
}

function buildSystemdUnit(ctx: ServiceContext, execStart: string[]): string {
  const env = buildServiceEnv(ctx);
  const envLines = Object.entries(env)
    .map(([key, value]) => `Environment=${key}=${systemdEscape(value)}`)
    .join("\n");

  return `[Unit]
Description=Portless HTTPS proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${envLines}
Environment=PATH=${systemdEscape(ctx.pathEnv)}
ExecStart=${execStart.map(systemdEscape).join(" ")}
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=5

[Install]
WantedBy=multi-user.target
`;
}

function buildWindowsScript(ctx: ServiceContext, command: string[]): string {
  const env = buildServiceEnv(ctx);
  const setEnv = Object.entries(env)
    .map(([key, value]) => `set "${key}=${value.replace(/"/g, "").replace(/%/g, "%%")}"`)
    .join("\r\n");
  const proxyCommand = [windowsQuote(ctx.nodePath), ...command.map(windowsQuote)].join(" ");
  return `@echo off\r\n${setEnv}\r\n${proxyCommand}\r\n`;
}

export function buildServiceSpec(options: {
  platform: SupportedPlatform;
  nodePath: string;
  entryScript: string;
  userHome: string;
  uid?: string;
  gid?: string;
  username?: string;
  stateDir?: string;
  pathEnv?: string;
  programData?: string;
}): ServiceSpec {
  const ctx: ServiceContext = {
    platform: options.platform,
    nodePath: options.nodePath,
    entryScript: options.entryScript,
    stateDir: options.stateDir || defaultStateDir(options.platform, options.userHome),
    user: {
      home: options.userHome,
      uid: options.uid,
      gid: options.gid,
      username: options.username,
    },
    pathEnv: options.pathEnv || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    programData: options.programData || "C:\\ProgramData",
  };
  const proxyCommand = buildProxyCommand(ctx.entryScript);

  if (ctx.platform === "darwin") {
    const programArguments = [ctx.nodePath, ...proxyCommand];
    return {
      platform: "darwin",
      label: SERVICE_LABEL,
      plistPath: `/Library/LaunchDaemons/${SERVICE_LABEL}.plist`,
      plist: buildLaunchdPlist(ctx, programArguments),
      stateDir: ctx.stateDir,
      programArguments,
    };
  }

  if (ctx.platform === "linux") {
    const execStart = [ctx.nodePath, ...proxyCommand];
    return {
      platform: "linux",
      serviceName: SYSTEMD_SERVICE,
      unitPath: `/etc/systemd/system/${SYSTEMD_SERVICE}`,
      unit: buildSystemdUnit(ctx, execStart),
      stateDir: ctx.stateDir,
      execStart,
    };
  }

  const scriptDir = path.win32.join(ctx.programData, "portless", "service");
  const scriptPath = path.win32.join(scriptDir, "portless-service.cmd");
  const script = buildWindowsScript(ctx, proxyCommand);
  const taskRun = windowsQuote(scriptPath);
  return {
    platform: "win32",
    taskName: WINDOWS_TASK_NAME,
    stateDir: ctx.stateDir,
    scriptDir,
    scriptPath,
    script,
    taskRun,
    createArgs: [
      "/Create",
      "/TN",
      WINDOWS_TASK_NAME,
      "/SC",
      "ONSTART",
      "/RU",
      "SYSTEM",
      "/RL",
      "HIGHEST",
      "/TR",
      taskRun,
      "/F",
    ],
    runArgs: ["/Run", "/TN", WINDOWS_TASK_NAME],
    deleteArgs: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"],
    queryArgs: ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"],
  };
}

function currentServiceSpec(entryScript: string): ServiceSpec {
  if (!isSupportedPlatform(process.platform)) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  const user = resolveUserContext(process.platform);
  return buildServiceSpec({
    platform: process.platform,
    nodePath: process.execPath,
    entryScript,
    userHome: user.home,
    uid: user.uid,
    gid: user.gid,
    username: user.username,
    stateDir: process.env.PORTLESS_STATE_DIR || defaultStateDir(process.platform, user.home),
    pathEnv: process.env.PATH,
    programData: process.env.ProgramData,
  });
}

function collectPortlessEnvArgs(
  env: NodeJS.ProcessEnv = process.env,
  omit: Set<string> = new Set()
): string[] {
  const envArgs: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.startsWith("PORTLESS_") && env[key] && !omit.has(key)) {
      envArgs.push(`${key}=${env[key]}`);
    }
  }
  return envArgs;
}

function buildElevatedEnvArgs(options: {
  home: string;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  extraEnv?: Record<string, string>;
}): string[] {
  const extraEnv = options.extraEnv ?? {};
  const overrideKeys = new Set(["PORTLESS_STATE_DIR", ...Object.keys(extraEnv)]);
  return [
    "env",
    ...collectPortlessEnvArgs(options.env, overrideKeys),
    ...Object.entries(extraEnv).map(([key, value]) => `${key}=${value}`),
    `HOME=${options.home}`,
    `PORTLESS_STATE_DIR=${options.stateDir}`,
  ];
}

export function buildServiceUninstallSudoArgs(
  entryScript: string,
  options: {
    nodePath?: string;
    home?: string;
    stateDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): string[] {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const stateDir = options.stateDir ?? env.PORTLESS_STATE_DIR ?? path.join(home, ".portless");
  return [
    ...buildElevatedEnvArgs({ home, stateDir, env }),
    options.nodePath ?? process.execPath,
    entryScript,
    "service",
    "uninstall",
  ];
}

function requireUnixElevation(args: string[], runner: CommandRunner): void {
  if (process.platform !== "darwin" && process.platform !== "linux") return;
  if ((process.getuid?.() ?? -1) === 0) return;
  if (process.env[INTERNAL_ELEVATED_ENV] === "1") return;

  const home = os.homedir();
  const stateDir = process.env.PORTLESS_STATE_DIR || path.join(home, ".portless");
  const result = runner(
    "sudo",
    [
      ...buildElevatedEnvArgs({
        home,
        stateDir,
        extraEnv: { [INTERNAL_ELEVATED_ENV]: "1" },
      }),
      process.execPath,
      args[0],
      ...args.slice(1),
    ],
    { stdio: "inherit" }
  );

  process.exit(result.status ?? 1);
}

function runRequired(runner: CommandRunner, command: string, args: string[]): void {
  const result = runner(command, args);
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || result.error?.message || `${command} failed`;
    throw new Error(detail.trim());
  }
}

function runOptional(runner: CommandRunner, command: string, args: string[]): void {
  runner(command, args);
}

function isPermissionError(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err ? String((err as { code?: unknown }).code) : "";
  const message = err instanceof Error ? err.message : String(err);
  return (
    code === "EACCES" ||
    code === "EPERM" ||
    /permission denied|operation not permitted|access is denied/i.test(message)
  );
}

function stopExistingProxy(entryScript: string, runner: CommandRunner): void {
  runRequired(runner, process.execPath, [
    entryScript,
    "proxy",
    "stop",
    "--port",
    SERVICE_PORT.toString(),
  ]);
}

function prepareTrust(stateDir: string): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fixOwnership(stateDir);
  try {
    ensureCerts(stateDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to generate certificates in ${stateDir}. Ensure OpenSSL is installed.\n${detail}`
    );
  }
  if (isCATrusted(stateDir)) return;

  console.log(colors.gray("Trusting portless CA for service startup..."));
  const trustResult = trustCA(stateDir);
  if (trustResult.trusted) {
    console.log(colors.green("CA added to the system trust store."));
    return;
  }

  console.warn(colors.yellow("Could not add the CA to the system trust store."));
  if (trustResult.error) {
    console.warn(colors.gray(trustResult.error));
  }
  console.warn(colors.yellow("Run `portless trust` if browsers show certificate warnings."));
}

async function installService(entryScript: string, runner: CommandRunner): Promise<void> {
  requireUnixElevation([entryScript, "service", "install"], runner);
  const spec = currentServiceSpec(entryScript);
  prepareTrust(spec.stateDir);

  if (spec.platform === "darwin") {
    runOptional(runner, "launchctl", ["bootout", "system", spec.plistPath]);
    stopExistingProxy(entryScript, runner);
    fs.writeFileSync(spec.plistPath, spec.plist);
    fs.chmodSync(spec.plistPath, 0o644);
    runRequired(runner, "chown", ["root:wheel", spec.plistPath]);
    runRequired(runner, "launchctl", ["bootstrap", "system", spec.plistPath]);
    runRequired(runner, "launchctl", ["enable", `system/${spec.label}`]);
    runRequired(runner, "launchctl", ["kickstart", "-k", `system/${spec.label}`]);
  } else if (spec.platform === "linux") {
    runOptional(runner, "systemctl", ["disable", "--now", spec.serviceName]);
    stopExistingProxy(entryScript, runner);
    fs.writeFileSync(spec.unitPath, spec.unit);
    fs.chmodSync(spec.unitPath, 0o644);
    runRequired(runner, "systemctl", ["daemon-reload"]);
    runRequired(runner, "systemctl", ["enable", spec.serviceName]);
    runRequired(runner, "systemctl", ["restart", spec.serviceName]);
  } else {
    runOptional(runner, "schtasks", ["/End", "/TN", spec.taskName]);
    stopExistingProxy(entryScript, runner);
    fs.mkdirSync(spec.scriptDir, { recursive: true });
    fs.writeFileSync(spec.scriptPath, spec.script);
    runRequired(runner, "schtasks", spec.createArgs);
    runOptional(runner, "schtasks", spec.runArgs);
  }

  console.log(colors.green("Portless service installed."));
  console.log(colors.gray(`State directory: ${spec.stateDir}`));
}

async function uninstallService(entryScript: string, runner: CommandRunner): Promise<void> {
  requireUnixElevation([entryScript, "service", "uninstall"], runner);
  const spec = currentServiceSpec(entryScript);

  if (spec.platform === "darwin") {
    runOptional(runner, "launchctl", ["bootout", "system", spec.plistPath]);
    fs.rmSync(spec.plistPath, { force: true });
  } else if (spec.platform === "linux") {
    runOptional(runner, "systemctl", ["disable", "--now", spec.serviceName]);
    fs.rmSync(spec.unitPath, { force: true });
    runOptional(runner, "systemctl", ["daemon-reload"]);
  } else {
    runOptional(runner, "schtasks", ["/End", "/TN", spec.taskName]);
    runOptional(runner, "schtasks", spec.deleteArgs);
    fs.rmSync(spec.scriptDir, { recursive: true, force: true });
  }

  console.log(colors.green("Portless service uninstalled."));
}

/**
 * Best-effort service removal for use by `portless clean`. Skips elevation
 * (caller is expected to already be elevated) and returns a result instead of
 * calling process.exit.
 */
export function tryUninstallService(
  entryScript: string,
  runner: CommandRunner = defaultRunner
): ServiceUninstallResult {
  let installed = false;
  try {
    const spec = currentServiceSpec(entryScript);

    if (spec.platform === "darwin") {
      installed = fs.existsSync(spec.plistPath);
      if (!installed) return { removed: false, installed: false };
      runOptional(runner, "launchctl", ["bootout", "system", spec.plistPath]);
      fs.rmSync(spec.plistPath, { force: true });
    } else if (spec.platform === "linux") {
      installed = fs.existsSync(spec.unitPath);
      if (!installed) return { removed: false, installed: false };
      runOptional(runner, "systemctl", ["disable", "--now", spec.serviceName]);
      fs.rmSync(spec.unitPath, { force: true });
      runOptional(runner, "systemctl", ["daemon-reload"]);
    } else {
      const query = runner("schtasks", ["/Query", "/TN", spec.taskName, "/FO", "LIST"]);
      installed = query.status === 0;
      if (!installed) return { removed: false, installed: false };
      runOptional(runner, "schtasks", ["/End", "/TN", spec.taskName]);
      runRequired(runner, "schtasks", spec.deleteArgs);
      fs.rmSync(spec.scriptDir, { recursive: true, force: true });
    }

    return { removed: true, installed: true };
  } catch (err) {
    return {
      removed: false,
      installed,
      error: err instanceof Error ? err.message : String(err),
      needsElevation: installed && isPermissionError(err),
    };
  }
}

async function getServiceStatus(
  entryScript: string,
  runner: CommandRunner
): Promise<ServiceStatus> {
  const spec = currentServiceSpec(entryScript);
  const proxyRunning = await isProxyRunning(SERVICE_PORT);

  if (spec.platform === "darwin") {
    const installed = fs.existsSync(spec.plistPath);
    const result = runner("launchctl", ["print", `system/${spec.label}`]);
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    const managerState =
      result.status === 0 && /state = running|pid = \d+/.test(output)
        ? "running"
        : installed
          ? "installed"
          : "not installed";
    return { installed, managerState, proxyRunning, details: spec.plistPath };
  }

  if (spec.platform === "linux") {
    const enabled = runner("systemctl", ["is-enabled", spec.serviceName]);
    const active = runner("systemctl", ["is-active", spec.serviceName]);
    const installed = enabled.status === 0 || active.status === 0 || fs.existsSync(spec.unitPath);
    const activeText = (active.stdout || "").trim();
    return {
      installed,
      managerState:
        active.status === 0 ? activeText || "active" : installed ? "installed" : "not installed",
      proxyRunning,
      details: spec.unitPath,
    };
  }

  const query = runner("schtasks", spec.queryArgs);
  const output = `${query.stdout || ""}${query.stderr || ""}`;
  const installed = query.status === 0;
  const stateMatch = output.match(/^\s*Status:\s*(.+)$/im);
  return {
    installed,
    managerState: installed ? stateMatch?.[1]?.trim() || "installed" : "not installed",
    proxyRunning,
    details: spec.taskName,
  };
}

async function printServiceStatus(entryScript: string, runner: CommandRunner): Promise<void> {
  const spec = currentServiceSpec(entryScript);
  const status = await getServiceStatus(entryScript, runner);
  console.log(colors.bold("portless service"));
  console.log(`  Manager state: ${status.managerState}`);
  console.log(`  Installed: ${status.installed ? "yes" : "no"}`);
  console.log(`  Proxy on 443: ${status.proxyRunning ? "responding" : "not responding"}`);
  console.log(`  State directory: ${spec.stateDir}`);
  if (status.details) {
    console.log(`  Service entry: ${status.details}`);
  }
}

export function printServiceHelp(): void {
  console.log(`
${colors.bold("portless service")} - Start portless automatically when the OS starts.

${colors.bold("Usage:")}
  ${colors.cyan("portless service install")}      Install and start the HTTPS service on port 443
  ${colors.cyan("portless service uninstall")}    Stop and remove the startup service
  ${colors.cyan("portless service status")}       Show service and proxy status

${colors.bold("Notes:")}
  The service uses the default clean URL mode: HTTPS on port 443.
  macOS and Linux install a root-owned service so port 443 can bind at boot.
  Windows installs a Task Scheduler startup task that runs as SYSTEM.
`);
}

export async function handleService(
  args: string[],
  options: { entryScript: string; runner?: CommandRunner }
): Promise<void> {
  const action = args[1];
  const runner = options.runner || defaultRunner;

  if (!action || action === "--help" || action === "-h") {
    printServiceHelp();
    process.exit(0);
  }

  try {
    if (action === "install") {
      await installService(options.entryScript, runner);
      return;
    }
    if (action === "uninstall") {
      await uninstallService(options.entryScript, runner);
      return;
    }
    if (action === "status") {
      await printServiceStatus(options.entryScript, runner);
      return;
    }

    console.error(colors.red(`Error: Unknown service command "${action}".`));
    printServiceHelp();
    process.exit(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(colors.red("Error:"), message);
    process.exit(1);
  }
}

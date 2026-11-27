import colors from "./colors.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";
import { ensureCerts, ensureTrust } from "./certs.js";
import {
  buildProxyStartConfig,
  canBindWithoutRoot,
  collectPortlessEnvArgs,
  discoverState,
  getProtocolPort,
  isProxyRunning,
} from "./cli-utils.js";
import { DEFAULT_TLD, parseTldList } from "./proxy-state.js";
import { isMdnsSupported } from "./mdns.js";
import { UsageError, visitLeadingFlags, type FlagKind } from "./args.js";
import { ensureStateDir, parsePort, resolveUserHome } from "./utils.js";

const DEFAULT_SERVICE_PORT = getProtocolPort(true);
const SERVICE_LABEL = "sh.portless.proxy";
const SYSTEMD_SERVICE = "portless.service";
const WINDOWS_TASK_NAME = "Portless Proxy";
const INTERNAL_ELEVATED_ENV = "PORTLESS_INTERNAL_SERVICE_ELEVATED";
const SERVICE_ENV_KEYS = new Set(["PORTLESS_SYNC_HOSTS"]);

type SupportedPlatform = "darwin" | "linux" | "win32";
type LinuxServiceScope = "system" | "user";

function normalizeTlds(tlds: readonly string[]): string[] {
  return [...new Set(tlds.length > 0 ? tlds : [DEFAULT_TLD])];
}

function primaryTld(tlds: readonly string[]): string {
  return tlds[0] ?? DEFAULT_TLD;
}

function formatTldList(tlds: readonly string[]): string {
  return tlds.map((tld) => `.${tld}`).join(", ");
}

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
  xdgConfigHome?: string;
};

type ServiceContext = {
  platform: SupportedPlatform;
  nodePath: string;
  entryScript: string;
  stateDir: string;
  user: UserContext;
  pathEnv: string;
  programData: string;
  config: NormalizedServiceConfig;
};

export type ServiceInstallConfig = {
  stateDir?: string;
  proxyPort: number;
  useHttps: boolean;
  customCertPath: string | null;
  customKeyPath: string | null;
  lanMode: boolean;
  lanIp: string | null;
  lanIpExplicit: boolean;
  tld: string;
  tlds: string[];
  useWildcard: boolean;
  unprivileged: boolean;
  extraEnv: Record<string, string>;
};

export type NormalizedServiceConfig = ServiceInstallConfig & {
  stateDir: string;
};

const DEFAULT_SERVICE_CONFIG: ServiceInstallConfig = {
  proxyPort: DEFAULT_SERVICE_PORT,
  useHttps: true,
  customCertPath: null,
  customKeyPath: null,
  lanMode: false,
  lanIp: null,
  lanIpExplicit: false,
  tld: DEFAULT_TLD,
  tlds: [DEFAULT_TLD],
  useWildcard: false,
  unprivileged: false,
  extraEnv: {},
};

export type ServiceSpec =
  | {
      platform: "darwin";
      label: string;
      plistPath: string;
      plist: string;
      stateDir: string;
      config: NormalizedServiceConfig;
      programArguments: string[];
    }
  | {
      platform: "linux";
      scope: LinuxServiceScope;
      serviceName: string;
      unitPath: string;
      unit: string;
      stateDir: string;
      config: NormalizedServiceConfig;
      execStart: string[];
    }
  | {
      platform: "win32";
      taskName: string;
      stateDir: string;
      config: NormalizedServiceConfig;
      scriptDir: string;
      scriptPath: string;
      script: string;
      taskXmlPath: string;
      taskXml: string;
      createArgs: string[];
      runArgs: string[];
      deleteArgs: string[];
      queryArgs: string[];
    };

type ServiceStatus = {
  installed: boolean;
  managerState: string;
  proxyRunning: boolean;
  config: NormalizedServiceConfig;
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

function xmlUnescape(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

function parsePortValue(value: string, source: string): number {
  const port = parsePort(value);
  if (port === null) {
    throw new Error(`${source} must be a number between 1 and 65535.`);
  }
  return port;
}

function resolveServicePath(value: string): string {
  const expanded =
    value === "~"
      ? os.homedir()
      : value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(os.homedir(), value.slice(2))
        : value;
  return path.resolve(expanded);
}

function normalizeServiceInstallPaths(config: ServiceInstallConfig): ServiceInstallConfig {
  return {
    ...config,
    stateDir: config.stateDir ? resolveServicePath(config.stateDir) : undefined,
    customCertPath: config.customCertPath ? resolveServicePath(config.customCertPath) : null,
    customKeyPath: config.customKeyPath ? resolveServicePath(config.customKeyPath) : null,
  };
}

function collectServiceExtraEnv(
  env: NodeJS.ProcessEnv | Record<string, string>
): Record<string, string> {
  const extraEnv: Record<string, string> = {};
  for (const key of SERVICE_ENV_KEYS) {
    const value = env[key];
    if (value) extraEnv[key] = value;
  }
  return extraEnv;
}

const SERVICE_INSTALL_FLAGS: Readonly<Record<string, FlagKind>> = {
  "-p": "value",
  "--port": "value",
  "--https": "boolean",
  "--no-tls": "boolean",
  "--lan": "boolean",
  "--ip": "value",
  "--tld": "value",
  "--wildcard": "boolean",
  "--unprivileged": "boolean",
  "--cert": "value",
  "--key": "value",
  "--state-dir": "value",
};

const SERVICE_RUNTIME_FLAGS: Readonly<Record<string, FlagKind>> = {
  "--foreground": "boolean",
  "--skip-trust": "boolean",
};

function serviceInstallSpec(allowRuntimeFlags: boolean | undefined): Record<string, FlagKind> {
  if (!allowRuntimeFlags) return { ...SERVICE_INSTALL_FLAGS };
  return { ...SERVICE_INSTALL_FLAGS, ...SERVICE_RUNTIME_FLAGS };
}

export function parseServiceInstallConfig(
  args: string[],
  env: NodeJS.ProcessEnv | Record<string, string> = process.env,
  options: { allowRuntimeFlags?: boolean } = {}
): ServiceInstallConfig {
  const config: ServiceInstallConfig = {
    ...DEFAULT_SERVICE_CONFIG,
    extraEnv: collectServiceExtraEnv(env),
  };

  if (env.PORTLESS_STATE_DIR) {
    config.stateDir = env.PORTLESS_STATE_DIR;
  }

  const envHttps = parseBooleanEnv(env.PORTLESS_HTTPS);
  let httpsExplicit = envHttps !== null;
  if (envHttps !== null) {
    config.useHttps = envHttps;
  }

  const envLan = parseBooleanEnv(env.PORTLESS_LAN);
  if (envLan !== null) {
    config.lanMode = envLan;
  }

  if (env.PORTLESS_LAN_IP) {
    config.lanMode = true;
    config.lanIp = env.PORTLESS_LAN_IP;
    config.lanIpExplicit = true;
  }

  if (env.PORTLESS_TLD) {
    config.tlds = normalizeTlds(parseTldList(env.PORTLESS_TLD, "PORTLESS_TLD"));
    config.tld = primaryTld(config.tlds);
  }

  const envWildcard = parseBooleanEnv(env.PORTLESS_WILDCARD);
  if (envWildcard !== null) {
    config.useWildcard = envWildcard;
  }

  const envUnprivileged = parseBooleanEnv(env.PORTLESS_UNPRIVILEGED);
  if (envUnprivileged !== null) {
    config.unprivileged = envUnprivileged;
  }

  if (env.PORTLESS_PORT) {
    config.proxyPort = parsePortValue(env.PORTLESS_PORT, "PORTLESS_PORT");
  } else {
    config.proxyPort = getProtocolPort(config.useHttps);
  }

  const tokens = args[0] === "service" ? args.slice(2) : args;
  let portFlagSeen = false;
  let tldFlagSeen = false;
  let tldFlagValues: string[] = [];

  const rest = visitLeadingFlags(
    "service install",
    tokens,
    serviceInstallSpec(options.allowRuntimeFlags),
    (flag, value) => {
      const flagValue = value ?? "";
      switch (flag) {
        case "-p":
        case "--port": {
          const port = parsePort(flagValue);
          if (port === null) {
            throw new UsageError(`Invalid port number: ${flagValue}`, [
              "Port must be between 1 and 65535.",
            ]);
          }
          config.proxyPort = port;
          portFlagSeen = true;
          break;
        }
        case "--https":
          config.useHttps = true;
          httpsExplicit = true;
          break;
        case "--no-tls":
          config.useHttps = false;
          httpsExplicit = true;
          break;
        case "--lan":
          config.lanMode = true;
          break;
        case "--ip":
          if (isIP(flagValue) === 0) {
            throw new UsageError(`--ip requires an IP address, but got "${flagValue}".`, [
              "See: portless service install --help",
            ]);
          }
          config.lanMode = true;
          config.lanIp = flagValue;
          config.lanIpExplicit = true;
          break;
        case "--tld":
          try {
            tldFlagValues = [...tldFlagValues, ...parseTldList(flagValue)];
          } catch (err) {
            throw new UsageError((err as Error).message, ["See: portless service install --help"]);
          }
          tldFlagSeen = true;
          break;
        case "--wildcard":
          config.useWildcard = true;
          break;
        case "--unprivileged":
          config.unprivileged = true;
          break;
        case "--cert":
          config.customCertPath = flagValue;
          config.useHttps = true;
          httpsExplicit = true;
          break;
        case "--key":
          config.customKeyPath = flagValue;
          config.useHttps = true;
          httpsExplicit = true;
          break;
        case "--state-dir":
          config.stateDir = flagValue;
          break;
      }
    }
  );

  if (rest.length > 0) {
    throw new UsageError(`Unexpected argument "${rest[0]}" for portless service install.`, [
      "See: portless service install --help",
    ]);
  }

  if (tldFlagSeen) {
    config.tlds = normalizeTlds(tldFlagValues);
    config.tld = primaryTld(config.tlds);
  }

  if (
    (config.customCertPath && !config.customKeyPath) ||
    (!config.customCertPath && config.customKeyPath)
  ) {
    throw new UsageError("--cert and --key must be used together.");
  }

  // Match proxy start: unprivileged mode serves plain HTTP on 80 unless
  // HTTPS was asked for.
  if (config.unprivileged && !httpsExplicit) {
    config.useHttps = false;
  }

  if (!env.PORTLESS_PORT && !portFlagSeen) {
    config.proxyPort = getProtocolPort(config.useHttps);
  }

  if (!config.lanMode) {
    config.lanIp = null;
    config.lanIpExplicit = false;
  } else {
    config.tlds = ["local"];
    config.tld = "local";
  }

  return config;
}

function resolveUserContext(platform: SupportedPlatform): UserContext {
  if (platform === "win32") {
    const home = resolveUserHome({ platform });
    return { home, username: process.env.USERNAME };
  }

  const sudoUser = process.env.SUDO_USER;
  const sudoUid = process.env.SUDO_UID;
  const sudoGid = process.env.SUDO_GID;
  if (sudoUser && sudoUser !== "root") {
    const home = resolveUserHome({ platform });
    return { home, uid: sudoUid, gid: sudoGid, username: sudoUser };
  }

  const userInfo = os.userInfo();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  return {
    home: os.homedir(),
    uid: process.getuid?.()?.toString(),
    gid: process.getgid?.()?.toString(),
    username: userInfo.username,
    xdgConfigHome:
      platform === "linux" && xdgConfigHome && path.posix.isAbsolute(xdgConfigHome)
        ? xdgConfigHome
        : undefined,
  };
}

function buildProxyCommand(entryScript: string, serviceConfig: ServiceInstallConfig): string[] {
  const proxyConfig = buildProxyStartConfig({
    useHttps: serviceConfig.useHttps,
    customCertPath: serviceConfig.customCertPath,
    customKeyPath: serviceConfig.customKeyPath,
    lanMode: serviceConfig.lanMode,
    lanIp: serviceConfig.lanIp,
    lanIpExplicit: serviceConfig.lanIpExplicit,
    tld: serviceConfig.tld,
    tlds: serviceConfig.tlds,
    useWildcard: serviceConfig.useWildcard,
    unprivileged: serviceConfig.unprivileged,
    foreground: true,
    includePort: true,
    proxyPort: serviceConfig.proxyPort,
    skipTrust: true,
  });
  return [entryScript, "proxy", "start", ...proxyConfig.args];
}

function realPathOrNull(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function isPathInside(targetPath: string, parentDir: string): boolean {
  if (!targetPath || !parentDir) return false;
  const isContained = (target: string, parent: string): boolean => {
    const relative = path.posix.relative(path.posix.resolve(parent), path.posix.resolve(target));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith("../") &&
      !path.posix.isAbsolute(relative)
    );
  };
  if (isContained(targetPath, parentDir)) return true;
  const realTarget = realPathOrNull(targetPath);
  const realParent = realPathOrNull(parentDir);
  return realTarget !== null && realParent !== null && isContained(realTarget, realParent);
}

function selectLinuxServiceScope(ctx: {
  nodePath: string;
  userHome: string;
  uid?: string;
  username?: string;
}): LinuxServiceScope {
  if (ctx.uid === "0" || ctx.username === "root" || path.posix.resolve(ctx.userHome) === "/root") {
    return "system";
  }
  return isPathInside(ctx.nodePath, ctx.userHome) ? "user" : "system";
}

function linuxUnitPath(scope: LinuxServiceScope, userHome: string, xdgConfigHome?: string): string {
  if (scope === "system") return `/etc/systemd/system/${SYSTEMD_SERVICE}`;
  const configRoot =
    xdgConfigHome && path.posix.isAbsolute(xdgConfigHome)
      ? xdgConfigHome
      : path.posix.join(userHome, ".config");
  return path.posix.join(configRoot, "systemd", "user", SYSTEMD_SERVICE);
}

function systemctlArgs(scope: LinuxServiceScope, args: string[]): string[] {
  return scope === "user" ? ["--user", ...args] : args;
}

function findInstalledLinuxScopes(
  preferred: LinuxServiceScope,
  userHome: string,
  xdgConfigHome?: string
): LinuxServiceScope[] {
  const scopes: LinuxServiceScope[] = [preferred, preferred === "user" ? "system" : "user"];
  return scopes.filter((scope) => fs.existsSync(linuxUnitPath(scope, userHome, xdgConfigHome)));
}

function warnAboutLinuxUnit(scope: LinuxServiceScope, unitPath: string): void {
  const message =
    scope === "system"
      ? `A root systemd unit already exists at ${unitPath}. Remove it with \`sudo portless service uninstall\` to avoid port conflicts.`
      : `A systemd user unit already exists at ${unitPath}. Remove it with \`portless service uninstall\` (without sudo) to avoid port conflicts.`;
  console.warn(colors.yellow(message));
}

function userServicePathEnv(ctx: ServiceContext): string {
  const normalize = (entry: string): string =>
    entry.replace(/\/+$/, "") || path.posix.parse(entry).root;
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of ctx.pathEnv.split(":")) {
    if (!entry || !path.posix.isAbsolute(entry)) continue;
    const key = normalize(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  const nodeDir = path.posix.isAbsolute(ctx.nodePath) ? path.posix.dirname(ctx.nodePath) : "";
  if (nodeDir && !seen.has(normalize(nodeDir))) {
    const firstNode = entries
      .map((dir) => path.posix.join(dir, "node"))
      .find((candidate) => fs.existsSync(candidate));
    const canonical = (value: string): string => realPathOrNull(value) ?? path.posix.resolve(value);
    if (firstNode && canonical(firstNode) !== canonical(ctx.nodePath)) {
      entries.unshift(nodeDir);
    } else {
      entries.push(nodeDir);
    }
  }
  return entries.join(":");
}

function windowsSystemPathEnv(pathEnv: string): string {
  const systemDrive = /^[a-z]:$/i.test(process.env.SystemDrive ?? "")
    ? process.env.SystemDrive!.toLowerCase()
    : "c:";
  const coreDirs = new Set([
    `${systemDrive}\\windows`,
    `${systemDrive}\\windows\\system32`,
    `${systemDrive}\\windows\\syswow64`,
  ]);
  const programRoots = [`${systemDrive}\\program files`, `${systemDrive}\\program files (x86)`];
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const entry of pathEnv.split(";")) {
    if (!entry || !path.win32.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) continue;
    const key = path.win32.resolve(entry).replace(/\\+$/, "").toLowerCase();
    const allowed =
      coreDirs.has(key) ||
      programRoots.some((root) => {
        const rel = path.win32.relative(root, key);
        return rel !== "" && rel !== ".." && !rel.startsWith("..\\") && !path.win32.isAbsolute(rel);
      });
    if (!allowed || seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries.join(";");
}

function buildServiceEnv(ctx: ServiceContext, scope?: LinuxServiceScope): Record<string, string> {
  const env: Record<string, string> = {
    PORTLESS_STATE_DIR: ctx.stateDir,
    PORTLESS_PORT: ctx.config.proxyPort.toString(),
    PORTLESS_HTTPS: ctx.config.useHttps ? "1" : "0",
    PORTLESS_LAN: ctx.config.lanMode ? "1" : "0",
    PORTLESS_WILDCARD: ctx.config.useWildcard ? "1" : "0",
    PORTLESS_UNPRIVILEGED: ctx.config.unprivileged ? "1" : "0",
    ...ctx.config.extraEnv,
  };

  if (ctx.config.lanMode && ctx.config.lanIpExplicit && ctx.config.lanIp) {
    env.PORTLESS_LAN_IP = ctx.config.lanIp;
  }

  if (ctx.config.lanMode) {
    env.PORTLESS_TLD = "local";
  } else if (ctx.config.tlds.length > 1 || ctx.config.tld !== DEFAULT_TLD) {
    env.PORTLESS_TLD = ctx.config.tlds.join(",");
  }

  if (ctx.platform === "win32") {
    env.USERPROFILE = ctx.user.home;
    const winPath = windowsSystemPathEnv(ctx.pathEnv);
    if (winPath) env.PATH = winPath;
  } else {
    env.HOME = ctx.user.home;
    if (ctx.platform === "linux" && scope === "user") {
      delete env.SUDO_UID;
      delete env.SUDO_GID;
      delete env.SUDO_USER;
    } else {
      if (ctx.user.uid) env.SUDO_UID = ctx.user.uid;
      if (ctx.user.gid) env.SUDO_GID = ctx.user.gid;
      if (ctx.user.username && ctx.user.username !== "root") env.SUDO_USER = ctx.user.username;
    }
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

function buildSystemdUnit(
  ctx: ServiceContext,
  scope: LinuxServiceScope,
  execStart: string[]
): string {
  const env = buildServiceEnv(ctx, scope);
  const envLines = Object.entries(env)
    .map(([key, value]) => `Environment=${key}=${systemdEscape(value)}`)
    .join("\n");
  const pathEnv = scope === "user" ? userServicePathEnv(ctx) : "/usr/bin:/bin:/usr/sbin:/sbin";
  const networkTargets =
    scope === "system" ? "After=network-online.target\nWants=network-online.target\n" : "";
  const wantedBy = scope === "user" ? "default.target" : "multi-user.target";

  return `[Unit]
Description=Portless HTTPS proxy
${networkTargets}StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
${envLines}
Environment=PATH=${systemdEscape(pathEnv)}
ExecStart=${execStart.map(systemdEscape).join(" ")}
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=5

[Install]
WantedBy=${wantedBy}
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

function buildWindowsTaskXml(scriptPath: string): string {
  const taskArguments = `/d /s /c "${windowsQuote(scriptPath)}"`;
  return `\uFEFF<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Portless HTTPS proxy</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="System">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="System">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${xmlEscape(taskArguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function buildServiceSpec(options: {
  platform: SupportedPlatform;
  nodePath: string;
  entryScript: string;
  userHome: string;
  uid?: string;
  gid?: string;
  username?: string;
  xdgConfigHome?: string;
  stateDir?: string;
  pathEnv?: string;
  programData?: string;
  installConfig?: Partial<ServiceInstallConfig>;
}): ServiceSpec {
  const installConfig: ServiceInstallConfig = {
    ...DEFAULT_SERVICE_CONFIG,
    ...options.installConfig,
    extraEnv: options.installConfig?.extraEnv ?? {},
  };
  installConfig.tlds = installConfig.lanMode
    ? ["local"]
    : normalizeTlds(
        options.installConfig?.tlds ??
          (options.installConfig?.tld ? [options.installConfig.tld] : installConfig.tlds)
      );
  installConfig.tld = primaryTld(installConfig.tlds);
  const stateDir =
    options.stateDir ||
    installConfig.stateDir ||
    defaultStateDir(options.platform, options.userHome);
  const normalizedConfig: NormalizedServiceConfig = {
    ...installConfig,
    stateDir,
  };
  const ctx: ServiceContext = {
    platform: options.platform,
    nodePath: options.nodePath,
    entryScript: options.entryScript,
    stateDir,
    user: {
      home: options.userHome,
      uid: options.uid,
      gid: options.gid,
      username: options.username,
      xdgConfigHome: options.xdgConfigHome,
    },
    pathEnv: options.pathEnv || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    programData: options.programData || "C:\\ProgramData",
    config: normalizedConfig,
  };
  const proxyCommand = buildProxyCommand(ctx.entryScript, ctx.config);

  if (ctx.platform === "darwin") {
    const programArguments = [ctx.nodePath, ...proxyCommand];
    return {
      platform: "darwin",
      label: SERVICE_LABEL,
      plistPath: `/Library/LaunchDaemons/${SERVICE_LABEL}.plist`,
      plist: buildLaunchdPlist(ctx, programArguments),
      stateDir: ctx.stateDir,
      config: ctx.config,
      programArguments,
    };
  }

  if (ctx.platform === "linux") {
    const scope = selectLinuxServiceScope({
      nodePath: ctx.nodePath,
      userHome: ctx.user.home,
      uid: ctx.user.uid,
      username: ctx.user.username,
    });
    const execStart =
      scope === "user"
        ? ["/usr/bin/env", "node", ...proxyCommand]
        : [ctx.nodePath, ...proxyCommand];
    return {
      platform: "linux",
      scope,
      serviceName: SYSTEMD_SERVICE,
      unitPath: linuxUnitPath(scope, ctx.user.home, ctx.user.xdgConfigHome),
      unit: buildSystemdUnit(ctx, scope, execStart),
      stateDir: ctx.stateDir,
      config: ctx.config,
      execStart,
    };
  }

  const scriptDir = path.win32.join(ctx.programData, "portless", "service");
  const scriptPath = path.win32.join(scriptDir, "portless-service.cmd");
  const taskXmlPath = path.win32.join(scriptDir, "portless-task.xml");
  const script = buildWindowsScript(ctx, proxyCommand);
  const taskXml = buildWindowsTaskXml(scriptPath);
  return {
    platform: "win32",
    taskName: WINDOWS_TASK_NAME,
    stateDir: ctx.stateDir,
    config: ctx.config,
    scriptDir,
    scriptPath,
    script,
    taskXmlPath,
    taskXml,
    createArgs: ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", taskXmlPath, "/F"],
    runArgs: ["/Run", "/TN", WINDOWS_TASK_NAME],
    deleteArgs: ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"],
    queryArgs: ["/Query", "/TN", WINDOWS_TASK_NAME, "/FO", "LIST", "/V"],
  };
}

/**
 * Whether the Windows scheduled task exists. The task store is checked because
 * schtasks reports a missing task and a failed query with the same status; an
 * unreadable store throws so callers keep the service files.
 */
function windowsTaskExists(taskName: string): boolean {
  const taskPath = path.win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "Tasks",
    taskName
  );
  return fs.statSync(taskPath, { throwIfNoEntry: false }) !== undefined;
}

function currentServiceSpec(
  entryScript: string,
  installConfig?: ServiceInstallConfig
): ServiceSpec {
  if (!isSupportedPlatform(process.platform)) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  const user = resolveUserContext(process.platform);
  const stateDir =
    installConfig?.stateDir ||
    process.env.PORTLESS_STATE_DIR ||
    defaultStateDir(process.platform, user.home);
  const config = installConfig ?? {
    ...DEFAULT_SERVICE_CONFIG,
    stateDir,
    extraEnv: collectServiceExtraEnv(process.env),
  };
  return buildServiceSpec({
    platform: process.platform,
    nodePath: process.execPath,
    entryScript,
    userHome: user.home,
    uid: user.uid,
    gid: user.gid,
    username: user.username,
    stateDir,
    pathEnv: process.env.PATH,
    programData: process.env.ProgramData,
    installConfig: config,
    xdgConfigHome: user.xdgConfigHome,
  });
}

type InstalledServiceSnapshot = {
  command: string[];
  env: Record<string, string>;
};

function parseQuotedWords(input: string, options: { unescapeBackslash?: boolean } = {}): string[] {
  const words: string[] = [];
  let current = "";
  let inQuote = false;
  let inWord = false;
  const unescapeBackslash = options.unescapeBackslash ?? true;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      inQuote = !inQuote;
      inWord = true;
      continue;
    }
    if (
      char === "\\" &&
      i + 1 < input.length &&
      (input[i + 1] === '"' || (unescapeBackslash && input[i + 1] === "\\"))
    ) {
      current += input[i + 1];
      inWord = true;
      i += 1;
      continue;
    }
    if (/\s/.test(char) && !inQuote) {
      if (inWord) {
        words.push(current);
        current = "";
        inWord = false;
      }
      continue;
    }
    current += char;
    inWord = true;
  }

  if (inWord) {
    words.push(current);
  }

  return words;
}

function parsePlistStrings(block: string): string[] {
  return [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => xmlUnescape(match[1]));
}

function parsePlistEnv(block: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const match of block.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g)) {
    env[xmlUnescape(match[1])] = xmlUnescape(match[2]);
  }
  return env;
}

function readInstalledServiceSnapshot(spec: ServiceSpec): InstalledServiceSnapshot | null {
  try {
    if (spec.platform === "darwin") {
      if (!fs.existsSync(spec.plistPath)) return null;
      const plist = fs.readFileSync(spec.plistPath, "utf-8");
      const argsBlock = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
      const envBlock = plist.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
      if (!argsBlock) return null;
      return {
        command: parsePlistStrings(argsBlock[1]),
        env: envBlock ? parsePlistEnv(envBlock[1]) : {},
      };
    }

    if (spec.platform === "linux") {
      if (!fs.existsSync(spec.unitPath)) return null;
      const unit = fs.readFileSync(spec.unitPath, "utf-8");
      const env: Record<string, string> = {};
      let command: string[] | null = null;
      for (const line of unit.split("\n")) {
        if (line.startsWith("Environment=")) {
          const entry = line.slice("Environment=".length);
          const eq = entry.indexOf("=");
          if (eq > 0) {
            const key = entry.slice(0, eq);
            const value = parseQuotedWords(entry.slice(eq + 1))[0] ?? "";
            env[key] = value;
          }
        } else if (line.startsWith("ExecStart=")) {
          command = parseQuotedWords(line.slice("ExecStart=".length));
        }
      }
      return command ? { command, env } : null;
    }

    if (!fs.existsSync(spec.scriptPath)) return null;
    const script = fs.readFileSync(spec.scriptPath, "utf-8");
    const env: Record<string, string> = {};
    let commandLine: string | null = null;
    for (const rawLine of script.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.toLowerCase() === "@echo off") continue;
      const envMatch = line.match(/^set "([^=]+)=(.*)"$/);
      if (envMatch) {
        env[envMatch[1]] = envMatch[2].replace(/%%/g, "%");
        continue;
      }
      commandLine = line;
    }
    return commandLine
      ? { command: parseQuotedWords(commandLine, { unescapeBackslash: false }), env }
      : null;
  } catch {
    return null;
  }
}

function installedConfigFromSnapshot(
  snapshot: InstalledServiceSnapshot,
  fallback: NormalizedServiceConfig
): NormalizedServiceConfig | null {
  const proxyIndex = snapshot.command.findIndex(
    (arg, index) => arg === "proxy" && snapshot.command[index + 1] === "start"
  );
  if (proxyIndex === -1) return null;

  try {
    const parsed = parseServiceInstallConfig(
      ["service", "install", ...snapshot.command.slice(proxyIndex + 2)],
      snapshot.env,
      { allowRuntimeFlags: true }
    );
    const stateDir = parsed.stateDir || snapshot.env.PORTLESS_STATE_DIR || fallback.stateDir;
    return { ...parsed, stateDir };
  } catch {
    return null;
  }
}

function readInstalledServiceConfig(spec: ServiceSpec): NormalizedServiceConfig | null {
  const snapshot = readInstalledServiceSnapshot(spec);
  if (!snapshot) return null;
  return installedConfigFromSnapshot(snapshot, spec.config);
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

type CommandResult = ReturnType<CommandRunner>;

function commandFailure(result: CommandResult, command: string): string {
  const detail = result.stderr || result.stdout || result.error?.message || `${command} failed`;
  return detail.trim();
}

function runRequired(runner: CommandRunner, command: string, args: string[]): void {
  const result = runner(command, args);
  if (result.status !== 0) {
    throw new Error(commandFailure(result, command));
  }
}

function runOptional(runner: CommandRunner, command: string, args: string[]): void {
  runner(command, args);
}

function isTargetMissing(result: CommandResult): boolean {
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /(not|could not be) found|could not find|no such process|not exist|not loaded|not running/i.test(
    output
  );
}

/** Runs a stop or delete step, ignoring a non-zero status only when the target is already gone. */
function runRemovalStep(runner: CommandRunner, command: string, args: string[]): void {
  const result = runner(command, args);
  if (result.status !== 0 && !isTargetMissing(result)) {
    if (result.error) throw result.error;
    throw new Error(commandFailure(result, command));
  }
}

/**
 * Whether a failed service removal should be retried with sudo. A systemd user
 * unit is owned by the user, so it never needs elevation. Windows has no sudo
 * retry, and a missing command is a real failure.
 */
function removalNeedsElevation(err: unknown, linuxScope?: LinuxServiceScope): boolean {
  if (process.platform === "win32" || linuxScope === "user") return false;
  if ((process.getuid?.() ?? -1) === 0) return false;
  if (process.env[INTERNAL_ELEVATED_ENV] === "1") return false;
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code?: unknown }).code);
    if (code === "ENOENT" || code === "EINVAL" || code === "ENOTDIR") return false;
  }
  return true;
}

function stopProxyOnPort(entryScript: string, runner: CommandRunner, proxyPort: number): void {
  runRequired(runner, process.execPath, [
    entryScript,
    "proxy",
    "stop",
    "--port",
    proxyPort.toString(),
  ]);
}

async function stopExistingProxy(
  entryScript: string,
  runner: CommandRunner,
  proxyPort: number
): Promise<void> {
  const ports = new Set<number>();
  try {
    const currentState = await discoverState();
    if (currentState.port !== proxyPort && (await isProxyRunning(currentState.port))) {
      ports.add(currentState.port);
    }
  } catch {
    // Best effort. The target port stop below still performs stale state cleanup.
  }

  ports.add(proxyPort);
  for (const port of ports) {
    stopProxyOnPort(entryScript, runner, port);
  }
}

function prepareServiceState(stateDir: string): void {
  const unsafe = ensureStateDir(stateDir);
  if (unsafe) throw new Error(`Cannot install the service with state in ${stateDir}: ${unsafe}`);
}

function prepareTrust(stateDir: string): void {
  try {
    ensureCerts(stateDir);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to generate certificates in ${stateDir}. Ensure OpenSSL is installed.\n${detail}`
    );
  }
  const trustResult = ensureTrust(stateDir);
  if (trustResult.state === "trusted") return;

  if (trustResult.state === "installed") {
    console.log(colors.green("CA added to the system trust store."));
    if (
      (trustResult.stores.browser === "unavailable" ||
        trustResult.stores.browser === "untrusted") &&
      trustResult.hint
    ) {
      console.warn(colors.yellow(trustResult.hint));
    }
    return;
  }

  console.warn(colors.yellow("Could not add the CA to the system trust store."));
  if (trustResult.error) {
    console.warn(colors.gray(trustResult.error));
  }
  console.warn(
    colors.yellow(trustResult.hint ?? "Run `portless trust` if browsers show certificate warnings.")
  );
}

function ensureServiceConfigSupported(config: ServiceInstallConfig): void {
  if (!config.lanMode) return;
  const mdnsSupport = isMdnsSupported();
  if (mdnsSupport.supported) return;

  const reason = mdnsSupport.reason ? `\n${mdnsSupport.reason}` : "";
  throw new Error(
    `LAN mode requires mDNS publishing, which is not supported on this platform.${reason}`
  );
}

async function installService(
  entryScript: string,
  runner: CommandRunner,
  args: string[]
): Promise<void> {
  const installConfig = normalizeServiceInstallPaths(parseServiceInstallConfig(args));
  ensureServiceConfigSupported(installConfig);
  const spec = currentServiceSpec(entryScript, installConfig);
  if (spec.platform === "linux" && spec.scope === "user") {
    if ((process.getuid?.() ?? -1) === 0) {
      throw new Error(
        `Node is installed under ${resolveUserContext("linux").home}, which uses a systemd user service. Re-run \`portless service install\` without sudo.`
      );
    }
    const bindCheck = canBindWithoutRoot(spec.config.proxyPort);
    if (!bindCheck.ok) {
      throw new Error(
        `Cannot install a systemd user service on port ${spec.config.proxyPort}: ${bindCheck.reason}\n` +
          `Run \`sudo sysctl -w net.ipv4.ip_unprivileged_port_start=${spec.config.proxyPort}\` to allow user services to bind port ${spec.config.proxyPort}, or re-run with \`--port 8443\` (or another port 1024 or higher).`
      );
    }
  } else {
    requireUnixElevation([entryScript, ...args], runner);
  }
  prepareServiceState(spec.stateDir);

  if (spec.config.useHttps && !spec.config.customCertPath) {
    prepareTrust(spec.stateDir);
  }

  if (spec.platform === "darwin") {
    runOptional(runner, "launchctl", ["bootout", "system", spec.plistPath]);
    await stopExistingProxy(entryScript, runner, spec.config.proxyPort);
    fs.writeFileSync(spec.plistPath, spec.plist);
    fs.chmodSync(spec.plistPath, 0o644);
    runRequired(runner, "chown", ["root:wheel", spec.plistPath]);
    runRequired(runner, "launchctl", ["bootstrap", "system", spec.plistPath]);
    runRequired(runner, "launchctl", ["enable", `system/${spec.label}`]);
    runRequired(runner, "launchctl", ["kickstart", "-k", `system/${spec.label}`]);
  } else if (spec.platform === "linux") {
    const user = resolveUserContext("linux");
    const other = spec.scope === "user" ? "system" : "user";
    const otherUnitPath = linuxUnitPath(other, user.home, user.xdgConfigHome);
    if (fs.existsSync(otherUnitPath)) warnAboutLinuxUnit(other, otherUnitPath);
    runOptional(
      runner,
      "systemctl",
      systemctlArgs(spec.scope, ["disable", "--now", spec.serviceName])
    );
    await stopExistingProxy(entryScript, runner, spec.config.proxyPort);
    if (spec.scope === "user") fs.mkdirSync(path.dirname(spec.unitPath), { recursive: true });
    fs.writeFileSync(spec.unitPath, spec.unit);
    fs.chmodSync(spec.unitPath, 0o644);
    runRequired(runner, "systemctl", systemctlArgs(spec.scope, ["daemon-reload"]));
    runRequired(runner, "systemctl", systemctlArgs(spec.scope, ["enable", spec.serviceName]));
    runRequired(runner, "systemctl", systemctlArgs(spec.scope, ["restart", spec.serviceName]));
    if (
      spec.scope === "user" &&
      user.username &&
      !fs.existsSync(`/var/lib/systemd/linger/${user.username}`)
    ) {
      console.log(
        colors.gray(
          `User services start at login. Run \`loginctl enable-linger ${user.username}\` to start at boot before login.`
        )
      );
    }
  } else {
    fs.mkdirSync(spec.scriptDir, { recursive: true });
    fs.writeFileSync(spec.scriptPath, spec.script);
    fs.writeFileSync(spec.taskXmlPath, spec.taskXml, "utf16le");
    runRequired(runner, "schtasks", spec.createArgs);
    runOptional(runner, "schtasks", ["/End", "/TN", spec.taskName]);
    await stopExistingProxy(entryScript, runner, spec.config.proxyPort);
    runOptional(runner, "schtasks", spec.runArgs);
  }

  console.log(colors.green("Portless service installed."));
  console.log(colors.gray(`State directory: ${spec.stateDir}`));
  console.log(colors.gray(`Proxy port: ${spec.config.proxyPort}`));
}

async function uninstallService(entryScript: string, runner: CommandRunner): Promise<void> {
  const spec = currentServiceSpec(entryScript);

  if (spec.platform === "darwin") {
    requireUnixElevation([entryScript, "service", "uninstall"], runner);
    runRemovalStep(runner, "launchctl", ["bootout", `system/${spec.label}`]);
    fs.rmSync(spec.plistPath, { force: true });
  } else if (spec.platform === "linux") {
    const user = resolveUserContext("linux");
    const preferred = (process.getuid?.() ?? -1) === 0 ? "system" : spec.scope;
    const scope =
      findInstalledLinuxScopes(preferred, user.home, user.xdgConfigHome)[0] ?? preferred;
    if (scope === "system") {
      requireUnixElevation([entryScript, "service", "uninstall"], runner);
    } else if ((process.getuid?.() ?? -1) === 0) {
      throw new Error(
        "The installed service is a systemd user service. Re-run `portless service uninstall` without sudo."
      );
    }
    runRemovalStep(
      runner,
      "systemctl",
      systemctlArgs(scope, ["disable", "--now", spec.serviceName])
    );
    fs.rmSync(linuxUnitPath(scope, user.home, user.xdgConfigHome), { force: true });
    runOptional(runner, "systemctl", systemctlArgs(scope, ["daemon-reload"]));
    const other = scope === "user" ? "system" : "user";
    const otherUnitPath = linuxUnitPath(other, user.home, user.xdgConfigHome);
    if (fs.existsSync(otherUnitPath)) warnAboutLinuxUnit(other, otherUnitPath);
  } else {
    if (windowsTaskExists(spec.taskName)) {
      runOptional(runner, "schtasks", ["/End", "/TN", spec.taskName]);
      runRemovalStep(runner, "schtasks", spec.deleteArgs);
    }
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
  let needsElevationScope: LinuxServiceScope | undefined;
  try {
    const spec = currentServiceSpec(entryScript);

    if (spec.platform === "darwin") {
      installed = fs.existsSync(spec.plistPath);
      if (!installed) return { removed: false, installed: false };
      runRemovalStep(runner, "launchctl", ["bootout", `system/${spec.label}`]);
      fs.rmSync(spec.plistPath, { force: true });
    } else if (spec.platform === "linux") {
      const user = resolveUserContext("linux");
      const scopes = findInstalledLinuxScopes(spec.scope, user.home, user.xdgConfigHome);
      if (scopes.length === 0) return { removed: false, installed: false };
      const isRoot = (process.getuid?.() ?? -1) === 0;
      const ordered: LinuxServiceScope[] = isRoot ? ["system", "user"] : ["user", "system"];
      for (const scope of ordered) {
        if (!scopes.includes(scope)) continue;
        installed = true;
        needsElevationScope = scope;
        if (scope === "user" && isRoot) {
          throw new Error(
            "The installed service is a systemd user service. Re-run `portless service uninstall` without sudo."
          );
        }
        runRemovalStep(
          runner,
          "systemctl",
          systemctlArgs(scope, ["disable", "--now", spec.serviceName])
        );
        fs.rmSync(linuxUnitPath(scope, user.home, user.xdgConfigHome), { force: true });
        runOptional(runner, "systemctl", systemctlArgs(scope, ["daemon-reload"]));
      }
    } else {
      installed = windowsTaskExists(spec.taskName);
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
      needsElevation: installed && removalNeedsElevation(err, needsElevationScope),
    };
  }
}

async function getServiceStatus(
  entryScript: string,
  runner: CommandRunner
): Promise<ServiceStatus> {
  let spec = currentServiceSpec(entryScript);
  if (spec.platform === "linux") {
    const user = resolveUserContext("linux");
    const scope =
      findInstalledLinuxScopes(spec.scope, user.home, user.xdgConfigHome)[0] ?? spec.scope;
    spec = { ...spec, scope, unitPath: linuxUnitPath(scope, user.home, user.xdgConfigHome) };
  }
  const installedConfig = readInstalledServiceConfig(spec) ?? spec.config;
  const proxyRunning = await isProxyRunning(installedConfig.proxyPort, installedConfig.useHttps);

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
    return {
      installed,
      managerState,
      proxyRunning,
      config: installedConfig,
      details: spec.plistPath,
    };
  }

  if (spec.platform === "linux") {
    const enabled = runner(
      "systemctl",
      systemctlArgs(spec.scope, ["is-enabled", spec.serviceName])
    );
    const active = runner("systemctl", systemctlArgs(spec.scope, ["is-active", spec.serviceName]));
    const installed = enabled.status === 0 || active.status === 0 || fs.existsSync(spec.unitPath);
    const activeText = (active.stdout || "").trim();
    return {
      installed,
      managerState:
        active.status === 0 ? activeText || "active" : installed ? "installed" : "not installed",
      proxyRunning,
      config: installedConfig,
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
    config: installedConfig,
    details: spec.taskName,
  };
}

async function printServiceStatus(entryScript: string, runner: CommandRunner): Promise<void> {
  const status = await getServiceStatus(entryScript, runner);
  const config = status.config;
  console.log(colors.bold("portless service"));
  console.log(`  Manager state: ${status.managerState}`);
  console.log(`  Installed: ${status.installed ? "yes" : "no"}`);
  console.log(
    `  Proxy on ${config.proxyPort}: ${status.proxyRunning ? "responding" : "not responding"}`
  );
  console.log(`  HTTPS: ${config.useHttps ? "yes" : "no"}`);
  console.log(`  TLDs: ${config.lanMode ? ".local" : formatTldList(config.tlds)}`);
  console.log(`  LAN mode: ${config.lanMode ? "yes" : "no"}`);
  if (config.lanIpExplicit && config.lanIp) {
    console.log(`  LAN IP: ${config.lanIp}`);
  }
  console.log(`  Wildcard: ${config.useWildcard ? "yes" : "no"}`);
  console.log(`  Unprivileged: ${config.unprivileged ? "yes" : "no"}`);
  console.log(`  State directory: ${config.stateDir}`);
  if (status.details) {
    console.log(`  Service entry: ${status.details}`);
  }
}

export function printServiceHelp(): void {
  console.log(`
${colors.bold("portless service")} - Start portless automatically when the OS starts.

${colors.bold("Usage:")}
  ${colors.cyan("portless service install")}             Install and start the HTTPS service on port 443
  ${colors.cyan("portless service install --lan")}       Enable LAN mode for the startup service
  ${colors.cyan("portless service install -p 8443")}     Use a custom proxy port
  ${colors.cyan("portless service uninstall")}           Stop and remove the startup service
  ${colors.cyan("portless service status")}              Show service and proxy status

${colors.bold("Install options:")}
  -p, --port <number>              Port for the proxy service
  --no-tls                         Disable HTTPS
  --https                          Enable HTTPS
  --lan                            Enable LAN mode
  --ip <address>                   Pin a specific LAN IP
  --tld <tld>                      Use a custom TLD outside LAN mode, repeatable
  --wildcard                       Allow subdomain fallback
  --unprivileged                   Bind the wildcard address, loopback peers only, no elevation
  --cert <path>                    Use a custom TLS certificate
  --key <path>                     Use a custom TLS private key
  --state-dir <path>               Use a custom service state directory

${colors.bold("Notes:")}
  Value flags accept both --flag <value> and --flag=<value>.
  The service uses the default clean URL mode unless options or PORTLESS_*
  environment variables are provided during install.
  On Linux, Node under a non-root user's home directory (such as nvm, fnm,
  volta, or mise) uses a systemd user service (systemctl --user) that resolves
  node from PATH at startup, avoiding SELinux enforcing denials. User services
  start at login (run loginctl enable-linger <user> to start at boot) and
  require unprivileged port access or --port 1024 or higher.
  Linux systemd units allow 5 starts per 60 seconds
  (StartLimitIntervalSec=60, StartLimitBurst=5).
  macOS, Windows, and other Linux installs use a root or SYSTEM service with
  the install-time Node path so port 443 can bind at boot.
`);
}

export async function handleService(
  args: string[],
  options: { entryScript: string; runner?: CommandRunner }
): Promise<void> {
  const action = args[1];
  const runner = options.runner || defaultRunner;

  if (!action) {
    printServiceHelp();
    process.exit(0);
  }

  if (action === "install") {
    await installService(options.entryScript, runner, args);
    return;
  }
  if (action !== "uninstall" && action !== "status") {
    throw new UsageError(`Unknown service command "${action}".`, ["See: portless service --help"]);
  }
  if (args.length > 2) {
    throw new UsageError(`Unexpected argument "${args[2]}" for portless service ${action}.`);
  }
  if (action === "uninstall") {
    await uninstallService(options.entryScript, runner);
    return;
  }
  await printServiceStatus(options.entryScript, runner);
}

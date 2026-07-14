import colors from "./colors.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureCerts, isCATrusted, trustCA } from "./certs.js";
import {
  buildProxyStartConfig,
  DEFAULT_TLD,
  discoverState,
  getProtocolPort,
  isProxyRunning,
  parseTldList,
} from "./cli-utils.js";
import { isMdnsSupported } from "./mdns.js";
import { fixOwnership, resolveUserHome } from "./utils.js";

const DEFAULT_SERVICE_PORT = getProtocolPort(true);
const SERVICE_LABEL = "sh.portless.proxy";
const SYSTEMD_SERVICE = "portless.service";
const WINDOWS_TASK_NAME = "Portless Proxy";
const INTERNAL_ELEVATED_ENV = "PORTLESS_INTERNAL_SERVICE_ELEVATED";
const SERVICE_ENV_KEYS = new Set(["PORTLESS_SYNC_HOSTS"]);

type SupportedPlatform = "darwin" | "linux" | "win32";

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
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`${source} must be a number between 1 and 65535.`);
  }
  return port;
}

function getFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
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

function parseServiceInstallConfig(
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

  if (env.PORTLESS_PORT) {
    config.proxyPort = parsePortValue(env.PORTLESS_PORT, "PORTLESS_PORT");
  } else {
    config.proxyPort = getProtocolPort(config.useHttps);
  }

  const tokens = args[0] === "service" ? args.slice(2) : args;
  let tldFlagSeen = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    switch (token) {
      case "-p":
      case "--port":
        config.proxyPort = parsePortValue(getFlagValue(tokens, i, token), token);
        i += 1;
        break;
      case "--https":
        config.useHttps = true;
        break;
      case "--no-tls":
        config.useHttps = false;
        break;
      case "--lan":
        config.lanMode = true;
        break;
      case "--ip":
        config.lanMode = true;
        config.lanIp = getFlagValue(tokens, i, token);
        config.lanIpExplicit = true;
        i += 1;
        break;
      case "--tld": {
        const tlds = parseTldList(getFlagValue(tokens, i, token));
        config.tlds = normalizeTlds([...(tldFlagSeen ? config.tlds : []), ...tlds]);
        config.tld = primaryTld(config.tlds);
        tldFlagSeen = true;
        i += 1;
        break;
      }
      case "--wildcard":
        config.useWildcard = true;
        break;
      case "--cert":
        config.customCertPath = getFlagValue(tokens, i, token);
        config.useHttps = true;
        i += 1;
        break;
      case "--key":
        config.customKeyPath = getFlagValue(tokens, i, token);
        config.useHttps = true;
        i += 1;
        break;
      case "--state-dir":
        config.stateDir = getFlagValue(tokens, i, token);
        i += 1;
        break;
      case "--foreground":
      case "--skip-trust":
        if (!options.allowRuntimeFlags) {
          throw new Error(`Unknown service install option "${token}".`);
        }
        break;
      default:
        throw new Error(`Unknown service install option "${token}".`);
    }
  }

  if (
    (config.customCertPath && !config.customKeyPath) ||
    (!config.customCertPath && config.customKeyPath)
  ) {
    throw new Error("--cert and --key must be used together.");
  }

  if (!env.PORTLESS_PORT && !tokens.includes("--port") && !tokens.includes("-p")) {
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
  return {
    home: os.homedir(),
    uid: process.getuid?.()?.toString(),
    gid: process.getgid?.()?.toString(),
    username: userInfo.username,
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
    foreground: true,
    includePort: true,
    proxyPort: serviceConfig.proxyPort,
    skipTrust: true,
  });
  return [entryScript, "proxy", "start", ...proxyConfig.args];
}

function buildServiceEnv(ctx: ServiceContext): Record<string, string> {
  const env: Record<string, string> = {
    PORTLESS_STATE_DIR: ctx.stateDir,
    PORTLESS_PORT: ctx.config.proxyPort.toString(),
    PORTLESS_HTTPS: ctx.config.useHttps ? "1" : "0",
    PORTLESS_LAN: ctx.config.lanMode ? "1" : "0",
    PORTLESS_WILDCARD: ctx.config.useWildcard ? "1" : "0",
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
    const execStart = [ctx.nodePath, ...proxyCommand];
    return {
      platform: "linux",
      serviceName: SYSTEMD_SERVICE,
      unitPath: `/etc/systemd/system/${SYSTEMD_SERVICE}`,
      unit: buildSystemdUnit(ctx, execStart),
      stateDir: ctx.stateDir,
      config: ctx.config,
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
    config: ctx.config,
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
  fs.mkdirSync(stateDir, { recursive: true });
  fixOwnership(stateDir);
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
  requireUnixElevation([entryScript, ...args], runner);
  const spec = currentServiceSpec(entryScript, installConfig);
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
    runOptional(runner, "systemctl", ["disable", "--now", spec.serviceName]);
    await stopExistingProxy(entryScript, runner, spec.config.proxyPort);
    fs.writeFileSync(spec.unitPath, spec.unit);
    fs.chmodSync(spec.unitPath, 0o644);
    runRequired(runner, "systemctl", ["daemon-reload"]);
    runRequired(runner, "systemctl", ["enable", spec.serviceName]);
    runRequired(runner, "systemctl", ["restart", spec.serviceName]);
  } else {
    runOptional(runner, "schtasks", ["/End", "/TN", spec.taskName]);
    await stopExistingProxy(entryScript, runner, spec.config.proxyPort);
    fs.mkdirSync(spec.scriptDir, { recursive: true });
    fs.writeFileSync(spec.scriptPath, spec.script);
    runRequired(runner, "schtasks", spec.createArgs);
    runOptional(runner, "schtasks", spec.runArgs);
  }

  console.log(colors.green("Portless service installed."));
  console.log(colors.gray(`State directory: ${spec.stateDir}`));
  console.log(colors.gray(`Proxy port: ${spec.config.proxyPort}`));
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
    const enabled = runner("systemctl", ["is-enabled", spec.serviceName]);
    const active = runner("systemctl", ["is-active", spec.serviceName]);
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
  --cert <path>                    Use a custom TLS certificate
  --key <path>                     Use a custom TLS private key
  --state-dir <path>               Use a custom service state directory

${colors.bold("Notes:")}
  The service uses the default clean URL mode unless options or PORTLESS_*
  environment variables are provided during install.
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
      await installService(options.entryScript, runner, args);
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

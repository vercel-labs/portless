import { parseTldList } from "./cli-utils.js";
import { ConfigValidationError, PROXY_SETTING_KEYS, loadConfig } from "./config.js";
import type { ProxySettings } from "./config.js";
import { findWorkspaceRoot } from "./workspace.js";

/** The `PORTLESS_*` variable each project setting stands in for. */
export const PROXY_SETTING_ENV: Record<keyof ProxySettings, string> = {
  https: "PORTLESS_HTTPS",
  port: "PORTLESS_PORT",
  tld: "PORTLESS_TLD",
  wildcard: "PORTLESS_WILDCARD",
  syncHosts: "PORTLESS_SYNC_HOSTS",
  unprivileged: "PORTLESS_UNPRIVILEGED",
};

export interface ProjectProxySettings {
  settings: ProxySettings;
  /** Where the settings came from, for messages. */
  source: string;
}

export interface AppliedProxySettings extends ProjectProxySettings {
  /** The variables this run set because nothing had set them already. */
  applied: Partial<Record<keyof ProxySettings, string>>;
}

/**
 * Read the proxy settings for a project. The proxy is one per machine and a
 * repo declares how it should run, so a package directory inside a workspace
 * falls back to the workspace root's config when it has none of its own.
 * App keys keep their existing current-directory-only rule.
 */
export function loadProjectProxySettings(cwd: string): ProjectProxySettings | null {
  const local = loadConfig(cwd);
  if (local && hasProxySettings(local.config)) {
    return { settings: pickProxySettings(local.config), source: local.source };
  }
  const root = findWorkspaceRoot(cwd);
  if (root && root !== cwd) {
    const rootConfig = loadConfig(root);
    if (rootConfig && hasProxySettings(rootConfig.config)) {
      return { settings: pickProxySettings(rootConfig.config), source: rootConfig.source };
    }
  }
  return null;
}

/**
 * Translate settings into the `PORTLESS_*` values they stand for, leaving
 * out every variable `env` already has. That one rule is the whole
 * precedence story: flags and exported variables keep winning.
 */
export function proxySettingsToEnv(
  settings: ProxySettings,
  env: NodeJS.ProcessEnv,
  source: string
): Partial<Record<keyof ProxySettings, string>> {
  const result: Partial<Record<keyof ProxySettings, string>> = {};
  for (const key of PROXY_SETTING_KEYS) {
    const value = settings[key];
    if (value === undefined || env[PROXY_SETTING_ENV[key]] !== undefined) continue;
    result[key] = formatSetting(key, value, source);
  }
  return result;
}

/**
 * Apply a project's proxy settings to `process.env` so every command in
 * this process, and every proxy it starts, sees them as if they had been
 * exported. Returns what was applied, or null when the project pins nothing.
 */
export function applyProjectProxySettings(cwd: string): AppliedProxySettings | null {
  const project = loadProjectProxySettings(cwd);
  if (!project) return null;
  const applied = proxySettingsToEnv(project.settings, process.env, project.source);
  for (const [key, value] of Object.entries(applied) as [keyof ProxySettings, string][]) {
    process.env[PROXY_SETTING_ENV[key]] = value;
  }
  return { ...project, applied };
}

function hasProxySettings(config: Partial<ProxySettings>): boolean {
  return PROXY_SETTING_KEYS.some((key) => config[key] !== undefined);
}

function pickProxySettings(config: Partial<ProxySettings>): ProxySettings {
  const settings: ProxySettings = {};
  for (const key of PROXY_SETTING_KEYS) {
    if (config[key] !== undefined) {
      (settings as Record<string, unknown>)[key] = config[key];
    }
  }
  return settings;
}

function formatSetting(
  key: keyof ProxySettings,
  value: NonNullable<ProxySettings[keyof ProxySettings]>,
  source: string
): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  const tlds = Array.isArray(value) ? value : [value];
  try {
    return parseTldList(tlds.join(","), `"${key}" in ${source}`).join(",");
  } catch (err) {
    throw new ConfigValidationError(err instanceof Error ? err.message : String(err));
  }
}

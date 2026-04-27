import * as fs from "node:fs";
import * as path from "node:path";
import colors from "./colors.js";

export interface AppConfig {
  name?: string;
  script?: string;
  appPort?: number;
}

export interface PortlessConfig extends AppConfig {
  apps?: Record<string, AppConfig>;
}

export interface LoadedConfig {
  config: PortlessConfig;
  configDir: string;
}

const CONFIG_FILENAME = "portless.json";

/**
 * Walk up from `cwd` looking for portless.json. Returns the parsed config
 * and the directory it was found in, or null if no config exists.
 */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig | null {
  let dir = cwd;
  for (;;) {
    const configPath = path.join(dir, CONFIG_FILENAME);
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      validateConfig(parsed, configPath);
      return { config: parsed, configDir: dir };
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
        continue;
      }
      if (err instanceof SyntaxError) {
        console.error(colors.red(`Error: Invalid JSON in ${configPath}`));
        process.exit(1);
      }
      throw err;
    }
  }
}

/**
 * Resolve the effective AppConfig for a specific package directory.
 * If the config has an `apps` map, match the package dir by walking
 * the relative path upward. Otherwise return the top-level fields.
 */
export function resolveAppConfig(
  config: PortlessConfig,
  configDir: string,
  packageDir: string
): AppConfig {
  if (config.apps) {
    const rel = normalizePath(path.relative(configDir, packageDir));
    if (rel && !rel.startsWith("..")) {
      let candidate = rel;
      while (candidate) {
        if (config.apps[candidate]) {
          return config.apps[candidate];
        }
        const parent = path.dirname(candidate);
        if (parent === "." || parent === candidate) break;
        candidate = normalizePath(parent);
      }
    }
    return {};
  }
  const { apps: _, ...topLevel } = config;
  return topLevel;
}

/**
 * Read a named script from the package.json in `packageDir` and split
 * it into an args array. Returns null if the script doesn't exist.
 */
export function resolveScript(scriptName: string, packageDir: string): string[] | null {
  const pkgPath = path.join(packageDir, "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    const scriptValue = pkg?.scripts?.[scriptName];
    if (typeof scriptValue !== "string" || !scriptValue.trim()) {
      return null;
    }
    return splitCommand(scriptValue);
  } catch {
    return null;
  }
}

/**
 * Check if a package.json in `dir` has a specific script defined.
 */
export function hasScript(scriptName: string, dir: string): boolean {
  const pkgPath = path.join(dir, "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    return typeof pkg?.scripts?.[scriptName] === "string";
  } catch {
    return false;
  }
}

/** Split a command string on whitespace into an args array. */
export function splitCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/** Normalize path separators to forward slashes for cross-platform matching. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function validateConfig(config: unknown, configPath: string): asserts config is PortlessConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    console.error(colors.red(`Error: ${configPath} must be a JSON object.`));
    process.exit(1);
  }

  const obj = config as Record<string, unknown>;

  if (obj.name !== undefined) {
    if (typeof obj.name !== "string" || !obj.name.trim()) {
      console.error(colors.red(`Error: "name" in ${configPath} must be a non-empty string.`));
      process.exit(1);
    }
  }

  if (obj.script !== undefined) {
    if (typeof obj.script !== "string" || !obj.script.trim()) {
      console.error(colors.red(`Error: "script" in ${configPath} must be a non-empty string.`));
      process.exit(1);
    }
  }

  if (obj.appPort !== undefined) {
    if (
      typeof obj.appPort !== "number" ||
      !Number.isInteger(obj.appPort) ||
      obj.appPort < 1 ||
      obj.appPort > 65535
    ) {
      console.error(
        colors.red(`Error: "appPort" in ${configPath} must be an integer between 1 and 65535.`)
      );
      process.exit(1);
    }
  }

  if (obj.apps !== undefined) {
    if (typeof obj.apps !== "object" || obj.apps === null || Array.isArray(obj.apps)) {
      console.error(colors.red(`Error: "apps" in ${configPath} must be an object.`));
      process.exit(1);
    }
    for (const [key, value] of Object.entries(obj.apps as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        console.error(colors.red(`Error: "apps.${key}" in ${configPath} must be an object.`));
        process.exit(1);
      }
      validateAppConfig(value as Record<string, unknown>, `apps.${key}`, configPath);
    }
  }
}

function validateAppConfig(obj: Record<string, unknown>, prefix: string, configPath: string): void {
  if (obj.name !== undefined) {
    if (typeof obj.name !== "string" || !obj.name.trim()) {
      console.error(
        colors.red(`Error: "${prefix}.name" in ${configPath} must be a non-empty string.`)
      );
      process.exit(1);
    }
  }
  if (obj.script !== undefined) {
    if (typeof obj.script !== "string" || !obj.script.trim()) {
      console.error(
        colors.red(`Error: "${prefix}.script" in ${configPath} must be a non-empty string.`)
      );
      process.exit(1);
    }
  }
  if (obj.appPort !== undefined) {
    if (
      typeof obj.appPort !== "number" ||
      !Number.isInteger(obj.appPort) ||
      obj.appPort < 1 ||
      obj.appPort > 65535
    ) {
      console.error(
        colors.red(
          `Error: "${prefix}.appPort" in ${configPath} must be an integer between 1 and 65535.`
        )
      );
      process.exit(1);
    }
  }
}

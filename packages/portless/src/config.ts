import * as fs from "node:fs";
import * as path from "node:path";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export interface AppConfig {
  name?: string;
  script?: string;
  appPort?: number;
  proxy?: boolean;
}

export interface PortlessConfig extends AppConfig {
  apps?: Record<string, AppConfig>;
  turbo?: boolean;
}

export interface LoadedConfig {
  config: PortlessConfig;
  configDir: string;
}

const CONFIG_FILENAME = "portless.json";

/**
 * Load portless config from `cwd`. Checks `portless.json` first, then
 * falls back to a `"portless"` key in `package.json`. Does not walk up
 * to parent directories.
 */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig | null {
  const configPath = path.join(cwd, CONFIG_FILENAME);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    validateConfig(parsed, configPath);
    return { config: parsed, configDir: cwd };
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return loadConfigFromPackageJson(cwd);
    }
    if (err instanceof SyntaxError) {
      throw new ConfigValidationError(`Invalid JSON in ${configPath}`);
    }
    throw err;
  }
}

/** Normalize the raw `"portless"` value: a string is shorthand for `{ name }`. */
function normalizePortlessValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim() ? { name: value.trim() } : null;
  }
  return value;
}

function loadConfigFromPackageJson(dir: string): LoadedConfig | null {
  const pkgPath = path.join(dir, "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg === "object" && "portless" in pkg) {
      const config = normalizePortlessValue(pkg.portless);
      if (config === null) return null;
      validateConfig(config, `${pkgPath} "portless"`);
      return { config: config as PortlessConfig, configDir: dir };
    }
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
  return null;
}

/**
 * Load the `"portless"` config from a specific directory's package.json
 * (does not walk up). Returns the AppConfig fields or null.
 */
export function loadPackagePortlessConfig(dir: string): AppConfig | null {
  const pkgPath = path.join(dir, "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw);
    if (pkg && typeof pkg === "object" && "portless" in pkg) {
      const config = normalizePortlessValue(pkg.portless);
      if (config === null) return null;
      if (typeof config === "object" && !Array.isArray(config)) {
        validateAppConfig(config as Record<string, unknown>, "portless", pkgPath);
        return config as AppConfig;
      }
    }
  } catch (err) {
    if (err instanceof ConfigValidationError) throw err;
  }
  return null;
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
  return { name: config.name, script: config.script, appPort: config.appPort, proxy: config.proxy };
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

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

const LOCK_FILES: [string, PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
];

/**
 * Detect the package manager for a project by walking up from `cwd`.
 * Checks `packageManager` field in package.json first, then lock files.
 * Defaults to `npm` if nothing is found.
 */
export function detectPackageManager(cwd: string): PackageManager {
  let dir = cwd;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const raw = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (typeof pkg.packageManager === "string") {
        const name = pkg.packageManager.split("@")[0] as string;
        if (name === "pnpm" || name === "yarn" || name === "bun" || name === "npm") {
          return name;
        }
      }
    } catch {
      // no package.json here
    }

    for (const [file, pm] of LOCK_FILES) {
      try {
        fs.accessSync(path.join(dir, file), fs.constants.F_OK);
        return pm;
      } catch {
        // not found
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "npm";
}

/**
 * Resolve a named script to a package-manager-delegated command.
 * Returns e.g. `["pnpm", "run", "dev"]` instead of parsing the script contents.
 * Returns null if the script doesn't exist.
 */
export function resolveScriptCommand(scriptName: string, packageDir: string): string[] | null {
  if (!hasScript(scriptName, packageDir)) return null;
  const pm = detectPackageManager(packageDir);
  return [pm, "run", scriptName];
}

/** Split a command string on whitespace, respecting quotes and backslash escapes. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Commands that are build tools / watchers and never start an HTTP server.
 * Used to auto-detect packages that should run without a proxy route.
 */
const BUILD_ONLY_COMMANDS = new Set([
  "tsup",
  "tsc",
  "esbuild",
  "rollup",
  "babel",
  "swc",
  "unbuild",
  "pkgroll",
  "ncc",
  "microbundle",
]);

/**
 * Returns true if the command looks like it starts an HTTP server
 * (and should be proxied), false if it's a known build-only tool.
 *
 * Uses a denylist: unknown commands are assumed to be servers. This is
 * intentionally permissive so we proxy by default rather than silently
 * skipping a real server. Use `proxy: false` in config to override.
 */
export function isServerCommand(args: string[]): boolean {
  if (args.length === 0) return false;
  const bin = path.basename(args[0]);
  return !BUILD_ONLY_COMMANDS.has(bin);
}

/** Normalize path separators to forward slashes for cross-platform matching. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

const KNOWN_TOP_KEYS = new Set(["name", "script", "appPort", "proxy", "apps", "turbo"]);
const KNOWN_APP_KEYS = new Set(["name", "script", "appPort", "proxy"]);

function validateConfig(config: unknown, configPath: string): asserts config is PortlessConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new ConfigValidationError(`${configPath} must be a JSON object.`);
  }

  const obj = config as Record<string, unknown>;

  if (obj.name !== undefined) {
    if (typeof obj.name !== "string" || !obj.name.trim()) {
      throw new ConfigValidationError(`"name" in ${configPath} must be a non-empty string.`);
    }
  }

  if (obj.script !== undefined) {
    if (typeof obj.script !== "string" || !obj.script.trim()) {
      throw new ConfigValidationError(`"script" in ${configPath} must be a non-empty string.`);
    }
  }

  if (obj.appPort !== undefined) {
    if (
      typeof obj.appPort !== "number" ||
      !Number.isInteger(obj.appPort) ||
      obj.appPort < 1 ||
      obj.appPort > 65535
    ) {
      throw new ConfigValidationError(
        `"appPort" in ${configPath} must be an integer between 1 and 65535.`
      );
    }
  }

  if (obj.proxy !== undefined) {
    if (typeof obj.proxy !== "boolean") {
      throw new ConfigValidationError(`"proxy" in ${configPath} must be a boolean.`);
    }
  }

  if (obj.turbo !== undefined) {
    if (typeof obj.turbo !== "boolean") {
      throw new ConfigValidationError(`"turbo" in ${configPath} must be a boolean.`);
    }
  }

  if (obj.apps !== undefined) {
    if (typeof obj.apps !== "object" || obj.apps === null || Array.isArray(obj.apps)) {
      throw new ConfigValidationError(`"apps" in ${configPath} must be an object.`);
    }
    for (const [key, value] of Object.entries(obj.apps as Record<string, unknown>)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ConfigValidationError(`"apps.${key}" in ${configPath} must be an object.`);
      }
      validateAppConfig(value as Record<string, unknown>, `apps.${key}`, configPath);
    }
  }

  warnUnknownKeys(obj, KNOWN_TOP_KEYS, configPath);
}

function validateAppConfig(obj: Record<string, unknown>, prefix: string, configPath: string): void {
  if (obj.name !== undefined) {
    if (typeof obj.name !== "string" || !obj.name.trim()) {
      throw new ConfigValidationError(
        `"${prefix}.name" in ${configPath} must be a non-empty string.`
      );
    }
  }
  if (obj.script !== undefined) {
    if (typeof obj.script !== "string" || !obj.script.trim()) {
      throw new ConfigValidationError(
        `"${prefix}.script" in ${configPath} must be a non-empty string.`
      );
    }
  }
  if (obj.appPort !== undefined) {
    if (
      typeof obj.appPort !== "number" ||
      !Number.isInteger(obj.appPort) ||
      obj.appPort < 1 ||
      obj.appPort > 65535
    ) {
      throw new ConfigValidationError(
        `"${prefix}.appPort" in ${configPath} must be an integer between 1 and 65535.`
      );
    }
  }
  if (obj.proxy !== undefined) {
    if (typeof obj.proxy !== "boolean") {
      throw new ConfigValidationError(`"${prefix}.proxy" in ${configPath} must be a boolean.`);
    }
  }

  warnUnknownKeys(obj, KNOWN_APP_KEYS, configPath, prefix);
}

function warnUnknownKeys(
  obj: Record<string, unknown>,
  known: Set<string>,
  configPath: string,
  prefix?: string
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      const label = prefix ? `"${prefix}.${key}"` : `"${key}"`;
      console.warn(
        `Warning: Unknown key ${label} in ${configPath}. Known keys: ${[...known].join(", ")}`
      );
    }
  }
}

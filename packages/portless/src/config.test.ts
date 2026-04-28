import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadConfig,
  resolveAppConfig,
  resolveScript,
  resolveScriptCommand,
  detectPackageManager,
  hasScript,
  splitCommand,
  isServerCommand,
  loadPackagePortlessConfig,
  ConfigValidationError,
} from "./config.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portless-config-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("splitCommand", () => {
  it("splits on whitespace", () => {
    expect(splitCommand("next dev")).toEqual(["next", "dev"]);
  });

  it("handles multiple spaces", () => {
    expect(splitCommand("next   dev")).toEqual(["next", "dev"]);
  });

  it("trims leading/trailing whitespace", () => {
    expect(splitCommand("  next dev  ")).toEqual(["next", "dev"]);
  });

  it("handles single-word command", () => {
    expect(splitCommand("vitest")).toEqual(["vitest"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitCommand("")).toEqual([]);
  });

  it("preserves single-quoted arguments", () => {
    expect(splitCommand("NODE_OPTIONS='--max-old-space-size=4096' next dev")).toEqual([
      "NODE_OPTIONS=--max-old-space-size=4096",
      "next",
      "dev",
    ]);
  });

  it("preserves double-quoted arguments", () => {
    expect(splitCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
  });

  it("handles mixed quotes", () => {
    expect(splitCommand(`KEY='val with spaces' CMD="another arg"`)).toEqual([
      "KEY=val with spaces",
      "CMD=another arg",
    ]);
  });

  it("handles quotes within a token", () => {
    expect(splitCommand("--flag='some value'")).toEqual(["--flag=some value"]);
  });

  it("handles backslash-escaped double quotes", () => {
    expect(splitCommand('echo \\"hello\\"')).toEqual(["echo", '"hello"']);
  });

  it("handles backslash-escaped single quotes", () => {
    expect(splitCommand("echo \\'hello\\'")).toEqual(["echo", "'hello'"]);
  });

  it("handles escaped backslash", () => {
    expect(splitCommand("echo \\\\path")).toEqual(["echo", "\\path"]);
  });

  it("handles backslash-escaped spaces", () => {
    expect(splitCommand("path\\ with\\ spaces arg")).toEqual(["path with spaces", "arg"]);
  });

  it("preserves backslash inside single quotes (POSIX behavior)", () => {
    expect(splitCommand("echo 'hello\\nworld'")).toEqual(["echo", "hello\\nworld"]);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("returns null when no portless.json exists", () => {
    expect(loadConfig(tmpDir)).toBeNull();
  });

  it("loads portless.json from cwd", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ name: "myapp" }));
    const result = loadConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.config.name).toBe("myapp");
    expect(result!.configDir).toBe(tmpDir);
  });

  it("does not walk up from a subdirectory", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ name: "myapp" }));
    const subDir = path.join(tmpDir, "src", "components");
    fs.mkdirSync(subDir, { recursive: true });
    expect(loadConfig(subDir)).toBeNull();
  });

  it("loads config with all fields", () => {
    const config = { name: "myapp", script: "start", appPort: 3000 };
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify(config));
    const result = loadConfig(tmpDir);
    expect(result!.config).toEqual(config);
  });

  it("loads config with proxy field", () => {
    fs.writeFileSync(
      path.join(tmpDir, "portless.json"),
      JSON.stringify({ name: "myapp", proxy: false })
    );
    const result = loadConfig(tmpDir);
    expect(result!.config.proxy).toBe(false);
  });

  it("loads config with apps map", () => {
    const config = {
      apps: {
        "apps/web": { name: "web" },
        "apps/api": { name: "api", script: "start" },
      },
    };
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify(config));
    const result = loadConfig(tmpDir);
    expect(result!.config.apps).toBeDefined();
    expect(Object.keys(result!.config.apps!)).toHaveLength(2);
  });

  it("loads empty object config", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), "{}");
    const result = loadConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.config).toEqual({});
  });

  it("loads config from package.json portless key", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", portless: { name: "myapp", script: "dev" } })
    );
    const result = loadConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.config.name).toBe("myapp");
    expect(result!.config.script).toBe("dev");
    expect(result!.configDir).toBe(tmpDir);
  });

  it("loads string shorthand from package.json portless key", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", portless: "myapp" })
    );
    const result = loadConfig(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.config.name).toBe("myapp");
  });

  it("ignores empty string portless key", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", portless: "" })
    );
    expect(loadConfig(tmpDir)).toBeNull();
  });

  it("prefers portless.json over package.json portless key", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ name: "from-file" }));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", portless: { name: "from-pkg" } })
    );
    const result = loadConfig(tmpDir);
    expect(result!.config.name).toBe("from-file");
  });

  it("ignores package.json without portless key", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", scripts: { dev: "next dev" } })
    );
    expect(loadConfig(tmpDir)).toBeNull();
  });

  it("does not walk up to find package.json portless key", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", portless: { name: "root-app" } })
    );
    const subDir = path.join(tmpDir, "packages", "web");
    fs.mkdirSync(subDir, { recursive: true });
    expect(loadConfig(subDir)).toBeNull();
  });
});

describe("loadConfig validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("throws on invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), "not json");
    expect(() => loadConfig(tmpDir)).toThrow(ConfigValidationError);
  });

  it("throws when config is an array", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), "[]");
    expect(() => loadConfig(tmpDir)).toThrow(ConfigValidationError);
  });

  it("throws when name is a number", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ name: 42 }));
    expect(() => loadConfig(tmpDir)).toThrow(ConfigValidationError);
  });

  it("throws when name is empty string", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ name: "" }));
    expect(() => loadConfig(tmpDir)).toThrow(ConfigValidationError);
  });

  it("throws when appPort is out of range", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ appPort: 99999 }));
    expect(() => loadConfig(tmpDir)).toThrow(ConfigValidationError);
  });

  it("throws when appPort is a string", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ appPort: "3000" }));
    expect(() => loadConfig(tmpDir)).toThrow(ConfigValidationError);
  });

  it("throws when apps entry is not an object", () => {
    fs.writeFileSync(
      path.join(tmpDir, "portless.json"),
      JSON.stringify({ apps: { "apps/web": "bad" } })
    );
    expect(() => loadConfig(tmpDir)).toThrow(ConfigValidationError);
  });

  it("throws when proxy is not a boolean", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ proxy: "false" }));
    expect(() => loadConfig(tmpDir)).toThrow(ConfigValidationError);
  });

  it("accepts turbo as a boolean", () => {
    fs.writeFileSync(
      path.join(tmpDir, "portless.json"),
      JSON.stringify({ name: "test", turbo: false })
    );
    const result = loadConfig(tmpDir);
    expect(result?.config.turbo).toBe(false);
  });

  it("throws when turbo is not a boolean", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ turbo: "yes" }));
    expect(() => loadConfig(tmpDir)).toThrow(ConfigValidationError);
  });

  it("warns on unknown top-level keys", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(
      path.join(tmpDir, "portless.json"),
      JSON.stringify({ name: "myapp", typo: true })
    );
    loadConfig(tmpDir);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"typo"'));
    spy.mockRestore();
  });

  it("warns on unknown keys in apps entries", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fs.writeFileSync(
      path.join(tmpDir, "portless.json"),
      JSON.stringify({ apps: { "apps/web": { name: "web", port: 3000 } } })
    );
    loadConfig(tmpDir);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"apps.apps/web.port"'));
    spy.mockRestore();
  });
});

describe("resolveAppConfig", () => {
  it("returns top-level fields when no apps key", () => {
    const config = { name: "myapp", script: "dev" };
    const result = resolveAppConfig(config, "/repo", "/repo");
    expect(result).toEqual({ name: "myapp", script: "dev", appPort: undefined, proxy: undefined });
  });

  it("returns proxy field from top-level config", () => {
    const config = { name: "myapp", proxy: false };
    const result = resolveAppConfig(config, "/repo", "/repo");
    expect(result.proxy).toBe(false);
  });

  it("returns proxy field from apps entry", () => {
    const config = {
      apps: {
        "apps/gen": { name: "gen", proxy: false },
      },
    };
    const result = resolveAppConfig(config, "/repo", "/repo/apps/gen");
    expect(result.proxy).toBe(false);
  });

  it("matches exact path in apps map", () => {
    const config = {
      apps: {
        "apps/web": { name: "web" },
        "apps/api": { name: "api" },
      },
    };
    const result = resolveAppConfig(config, "/repo", "/repo/apps/web");
    expect(result).toEqual({ name: "web" });
  });

  it("matches subdirectory to parent app entry", () => {
    const config = {
      apps: {
        "apps/web": { name: "web" },
      },
    };
    const result = resolveAppConfig(config, "/repo", "/repo/apps/web/src/components");
    expect(result).toEqual({ name: "web" });
  });

  it("returns empty object when no apps key matches", () => {
    const config = {
      apps: {
        "apps/web": { name: "web" },
      },
    };
    const result = resolveAppConfig(config, "/repo", "/repo/packages/shared");
    expect(result).toEqual({});
  });

  it("ignores top-level fields when apps is present", () => {
    const config = {
      name: "top-level",
      apps: {
        "apps/web": { name: "web" },
      },
    };
    const result = resolveAppConfig(config, "/repo", "/repo/packages/other");
    expect(result).toEqual({});
  });

  it("handles Windows-style backslash paths", () => {
    const config = {
      apps: {
        "apps/web": { name: "web" },
      },
    };
    // path.relative on Windows returns backslashes
    const result = resolveAppConfig(config, "/repo", "/repo/apps/web");
    expect(result).toEqual({ name: "web" });
  });
});

describe("resolveScript", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("reads script from package.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } })
    );
    const result = resolveScript("dev", tmpDir);
    expect(result).toEqual(["next", "dev"]);
  });

  it("returns null for missing script", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "next build" } })
    );
    expect(resolveScript("dev", tmpDir)).toBeNull();
  });

  it("returns null for missing package.json", () => {
    expect(resolveScript("dev", tmpDir)).toBeNull();
  });

  it("returns null for empty script value", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ scripts: { dev: "" } }));
    expect(resolveScript("dev", tmpDir)).toBeNull();
  });

  it("splits multi-word script into args", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "NODE_ENV=development next dev --turbo" } })
    );
    const result = resolveScript("dev", tmpDir);
    expect(result).toEqual(["NODE_ENV=development", "next", "dev", "--turbo"]);
  });
});

describe("hasScript", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("returns true when script exists", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } })
    );
    expect(hasScript("dev", tmpDir)).toBe(true);
  });

  it("returns false when script is missing", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "next build" } })
    );
    expect(hasScript("dev", tmpDir)).toBe(false);
  });

  it("returns false when package.json is missing", () => {
    expect(hasScript("dev", tmpDir)).toBe(false);
  });

  it("returns false when scripts object is missing", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    expect(hasScript("dev", tmpDir)).toBe(false);
  });
});

describe("loadPackagePortlessConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("returns config from package.json portless key", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", portless: { name: "myapp", script: "start" } })
    );
    const result = loadPackagePortlessConfig(tmpDir);
    expect(result).toEqual({ name: "myapp", script: "start" });
  });

  it("returns config from string shorthand", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", portless: "myapp" })
    );
    const result = loadPackagePortlessConfig(tmpDir);
    expect(result).toEqual({ name: "myapp" });
  });

  it("returns null for empty string shorthand", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", portless: "" })
    );
    expect(loadPackagePortlessConfig(tmpDir)).toBeNull();
  });

  it("returns null when no portless key", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    expect(loadPackagePortlessConfig(tmpDir)).toBeNull();
  });

  it("returns null when no package.json", () => {
    expect(loadPackagePortlessConfig(tmpDir)).toBeNull();
  });

  it("throws ConfigValidationError for invalid portless config", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", portless: { appPort: "bad" } })
    );
    expect(() => loadPackagePortlessConfig(tmpDir)).toThrow(ConfigValidationError);
  });
});

describe("isServerCommand", () => {
  it("returns true for web server commands", () => {
    expect(isServerCommand(["next", "dev"])).toBe(true);
    expect(isServerCommand(["vite"])).toBe(true);
    expect(isServerCommand(["node", "server.js"])).toBe(true);
    expect(isServerCommand(["remix", "dev"])).toBe(true);
  });

  it("returns false for build-only commands", () => {
    expect(isServerCommand(["tsup", "--watch"])).toBe(false);
    expect(isServerCommand(["tsc", "--watch"])).toBe(false);
    expect(isServerCommand(["esbuild", "src/index.ts"])).toBe(false);
    expect(isServerCommand(["rollup", "-c", "-w"])).toBe(false);
    expect(isServerCommand(["swc", "src", "-d", "dist", "-w"])).toBe(false);
    expect(isServerCommand(["unbuild"])).toBe(false);
  });

  it("returns false for empty args", () => {
    expect(isServerCommand([])).toBe(false);
  });
});

describe("detectPackageManager", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("detects pnpm from pnpm-lock.yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("detects yarn from yarn.lock", () => {
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("detects bun from bun.lockb", () => {
    fs.writeFileSync(path.join(tmpDir, "bun.lockb"), "");
    expect(detectPackageManager(tmpDir)).toBe("bun");
  });

  it("detects npm from package-lock.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package-lock.json"), "{}");
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });

  it("reads packageManager field from package.json", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", packageManager: "pnpm@9.15.4" })
    );
    expect(detectPackageManager(tmpDir)).toBe("pnpm");
  });

  it("prefers packageManager field over lock file", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", packageManager: "yarn@4.0.0" })
    );
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(tmpDir)).toBe("yarn");
  });

  it("walks up to find lock file in parent", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    const subDir = path.join(tmpDir, "packages", "web");
    fs.mkdirSync(subDir, { recursive: true });
    expect(detectPackageManager(subDir)).toBe("pnpm");
  });

  it("defaults to npm when nothing found", () => {
    expect(detectPackageManager(tmpDir)).toBe("npm");
  });
});

describe("resolveScriptCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("returns PM-delegated command when script exists", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } })
    );
    expect(resolveScriptCommand("dev", tmpDir)).toEqual(["pnpm", "run", "dev"]);
  });

  it("returns null when script is missing", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { build: "next build" } })
    );
    expect(resolveScriptCommand("dev", tmpDir)).toBeNull();
  });

  it("returns null when package.json is missing", () => {
    expect(resolveScriptCommand("dev", tmpDir)).toBeNull();
  });

  it("uses detected package manager", () => {
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } })
    );
    expect(resolveScriptCommand("dev", tmpDir)).toEqual(["yarn", "run", "dev"]);
  });
});

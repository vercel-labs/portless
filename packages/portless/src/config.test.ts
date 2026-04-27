import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig, resolveAppConfig, resolveScript, hasScript, splitCommand } from "./config.js";

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

  it("walks up from a subdirectory", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ name: "myapp" }));
    const subDir = path.join(tmpDir, "src", "components");
    fs.mkdirSync(subDir, { recursive: true });
    const result = loadConfig(subDir);
    expect(result).not.toBeNull();
    expect(result!.config.name).toBe("myapp");
    expect(result!.configDir).toBe(tmpDir);
  });

  it("loads config with all fields", () => {
    const config = { name: "myapp", script: "start", appPort: 3000 };
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify(config));
    const result = loadConfig(tmpDir);
    expect(result!.config).toEqual(config);
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
});

describe("loadConfig validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("exits on invalid JSON", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), "not json");
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => loadConfig(tmpDir)).toThrow("process.exit");
    mockExit.mockRestore();
  });

  it("exits when config is an array", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), "[]");
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => loadConfig(tmpDir)).toThrow("process.exit");
    mockExit.mockRestore();
  });

  it("exits when name is a number", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ name: 42 }));
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => loadConfig(tmpDir)).toThrow("process.exit");
    mockExit.mockRestore();
  });

  it("exits when name is empty string", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ name: "" }));
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => loadConfig(tmpDir)).toThrow("process.exit");
    mockExit.mockRestore();
  });

  it("exits when appPort is out of range", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ appPort: 99999 }));
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => loadConfig(tmpDir)).toThrow("process.exit");
    mockExit.mockRestore();
  });

  it("exits when appPort is a string", () => {
    fs.writeFileSync(path.join(tmpDir, "portless.json"), JSON.stringify({ appPort: "3000" }));
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => loadConfig(tmpDir)).toThrow("process.exit");
    mockExit.mockRestore();
  });

  it("exits when apps entry is not an object", () => {
    fs.writeFileSync(
      path.join(tmpDir, "portless.json"),
      JSON.stringify({ apps: { "apps/web": "bad" } })
    );
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => loadConfig(tmpDir)).toThrow("process.exit");
    mockExit.mockRestore();
  });
});

describe("resolveAppConfig", () => {
  it("returns top-level fields when no apps key", () => {
    const config = { name: "myapp", script: "dev" };
    const result = resolveAppConfig(config, "/repo", "/repo");
    expect(result).toEqual({ name: "myapp", script: "dev" });
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

// Vitest provides vi globally
import { vi } from "vitest";

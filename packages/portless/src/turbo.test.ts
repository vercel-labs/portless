import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { EnvPublication, buildNodeOptions, hasTurboConfig, loaderPath } from "./turbo.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portless-turbo-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("hasTurboConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("returns true when turbo.json exists", () => {
    fs.writeFileSync(path.join(tmpDir, "turbo.json"), "{}");
    expect(hasTurboConfig(tmpDir)).toBe(true);
  });

  it("returns true when turbo.jsonc exists", () => {
    fs.writeFileSync(
      path.join(tmpDir, "turbo.jsonc"),
      '{\n  // Turbo supports comments\n  "tasks": {}\n}\n'
    );
    expect(hasTurboConfig(tmpDir)).toBe(true);
  });

  it("returns true when both Turbo configuration files exist", () => {
    fs.writeFileSync(path.join(tmpDir, "turbo.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "turbo.jsonc"), "{\n  // Turbo supports comments\n}\n");
    expect(hasTurboConfig(tmpDir)).toBe(true);
  });

  it("returns false when neither Turbo configuration file exists", () => {
    expect(hasTurboConfig(tmpDir)).toBe(false);
  });
});

describe("EnvPublication", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(createTmpDir());
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("sets the env vars of the package directory a Node process starts in until retired", () => {
    const pkgDir = path.join(tmpDir, "web");
    fs.mkdirSync(pkgDir);
    const publication = new EnvPublication(tmpDir);
    publication.publish({
      [pkgDir]: { PORT: "4123", HOST: "127.0.0.1", PORTLESS_URL: "http://web.localhost" },
    });
    const portIn = (cwd: string) =>
      spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.PORT || '')"], {
        cwd,
        encoding: "utf-8",
        env: { ...process.env, PORT: "", NODE_OPTIONS: buildNodeOptions(tmpDir) },
      });
    expect(portIn(pkgDir).stdout).toBe("4123");
    expect(portIn(tmpDir).stdout).toBe("");
    publication.retire();
    const afterRetire = portIn(pkgDir);
    expect(afterRetire.status).toBe(0);
    expect(afterRetire.stdout).toBe("");
  });
});

describe("buildNodeOptions", () => {
  let tmpDir: string;
  const originalNodeOptions = process.env.NODE_OPTIONS;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
    if (originalNodeOptions !== undefined) {
      process.env.NODE_OPTIONS = originalNodeOptions;
    } else {
      delete process.env.NODE_OPTIONS;
    }
  });

  it("sets --require when NODE_OPTIONS is empty", () => {
    delete process.env.NODE_OPTIONS;
    const result = buildNodeOptions(tmpDir);
    expect(result).toBe(`--require ${loaderPath(tmpDir)}`);
  });

  it("prepends --require to existing NODE_OPTIONS", () => {
    process.env.NODE_OPTIONS = "--max-old-space-size=4096";
    const result = buildNodeOptions(tmpDir);
    expect(result).toBe(`--require ${loaderPath(tmpDir)} --max-old-space-size=4096`);
  });

  it("quotes the loader path when it contains spaces", () => {
    delete process.env.NODE_OPTIONS;
    const spacedDir = path.join(tmpDir, "path with spaces");
    fs.mkdirSync(spacedDir, { recursive: true });
    const result = buildNodeOptions(spacedDir);
    expect(result).toBe(`--require "${loaderPath(spacedDir)}"`);
  });
});

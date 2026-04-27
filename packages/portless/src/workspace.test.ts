import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  findWorkspaceRoot,
  discoverWorkspacePackages,
  parsePnpmWorkspaceYaml,
  expandPackageGlobs,
} from "./workspace.js";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portless-ws-test-"));
}

function cleanupDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("parsePnpmWorkspaceYaml", () => {
  it("parses basic packages list", () => {
    const content = `packages:
  - apps/*
  - packages/*
`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*", "packages/*"]);
  });

  it("handles comments and blank lines", () => {
    const content = `packages:
  # Apps directory
  - apps/*

  # Packages directory
  - packages/*
`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*", "packages/*"]);
  });

  it("handles quoted values", () => {
    const content = `packages:
  - 'apps/*'
  - "packages/*"
`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*", "packages/*"]);
  });

  it("returns empty array when no packages key", () => {
    expect(parsePnpmWorkspaceYaml("version: 1")).toEqual([]);
  });

  it("returns empty array for empty content", () => {
    expect(parsePnpmWorkspaceYaml("")).toEqual([]);
  });

  it("stops at next top-level key", () => {
    const content = `packages:
  - apps/*
catalog:
  react: 19
`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*"]);
  });

  it("handles negation patterns", () => {
    const content = `packages:
  - apps/*
  - '!apps/legacy'
`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*", "!apps/legacy"]);
  });

  it("handles inline comments", () => {
    const content = `packages:
  - apps/* # the apps
  - packages/*
`;
    expect(parsePnpmWorkspaceYaml(content)).toEqual(["apps/*", "packages/*"]);
  });
});

describe("expandPackageGlobs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("expands wildcard globs to directories", () => {
    fs.mkdirSync(path.join(tmpDir, "apps", "web"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "apps", "api"), { recursive: true });
    // Create a file to ensure it's filtered out
    fs.writeFileSync(path.join(tmpDir, "apps", "README.md"), "");

    const result = expandPackageGlobs(tmpDir, ["apps/*"]);
    expect(result).toHaveLength(2);
    expect(result).toContain(path.join(tmpDir, "apps", "api"));
    expect(result).toContain(path.join(tmpDir, "apps", "web"));
  });

  it("handles literal directory paths", () => {
    fs.mkdirSync(path.join(tmpDir, "tools"), { recursive: true });
    const result = expandPackageGlobs(tmpDir, ["tools"]);
    expect(result).toEqual([path.join(tmpDir, "tools")]);
  });

  it("handles negation patterns", () => {
    fs.mkdirSync(path.join(tmpDir, "apps", "web"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "apps", "legacy"), { recursive: true });

    const result = expandPackageGlobs(tmpDir, ["apps/*", "!apps/legacy"]);
    expect(result).toHaveLength(1);
    expect(result).toContain(path.join(tmpDir, "apps", "web"));
  });

  it("returns empty for non-existent base directory", () => {
    expect(expandPackageGlobs(tmpDir, ["nonexistent/*"])).toEqual([]);
  });

  it("handles double-star globs same as single star", () => {
    fs.mkdirSync(path.join(tmpDir, "packages", "shared"), { recursive: true });
    const result = expandPackageGlobs(tmpDir, ["packages/**"]);
    expect(result).toHaveLength(1);
    expect(result).toContain(path.join(tmpDir, "packages", "shared"));
  });
});

describe("findWorkspaceRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("finds pnpm-workspace.yaml in cwd", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    expect(findWorkspaceRoot(tmpDir)).toBe(tmpDir);
  });

  it("walks up to find pnpm-workspace.yaml", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    const subDir = path.join(tmpDir, "apps", "web", "src");
    fs.mkdirSync(subDir, { recursive: true });
    expect(findWorkspaceRoot(subDir)).toBe(tmpDir);
  });

  it("returns null when no pnpm-workspace.yaml exists", () => {
    expect(findWorkspaceRoot(tmpDir)).toBeNull();
  });
});

describe("discoverWorkspacePackages", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("discovers packages with package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    const webDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      path.join(webDir, "package.json"),
      JSON.stringify({ name: "@myorg/web", scripts: { dev: "next dev" } })
    );

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe("web");
    expect(packages[0].scripts.dev).toBe("next dev");
    expect(packages[0].dir).toBe(webDir);
  });

  it("strips @scope/ from package names", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    const webDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      path.join(webDir, "package.json"),
      JSON.stringify({ name: "@company/web-app" })
    );

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages[0].name).toBe("web-app");
  });

  it("handles packages without a name field", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    const webDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      path.join(webDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } })
    );

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages[0].name).toBeNull();
  });

  it("skips directories without package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    fs.mkdirSync(path.join(tmpDir, "apps", "empty"), { recursive: true });

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages).toHaveLength(0);
  });

  it("discovers multiple packages from multiple globs", () => {
    fs.writeFileSync(
      path.join(tmpDir, "pnpm-workspace.yaml"),
      "packages:\n  - apps/*\n  - packages/*\n"
    );

    for (const dir of ["apps/web", "apps/api", "packages/shared"]) {
      const full = path.join(tmpDir, dir);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(
        path.join(full, "package.json"),
        JSON.stringify({ name: path.basename(dir), scripts: { dev: "echo dev" } })
      );
    }

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages).toHaveLength(3);
    const names = packages.map((p) => p.name).sort();
    expect(names).toEqual(["api", "shared", "web"]);
  });

  it("returns empty when pnpm-workspace.yaml is missing", () => {
    expect(discoverWorkspacePackages(tmpDir)).toEqual([]);
  });
});

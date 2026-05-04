import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  findWorkspaceRoot,
  discoverWorkspacePackages,
  parsePnpmWorkspaceYaml,
  expandPackageGlobs,
  readWorkspacesFromPackageJson,
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

  it("parses flow sequence on same line", () => {
    expect(parsePnpmWorkspaceYaml("packages: [apps/*, packages/*]")).toEqual([
      "apps/*",
      "packages/*",
    ]);
  });

  it("parses flow sequence with quotes", () => {
    expect(parsePnpmWorkspaceYaml(`packages: ['apps/*', "packages/*"]`)).toEqual([
      "apps/*",
      "packages/*",
    ]);
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

  it("handles mid-path wildcard (packages/*/src)", () => {
    const sharedSrc = path.join(tmpDir, "packages", "shared", "src");
    const utilsSrc = path.join(tmpDir, "packages", "utils", "src");
    fs.mkdirSync(sharedSrc, { recursive: true });
    fs.mkdirSync(utilsSrc, { recursive: true });
    // A package without src should not match
    fs.mkdirSync(path.join(tmpDir, "packages", "no-src"), { recursive: true });

    const result = expandPackageGlobs(tmpDir, ["packages/*/src"]);
    expect(result).toHaveLength(2);
    expect(result).toContain(sharedSrc);
    expect(result).toContain(utilsSrc);
  });

  it("handles prefix wildcard (apps/team-*)", () => {
    fs.mkdirSync(path.join(tmpDir, "apps", "team-alpha"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "apps", "team-beta"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "apps", "other"), { recursive: true });

    const result = expandPackageGlobs(tmpDir, ["apps/team-*"]);
    expect(result).toHaveLength(2);
    expect(result).toContain(path.join(tmpDir, "apps", "team-alpha"));
    expect(result).toContain(path.join(tmpDir, "apps", "team-beta"));
  });

  it("does not crash on prefix wildcard with trailing segments", () => {
    fs.mkdirSync(path.join(tmpDir, "apps", "team-alpha", "sub"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "apps", "team-beta"), { recursive: true });

    const result = expandPackageGlobs(tmpDir, ["apps/team-*/sub"]);
    expect(result).toHaveLength(1);
    expect(result).toContain(path.join(tmpDir, "apps", "team-alpha", "sub"));
  });
});

describe("readWorkspacesFromPackageJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  it("reads array-form workspaces", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: ["apps/*", "packages/*"] })
    );
    expect(readWorkspacesFromPackageJson(tmpDir)).toEqual(["apps/*", "packages/*"]);
  });

  it("reads yarn-classic object form", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: { packages: ["apps/*", "packages/*"] } })
    );
    expect(readWorkspacesFromPackageJson(tmpDir)).toEqual(["apps/*", "packages/*"]);
  });

  it("returns null when no workspaces field", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
    expect(readWorkspacesFromPackageJson(tmpDir)).toBeNull();
  });

  it("returns null when no package.json", () => {
    expect(readWorkspacesFromPackageJson(tmpDir)).toBeNull();
  });

  it("filters non-string entries", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: ["apps/*", 42, null, "packages/*"] })
    );
    expect(readWorkspacesFromPackageJson(tmpDir)).toEqual(["apps/*", "packages/*"]);
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

  it("returns null when no workspace root exists", () => {
    expect(findWorkspaceRoot(tmpDir)).toBeNull();
  });

  it("finds package.json workspaces in cwd", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    expect(findWorkspaceRoot(tmpDir)).toBe(tmpDir);
  });

  it("walks up to find package.json workspaces", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    const subDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(subDir, { recursive: true });
    expect(findWorkspaceRoot(subDir)).toBe(tmpDir);
  });

  it("prefers pnpm-workspace.yaml over package.json workspaces", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - pnpm-apps/*\n");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: ["npm-apps/*"] })
    );
    expect(findWorkspaceRoot(tmpDir)).toBe(tmpDir);
  });

  it("ignores package.json without workspaces field", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test" }));
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
    expect(packages[0].scope).toBe("myorg");
    expect(packages[0].scripts.dev).toBe("next dev");
    expect(packages[0].dir).toBe(webDir);
  });

  it("strips @scope/ from package names and preserves scope", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    const webDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      path.join(webDir, "package.json"),
      JSON.stringify({ name: "@company/web-app" })
    );

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages[0].name).toBe("web-app");
    expect(packages[0].scope).toBe("company");
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
    expect(packages[0].scope).toBeNull();
  });

  it("handles unscoped package names", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    const webDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, "package.json"), JSON.stringify({ name: "my-app" }));

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages[0].name).toBe("my-app");
    expect(packages[0].scope).toBeNull();
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

  it("returns empty when no workspace config exists", () => {
    expect(discoverWorkspacePackages(tmpDir)).toEqual([]);
  });

  it("discovers packages from package.json workspaces (npm/yarn/bun)", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
    const webDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      path.join(webDir, "package.json"),
      JSON.stringify({ name: "@myorg/web", scripts: { dev: "next dev" } })
    );

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe("web");
    expect(packages[0].scope).toBe("myorg");
    expect(packages[0].dir).toBe(webDir);
  });

  it("discovers packages from yarn-classic object workspaces", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: { packages: ["apps/*", "packages/*"] } })
    );
    for (const dir of ["apps/web", "packages/shared"]) {
      const full = path.join(tmpDir, dir);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(
        path.join(full, "package.json"),
        JSON.stringify({ name: path.basename(dir), scripts: { dev: "echo dev" } })
      );
    }

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages).toHaveLength(2);
    const names = packages.map((p) => p.name).sort();
    expect(names).toEqual(["shared", "web"]);
  });

  it("prefers pnpm-workspace.yaml over package.json workspaces", () => {
    fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] })
    );
    const webDir = path.join(tmpDir, "apps", "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      path.join(webDir, "package.json"),
      JSON.stringify({ name: "web", scripts: { dev: "echo dev" } })
    );
    const sharedDir = path.join(tmpDir, "packages", "shared");
    fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(
      path.join(sharedDir, "package.json"),
      JSON.stringify({ name: "shared", scripts: { dev: "echo dev" } })
    );

    const packages = discoverWorkspacePackages(tmpDir);
    expect(packages).toHaveLength(1);
    expect(packages[0].name).toBe("web");
  });
});

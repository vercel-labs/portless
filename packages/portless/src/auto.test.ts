import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  sanitizeForHostname,
  truncateLabel,
  inferProjectName,
  resolveWorktreeNaming,
  composeHostname,
} from "./auto.js";

// ---------------------------------------------------------------------------
// sanitizeForHostname
// ---------------------------------------------------------------------------

describe("sanitizeForHostname", () => {
  it("lowercases input", () => {
    expect(sanitizeForHostname("MyApp")).toBe("myapp");
  });

  it("replaces invalid characters with hyphens", () => {
    expect(sanitizeForHostname("my_app")).toBe("my-app");
    expect(sanitizeForHostname("my app")).toBe("my-app");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeForHostname("my--app")).toBe("my-app");
    expect(sanitizeForHostname("a___b")).toBe("a-b");
  });

  it("trims leading and trailing hyphens", () => {
    expect(sanitizeForHostname("-myapp-")).toBe("myapp");
    expect(sanitizeForHostname("--myapp--")).toBe("myapp");
    expect(sanitizeForHostname("@myapp!")).toBe("myapp");
  });

  it("returns empty string for entirely invalid input", () => {
    expect(sanitizeForHostname("@@@")).toBe("");
    expect(sanitizeForHostname("---")).toBe("");
    expect(sanitizeForHostname("")).toBe("");
  });

  it("preserves valid characters", () => {
    expect(sanitizeForHostname("my-app-123")).toBe("my-app-123");
  });

  it("handles mixed case and underscores", () => {
    expect(sanitizeForHostname("My_Feature_Branch")).toBe("my-feature-branch");
  });
});

// ---------------------------------------------------------------------------
// truncateLabel
// ---------------------------------------------------------------------------

describe("truncateLabel", () => {
  it("returns label unchanged when <= 63 characters", () => {
    expect(truncateLabel("my-app")).toBe("my-app");
    expect(truncateLabel("a".repeat(63))).toBe("a".repeat(63));
  });

  it("truncates label exceeding 63 characters", () => {
    const result = truncateLabel("a".repeat(80));
    expect(result.length).toBeLessThanOrEqual(63);
  });

  it("appends a hash suffix for uniqueness", () => {
    const result = truncateLabel("a".repeat(80));
    expect(result).toMatch(/-[a-f0-9]{6}$/);
  });

  it("produces different hashes for different inputs", () => {
    const result1 = truncateLabel("a".repeat(80));
    const result2 = truncateLabel("b".repeat(80));
    expect(result1).not.toBe(result2);
  });

  it("is deterministic", () => {
    const input =
      "my-very-long-feature-branch-name-that-exceeds-the-dns-label-limit-by-quite-a-bit";
    expect(truncateLabel(input)).toBe(truncateLabel(input));
  });

  it("does not end with a hyphen before the hash", () => {
    // Construct input where truncation point falls on a hyphen
    const input = "a".repeat(55) + "-" + "b".repeat(20);
    const result = truncateLabel(input);
    expect(result.length).toBeLessThanOrEqual(63);
    // Should not have double hyphens from trailing-hyphen stripping + hash separator
    expect(result).not.toMatch(/--/);
  });
});

// ---------------------------------------------------------------------------
// inferProjectName
// ---------------------------------------------------------------------------

describe("inferProjectName", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads name from package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "my-cool-app" }));
    const result = inferProjectName(tmpDir);
    expect(result.name).toBe("my-cool-app");
    expect(result.source).toBe("package.json");
  });

  it("strips scoped package name prefix", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "@org/myapp" }));
    const result = inferProjectName(tmpDir);
    expect(result.name).toBe("myapp");
    expect(result.source).toBe("package.json");
  });

  it("walks up directories to find package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "parent-app" }));
    const subDir = path.join(tmpDir, "src", "components");
    fs.mkdirSync(subDir, { recursive: true });
    const result = inferProjectName(subDir);
    expect(result.name).toBe("parent-app");
    expect(result.source).toBe("package.json");
  });

  it("skips package.json with empty name", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "" }));
    const result = inferProjectName(tmpDir);
    expect(result.source).not.toBe("package.json");
  });

  it("skips package.json without name field", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    const result = inferProjectName(tmpDir);
    expect(result.source).not.toBe("package.json");
  });

  it("falls back to git root directory name", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const result = inferProjectName(tmpDir);
    expect(result.source).toBe("git root");
    expect(result.name).toBeTruthy();
  });

  it("falls back to cwd basename", () => {
    const namedDir = path.join(tmpDir, "my-project");
    fs.mkdirSync(namedDir);
    const result = inferProjectName(namedDir);
    expect(result.name).toBe("my-project");
    expect(result.source).toBe("directory name");
  });

  it("sanitizes the package.json name", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "My_App" }));
    const result = inferProjectName(tmpDir);
    expect(result.name).toBe("my-app");
  });

  it("keeps the full inferred name until flat hostname composition", () => {
    const name = `My_${"A".repeat(80)}`;
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name }));
    const inferred = inferProjectName(tmpDir);
    const sanitized = `my-${"a".repeat(80)}`;
    const naming = resolveWorktreeNaming({ override: "feature", config: { flat: true } });
    expect(inferred.name).toBe(sanitized);
    expect(composeHostname(inferred.name, naming)).toBe(truncateLabel(`feature-${sanitized}`));
  });

  it("skips package.json whose name sanitizes to empty", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "@@@" }));
    const result = inferProjectName(tmpDir);
    expect(result.source).not.toBe("package.json");
  });
});

// ---------------------------------------------------------------------------
// resolveWorktreeNaming
// ---------------------------------------------------------------------------

describe("resolveWorktreeNaming", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
    vi.stubEnv("PORTLESS_PREFIX", undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  // These tests exercise the filesystem-based fallback path. The git CLI
  // fails naturally in temp dirs outside any real git repo.

  /**
   * Set up a fake worktree: a .git file pointing to a gitdir, and a HEAD
   * file inside that gitdir with the given branch ref.
   */
  function setupWorktree(dir: string, branch: string) {
    const worktreeName = "wt";
    const gitdir = path.join(tmpDir, "fake-bare.git", "worktrees", worktreeName);
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`);
    fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gitdir}\n`);
  }

  it("returns null for a main checkout (.git directory)", () => {
    fs.mkdirSync(path.join(tmpDir, ".git"));
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toBeNull();
  });

  it("uses branch name as prefix from .git file", () => {
    setupWorktree(tmpDir, "feature-auth");
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toMatchObject({ prefix: "feature-auth", source: "git branch" });
  });

  it("returns null when branch is main", () => {
    setupWorktree(tmpDir, "main");
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toBeNull();
  });

  it("returns null when branch is master", () => {
    setupWorktree(tmpDir, "master");
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toBeNull();
  });

  it("returns null for submodule .git file", () => {
    const gitdir = path.join(tmpDir, "fake.git", "modules", "my-submodule");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git"), `gitdir: ${gitdir}\n`);
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toBeNull();
  });

  it("uses last segment of branch name with slashes", () => {
    setupWorktree(tmpDir, "feature/My_Branch");
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toMatchObject({ prefix: "my-branch", source: "git branch" });
  });

  it("keeps the whole branch name with the branch prefix style", () => {
    const cases: [string, string][] = [
      ["team-a/login", "team-a-login"],
      ["team-b/login", "team-b-login"],
    ];
    for (const [branch, expected] of cases) {
      setupWorktree(tmpDir, branch);
      expect(resolveWorktreeNaming({ cwd: tmpDir })!.prefix).toBe("login");
      expect(resolveWorktreeNaming({ cwd: tmpDir, config: { prefix: "branch" } })).toMatchObject({
        prefix: expected,
        source: "git branch",
      });
    }
    vi.stubEnv("PORTLESS_PREFIX", "main");
    expect(resolveWorktreeNaming({ cwd: tmpDir })).toMatchObject({
      prefix: "main",
      source: "PORTLESS_PREFIX",
    });
    vi.stubEnv("PORTLESS_PREFIX", "");
    expect(resolveWorktreeNaming({ cwd: tmpDir, config: { prefix: "branch" } })).toBeNull();
  });

  it("returns null when no .git found at all", () => {
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toBeNull();
  });

  it("walks up directories to find .git file", () => {
    setupWorktree(tmpDir, "deep-feature");
    const subDir = path.join(tmpDir, "src", "lib");
    fs.mkdirSync(subDir, { recursive: true });
    const result = resolveWorktreeNaming({ cwd: subDir });
    expect(result).toMatchObject({ prefix: "deep-feature", source: "git branch" });
  });

  it("returns null for detached HEAD", () => {
    const worktreeName = "wt";
    const gitdir = path.join(tmpDir, "fake-bare.git", "worktrees", worktreeName);
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "HEAD"), "abc123def456\n");
    fs.writeFileSync(path.join(tmpDir, ".git"), `gitdir: ${gitdir}\n`);
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toBeNull();
  });

  it("returns null for .git file with no gitdir line", () => {
    fs.writeFileSync(path.join(tmpDir, ".git"), "something unexpected\n");
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toBeNull();
  });

  it("uses last segment even when it matches a default branch name", () => {
    setupWorktree(tmpDir, "feature/main");
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toMatchObject({ prefix: "main", source: "git branch" });
  });

  it("uses last segment for feature/master", () => {
    setupWorktree(tmpDir, "feature/master");
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toMatchObject({ prefix: "master", source: "git branch" });
  });

  it("returns null when branch sanitizes to empty", () => {
    setupWorktree(tmpDir, "@@@");
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).toBeNull();
  });

  it("truncates prefix from a branch name exceeding 63 characters", () => {
    const longBranch = "ctd-1744-improve-visibility-of-later-and-undated-notifications-in";
    expect(longBranch.length).toBeGreaterThan(63);
    setupWorktree(tmpDir, longBranch);
    const result = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result).not.toBeNull();
    expect(result!.prefix.length).toBeLessThanOrEqual(63);
    expect(result!.source).toBe("git branch");
  });

  it("produces a deterministic truncated prefix for a long branch name", () => {
    const longBranch = "ctd-1744-improve-visibility-of-later-and-undated-notifications-in";
    setupWorktree(tmpDir, longBranch);
    const result1 = resolveWorktreeNaming({ cwd: tmpDir });
    const result2 = resolveWorktreeNaming({ cwd: tmpDir });
    expect(result1!.prefix).toBe(result2!.prefix);
  });
});

// ---------------------------------------------------------------------------
// resolveWorktreeNaming (git CLI path)
// ---------------------------------------------------------------------------

describe("resolveWorktreeNaming (git CLI path)", { timeout: 15_000 }, () => {
  let gitInitWorks = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    // Also verify git init actually works (may be blocked in sandboxes)
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "portless-git-probe-"));
    try {
      execFileSync("git", ["init"], { cwd: probe, stdio: "ignore" });
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  } catch {
    gitInitWorks = false;
  }

  if (!gitInitWorks) {
    it.skip("git init not available (sandboxed environment)", () => {});
    return;
  }

  function runGit(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  }

  function initRepoWithCommit(repoDir: string): void {
    fs.mkdirSync(repoDir, { recursive: true });
    runGit(repoDir, ["init"]);
    runGit(repoDir, ["branch", "-M", "main"]);
    runGit(repoDir, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ]);
  }

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-git-test-"));
    vi.stubEnv("PORTLESS_PREFIX", undefined);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("returns null for a single worktree (no linked worktrees)", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    const result = resolveWorktreeNaming({ cwd: repo });
    expect(result).toBeNull();
  });

  it("returns prefix for a linked worktree on a non-default branch", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    runGit(repo, ["branch", "feature-auth"]);
    const wtDir = path.join(tmpDir, "wt-feature-auth");
    runGit(repo, ["worktree", "add", wtDir, "feature-auth"]);

    const result = resolveWorktreeNaming({ cwd: wtDir });
    expect(result).toMatchObject({ prefix: "feature-auth", source: "git branch" });
    expect(resolveWorktreeNaming({ cwd: wtDir, config: { flat: true } })).toMatchObject({
      prefix: "feature-auth",
      source: "git branch",
    });
  });

  it("returns null for the primary checkout on main when worktrees exist", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    runGit(repo, ["branch", "feature-auth"]);
    const wtDir = path.join(tmpDir, "wt-feature-auth");
    runGit(repo, ["worktree", "add", wtDir, "feature-auth"]);

    const result = resolveWorktreeNaming({ cwd: repo });
    expect(result).toBeNull();
  });

  it("returns null for root worktree on a feature branch (not a linked worktree)", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    // Create a linked worktree so worktreeCount > 1
    runGit(repo, ["branch", "feature-auth"]);
    const wtDir = path.join(tmpDir, "wt-feature-auth");
    runGit(repo, ["worktree", "add", wtDir, "feature-auth"]);

    // Switch the root worktree to a feature branch
    runGit(repo, ["checkout", "-b", "feature-other"]);

    // Root worktree on a non-default branch should NOT get a prefix
    const result = resolveWorktreeNaming({ cwd: repo });
    expect(result).toBeNull();
  });

  it("returns last segment as prefix for slash-prefixed branch (feature/main)", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    runGit(repo, ["branch", "feature/main"]);
    const wtDir = path.join(tmpDir, "wt-feature-main");
    runGit(repo, ["worktree", "add", wtDir, "feature/main"]);

    const result = resolveWorktreeNaming({ cwd: wtDir });
    expect(result).toMatchObject({ prefix: "main", source: "git branch" });
  });

  it("truncates prefix when branch name exceeds 63 characters", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    const longBranch = "ctd-1744-improve-visibility-of-later-and-undated-notifications-in";
    expect(longBranch.length).toBeGreaterThan(63);

    runGit(repo, ["branch", longBranch]);
    const wtDir = path.join(tmpDir, "wt-long");
    runGit(repo, ["worktree", "add", wtDir, longBranch]);

    const result = resolveWorktreeNaming({ cwd: wtDir });
    expect(result).not.toBeNull();
    expect(result!.prefix.length).toBeLessThanOrEqual(63);
    expect(result!.source).toBe("git branch");
  });
});

describe("composeHostname", () => {
  function naming(config?: { hostnameTemplate?: string; flat?: boolean; base?: string }) {
    return resolveWorktreeNaming({ override: "feature-x", config });
  }

  it("prepends the prefix and truncates each label even without naming", () => {
    expect(composeHostname("web.json-render", naming())).toBe("feature-x.web.json-render");
    expect(composeHostname("api", naming())).toBe("feature-x.api");
    const long = "a".repeat(80);
    expect(composeHostname(`${long}.web`, null)).toBe(`${truncateLabel(long)}.web`);
  });

  it("uses the template before other layouts and preserves template lowercasing", () => {
    const config = { hostnameTemplate: "{worktree}-{name}", flat: true, base: "example" };
    expect(composeHostname("WEB.example", naming(config))).toBe("feature-x-web.example");
    const long = resolveWorktreeNaming({ override: "a".repeat(63), config });
    const web = composeHostname("web", long);
    expect(web).toHaveLength(63);
    expect(composeHostname("WEB", long)).toBe(web);
    expect(composeHostname("api", long)).not.toBe(web);
    const longName = "b".repeat(80);
    expect(composeHostname(longName, naming(config))).toBe(
      truncateLabel(`feature-x-${truncateLabel(longName)}`)
    );
  });

  it("flattens all labels and hashes the complete untruncated input once", () => {
    expect(composeHostname("api.project", naming({ flat: true, base: "project" }))).toBe(
      "feature-x-api-project"
    );
    const prefix = "p".repeat(80);
    const base = `${"a".repeat(70)}.project`;
    const resolved = resolveWorktreeNaming({ override: prefix, config: { flat: true } });
    expect(composeHostname(base, resolved)).toBe(
      truncateLabel(`${prefix}-${base.replaceAll(".", "-")}`)
    );
    expect(composeHostname(base.toUpperCase(), resolved)).toBe(composeHostname(base, resolved));
  });

  it("preserves empty labels for hostname validation when flattening", () => {
    expect(composeHostname("web..project", naming({ flat: true }))).toBe("feature-x.web..project");
  });

  it("inserts the prefix before a matching base at label boundaries", () => {
    const resolved = naming({ base: "Project.Example" });
    expect(composeHostname("web.project.example", resolved)).toBe("web.feature-x.project.example");
    expect(composeHostname("PROJECT.EXAMPLE", resolved)).toBe("feature-x.PROJECT.EXAMPLE");
    expect(composeHostname("notproject.example", resolved)).toBe("feature-x.notproject.example");
    expect(composeHostname("web.other", resolved)).toBe("feature-x.web.other");
  });
});

describe("resolveWorktreeNaming overrides", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("gives explicit overrides precedence over the environment, including disable", () => {
    vi.stubEnv("PORTLESS_PREFIX", "from-env");
    expect(resolveWorktreeNaming({ override: "From CLI" })).toMatchObject({
      prefix: "from-cli",
      source: "--prefix flag",
    });
    expect(resolveWorktreeNaming({ override: null })).toBeNull();
    expect(resolveWorktreeNaming({ override: "" })).toBeNull();
    expect(resolveWorktreeNaming()).toMatchObject({
      prefix: "from-env",
      source: "PORTLESS_PREFIX",
    });
    vi.stubEnv("PORTLESS_PREFIX", "");
    expect(resolveWorktreeNaming()).toBeNull();
  });
});

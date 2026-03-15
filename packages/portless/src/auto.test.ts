import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  sanitizeForHostname,
  truncateLabel,
  inferProjectName,
  detectWorktreePrefix,
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

  it("truncates labels exceeding 63 characters", () => {
    const longName = "a".repeat(80);
    const result = sanitizeForHostname(longName);
    expect(result.length).toBeLessThanOrEqual(63);
  });

  it("returns deterministic result for truncated labels", () => {
    const longName = "a".repeat(80);
    expect(sanitizeForHostname(longName)).toBe(sanitizeForHostname(longName));
  });

  it("preserves labels at exactly 63 characters", () => {
    const name63 = "a".repeat(63);
    expect(sanitizeForHostname(name63)).toBe(name63);
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

  it("skips package.json whose name sanitizes to empty", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "@@@" }));
    const result = inferProjectName(tmpDir);
    expect(result.source).not.toBe("package.json");
  });
});

// ---------------------------------------------------------------------------
// detectWorktreePrefix
// ---------------------------------------------------------------------------

describe("detectWorktreePrefix", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toBeNull();
  });

  it("uses branch name as prefix from .git file", () => {
    setupWorktree(tmpDir, "feature-auth");
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toEqual({ prefix: "feature-auth", source: "git branch" });
  });

  it("returns null when branch is main", () => {
    setupWorktree(tmpDir, "main");
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when branch is master", () => {
    setupWorktree(tmpDir, "master");
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for submodule .git file", () => {
    const gitdir = path.join(tmpDir, "fake.git", "modules", "my-submodule");
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git"), `gitdir: ${gitdir}\n`);
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toBeNull();
  });

  it("uses last segment of branch name with slashes", () => {
    setupWorktree(tmpDir, "feature/My_Branch");
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toEqual({ prefix: "my-branch", source: "git branch" });
  });

  it("returns null when no .git found at all", () => {
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toBeNull();
  });

  it("walks up directories to find .git file", () => {
    setupWorktree(tmpDir, "deep-feature");
    const subDir = path.join(tmpDir, "src", "lib");
    fs.mkdirSync(subDir, { recursive: true });
    const result = detectWorktreePrefix(subDir);
    expect(result).toEqual({ prefix: "deep-feature", source: "git branch" });
  });

  it("returns null for detached HEAD", () => {
    const worktreeName = "wt";
    const gitdir = path.join(tmpDir, "fake-bare.git", "worktrees", worktreeName);
    fs.mkdirSync(gitdir, { recursive: true });
    fs.writeFileSync(path.join(gitdir, "HEAD"), "abc123def456\n");
    fs.writeFileSync(path.join(tmpDir, ".git"), `gitdir: ${gitdir}\n`);
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for .git file with no gitdir line", () => {
    fs.writeFileSync(path.join(tmpDir, ".git"), "something unexpected\n");
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toBeNull();
  });

  it("uses last segment even when it matches a default branch name", () => {
    setupWorktree(tmpDir, "feature/main");
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toEqual({ prefix: "main", source: "git branch" });
  });

  it("uses last segment for feature/master", () => {
    setupWorktree(tmpDir, "feature/master");
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toEqual({ prefix: "master", source: "git branch" });
  });

  it("returns null when branch sanitizes to empty", () => {
    setupWorktree(tmpDir, "@@@");
    const result = detectWorktreePrefix(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectWorktreePrefix (git CLI path)
// ---------------------------------------------------------------------------

describe("detectWorktreePrefix (git CLI path)", () => {
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
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ]);
  }

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-git-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for a single worktree (no linked worktrees)", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    const result = detectWorktreePrefix(repo);
    expect(result).toBeNull();
  });

  it("returns prefix for a linked worktree on a non-default branch", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    runGit(repo, ["branch", "feature-auth"]);
    const wtDir = path.join(tmpDir, "wt-feature-auth");
    runGit(repo, ["worktree", "add", wtDir, "feature-auth"]);

    const result = detectWorktreePrefix(wtDir);
    expect(result).toEqual({ prefix: "feature-auth", source: "git branch" });
  });

  it("returns null for the primary checkout on main when worktrees exist", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    runGit(repo, ["branch", "feature-auth"]);
    const wtDir = path.join(tmpDir, "wt-feature-auth");
    runGit(repo, ["worktree", "add", wtDir, "feature-auth"]);

    const result = detectWorktreePrefix(repo);
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
    const result = detectWorktreePrefix(repo);
    expect(result).toBeNull();
  });

  it("returns last segment as prefix for slash-prefixed branch (feature/main)", () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    runGit(repo, ["branch", "feature/main"]);
    const wtDir = path.join(tmpDir, "wt-feature-main");
    runGit(repo, ["worktree", "add", wtDir, "feature/main"]);

    const result = detectWorktreePrefix(wtDir);
    expect(result).toEqual({ prefix: "main", source: "git branch" });
  });
});

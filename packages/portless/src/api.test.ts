import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getUrl } from "./api.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeStateMarkers(
  dir: string,
  options: { port?: number; tls?: boolean; tld?: string } = {}
): void {
  fs.mkdirSync(dir, { recursive: true });
  if (options.port !== undefined) {
    fs.writeFileSync(path.join(dir, "proxy.port"), String(options.port));
  }
  if (options.tls) {
    fs.writeFileSync(path.join(dir, "proxy.tls"), "1");
  }
  if (options.tld !== undefined) {
    fs.writeFileSync(path.join(dir, "proxy.tld"), options.tld);
  }
}

// ---------------------------------------------------------------------------
// getUrl — basic shape and component fields
// ---------------------------------------------------------------------------

describe("getUrl", () => {
  let tmpDir: string;
  let stateDir: string;
  const originalStateDir = process.env.PORTLESS_STATE_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-api-"));
    stateDir = path.join(tmpDir, "state");
    process.env.PORTLESS_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.PORTLESS_STATE_DIR;
    } else {
      process.env.PORTLESS_STATE_DIR = originalStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // These tests pass `worktree: false` so the assertions are independent of
  // the cwd the test runner happens to be in (the suite itself runs inside
  // the portless worktree, which would otherwise inject a branch prefix).

  it("returns the URL and components from persisted markers (HTTPS + default TLD)", async () => {
    writeStateMarkers(stateDir, { port: 443, tls: true });

    const result = await getUrl("myapp", { worktree: false });

    expect(result.url).toBe("https://myapp.localhost");
    expect(result.hostname).toBe("myapp.localhost");
    expect(result.port).toBe(443);
    expect(result.tls).toBe(true);
    expect(result.tld).toBe("localhost");
  });

  it("returns HTTP with the proxy port when TLS marker is absent", async () => {
    writeStateMarkers(stateDir, { port: 1355 });

    const result = await getUrl("myapp", { worktree: false });

    expect(result.url).toBe("http://myapp.localhost:1355");
    expect(result.tls).toBe(false);
  });

  it("uses a custom TLD when proxy.tld is set", async () => {
    writeStateMarkers(stateDir, { port: 443, tls: true, tld: "test" });

    const result = await getUrl("myapp", { worktree: false });

    expect(result.url).toBe("https://myapp.test");
    expect(result.hostname).toBe("myapp.test");
    expect(result.tld).toBe("test");
  });

  it("preserves dotted service names as subdomain chains", async () => {
    writeStateMarkers(stateDir, { port: 443, tls: true });

    const result = await getUrl("api.myapp", { worktree: false });

    expect(result.url).toBe("https://api.myapp.localhost");
    expect(result.hostname).toBe("api.myapp.localhost");
  });

  it("rejects invalid hostname characters", async () => {
    writeStateMarkers(stateDir, { port: 443 });

    await expect(getUrl("my@app", { worktree: false })).rejects.toThrow(/Invalid hostname/);
  });
});

// ---------------------------------------------------------------------------
// getUrl — string coercion via toString()
// ---------------------------------------------------------------------------

describe("getUrl — string coercion", () => {
  let tmpDir: string;
  let stateDir: string;
  const originalStateDir = process.env.PORTLESS_STATE_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-api-coerce-"));
    stateDir = path.join(tmpDir, "state");
    process.env.PORTLESS_STATE_DIR = stateDir;
    writeStateMarkers(stateDir, { port: 443, tls: true });
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.PORTLESS_STATE_DIR;
    } else {
      process.env.PORTLESS_STATE_DIR = originalStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("coerces to the URL string in template literals", async () => {
    const result = await getUrl("myapp", { worktree: false });
    expect(`${result}`).toBe("https://myapp.localhost");
  });

  it("coerces to the URL string via String()", async () => {
    const result = await getUrl("myapp", { worktree: false });
    expect(String(result)).toBe("https://myapp.localhost");
  });

  it("coerces to the URL string in concatenation", async () => {
    const result = await getUrl("myapp", { worktree: false });
    expect(result + "/health").toBe("https://myapp.localhost/health");
  });

  it("works with the URL constructor", async () => {
    const result = await getUrl("myapp", { worktree: false });
    expect(new URL(String(result)).hostname).toBe("myapp.localhost");
  });

  it("does not include toString in JSON.stringify output", async () => {
    const result = await getUrl("myapp", { worktree: false });
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed).toEqual({
      url: "https://myapp.localhost",
      hostname: "myapp.localhost",
      port: 443,
      tls: true,
      tld: "localhost",
    });
  });

  it("does not include toString in Object.keys", async () => {
    const result = await getUrl("myapp", { worktree: false });
    expect(Object.keys(result).sort()).toEqual(["hostname", "port", "tld", "tls", "url"]);
  });
});

// ---------------------------------------------------------------------------
// getUrl — worktree prefix behavior
// ---------------------------------------------------------------------------

describe("getUrl — worktree behavior", { timeout: 15_000 }, () => {
  let gitInitWorks = true;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), "portless-api-git-probe-"));
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
  let stateDir: string;
  const originalStateDir = process.env.PORTLESS_STATE_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-api-wt-"));
    stateDir = path.join(tmpDir, "state");
    process.env.PORTLESS_STATE_DIR = stateDir;
    writeStateMarkers(stateDir, { port: 443, tls: true });
  });

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env.PORTLESS_STATE_DIR;
    } else {
      process.env.PORTLESS_STATE_DIR = originalStateDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies the branch as a subdomain inside a linked worktree", async () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);
    runGit(repo, ["branch", "feature-x"]);
    const wtDir = path.join(tmpDir, "wt-feature-x");
    runGit(repo, ["worktree", "add", wtDir, "feature-x"]);

    const result = await getUrl("myapp", { cwd: wtDir });

    expect(result.url).toBe("https://feature-x.myapp.localhost");
    expect(result.hostname).toBe("feature-x.myapp.localhost");
  });

  it("returns the bare URL on the primary checkout, even when linked worktrees exist", async () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);
    runGit(repo, ["branch", "feature-x"]);
    runGit(repo, ["worktree", "add", path.join(tmpDir, "wt-feature-x"), "feature-x"]);

    const result = await getUrl("myapp", { cwd: repo });

    expect(result.url).toBe("https://myapp.localhost");
    expect(result.hostname).toBe("myapp.localhost");
  });

  it("skips the worktree prefix when worktree: false", async () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);
    runGit(repo, ["branch", "feature-x"]);
    const wtDir = path.join(tmpDir, "wt-feature-x");
    runGit(repo, ["worktree", "add", wtDir, "feature-x"]);

    const result = await getUrl("myapp", { cwd: wtDir, worktree: false });

    expect(result.url).toBe("https://myapp.localhost");
    expect(result.hostname).toBe("myapp.localhost");
  });

  it("ignores worktree: true (default behavior) when not in a linked worktree", async () => {
    const repo = path.join(tmpDir, "repo");
    initRepoWithCommit(repo);

    const result = await getUrl("myapp", { cwd: repo });

    expect(result.url).toBe("https://myapp.localhost");
  });
});

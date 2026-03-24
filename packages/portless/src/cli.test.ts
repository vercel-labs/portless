import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { RouteStore } from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

/** Run the CLI with the given args and optional env overrides. */
function run(args: string[], options?: { env?: Record<string, string | undefined>; cwd?: string }) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
    cwd: options?.cwd,
    env: { ...process.env, ...options?.env, NO_COLOR: "1" },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("CLI", () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`Built CLI not found at ${CLI_PATH}. Run 'pnpm build' before running tests.`);
    }
  });

  describe("--help", () => {
    it("prints help and exits 0 with --help", () => {
      const { status, stdout } = run(["--help"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless");
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("Examples:");
      expect(stdout).toContain("proxy start");
      expect(stdout).toContain("portless run");
      expect(stdout).toContain("portless get");
      expect(stdout).toContain("run [--name <name>]");
      expect(stdout).toContain("--port");
      expect(stdout).toContain("-p");
      expect(stdout).toContain("--foreground");
      expect(stdout).toContain("PORTLESS_STATE_DIR");
      expect(stdout).toContain("PORTLESS_URL");
    });

    it("prints help and exits 0 with -h", () => {
      const { status, stdout } = run(["-h"]);
      expect(status).toBe(0);
      expect(stdout).toContain("Usage:");
    });

    it("prints help and exits 0 with no args", () => {
      const { status, stdout } = run([]);
      expect(status).toBe(0);
      expect(stdout).toContain("Usage:");
    });
  });

  describe("--version", () => {
    it("prints version and exits 0 with --version", () => {
      const { status, stdout } = run(["--version"]);
      expect(status).toBe(0);
      // Version should be a semver-like string
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it("prints version and exits 0 with -v", () => {
      const { status, stdout } = run(["-v"]);
      expect(status).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("list", () => {
    it("shows no active routes message when none registered", () => {
      // Note: the CLI discovers the state dir dynamically. We just verify
      // it doesn't crash and returns 0.
      const { status } = run(["list"]);
      expect(status).toBe(0);
    });

    it("shows TCP aliases with tcp:// URLs and listen ports", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-cli-list-test-"));
      try {
        fs.writeFileSync(
          path.join(tmpDir, "routes.json"),
          JSON.stringify([
            {
              hostname: "redis.localhost",
              port: 6379,
              pid: 0,
              type: "tcp",
              listenPort: 5501,
            },
          ])
        );

        const { status, stdout } = run(["list"], { env: { PORTLESS_STATE_DIR: tmpDir } });
        expect(status).toBe(0);
        expect(stdout).toContain("127.0.0.1:5501");
        expect(stdout).toContain("(redis.localhost)");
        expect(stdout).toContain("localhost:6379");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("proxy", () => {
    it("shows proxy usage hint for bare 'proxy' command", () => {
      const { status, stdout } = run(["proxy"]);
      expect(status).toBe(0);
      expect(stdout).toContain("proxy start");
      expect(stdout).toContain("proxy stop");
      expect(stdout).toContain("--foreground");
    });

    it("exits 1 for unknown proxy subcommand", () => {
      const { status, stdout } = run(["proxy", "unknown"]);
      expect(status).toBe(1);
      expect(stdout).toContain("proxy start");
    });
  });

  describe("error: no command provided", () => {
    it("exits 1 when only a name is given without a command", () => {
      const { status, stderr } = run(["myapp"]);
      expect(status).toBe(1);
      expect(stderr).toContain("No command provided");
    });
  });

  describe("PORTLESS=0 bypass", () => {
    it("runs command directly when PORTLESS=0 is set", () => {
      const { status, stdout } = run(["myapp", "echo", "hello"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("hello");
    });

    it("runs command directly when PORTLESS=skip is set", () => {
      const { status, stdout } = run(["myapp", "echo", "bypassed"], {
        env: { PORTLESS: "skip" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("bypassed");
    });

    it("does not bypass proxy commands when PORTLESS=0 is set", () => {
      // 'proxy stop' should still be handled as a proxy command, not bypassed
      const { stderr } = run(["proxy", "stop"], {
        env: { PORTLESS: "0" },
      });
      // Should not try to run "stop" as a shell command
      expect(stderr).not.toContain("ENOENT");
    });

    it("passes through exit code from bypassed command", () => {
      const { status } = run(["myapp", "node", "-e", "process.exit(42)"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(42);
    });
  });

  describe("PORTLESS=0 bypass with run subcommand", () => {
    it("runs command directly in run mode", () => {
      const { status, stdout } = run(["run", "echo", "hello"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("hello");
    });

    it("strips --force but passes child --force through", () => {
      const { status, stdout } = run(["run", "--force", "echo", "--force", "kept"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("--force kept");
    });

    it("passes -- separator through to child command", () => {
      const { status, stdout } = run(["run", "--", "echo", "hello"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("hello");
    });
  });

  describe("--force positioning", () => {
    it("accepts --force before name (PORTLESS=0)", () => {
      const { status, stdout } = run(["--force", "myapp", "echo", "ok"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("ok");
    });

    it("accepts --force after name (PORTLESS=0)", () => {
      const { status, stdout } = run(["myapp", "--force", "echo", "ok"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("ok");
    });

    it("does not strip child command --force (PORTLESS=0)", () => {
      const { status, stdout } = run(["myapp", "echo", "--force", "kept"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("--force kept");
    });
  });

  describe("unknown flag detection", () => {
    it("rejects unknown flags before command", () => {
      const { status, stderr } = run(["--forec", "myapp", "echo", "test"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Unknown flag");
    });
  });

  describe("invalid hostname", () => {
    it("exits 1 for hostname with invalid characters", () => {
      // The proxy won't be running, but parseHostname should fail first
      // Note: this will try to runApp which checks proxy first in non-TTY mode
      const { status, stderr } = run(["my@app", "echo", "test"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Invalid hostname");
    });
  });

  describe("run subcommand dispatch", () => {
    it("exits 1 with 'No command provided' when no args follow run", () => {
      const { status, stderr } = run(["run"]);
      expect(status).toBe(1);
      expect(stderr).toContain("No command provided");
    });

    it("does not dispatch 'list' as the global list command", () => {
      // With PORTLESS=0, "run list" should try to exec "list" as a child
      // process (which will ENOENT), not show routes.
      const { stdout } = run(["run", "list"], {
        env: { PORTLESS: "0" },
      });
      // If it mistakenly ran the global "list" handler, status would be 0
      // and stdout would contain route output. Instead it should try to
      // spawn "list" which doesn't exist.
      expect(stdout).not.toContain("Active routes");
      expect(stdout).not.toContain("No active routes");
    });

    it("does not print version for run --version", () => {
      // parseRunArgs rejects unknown flags
      const { status, stderr } = run(["run", "--version"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Unknown flag");
    });

    it("prints run-specific help for run --help", () => {
      const { status, stdout } = run(["run", "--help"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless run");
      expect(stdout).toContain("--force");
      expect(stdout).toContain("--app-port");
    });

    it("prints run-specific help for run -h", () => {
      const { status, stdout } = run(["run", "-h"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless run");
    });
  });

  describe("--app-port flag", () => {
    it("passes --app-port through in bypass mode (PORTLESS=0)", () => {
      const { status, stdout } = run(["run", "--app-port", "4567", "echo", "ok"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("ok");
    });

    it("rejects invalid --app-port value", () => {
      const { status, stderr } = run(["run", "--app-port", "abc", "echo", "ok"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(1);
      expect(stderr).toContain("Invalid app port");
    });

    it("rejects --app-port without a value", () => {
      const { status, stderr } = run(["run", "--app-port"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(1);
      expect(stderr).toContain("--app-port requires");
    });

    it("accepts --app-port in named mode (PORTLESS=0)", () => {
      const { status, stdout } = run(["myapp", "--app-port", "3000", "echo", "ok"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("ok");
    });
  });

  describe("alias subcommand", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-cli-alias-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const getEnv = () => ({ PORTLESS_STATE_DIR: tmpDir });

    it("prints help with --help", () => {
      const { status, stdout } = run(["alias", "--help"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless alias");
      expect(stdout).toContain("--remove");
      expect(stdout).toContain("--tcp");
    });

    it("prints help with -h", () => {
      const { status, stdout } = run(["alias", "-h"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless alias");
    });

    it("exits 1 with usage when no args given", () => {
      const { status, stderr } = run(["alias"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Missing arguments");
    });

    it("exits 1 with usage when only name is given", () => {
      const { status, stderr } = run(["alias", "mydb"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Missing arguments");
    });

    it("exits 1 for invalid port", () => {
      const { status, stderr } = run(["alias", "mydb", "notaport"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Invalid port");
    });

    it("exits 1 when --remove has no name", () => {
      const { status, stderr } = run(["alias", "--remove"]);
      expect(status).toBe(1);
      expect(stderr).toContain("No alias name");
    });

    it("registers a TCP alias with a listen port", () => {
      const { status, stdout } = run(["alias", "--tcp", "mydb", "5432"], { env: getEnv() });
      expect(status).toBe(0);
      expect(stdout).toContain("TCP alias registered");
      expect(stdout).toContain("TCP listener will be available after starting the proxy daemon.");
      expect(stdout).toContain("Start it with: portless proxy start");
      expect(stdout).not.toContain("Connect to:");

      const routesPath = path.join(tmpDir, "routes.json");
      const routes = JSON.parse(fs.readFileSync(routesPath, "utf-8"));
      expect(routes).toHaveLength(1);
      expect(routes[0].hostname).toBe("mydb.localhost");
      expect(routes[0].port).toBe(5432);
      expect(routes[0].pid).toBe(0);
      expect(routes[0].type).toBe("tcp");
      expect(routes[0].listenPort).toBeGreaterThanOrEqual(5500);
      expect(routes[0].listenPort).toBeLessThanOrEqual(5999);
    });

    it("does not reuse a stored TCP listen port when the proxy is stopped", () => {
      const first = run(["alias", "--tcp", "db1", "5432"], { env: getEnv() });
      const second = run(["alias", "--tcp", "db2", "5433"], { env: getEnv() });

      expect(first.status).toBe(0);
      expect(second.status).toBe(0);

      const routesPath = path.join(tmpDir, "routes.json");
      const routes = JSON.parse(fs.readFileSync(routesPath, "utf-8"));
      expect(routes).toHaveLength(2);
      expect(routes[0].listenPort).not.toBe(routes[1].listenPort);
    });

    it("reuses the existing listen port when replacing a TCP alias", () => {
      const first = run(["alias", "--tcp", "db", "5432"], { env: getEnv() });
      expect(first.status).toBe(0);

      const routesPath = path.join(tmpDir, "routes.json");
      const before = JSON.parse(fs.readFileSync(routesPath, "utf-8"));
      const originalListenPort = before[0].listenPort;

      const second = run(["alias", "--tcp", "db", "5433"], { env: getEnv() });
      expect(second.status).toBe(0);

      const after = JSON.parse(fs.readFileSync(routesPath, "utf-8"));
      expect(after).toHaveLength(1);
      expect(after[0].port).toBe(5433);
      expect(after[0].listenPort).toBe(originalListenPort);
    });
  });

  describe("hosts subcommand", () => {
    it("prints help with --help", () => {
      const { status, stdout } = run(["hosts", "--help"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless hosts");
      expect(stdout).toContain("sync");
      expect(stdout).toContain("clean");
    });

    it("prints help with -h", () => {
      const { status, stdout } = run(["hosts", "-h"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless hosts");
    });

    it("shows usage for bare 'hosts' without subcommand", () => {
      const { status, stdout } = run(["hosts"]);
      expect(status).toBe(0);
      expect(stdout).toContain("sync");
      expect(stdout).toContain("clean");
    });

    it("rejects unknown hosts subcommand", () => {
      const { status, stderr } = run(["hosts", "typo"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Unknown hosts subcommand");
    });
  });

  describe("proxy subcommand", () => {
    it("prints help with --help", () => {
      const { status, stdout } = run(["proxy", "--help"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless proxy");
      expect(stdout).toContain("start");
      expect(stdout).toContain("stop");
    });

    it("prints help with -h", () => {
      const { status, stdout } = run(["proxy", "-h"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless proxy");
    });

    it("shows usage for bare 'proxy' without subcommand", () => {
      const { status, stdout } = run(["proxy"]);
      expect(status).toBe(0);
      expect(stdout).toContain("start");
      expect(stdout).toContain("stop");
    });

    it("exits 1 for unknown proxy subcommand", () => {
      const { status } = run(["proxy", "typo"]);
      expect(status).toBe(1);
    });
  });

  describe("get subcommand", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-cli-get-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const getEnv = () => ({ PORTLESS_STATE_DIR: tmpDir });

    it("prints help with --help", () => {
      const { status, stdout } = run(["get", "--help"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless get");
      expect(stdout).toContain("--no-worktree");
    });

    it("prints help with -h", () => {
      const { status, stdout } = run(["get", "-h"]);
      expect(status).toBe(0);
      expect(stdout).toContain("portless get");
    });

    it("exits 1 with usage when no name given", () => {
      const { status, stderr } = run(["get"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Missing service name");
    });

    it("prints URL for a given service name", () => {
      const { status, stdout } = run(["get", "backend"], { env: getEnv() });
      expect(status).toBe(0);
      expect(stdout.trim()).toMatch(/^https?:\/\/backend\.localhost(:\d+)?$/);
    });

    it("prints URL for a dotted service name", () => {
      const { status, stdout } = run(["get", "api.backend"], { env: getEnv() });
      expect(status).toBe(0);
      expect(stdout.trim()).toMatch(/^https?:\/\/api\.backend\.localhost(:\d+)?$/);
    });

    it("prints the localhost endpoint for a TCP alias", async () => {
      const store = new RouteStore(tmpDir);
      await store.addTcpRoute("db.localhost", 5432, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5505,
      });

      const { status, stdout } = run(["get", "db"], { env: getEnv() });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("127.0.0.1:5500");
    });

    it("falls back to the unprefixed TCP alias inside a git worktree", async () => {
      const store = new RouteStore(tmpDir);
      await store.addTcpRoute("db.localhost", 5432, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5505,
      });

      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-get-worktree-repo-"));
      const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-get-worktree-linked-"));

      try {
        const git = (gitArgs: string[], cwd: string) =>
          spawnSync("git", gitArgs, {
            cwd,
            encoding: "utf-8",
            env: { ...process.env, NO_COLOR: "1" },
          });

        fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "repo" }));
        expect(git(["init", "-b", "main"], repoDir).status).toBe(0);
        expect(git(["config", "user.name", "Test User"], repoDir).status).toBe(0);
        expect(git(["config", "user.email", "test@example.com"], repoDir).status).toBe(0);
        expect(git(["add", "package.json"], repoDir).status).toBe(0);
        expect(git(["commit", "-m", "init"], repoDir).status).toBe(0);
        expect(git(["branch", "feature/db"], repoDir).status).toBe(0);
        expect(git(["worktree", "add", worktreeDir, "feature/db"], repoDir).status).toBe(0);

        const { status, stdout } = run(["get", "db"], {
          cwd: worktreeDir,
          env: getEnv(),
        });
        expect(status).toBe(0);
        expect(stdout.trim()).toBe("127.0.0.1:5500");
      } finally {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it("rejects unknown flags", () => {
      const { status, stderr } = run(["get", "--typo", "backend"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Unknown flag");
    });

    it("accepts --no-worktree flag", () => {
      const { status, stdout } = run(["get", "--no-worktree", "backend"], { env: getEnv() });
      expect(status).toBe(0);
      expect(stdout.trim()).toMatch(/^https?:\/\/backend\.localhost(:\d+)?$/);
    });

    it("exits 1 for invalid hostname", () => {
      const { status, stderr } = run(["get", "my@app"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Invalid hostname");
    });
  });

  describe("--name flag", () => {
    it("treats reserved word as app name with PORTLESS=0", () => {
      const { status, stdout } = run(["--name", "run", "echo", "ok"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("ok");
    });

    it("passes --force through with --name (PORTLESS=0)", () => {
      const { status, stdout } = run(["--name", "alias", "--force", "echo", "ok"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("ok");
    });

    it("exits 1 when --name has no value", () => {
      const { status, stderr } = run(["--name"]);
      expect(status).toBe(1);
      expect(stderr).toContain("--name requires");
    });

    it("exits 1 when --name has name but no command", () => {
      const { status, stderr } = run(["--name", "myapp"]);
      expect(status).toBe(1);
      expect(stderr).toContain("No command provided");
    });
  });

  describe("run --name flag", () => {
    it("shows --name in run help", () => {
      const { status, stdout } = run(["run", "--help"]);
      expect(status).toBe(0);
      expect(stdout).toContain("--name");
    });

    it("strips --name and passes command through (PORTLESS=0)", () => {
      const { status, stdout } = run(["run", "--name", "custom", "echo", "ok"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("ok");
    });

    it("exits 1 when --name has no value", () => {
      const { status, stderr } = run(["run", "--name"]);
      expect(status).toBe(1);
      expect(stderr).toContain("--name requires");
    });

    it("exits 1 when --name value looks like a flag", () => {
      const { status, stderr } = run(["run", "--name", "--force", "echo", "ok"]);
      expect(status).toBe(1);
      expect(stderr).toContain("--name requires");
    });

    it("combines --name with --force (PORTLESS=0)", () => {
      const { status, stdout } = run(["run", "--name", "foo", "--force", "echo", "ok"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("ok");
    });

    it("does not consume --name after -- separator (PORTLESS=0)", () => {
      const { status, stdout } = run(["run", "--", "echo", "--name", "foo"], {
        env: { PORTLESS: "0" },
      });
      expect(status).toBe(0);
      expect(stdout.trim()).toBe("--name foo");
    });
  });
});

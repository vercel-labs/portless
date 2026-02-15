import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

/** Run the CLI with the given args and optional env overrides. */
function run(args: string[], options?: { env?: Record<string, string | undefined> }) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
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
      expect(stdout).toContain("--port");
      expect(stdout).toContain("-p");
      expect(stdout).toContain("--foreground");
      expect(stdout).toContain("PORTLESS_STATE_DIR");
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

  describe("invalid hostname", () => {
    it("exits 1 for hostname with invalid characters", () => {
      // The proxy won't be running, but parseHostname should fail first
      // Note: this will try to runApp which checks proxy first in non-TTY mode
      const { status, stderr } = run(["my@app", "echo", "test"]);
      expect(status).toBe(1);
      expect(stderr).toContain("Invalid hostname");
    });
  });
});

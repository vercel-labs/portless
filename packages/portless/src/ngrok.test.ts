import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildNgrokArgs,
  ensureNgrokAvailable,
  extractNgrokUrl,
  startNgrok,
  stopNgrokProcess,
  type NgrokCommandRunner,
  type NgrokChildProcess,
  type NgrokSpawner,
} from "./ngrok.js";

class MockNgrokChild extends EventEmitter {
  pid = 12345;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    return true;
  }
}

function createSpawner(child: MockNgrokChild, calls: string[][] = []): NgrokSpawner {
  return (args: string[]) => {
    calls.push(args);
    return child as unknown as NgrokChildProcess;
  };
}

describe("ngrok", () => {
  describe("ensureNgrokAvailable", () => {
    it("checks the ngrok CLI version", () => {
      const calls: string[][] = [];
      const runner: NgrokCommandRunner = (args) => {
        calls.push(args);
        return { status: 0, stdout: "ngrok version 3.0.0", stderr: "" };
      };

      expect(() => ensureNgrokAvailable(runner)).not.toThrow();
      expect(calls).toEqual([["version"]]);
    });

    it("throws an install hint when the ngrok CLI is missing", () => {
      const error = Object.assign(new Error("spawn ngrok ENOENT"), { code: "ENOENT" });
      const runner: NgrokCommandRunner = () => ({
        status: null,
        stdout: "",
        stderr: "",
        error,
      });

      expect(() => ensureNgrokAvailable(runner)).toThrow("ngrok CLI not found");
    });

    it("throws command output when the version check fails", () => {
      const runner: NgrokCommandRunner = () => ({
        status: 1,
        stdout: "",
        stderr: "permission denied",
      });

      expect(() => ensureNgrokAvailable(runner)).toThrow("permission denied");
    });
  });

  describe("buildNgrokArgs", () => {
    it("forwards HTTP traffic to the local app port with host rewriting", () => {
      expect(buildNgrokArgs(4123)).toEqual([
        "http",
        "--log=stdout",
        "--log-format=logfmt",
        "--host-header=rewrite",
        "http://127.0.0.1:4123",
      ]);
    });

    it("uses the requested upstream host header", () => {
      expect(buildNgrokArgs(4123, "myapp.localhost")).toEqual([
        "http",
        "--log=stdout",
        "--log-format=logfmt",
        "--host-header=myapp.localhost",
        "http://127.0.0.1:4123",
      ]);
    });
  });

  describe("extractNgrokUrl", () => {
    it("extracts the public URL from text output", () => {
      const output = "Forwarding https://abc123.ngrok.app -> http://127.0.0.1:4123";
      expect(extractNgrokUrl(output)).toBe("https://abc123.ngrok.app");
    });

    it("extracts the public URL from structured log output", () => {
      const output =
        't=2026-06-04 lvl=info msg="started tunnel" obj=tunnels url=https://abc123.ngrok-free.app';
      expect(extractNgrokUrl(output)).toBe("https://abc123.ngrok-free.app");
    });

    it("ignores ngrok docs URLs from errors", () => {
      const output = "ERROR see https://ngrok.com/docs/errors/err_ngrok_4018";
      expect(extractNgrokUrl(output)).toBeNull();
    });
  });

  describe("startNgrok", () => {
    it("spawns ngrok and resolves with the public URL", async () => {
      const child = new MockNgrokChild();
      const calls: string[][] = [];
      const promise = startNgrok(4123, {
        spawner: createSpawner(child, calls),
        timeoutMs: 1000,
      });

      child.stdout.write("Forwarding https://abc123.ngrok.app -> http://127.0.0.1:4123\n");

      await expect(promise).resolves.toMatchObject({
        url: "https://abc123.ngrok.app",
        pid: 12345,
      });
      expect(calls).toEqual([
        [
          "http",
          "--log=stdout",
          "--log-format=logfmt",
          "--host-header=rewrite",
          "http://127.0.0.1:4123",
        ],
      ]);
    });

    it("notifies when ngrok exits after startup", async () => {
      const child = new MockNgrokChild();
      const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
      const promise = startNgrok(4123, {
        onExit: (code, signal) => exits.push({ code, signal }),
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stdout.write("Forwarding https://abc123.ngrok.app -> http://127.0.0.1:4123\n");

      await expect(promise).resolves.toMatchObject({
        url: "https://abc123.ngrok.app",
      });
      child.emit("exit", 0, null);
      expect(exits).toEqual([{ code: 0, signal: null }]);
    });

    it("throws an install hint when the ngrok CLI is missing", async () => {
      const error = Object.assign(new Error("spawn ngrok ENOENT"), { code: "ENOENT" });
      const spawner: NgrokSpawner = () => {
        throw error;
      };

      await expect(startNgrok(4123, { spawner })).rejects.toThrow("ngrok CLI not found");
    });

    it("throws an auth hint when ngrok exits with auth output", async () => {
      const child = new MockNgrokChild();
      const promise = startNgrok(4123, {
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stderr.write("ERROR authtoken is required\n");
      child.emit("exit", 1, null);

      await expect(promise).rejects.toThrow("authentication is not configured");
    });

    it("kills ngrok when no public URL appears before the timeout", async () => {
      const child = new MockNgrokChild();
      const promise = startNgrok(4123, {
        spawner: createSpawner(child),
        timeoutMs: 1,
      });

      await expect(promise).rejects.toThrow("Timed out waiting for ngrok");
      expect(child.killedWith).toBe("SIGTERM");
    });
  });

  describe("stopNgrokProcess", () => {
    it("terminates the child process", () => {
      const child = new MockNgrokChild();
      stopNgrokProcess(child as unknown as NgrokChildProcess);
      expect(child.killedWith).toBe("SIGTERM");
    });
  });
});

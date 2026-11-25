import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildCloudflareArgs, extractCloudflareUrl, startCloudflare } from "./tunnel.js";
import {
  PROCESS_TUNNELS,
  buildNgrokArgs,
  buildNetbirdArgs,
  ensureNgrokAvailable,
  ensureNetbirdAvailable,
  extractNgrokUrl,
  extractNetbirdUrl,
  normalizeNgrokUrl,
  startNgrok,
  startNetbird,
  stopTunnelProcess,
  type TunnelCommandRunner as NgrokCommandRunner,
  type TunnelChildProcess as NgrokChildProcess,
  type TunnelSpawner as NgrokSpawner,
} from "./tunnel.js";

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

  describe("normalizeNgrokUrl", () => {
    it("adds https and trims a trailing slash", () => {
      expect(normalizeNgrokUrl("abc123.ngrok.dev/")).toBe("https://abc123.ngrok.dev");
      expect(normalizeNgrokUrl("http://abc123.ngrok.dev/Path/Case")).toBe(
        "http://abc123.ngrok.dev/Path/Case"
      );
    });

    it("rejects invalid URLs", () => {
      expect(() => normalizeNgrokUrl("ftp://abc123.ngrok.dev")).toThrow("Invalid ngrok URL");
      expect(() => normalizeNgrokUrl("http://[")).toThrow("Invalid ngrok URL");
      expect(() => normalizeNgrokUrl("   ")).toThrow("ngrok URL cannot be empty.");
    });
  });

  describe("PROCESS_TUNNELS", () => {
    it("marks NetBird as binding all interfaces", () => {
      expect(PROCESS_TUNNELS).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "netbird", bindAllInterfaces: true }),
        ])
      );
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

    it("normalizes a configured public URL before passing it to ngrok", () => {
      expect(buildNgrokArgs(4123, "myapp.localhost", "abc123.ngrok.dev/")).toEqual([
        "http",
        "--log=stdout",
        "--log-format=logfmt",
        "--host-header=myapp.localhost",
        "--url=https://abc123.ngrok.dev",
        "http://127.0.0.1:4123",
      ]);
    });
  });

  describe("extractNgrokUrl", () => {
    it("extracts the public URL from forwarding output", () => {
      expect(extractNgrokUrl("Forwarding https://abc123.ngrok.app -> http://127.0.0.1:4123")).toBe(
        "https://abc123.ngrok.app"
      );
    });

    it("extracts the public URL from logged url output", () => {
      expect(
        extractNgrokUrl(
          't=2026-06-04 lvl=info msg="started tunnel" obj=tunnels url=http://abc123.ngrok-free.app'
        )
      ).toBe("http://abc123.ngrok-free.app");
    });

    it.each(["https", "http"])(
      "extracts the public %s URL instead of the local address",
      (scheme) => {
        expect(
          extractNgrokUrl(
            `msg="started tunnel" addr=http://127.0.0.1:4000 url=${scheme}://my-app.ngrok.dev`
          )
        ).toBe(`${scheme}://my-app.ngrok.dev`);
      }
    );

    it("ignores ngrok docs URLs from errors", () => {
      expect(extractNgrokUrl("ERROR see https://ngrok.com/docs/errors/err_ngrok_4018")).toBeNull();
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

    it("throws an auth hint when ngrok has no authtoken", async () => {
      const child = new MockNgrokChild();
      const promise = startNgrok(4123, {
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stderr.write(
        "ERROR:  authentication failed: This ngrok session is not authenticated.\nERROR:  ERR_NGROK_4018\n"
      );
      child.emit("exit", 1, null);

      await expect(promise).rejects.toThrow("authentication is not configured");
    });

    it("throws ngrok's own error when the authtoken is rejected", async () => {
      const child = new MockNgrokChild();
      const promise = startNgrok(4123, {
        spawner: createSpawner(child),
        timeoutMs: 1000,
      });

      child.stdout.write('t=now lvl=crit msg="command failed" err="authentication failed"\n');
      child.stderr.write(
        "ERROR:  authentication failed: The authtoken you specified does not look like a proper ngrok authtoken.\nERROR:  \nERROR:  ERR_NGROK_105\n"
      );
      child.emit("exit", 1, null);

      await expect(promise).rejects.toThrow(
        "Failed to start ngrok tunnel: authentication failed: The authtoken you specified does not look like a proper ngrok authtoken. ERR_NGROK_105 (exit 1)"
      );
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

  describe("stopTunnelProcess", () => {
    it("terminates the child process", () => {
      const child = new MockNgrokChild();
      stopTunnelProcess(child as unknown as NgrokChildProcess);
      expect(child.killedWith).toBe("SIGTERM");
    });
  });
});

class MockNetbirdChild extends EventEmitter {
  pid = 67890;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killedWith: NodeJS.Signals | undefined;

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal;
    return true;
  }
}

function createNetbirdSpawner(
  child: MockNetbirdChild,
  calls: string[][] = []
): (args: string[]) => MockNetbirdChild {
  return (args: string[]) => {
    calls.push(args);
    return child;
  };
}

const BANNER =
  "INF Thank you for trying Cloudflare Tunnel.\nINF |  https://red-fox-ab.trycloudflare.com  |\n";
const REGISTERED = "INF Registered tunnel connection connIndex=0 protocol=quic\n";
const QUICK_URL = "https://red-fox-ab.trycloudflare.com";
const configPath = `${fs.mkdtempSync(`${os.tmpdir()}/portless-cf-`)}/c.yml`;

describe("cloudflare", () => {
  it("builds a quick tunnel command that ignores the user config", () => {
    expect(buildCloudflareArgs(4123, "myapp.localhost", "/c.yml").join(" ")).toBe(
      "tunnel --no-autoupdate --grace-period 1s --config /c.yml --url http://127.0.0.1:4123 --http-host-header myapp.localhost"
    );
  });

  it("reports the URL only once a connection is registered", () => {
    expect(extractCloudflareUrl(BANNER)).toBeNull();
    expect(extractCloudflareUrl(BANNER + REGISTERED)).toBe(QUICK_URL);
    expect(extractCloudflareUrl("https://api.trycloudflare.com\n" + REGISTERED)).toBeNull();
    expect(extractCloudflareUrl(BANNER + "INF Connection 4b2f-9a7b registered\n")).toBe(QUICK_URL);
  });

  it("writes an empty config and resolves once connected", async () => {
    const child = new MockNgrokChild();
    const promise = startCloudflare(4123, { configPath, spawner: createSpawner(child) });
    expect(fs.readFileSync(configPath, "utf-8")).toBe("{}");
    child.stderr.write(BANNER + REGISTERED);
    await expect(promise).resolves.toMatchObject({ url: QUICK_URL, pid: 12345 });
  });

  it("reports ERR lines, or a generic message, when cloudflared exits early", async () => {
    const fail = (output: string) => {
      const child = new MockNgrokChild();
      const promise = startCloudflare(4123, { configPath, spawner: createSpawner(child) });
      child.stderr.write(output);
      child.emit("exit", 1, null);
      return promise.catch((err: Error) => err.message);
    };
    expect(await fail(BANNER + "2026-10-16T12:00:01Z ERR failed to request quick Tunnel\n")).toBe(
      "Failed to start Cloudflare tunnel: 2026-10-16T12:00:01Z ERR failed to request quick Tunnel (exit 1)"
    );
    expect(await fail(BANNER)).toBe(
      "Failed to start Cloudflare tunnel: cloudflared exited before connecting (exit 1)"
    );
  });
});

describe("netbird", () => {
  describe("ensureNetbirdAvailable", () => {
    it("checks the netbird CLI status", () => {
      const calls: string[][] = [];
      const runner = (args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: '{"daemonStatus":"Connected"}', stderr: "" };
      };

      expect(() => ensureNetbirdAvailable(runner)).not.toThrow();
      expect(calls).toEqual([["status", "--json"]]);
    });

    it("throws an install hint when the netbird CLI is missing", () => {
      const error = Object.assign(new Error("spawn netbird ENOENT"), { code: "ENOENT" });
      const runner = () => ({ status: null, stdout: "", stderr: "", error });

      expect(() => ensureNetbirdAvailable(runner)).toThrow("NetBird CLI not found");
    });

    it("throws when netbird is not connected", () => {
      const runner = () => ({ status: 0, stdout: '{"daemonStatus":"Disconnected"}', stderr: "" });

      expect(() => ensureNetbirdAvailable(runner)).toThrow(
        "NetBird is not connected (status: Disconnected)"
      );
    });
  });

  describe("buildNetbirdArgs", () => {
    it("builds the expose command with sanitized prefix and groups", () => {
      expect(
        buildNetbirdArgs(4123, {
          appName: "My App! 2026 With A Very Long Name That Keeps Going",
          password: "secret",
          pin: "123456",
          groups: [" dev ", "", "ops"],
        })
      ).toEqual([
        "expose",
        "--protocol",
        "http",
        "--with-password",
        "secret",
        "--with-pin",
        "123456",
        "--with-name-prefix",
        "my-app--2026-with-a-very-long-na",
        "--with-user-groups",
        "dev,ops",
        "4123",
      ]);
    });
  });

  describe("extractNetbirdUrl", () => {
    it("extracts the public URL from status output", () => {
      expect(extractNetbirdUrl("URL: https://abc123.netbird.cloud/\n")).toBe(
        "https://abc123.netbird.cloud"
      );
    });

    it("ignores invalid URLs", () => {
      expect(extractNetbirdUrl("URL: not-a-url\n")).toBeNull();
    });
  });

  describe("startNetbird", () => {
    it("spawns netbird and resolves with the public URL", async () => {
      const child = new MockNetbirdChild();
      const calls: string[][] = [];
      const promise = startNetbird(4123, {
        spawner: createNetbirdSpawner(child, calls),
        timeoutMs: 1000,
      });

      child.stdout.write("URL: https://abc123.netbird.cloud/\n");

      await expect(promise).resolves.toMatchObject({
        url: "https://abc123.netbird.cloud",
        pid: 67890,
      });
      expect(calls).toEqual([["expose", "--protocol", "http", "4123"]]);
    });

    it("throws when netbird exits before printing a URL", async () => {
      const child = new MockNetbirdChild();
      const promise = startNetbird(4123, {
        spawner: createNetbirdSpawner(child),
        timeoutMs: 1000,
      });

      child.stderr.write("netbird error\n");
      child.emit("exit", 1, null);

      await expect(promise).rejects.toThrow(
        "Failed to start NetBird tunnel: netbird error (exit 1)"
      );
    });
  });
});

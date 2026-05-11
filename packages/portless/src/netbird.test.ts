import { EventEmitter } from "node:events";
import { describe, it, expect } from "vitest";
import {
  buildExposeArgs,
  ensureNetbirdReady,
  parseExposeInfo,
  startExpose,
  type ExposeProcessLike,
  type ExposeSpawner,
  type NetbirdCommandRunner,
} from "./netbird.js";

interface MockResult {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

function createRunner(
  results: Record<string, MockResult>,
  calls: string[][] = []
): NetbirdCommandRunner {
  return (args: string[]) => {
    calls.push(args);
    const key = args.join(" ");
    const result = results[key];
    if (!result) throw new Error(`Unexpected netbird call: ${key}`);
    return {
      status: result.status ?? 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
  };
}

class FakeProcess extends EventEmitter implements ExposeProcessLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  killSignal: NodeJS.Signals | number | undefined;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  emitStdout(data: string): void {
    this.stdout.emit("data", Buffer.from(data));
  }

  emitStderr(data: string): void {
    this.stderr.emit("data", Buffer.from(data));
  }
}

const SUCCESS_OUTPUT = `Service exposed successfully!
  Name:     myapp-a1b2c3
  URL:      https://myapp-a1b2c3.proxy.example.com
  Domain:   myapp-a1b2c3.proxy.example.com
  Protocol: http
  Internal: 8080

Press Ctrl+C to stop exposing.
`;

describe("netbird", () => {
  // -----------------------------------------------------------------------
  // ensureNetbirdReady
  // -----------------------------------------------------------------------

  describe("ensureNetbirdReady", () => {
    it("returns daemon status and fqdn when connected", () => {
      const runner = createRunner({
        "status --json": {
          status: 0,
          stdout: JSON.stringify({ daemonStatus: "Connected", fqdn: "devbox.netbird.cloud" }),
        },
      });
      const ready = ensureNetbirdReady(runner);
      expect(ready.daemonStatus).toBe("Connected");
      expect(ready.fqdn).toBe("devbox.netbird.cloud");
    });

    it("throws when daemon is not connected", () => {
      const runner = createRunner({
        "status --json": {
          status: 0,
          stdout: JSON.stringify({ daemonStatus: "NeedsLogin" }),
        },
      });
      expect(() => ensureNetbirdReady(runner)).toThrow(
        "NetBird is not connected (status: NeedsLogin)"
      );
    });

    it("throws when netbird CLI is missing", () => {
      const enoent = Object.assign(new Error("spawn netbird ENOENT"), { code: "ENOENT" });
      const runner = createRunner({ "status --json": { status: null, error: enoent } });
      expect(() => ensureNetbirdReady(runner)).toThrow("NetBird CLI not found");
    });

    it("throws on invalid status JSON", () => {
      const runner = createRunner({
        "status --json": { status: 0, stdout: "not json" },
      });
      expect(() => ensureNetbirdReady(runner)).toThrow("Failed to parse");
    });

    it("surfaces stderr details when status command fails", () => {
      const runner = createRunner({
        "status --json": { status: 1, stderr: "daemon not running" },
      });
      expect(() => ensureNetbirdReady(runner)).toThrow("daemon not running");
    });
  });

  // -----------------------------------------------------------------------
  // buildExposeArgs
  // -----------------------------------------------------------------------

  describe("buildExposeArgs", () => {
    it("builds bare expose with just the port", () => {
      expect(buildExposeArgs(8080)).toEqual(["expose", "8080"]);
    });

    it("appends every supported flag in order, with port last", () => {
      const args = buildExposeArgs(5432, {
        protocol: "tcp",
        password: "s3cret",
        pin: "123456",
        namePrefix: "myapp",
        externalPort: 5433,
        customDomain: "tls.example.com",
        userGroups: ["devops", "Backend"],
      });
      expect(args).toEqual([
        "expose",
        "--protocol",
        "tcp",
        "--with-password",
        "s3cret",
        "--with-pin",
        "123456",
        "--with-name-prefix",
        "myapp",
        "--with-external-port",
        "5433",
        "--with-custom-domain",
        "tls.example.com",
        "--with-user-groups",
        "devops,Backend",
        "5432",
      ]);
    });

    it("omits --with-user-groups when the array is empty", () => {
      expect(buildExposeArgs(80, { userGroups: [] })).toEqual(["expose", "80"]);
    });
  });

  // -----------------------------------------------------------------------
  // parseExposeInfo
  // -----------------------------------------------------------------------

  describe("parseExposeInfo", () => {
    it("extracts the four fields from the success block", () => {
      const info = parseExposeInfo(SUCCESS_OUTPUT);
      expect(info).toEqual({
        name: "myapp-a1b2c3",
        url: "https://myapp-a1b2c3.proxy.example.com",
        domain: "myapp-a1b2c3.proxy.example.com",
        protocol: "http",
      });
    });

    it("returns null when any required field is missing", () => {
      const partial = "Name: myapp-a1b2c3\nURL: https://example.com\n";
      expect(parseExposeInfo(partial)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // startExpose
  // -----------------------------------------------------------------------

  describe("startExpose", () => {
    it("resolves with parsed info when the URL block is printed", async () => {
      const fake = new FakeProcess();
      const calls: string[][] = [];
      const spawner: ExposeSpawner = (args) => {
        calls.push(args);
        return fake;
      };
      const promise = startExpose(8080, { spawner, namePrefix: "myapp" });
      fake.emitStdout(SUCCESS_OUTPUT);
      const handle = await promise;
      expect(handle.info.url).toBe("https://myapp-a1b2c3.proxy.example.com");
      expect(calls[0]).toEqual(["expose", "--with-name-prefix", "myapp", "8080"]);
    });

    it("resolves when the URL block is printed on stderr (netbird's real behavior)", async () => {
      const fake = new FakeProcess();
      const promise = startExpose(8080, { spawner: () => fake });
      fake.emitStderr(SUCCESS_OUTPUT);
      const handle = await promise;
      expect(handle.info.url).toBe("https://myapp-a1b2c3.proxy.example.com");
    });

    it("stop() sends SIGTERM to the child", async () => {
      const fake = new FakeProcess();
      const promise = startExpose(8080, { spawner: () => fake });
      fake.emitStdout(SUCCESS_OUTPUT);
      const handle = await promise;
      handle.stop();
      expect(fake.killed).toBe(true);
      expect(fake.killSignal).toBe("SIGTERM");
    });

    it("rejects and kills the child if the URL never arrives before the timeout", async () => {
      const fake = new FakeProcess();
      const promise = startExpose(8080, { spawner: () => fake, timeoutMs: 10 });
      await expect(promise).rejects.toThrow("Timed out waiting for netbird expose");
      expect(fake.killed).toBe(true);
    });

    it("rejects with stderr details when the child exits early", async () => {
      const fake = new FakeProcess();
      const promise = startExpose(8080, { spawner: () => fake });
      fake.emitStderr("client is not running, run 'netbird up' first\n");
      fake.emit("exit", 1);
      await expect(promise).rejects.toThrow("client is not running");
    });

    it("rejects with a CLI-not-found error on ENOENT", async () => {
      const fake = new FakeProcess();
      const enoent = Object.assign(new Error("spawn netbird ENOENT"), { code: "ENOENT" });
      const promise = startExpose(8080, { spawner: () => fake });
      fake.emit("error", enoent);
      await expect(promise).rejects.toThrow("NetBird CLI not found");
    });
  });
});

import net from "node:net";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createLoopbackConnection,
  escapeHtml,
  formatUptime,
  formatUrl,
  isErrnoException,
  isProcessAlive,
  parseHostname,
  parseHostnames,
  parsePort,
  resolveUserHome,
} from "./utils.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveUserHome", () => {
  it("uses the invoking user's home under sudo", () => {
    expect(
      resolveUserHome({
        platform: "linux",
        env: { SUDO_USER: "alice", HOME: "/root" },
        homedir: "/root",
        passwdHome: () => "/home/alice",
      })
    ).toBe("/home/alice");
  });

  it("keeps a preserved non-root home under sudo", () => {
    expect(
      resolveUserHome({
        platform: "darwin",
        env: { SUDO_USER: "alice", HOME: "/Users/alice" },
        homedir: "/var/root",
      })
    ).toBe("/Users/alice");
  });

  it("uses the effective user's home without sudo", () => {
    expect(
      resolveUserHome({
        platform: "linux",
        env: { HOME: "/root" },
        homedir: "/root",
      })
    ).toBe("/root");
  });

  it("falls back to the platform convention when passwd lookup fails", () => {
    expect(
      resolveUserHome({
        platform: "linux",
        env: { SUDO_USER: "alice", HOME: "/root" },
        homedir: "/root",
        passwdHome: () => null,
      })
    ).toBe("/home/alice");
  });
});

describe("escapeHtml", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("escapes quotes", () => {
    expect(escapeHtml("\"hello\" & 'world'")).toBe("&quot;hello&quot; &amp; &#39;world&#39;");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("leaves safe text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("isErrnoException", () => {
  it("returns true for a Node.js system error", () => {
    const err = new Error("fail") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    expect(isErrnoException(err)).toBe(true);
  });

  it("returns false for a plain Error without code", () => {
    expect(isErrnoException(new Error("plain"))).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isErrnoException("something")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isErrnoException(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isErrnoException(undefined)).toBe(false);
  });

  it("returns false for a plain object with code", () => {
    expect(isErrnoException({ code: "ENOENT", message: "fail" })).toBe(false);
  });

  it("returns false for an Error with a non-string code", () => {
    const err = new Error("fail");
    (err as unknown as Record<string, unknown>).code = 42;
    expect(isErrnoException(err)).toBe(false);
  });
});

describe("isProcessAlive", () => {
  it("returns true when signal 0 succeeds", () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    expect(isProcessAlive(123)).toBe(true);
  });

  it("treats EPERM as an alive process", () => {
    const err = new Error("permission denied") as NodeJS.ErrnoException;
    err.code = "EPERM";
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });

    expect(isProcessAlive(123)).toBe(true);
  });

  it("returns false when the process does not exist", () => {
    const err = new Error("missing") as NodeJS.ErrnoException;
    err.code = "ESRCH";
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw err;
    });

    expect(isProcessAlive(123)).toBe(false);
  });

  it("returns false for non-positive PIDs", () => {
    const spy = vi.spyOn(process, "kill");

    expect(isProcessAlive(0)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("formatUrl", () => {
  it("omits port for standard HTTP port (80)", () => {
    expect(formatUrl("myapp.localhost", 80)).toBe("http://myapp.localhost");
  });

  it("includes port for non-standard ports", () => {
    expect(formatUrl("myapp.localhost", 1355)).toBe("http://myapp.localhost:1355");
    expect(formatUrl("myapp.localhost", 8080)).toBe("http://myapp.localhost:8080");
    expect(formatUrl("myapp.localhost", 3000)).toBe("http://myapp.localhost:3000");
  });
});

describe("formatUptime", () => {
  const NOW = 1_700_000_000_000;

  it.each([
    [59_000, "59s"],
    [60_000, "1m"],
    [59 * 60_000, "59m"],
    [60 * 60_000, "1h"],
    [119 * 60_000, "1h"],
    [23 * 60 * 60_000, "23h"],
    [24 * 60 * 60_000, "1d"],
    [400 * 24 * 60 * 60_000, "400d"],
  ])("a route registered %d ms ago shows %s", (ageMs, expected) => {
    expect(formatUptime(NOW - ageMs, NOW)).toBe(expected);
  });

  it("shows 0s for a registration time 30 seconds in the future", () => {
    expect(formatUptime(NOW + 30_000, NOW)).toBe("0s");
  });

  it("shows nothing for a registration time 2 minutes in the future", () => {
    expect(formatUptime(NOW + 120_000, NOW)).toBeNull();
  });

  it.each([undefined, 0, -1000, NaN, "1700000000000"])(
    "shows nothing for an invalid registration time %s",
    (registeredAt) => {
      expect(formatUptime(registeredAt, NOW)).toBeNull();
    }
  );
});

describe("parseHostname", () => {
  it("appends .localhost to simple name", () => {
    expect(parseHostname("myapp")).toBe("myapp.localhost");
  });

  it("preserves existing .localhost suffix", () => {
    expect(parseHostname("myapp.localhost")).toBe("myapp.localhost");
  });

  it("strips http:// protocol", () => {
    expect(parseHostname("http://myapp")).toBe("myapp.localhost");
  });

  it("strips https:// protocol", () => {
    expect(parseHostname("https://myapp")).toBe("myapp.localhost");
  });

  it("strips an uppercase or mixed-case protocol", () => {
    expect(parseHostname("HTTP://myapp.localhost")).toBe("myapp.localhost");
    expect(parseHostname("HTTPS://myapp")).toBe("myapp.localhost");
    expect(parseHostname("Https://MyApp/path")).toBe("myapp.localhost");
  });

  it("strips path after hostname", () => {
    expect(parseHostname("myapp/some/path")).toBe("myapp.localhost");
  });

  it("strips protocol and path", () => {
    expect(parseHostname("http://myapp.localhost/path")).toBe("myapp.localhost");
  });

  it("converts to lowercase", () => {
    expect(parseHostname("MyApp")).toBe("myapp.localhost");
  });

  it("handles subdomain-style names", () => {
    expect(parseHostname("api.myapp")).toBe("api.myapp.localhost");
  });

  it("handles hyphens", () => {
    expect(parseHostname("my-app")).toBe("my-app.localhost");
  });

  it("throws on empty input", () => {
    expect(() => parseHostname("")).toThrow("Hostname cannot be empty");
  });

  it("throws on whitespace-only input", () => {
    expect(() => parseHostname("   ")).toThrow("Hostname cannot be empty");
  });

  it("throws on invalid characters", () => {
    expect(() => parseHostname("my app")).toThrow("Invalid hostname");
  });

  it("throws on hostname starting with hyphen", () => {
    expect(() => parseHostname("-myapp")).toThrow("Invalid hostname");
  });

  it("throws on hostname ending with hyphen", () => {
    expect(() => parseHostname("myapp-")).toThrow("Invalid hostname");
  });

  it("throws on special characters", () => {
    expect(() => parseHostname("my@app")).toThrow("Invalid hostname");
  });

  it("throws on consecutive dots", () => {
    expect(() => parseHostname("my..app")).toThrow("consecutive dots are not allowed");
  });

  it("accepts numeric hostnames", () => {
    expect(parseHostname("123")).toBe("123.localhost");
  });

  it("handles protocol with .localhost already present", () => {
    expect(parseHostname("https://test.localhost")).toBe("test.localhost");
  });

  it("throws on label exceeding 63 characters", () => {
    const longLabel = "a".repeat(64);
    expect(() => parseHostname(longLabel)).toThrow("exceeds 63-character DNS limit");
  });

  it("accepts label at exactly 63 characters", () => {
    const label63 = "a".repeat(63);
    expect(parseHostname(label63)).toBe(`${label63}.localhost`);
  });

  it("throws when any label in multi-part hostname exceeds 63 characters", () => {
    const longLabel = "a".repeat(64);
    expect(() => parseHostname(`prefix.${longLabel}`)).toThrow("exceeds 63-character DNS limit");
  });

  describe("custom TLD", () => {
    it("appends custom TLD suffix", () => {
      expect(parseHostname("myapp", "test")).toBe("myapp.test");
    });

    it("preserves existing custom TLD suffix", () => {
      expect(parseHostname("myapp.test", "test")).toBe("myapp.test");
    });

    it("strips .localhost suffix when using a different TLD", () => {
      expect(parseHostname("myapp.localhost", "test")).toBe("myapp.test");
    });

    it("strips .localhost subdomain suffix when using a different TLD", () => {
      expect(parseHostname("api.myapp.localhost", "test")).toBe("api.myapp.test");
    });

    it("handles subdomain with custom TLD", () => {
      expect(parseHostname("api.myapp", "test")).toBe("api.myapp.test");
    });

    it("handles multi-segment custom TLDs", () => {
      expect(parseHostname("myapp", "local.example.dev")).toBe("myapp.local.example.dev");
      expect(parseHostname("api.myapp", "local.example.dev")).toBe("api.myapp.local.example.dev");
      expect(parseHostname("myapp.local.example.dev", "local.example.dev")).toBe(
        "myapp.local.example.dev"
      );
    });

    it("rejects a final hostname over 253 characters", () => {
      const label = "a".repeat(63);
      const tld = [label, label, label, "b".repeat(60)].join(".");
      expect(() => parseHostname("myapp", tld)).toThrow("exceeds 253-character DNS limit");
    });

    it("throws on empty input with custom TLD", () => {
      expect(() => parseHostname("", "test")).toThrow("Hostname cannot be empty");
    });

    it("throws on bare TLD suffix", () => {
      expect(() => parseHostname(".test", "test")).toThrow("Hostname cannot be empty");
    });

    it("validates characters with custom TLD", () => {
      expect(() => parseHostname("my app", "test")).toThrow("Invalid hostname");
    });

    it("works with dev TLD", () => {
      expect(parseHostname("myapp", "dev")).toBe("myapp.dev");
    });
  });
});

describe("parseHostnames", () => {
  it("builds one hostname per TLD", () => {
    expect(parseHostnames("myapp", ["localhost", "test"])).toEqual([
      "myapp.localhost",
      "myapp.test",
    ]);
  });

  it("strips an active TLD before building all hostnames", () => {
    expect(parseHostnames("api.myapp.test", ["localhost", "test"])).toEqual([
      "api.myapp.localhost",
      "api.myapp.test",
    ]);
  });

  it("strips a configured TLD before expanding only the selected TLDs", () => {
    expect(parseHostnames("api.myapp.test", ["localhost", "test"], ["localhost"])).toEqual([
      "api.myapp.localhost",
    ]);
    expect(() => parseHostnames("api.myapp.test", ["localhost", "test"], ["dev"])).toThrow(Error);
  });

  it("strips the longest matching TLD when configured TLDs overlap", () => {
    expect(parseHostnames("app.dev.example.com", ["example.com", "dev.example.com"])).toEqual([
      "app.example.com",
      "app.dev.example.com",
    ]);
  });

  it("strips an uppercase protocol before building hostnames", () => {
    expect(parseHostnames("HTTPS://myapp.test", ["localhost", "test"])).toEqual([
      "myapp.localhost",
      "myapp.test",
    ]);
  });

  it("deduplicates TLDs", () => {
    expect(parseHostnames("myapp", ["test", "test"])).toEqual(["myapp.test"]);
  });

  it("skips a TLD that pushes the hostname past 253 chars and keeps the rest", () => {
    const label = "a".repeat(62);
    const longTld = [label, label, label, label].join("."); // 251 chars, valid TLD
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseHostnames("myapp", ["localhost", longTld])).toEqual(["myapp.localhost"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(longTld));
    } finally {
      warn.mockRestore();
    }
  });

  it("still throws when no TLD survives", () => {
    expect(() => parseHostnames("my..app", ["localhost", "test"])).toThrow(/consecutive dots/);
  });
});

describe("parsePort", () => {
  it("accepts whole numbers from 1 to 65535", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort("8123")).toBe(8123);
    expect(parsePort("65535")).toBe(65535);
    expect(parsePort(" 3000 ")).toBe(3000);
  });

  it("rejects out of range and malformed values", () => {
    for (const value of [
      "",
      "0",
      "65536",
      "192.168.1.1:8123",
      "8123abc",
      "81.23",
      "1e3",
      "30 00",
      "3000abc",
      "-1",
    ]) {
      expect(parsePort(value)).toBeNull();
    }
  });
});

describe("createLoopbackConnection", () => {
  afterEach(() => vi.useRealTimers());

  function mockAttempts() {
    const sockets = [new net.Socket(), new net.Socket()];
    const connect = vi
      .spyOn(net, "connect")
      .mockReturnValueOnce(sockets[0])
      .mockReturnValueOnce(sockets[1]);
    return { sockets, connect };
  }

  it("waits for pending IPv4 despite refused IPv6 and elapsed time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { sockets, connect } = mockAttempts();
    const callback = vi.fn();
    const cancel = createLoopbackConnection(1234, callback);
    expect(connect).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(connect.mock.calls).toEqual([
      [{ host: "127.0.0.1", port: 1234, family: 4 }],
      [{ host: "::1", port: 1234, family: 6 }],
    ]);
    sockets[1].emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    vi.advanceTimersByTime(2_147_483_647);
    expect(callback).not.toHaveBeenCalled();
    expect(sockets[0].destroyed).toBe(false);
    sockets[0].emit("connect");
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, sockets[0]);
    expect(sockets[1].destroyed).toBe(true);
    cancel();
    expect(sockets[0].destroyed).toBe(false);
    sockets[0].destroy();
  });

  it("preserves both family failures in an AggregateError", async () => {
    const { sockets } = mockAttempts();
    const callback = vi.fn();
    createLoopbackConnection(1234, callback);
    await Promise.resolve();
    const errors = ["127.0.0.1", "::1"].map((address) =>
      Object.assign(new Error("refused"), {
        code: "ECONNREFUSED",
        address,
        port: 1234,
        syscall: "connect",
      })
    );
    sockets[1].emit("error", errors[1]);
    expect(callback).not.toHaveBeenCalled();
    sockets[0].emit("error", errors[0]);
    expect(callback).toHaveBeenCalledTimes(1);
    const error = callback.mock.calls[0][0];
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual(errors);
    expect(error.code).toBe("ECONNREFUSED");
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    sockets[0].emit("error", errors[0]);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])(
    "hands off winner %s synchronously and ignores late loser events",
    async (winner) => {
      const { sockets } = mockAttempts();
      const callback = vi.fn();
      createLoopbackConnection(1234, callback);
      await Promise.resolve();
      const loser = sockets[1 - winner];
      sockets[winner].emit("connect");
      expect(callback).toHaveBeenCalledExactlyOnceWith(null, sockets[winner]);
      expect(loser.destroyed).toBe(true);
      expect(loser.listenerCount("connect")).toBe(0);
      expect(sockets[winner].listenerCount("error")).toBe(0);
      loser.emit("connect");
      loser.emit("error", new Error("late failure"));
      expect(callback).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => loser.once("close", resolve));
      expect(loser.listenerCount("error")).toBe(0);
      sockets[winner].destroy();
    }
  );

  it("counts a close before connect as a family failure", async () => {
    const { sockets } = mockAttempts();
    const callback = vi.fn();
    createLoopbackConnection(1234, callback);
    await Promise.resolve();
    sockets[0].emit("close");
    expect(callback).not.toHaveBeenCalled();
    expect(sockets[0].listenerCount("error")).toBe(0);
    const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    sockets[1].emit("error", refused);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].errors).toEqual([
      expect.objectContaining({ code: "ECONNRESET", address: "127.0.0.1", port: 1234 }),
      refused,
    ]);
  });

  it("cancels before startup without launching sockets", async () => {
    const { connect } = mockAttempts();
    const callback = vi.fn();
    const cancel = createLoopbackConnection(1234, callback);
    cancel();
    cancel();
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "ABORT_ERR" }),
      undefined
    );
  });

  it("cancels both pending attempts and ignores late events", async () => {
    const { sockets } = mockAttempts();
    const callback = vi.fn();
    const cancel = createLoopbackConnection(1234, callback);
    await Promise.resolve();
    cancel();
    cancel();
    expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    for (const socket of sockets) {
      socket.emit("error", new Error("late failure"));
      socket.emit("connect");
    }
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "ABORT_ERR" }),
      undefined
    );
  });

  it.for(["127.0.0.1", "::1"])(
    "connects to %s despite a 2.6-second event-loop stall",
    async (host, ctx) => {
      const server = net.createServer((socket) => {
        socket.on("error", () => {});
        socket.end("connected");
      });
      const listening = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (error) => (host === "::1" ? resolve(false) : reject(error)));
        server.listen(0, host, () => resolve(true));
      });
      if (!listening) {
        ctx.skip();
        return;
      }
      const port = (server.address() as net.AddressInfo).port;
      let socket: net.Socket | undefined;
      let cancel = () => {};
      try {
        const result = new Promise<string>((resolve, reject) => {
          cancel = createLoopbackConnection(port, (error, connected) => {
            if (error) return reject(error);
            socket = connected!;
            let data = "";
            socket.on("data", (chunk) => (data += chunk));
            socket.once("end", () => resolve(data));
            socket.once("error", reject);
          });
        });
        await Promise.resolve();
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2600);
        await expect(result).resolves.toBe("connected");
      } finally {
        cancel();
        socket?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});

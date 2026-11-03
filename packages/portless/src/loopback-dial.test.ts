import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { dialLoopback } from "./loopback-dial.js";

const netMocks = vi.hoisted(() => ({
  connect: vi.fn<(options: net.TcpNetConnectOpts) => net.Socket>(),
  getDefaultAutoSelectFamilyAttemptTimeout: vi.fn<() => number>(),
}));
vi.mock("node:net", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:net")>()),
  ...netMocks,
}));

let sockets: net.Socket[];
const error = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  sockets = [];
  netMocks.connect.mockReset().mockImplementation(() => {
    const socket = new net.Socket();
    sockets.push(socket);
    return socket;
  });
  netMocks.getDefaultAutoSelectFamilyAttemptTimeout.mockReset().mockReturnValue(250);
});
afterEach(() => {
  for (const socket of sockets) socket.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("dialLoopback", () => {
  it("keeps IPv4 pending when IPv6 refuses, then hands off IPv4 synchronously", async () => {
    const order: string[] = [];
    const callback = vi.fn(() => order.push("callback"));
    const handle = dialLoopback(4321, callback);
    await Promise.resolve();
    expect(netMocks.connect).toHaveBeenCalledExactlyOnceWith({
      host: "127.0.0.1",
      family: 4,
      port: 4321,
    });
    vi.advanceTimersByTime(250);
    expect(netMocks.connect).toHaveBeenLastCalledWith({ host: "::1", family: 6, port: 4321 });
    sockets[1]!.emit("error", error("ECONNREFUSED"));
    expect(sockets[0]!.destroyed).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    expect(() => sockets[1]!.emit("error", error("ECONNRESET"))).not.toThrow();
    sockets[0]!.on("connect", () => order.push("after"));
    sockets[0]!.emit("connect");
    expect(order).toEqual(["callback", "after"]);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, sockets[0]);
    expect(vi.getTimerCount()).toBe(0);
    handle.cancel();
    expect(sockets[0]!.destroyed).toBe(false);
  });

  it("starts IPv6 immediately when IPv4 refuses", async () => {
    const callback = vi.fn();
    dialLoopback(4321, callback);
    await Promise.resolve();
    sockets[0]!.emit("error", error("ECONNREFUSED"));
    expect(netMocks.connect).toHaveBeenCalledTimes(2);
    expect(netMocks.connect).toHaveBeenLastCalledWith({ host: "::1", family: 6, port: 4321 });
    expect(sockets[0]!.destroyed).toBe(true);
    sockets[1]!.emit("connect");
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, sockets[1]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([4, 6] as const)(
    "reports both failures in IPv4-first order when IPv%i fails first",
    async (first) => {
      const callback = vi.fn();
      dialLoopback(4321, callback);
      await Promise.resolve();
      vi.advanceTimersByTime(250);
      const ipv4 = error("ECONNREFUSED");
      const ipv6 = error("ENETUNREACH");
      sockets[first === 4 ? 0 : 1]!.emit("error", first === 4 ? ipv4 : ipv6);
      expect(callback).not.toHaveBeenCalled();
      sockets[first === 4 ? 1 : 0]!.emit("error", first === 4 ? ipv6 : ipv4);
      const result = callback.mock.calls[0]![0] as AggregateError & NodeJS.ErrnoException;
      expect(result).toBeInstanceOf(AggregateError);
      expect(result).toMatchObject({ errors: [ipv4, ipv6], code: "ECONNREFUSED" });
      expect(callback).toHaveBeenCalledTimes(1);
      expect(sockets.every((socket) => socket.destroyed)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([false, true])("cancels once and cleans up, IPv6 started: %s", async (startIPv6) => {
    const callback = vi.fn();
    const handle = dialLoopback(4321, callback);
    await Promise.resolve();
    if (startIPv6) vi.advanceTimersByTime(250);
    handle.cancel();
    handle.cancel();
    for (const socket of sockets) {
      expect(socket.destroyed).toBe(true);
      expect(() => socket.emit("error", error("ECONNRESET"))).not.toThrow();
    }
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0]).toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it.each([
    { delay: 250, fallback: 250, deadline: 10_000 },
    { delay: 15_000, fallback: 15_000, deadline: 20_000 },
    { delay: 2_147_483_647, fallback: 2_147_478_647, deadline: 2_147_483_647 },
  ])(
    "times out and cleans up after a $delay ms fallback",
    async ({ delay, fallback, deadline }) => {
      netMocks.getDefaultAutoSelectFamilyAttemptTimeout.mockReturnValue(delay);
      const callback = vi.fn();
      dialLoopback(4321, callback);
      await Promise.resolve();
      vi.advanceTimersByTime(fallback);
      expect(netMocks.connect).toHaveBeenLastCalledWith({ host: "::1", family: 6, port: 4321 });
      sockets[1]!.emit("error", error("EAFNOSUPPORT"));
      vi.advanceTimersByTime(deadline - fallback - 1);
      expect(callback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback.mock.calls[0]![0]).toMatchObject({ code: "ETIMEDOUT" });
      expect(sockets.every((socket) => socket.destroyed)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  for (const { host, pendingIPv4 } of [
    { host: "127.0.0.1", pendingIPv4: false },
    { host: "::1", pendingIPv4: true },
  ]) {
    it(`connects a real HTTP server on ${host} through an agent`, async (ctx) => {
      const actualNet = await vi.importActual<typeof import("node:net")>("node:net");
      const server = http.createServer((_request, response) => response.end("ok"));
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, host, resolve);
        });
      } catch (err) {
        if (
          pendingIPv4 &&
          ["EAFNOSUPPORT", "EADDRNOTAVAIL", "EPROTONOSUPPORT"].includes(
            (err as NodeJS.ErrnoException).code ?? ""
          )
        )
          return ctx.skip();
        throw err;
      }
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");
      netMocks.connect.mockImplementation((options) => {
        const socket =
          pendingIPv4 && options.family === 4 ? new net.Socket() : actualNet.connect(options);
        sockets.push(socket);
        return socket;
      });
      const agent = new http.Agent();
      agent.createConnection = (_options, oncreate) => {
        dialLoopback(address.port, (err, socket) => oncreate!(err, socket!));
        return undefined;
      };
      try {
        const body = new Promise<string>((resolve, reject) => {
          const request = http.get({ host: "localhost", port: address.port, agent }, (response) => {
            let data = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
              data += chunk;
            });
            response.on("end", () => resolve(data));
            response.on("error", reject);
          });
          request.on("error", reject);
        });
        await Promise.resolve();
        if (pendingIPv4) vi.advanceTimersByTime(250);
        expect(await body).toBe("ok");
        expect(netMocks.connect.mock.calls.map(([options]) => options.host)).toEqual(
          pendingIPv4 ? ["127.0.0.1", "::1"] : ["127.0.0.1"]
        );
        if (pendingIPv4) expect(sockets[0]!.destroyed).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        agent.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve()))
        );
      }
    });
  }
});

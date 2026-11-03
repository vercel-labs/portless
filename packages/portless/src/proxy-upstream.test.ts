import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { createProxyServer } from "./proxy.js";
import type { RouteInfo } from "./types.js";

// Dials are delayed so the proxy has many in flight at once, which is what
// a cold HTTP/2 page load does to a dev server's accept backlog.
const dials = vi.hoisted(() => ({ pending: 0, maxPending: 0, started: 0, delayMs: 0 }));
const mocks = vi.hoisted(() => ({ connect: vi.fn() }));

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  mocks.connect.mockImplementation(actual.connect);
  return { ...actual, connect: mocks.connect };
});

vi.mock("./loopback-dial.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loopback-dial.js")>();
  return {
    dialLoopback: (port: number, callback: Parameters<typeof actual.dialLoopback>[1]) => {
      dials.pending++;
      dials.started++;
      dials.maxPending = Math.max(dials.maxPending, dials.pending);
      let cancelled = false;
      let inner: ReturnType<typeof actual.dialLoopback> | undefined;
      const finish = (error: NodeJS.ErrnoException | null, socket?: net.Socket) => {
        dials.pending--;
        callback(error, socket);
      };
      const timer = setTimeout(() => (inner = actual.dialLoopback(port, finish)), dials.delayMs);
      return {
        cancel() {
          if (inner) return inner.cancel();
          if (cancelled) return;
          cancelled = true;
          clearTimeout(timer);
          queueMicrotask(() => finish(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })));
        },
      };
    },
  };
});

const servers: { close: (cb?: () => void) => unknown }[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port))
  );
}

describe("upstream dialing", () => {
  it("limits dials in progress and reuses sockets for a burst (issue #370)", async () => {
    dials.pending = 0;
    dials.maxPending = 0;
    dials.delayMs = 20;

    let connections = 0;
    const backend = http.createServer((_req, res) => res.end("ok"));
    backend.on("connection", () => connections++);
    const backendPort = await listen(backend);

    const routes: RouteInfo[] = [{ hostname: "myapp.localhost", port: backendPort }];
    const proxyPort = await listen(
      createProxyServer({ getRoutes: () => routes, proxyPort: 1355 }) as http.Server
    );

    const agent = new http.Agent({ keepAlive: true });
    const statuses = await Promise.all(
      Array.from(
        { length: 100 },
        () =>
          new Promise<number>((resolve, reject) => {
            const req = http.get(
              { port: proxyPort, headers: { host: "myapp.localhost" }, agent },
              (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
              }
            );
            req.on("error", reject);
          })
      )
    );
    agent.destroy();

    expect(statuses.filter((status) => status !== 200)).toEqual([]);
    expect(dials.maxPending).toBeLessThanOrEqual(16);
    expect(connections).toBeLessThan(100);
  });

  it("keeps stalled IPv4 alive after IPv6 fails", async () => {
    dials.delayMs = 0;
    const backendPort = await listen(http.createServer((_req, res) => res.end("ok")));
    const connect = mocks.connect.getMockImplementation()!;
    let ipv4: net.Socket | undefined;
    let ipv6: net.Socket | undefined;
    mocks.connect.mockImplementation((options: net.TcpNetConnectOpts) => {
      if (options.port !== backendPort) return connect(options);
      if (options.family === 4) return (ipv4 = new net.Socket());
      ipv6 = new net.Socket();
      const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
      queueMicrotask(() => ipv6!.emit("error", refused));
      return ipv6;
    });
    const route = { hostname: "myapp.localhost", port: backendPort };
    const proxyPort = await listen(
      createProxyServer({ getRoutes: () => [route], proxyPort: 1355 }) as http.Server
    );
    let status = 0;
    const request = http.get({ port: proxyPort, headers: { host: "myapp.localhost" } }, (res) => {
      res.resume();
      res.on("end", () => (status = res.statusCode ?? 0));
    });
    request.on("error", () => {});
    try {
      await vi.waitFor(() => expect(ipv6?.destroyed).toBe(true));
      expect(status).toBe(0);
      expect(ipv4?.destroyed).toBe(false);
      ipv4!.connect({ host: "127.0.0.1", port: backendPort });
      await vi.waitFor(() => expect(status).toBe(200));
    } finally {
      request.destroy();
      ipv4?.destroy();
      mocks.connect.mockImplementation(connect);
    }
  });

  it("removes cancelled waiters, releases dial slots, and cancels pending dials on close", async () => {
    dials.started = 0;
    dials.maxPending = 0;
    dials.delayMs = 60_000;
    const proxy = createProxyServer({
      getRoutes: () => [{ hostname: "myapp.localhost", port: 4000 }],
      proxyPort: 1355,
      onError: () => {},
    }) as http.Server;
    const responses = new Map<number, http.ServerResponse>();
    proxy.on("request", (req, res) => responses.set(Number(req.url!.slice(1)), res));
    const proxyPort = await listen(proxy);
    const headers = { host: "myapp.localhost" };
    const clients = Array.from({ length: 18 }, (_, index) => {
      const req = http.get({ port: proxyPort, path: `/${index}`, headers, agent: false });
      req.on("error", () => {});
      return req;
    });
    try {
      await vi.waitFor(() => {
        expect(responses.size).toBe(18);
        expect(dials.pending).toBe(16);
      });
      const paths = [...responses.keys()];
      const queued = responses.get(paths[16]!)!;
      const queuedClosed = new Promise<void>((resolve) => queued.once("close", resolve));
      clients[paths[16]!]!.destroy();
      await queuedClosed;
      clients[paths[0]!]!.destroy();
      await vi.waitFor(() => {
        expect(dials.started).toBe(17);
        expect(dials.pending).toBe(16);
      });
      expect(dials.maxPending).toBe(16);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      expect(dials.pending).toBe(0);
    } finally {
      for (const client of clients) client.destroy();
      await vi.waitFor(() => expect(dials.pending).toBe(0));
    }
  });
});

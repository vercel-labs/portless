import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { createProxyServer } from "./proxy.js";
import type { RouteInfo } from "./types.js";

// Dials are delayed so the proxy has many in flight at once, which is what
// a cold HTTP/2 page load does to a dev server's accept backlog.
const dials = vi.hoisted(() => ({
  pending: 0,
  maxPending: 0,
  delayMs: 0,
  stalled: false,
  cancelled: 0,
}));

vi.mock("./utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils.js")>();
  return {
    ...actual,
    createLoopbackConnection: (
      port: number,
      callback: (error: NodeJS.ErrnoException | null, socket?: net.Socket) => void
    ) => {
      dials.pending++;
      dials.maxPending = Math.max(dials.maxPending, dials.pending);
      let socket: net.Socket | undefined;
      let settled = false;
      const finish = (error: NodeJS.ErrnoException | null) => {
        if (settled) return;
        settled = true;
        dials.pending--;
        callback(error, error ? undefined : socket);
      };
      const timer = setTimeout(() => {
        if (dials.stalled) return;
        socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => finish(null));
        socket.once("error", finish);
      }, dials.delayMs);
      return () => {
        if (settled) return;
        clearTimeout(timer);
        socket?.destroy();
        dials.cancelled++;
        finish(Object.assign(new Error("Connection cancelled"), { code: "ABORT_ERR" }));
      };
    },
  };
});

beforeEach(() => {
  Object.assign(dials, { pending: 0, maxPending: 0, delayMs: 0, stalled: false, cancelled: 0 });
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
    expect(dials.maxPending).toBeLessThanOrEqual(8);
    expect(connections).toBeLessThan(100);
  });

  it("releases failed dial slots so queued requests receive an answer", async () => {
    const backend = http.createServer();
    const backendPort = await listen(backend);
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    const proxyPort = await listen(
      createProxyServer({
        getRoutes: () => [{ hostname: "myapp.localhost", port: backendPort }],
        proxyPort: 1355,
        onError: () => {},
      }) as http.Server
    );
    const statuses = await Promise.all(
      Array.from(
        { length: 24 },
        () =>
          new Promise<number>((resolve, reject) => {
            http
              .get(
                {
                  host: "127.0.0.1",
                  port: proxyPort,
                  headers: { host: "myapp.localhost" },
                  agent: false,
                },
                (res) => {
                  res.resume();
                  res.on("end", () => resolve(res.statusCode ?? 0));
                }
              )
              .on("error", reject);
          })
      )
    );
    expect(statuses).toEqual(Array(24).fill(502));
    expect(dials.pending).toBe(0);
    expect(dials.maxPending).toBeLessThanOrEqual(8);
  });

  it("cancels disconnected clients and lets a queued request dial", async () => {
    dials.stalled = true;
    const onError = vi.fn();
    const backendPort = await listen(http.createServer((_req, res) => res.end("ok")));
    const proxyPort = await listen(
      createProxyServer({
        getRoutes: () => [{ hostname: "myapp.localhost", port: backendPort }],
        proxyPort: 1355,
        onError,
      }) as http.Server
    );
    const clients = Array.from({ length: 8 }, () =>
      http
        .get({
          host: "127.0.0.1",
          port: proxyPort,
          headers: { host: "myapp.localhost" },
          agent: false,
        })
        .on("error", () => {})
    );
    await vi.waitFor(() => expect(dials.pending).toBe(8));
    const response = new Promise<string>((resolve, reject) => {
      http
        .get(
          {
            host: "127.0.0.1",
            port: proxyPort,
            headers: { host: "myapp.localhost" },
            agent: false,
          },
          (res) => {
            let body = "";
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve(body));
          }
        )
        .on("error", reject);
    });
    dials.stalled = false;
    clients.forEach((client) => client.destroy());
    expect(await response).toBe("ok");
    await vi.waitFor(() => expect(dials.pending).toBe(0));
    expect(dials.cancelled).toBe(8);
    expect(dials.maxPending).toBe(8);
    expect(onError).not.toHaveBeenCalled();
  });

  it("cancels pending upstream dials when the proxy closes", async () => {
    dials.stalled = true;
    const proxy = createProxyServer({
      getRoutes: () => [{ hostname: "myapp.localhost", port: 19877 }],
      proxyPort: 1355,
      onError: () => {},
    }) as http.Server;
    const proxyPort = await listen(proxy);
    const responses = Array.from(
      { length: 9 },
      () =>
        new Promise<number | string>((resolve, reject) => {
          http
            .get(
              {
                host: "127.0.0.1",
                port: proxyPort,
                headers: { host: "myapp.localhost" },
                agent: false,
              },
              (res) => {
                res.resume();
                res.on("end", () => resolve(res.statusCode ?? 0));
              }
            )
            .on("error", (error: NodeJS.ErrnoException) => {
              if (error.code === "ECONNRESET") resolve(error.code);
              else reject(error);
            });
        })
    );
    await vi.waitFor(() => expect(dials.pending).toBe(8));
    const closed = new Promise<void>((resolve) => proxy.close(() => resolve()));
    const statuses = await Promise.all(responses);
    expect(statuses.filter((status) => status === 502)).toHaveLength(8);
    expect(statuses.filter((status) => status === "ECONNRESET")).toHaveLength(1);
    await closed;
    expect(dials.pending).toBe(0);
    expect(dials.cancelled).toBe(8);
  });

  it("can listen again after closing", async () => {
    const backendPort = await listen(http.createServer((_req, res) => res.end("ok")));
    const proxy = createProxyServer({
      getRoutes: () => [{ hostname: "myapp.localhost", port: backendPort }],
      proxyPort: 1355,
      loopbackOnly: true,
    }) as http.Server;
    servers.push(proxy);
    for (let attempt = 0; attempt < 2; attempt++) {
      const proxyPort = await new Promise<number>((resolve) =>
        proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as net.AddressInfo).port))
      );
      const status = await new Promise<number>((resolve, reject) => {
        http
          .get(
            {
              host: "127.0.0.1",
              port: proxyPort,
              headers: { host: "myapp.localhost" },
              agent: false,
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            }
          )
          .on("error", reject);
      });
      expect(status).toBe(200);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});

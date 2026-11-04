import { describe, it, expect, afterEach, vi } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { createProxyServer } from "./proxy.js";
import type { RouteInfo } from "./types.js";

// Dials are delayed so the proxy has many in flight at once, which is what
// a cold HTTP/2 page load does to a dev server's accept backlog.
const dials = vi.hoisted(() => ({ pending: 0, maxPending: 0, delayMs: 0 }));

vi.mock("./utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils.js")>();
  return {
    ...actual,
    createLoopbackConnection: (port: number) => {
      dials.pending++;
      dials.maxPending = Math.max(dials.maxPending, dials.pending);
      const socket = net.connect({
        host: "localhost",
        port,
        lookup: ((
          _host: string,
          options: { all?: boolean },
          callback: (...args: unknown[]) => void
        ) =>
          setTimeout(
            () =>
              options.all
                ? callback(null, [{ address: "127.0.0.1", family: 4 }])
                : callback(null, "127.0.0.1", 4),
            dials.delayMs
          )) as unknown as net.LookupFunction,
      });
      socket.once("connect", () => dials.pending--);
      return socket;
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
});

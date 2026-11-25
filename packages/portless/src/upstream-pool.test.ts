import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ensureCerts } from "./certs.js";
import { createProxyServer } from "./proxy.js";
import type { RouteInfo } from "./types.js";
import { UpstreamPool } from "./upstream-pool.js";

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
const requests = new Set<http.ClientRequest>();
const pools: UpstreamPool[] = [];
const tempDirs: string[] = [];

function trackSocket(socket: net.Socket): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
}

function listen(server: net.Server, backlog = 511): Promise<number> {
  servers.push(server);
  server.on("connection", trackSocket);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", backlog }, () => {
      server.removeListener("error", reject);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

function get(port: number, requestPath = "/"): http.ClientRequest {
  const req = http.get({
    host: "127.0.0.1",
    port,
    path: requestPath,
    headers: { host: "app.localhost" },
    agent: false,
  });
  requests.add(req);
  req.once("close", () => requests.delete(req));
  req.on("error", () => {});
  return req;
}

function response(req: http.ClientRequest): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    req.once("error", reject);
    req.once("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
  });
}

function proxy(backendPort: number, onError: (error: string) => void = () => {}): http.Server {
  return createProxyServer({
    getRoutes: () => [{ hostname: "app.localhost", port: backendPort }],
    proxyPort: 1355,
    onError,
  }) as http.Server;
}

afterEach(async () => {
  for (const pool of pools.splice(0)) pool.destroy();
  for (const req of requests) req.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  requests.clear();
  sockets.clear();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("UpstreamPool", () => {
  it("caps concurrent upstream sockets during a 300-request burst (issue #531)", async () => {
    let active = 0;
    let peak = 0;
    const errors: string[] = [];
    const backend = http.createServer((_req, res) => {
      const timer = setTimeout(() => res.end("ok"), 25);
      res.once("close", () => clearTimeout(timer));
    });
    backend.on("connection", (socket) => {
      active++;
      peak = Math.max(peak, active);
      socket.once("close", () => (active -= 1));
    });
    const backendPort = await listen(backend, 128);
    const proxyPort = await listen(proxy(backendPort, (error) => errors.push(error)));

    const results = await Promise.all(
      Array.from({ length: 300 }, () => response(get(proxyPort)))
    );

    expect(results).toEqual(Array(300).fill({ status: 200, body: "ok" }));
    expect(errors).toEqual([]);
    expect(peak).toBeLessThanOrEqual(48);
  }, 30_000);

  it("promotes chunked streaming responses out of the request cap", async () => {
    const backend = http.createServer((req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("open\n");
      } else {
        res.end("ok");
      }
    });
    const backendPort = await listen(backend);
    const proxyPort = await listen(proxy(backendPort));
    const streams = Array.from({ length: 60 }, () => get(proxyPort, "/stream"));

    await Promise.all(
      streams.map(
        (req) =>
          new Promise<void>((resolve, reject) => {
            req.once("error", reject);
            req.once("response", (res) => {
              if (res.statusCode !== 200) return reject(new Error(`Unexpected status ${res.statusCode}`));
              res.setEncoding("utf8");
              let body = "";
              res.on("data", (chunk: string) => {
                body += chunk;
                if (body.includes("open\n")) resolve();
              });
              res.once("error", reject);
            });
          })
      )
    );
    expect(await response(get(proxyPort, "/health"))).toEqual({ status: 200, body: "ok" });
    for (const stream of streams) stream.destroy();
  }, 30_000);

  it("does not let a waiting fresh-connection replay block a normal request when an idle socket is free", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-pool-test-"));
    tempDirs.push(dir);
    const certs = ensureCerts(dir);
    const backend = https.createServer(
      { cert: fs.readFileSync(certs.certPath), key: fs.readFileSync(certs.keyPath) },
      (_req, res) => res.end("ok")
    );
    const backendPort = await listen(backend);
    let forward = true;
    let accepted = 0;
    const tunnel = net.createServer((socket) => {
      accepted++;
      if (!forward) {
        socket.resume();
        return;
      }
      const target = net.connect(backendPort, "127.0.0.1");
      trackSocket(target);
      target.on("error", () => socket.destroy());
      socket.pipe(target).pipe(socket);
    });
    const tunnelPort = await listen(tunnel);
    const route: RouteInfo = {
      hostname: "app.localhost",
      port: tunnelPort,
      upstream: { tls: true, host: "app.localhost" },
    };
    const pool = new UpstreamPool();
    pools.push(pool);
    let freshStarted = false;
    let replayArrived = false;
    const gateway = http.createServer((req, res) => {
      if (req.url === "/replay") replayArrived = true;
      pool.dispatch(
        route,
        { headers: { host: "app.localhost" }, freshConnection: req.url !== "/normal" },
        res,
        (upstream) => {
          if (req.url === "/replay") freshStarted = true;
          upstream.once("response", (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          });
          upstream.once("error", () => res.destroy());
          upstream.end();
        }
      );
    });
    const gatewayPort = await listen(gateway);

    expect(await response(get(gatewayPort, "/normal"))).toEqual({ status: 200, body: "ok" });
    forward = false;
    const stalled = Array.from({ length: 8 }, () => get(gatewayPort, "/stalled"));
    await vi.waitFor(() => expect(accepted).toBe(9), { timeout: 10_000 });
    const replay = get(gatewayPort, "/replay");
    await vi.waitFor(() => expect(replayArrived).toBe(true), { timeout: 10_000 });
    expect(await response(get(gatewayPort, "/normal"))).toEqual({ status: 200, body: "ok" });
    expect(freshStarted).toBe(false);
    expect(accepted).toBe(9);
    replay.destroy();
    for (const req of stalled) req.destroy();
  }, 180_000);

  it("drops queued requests cleanly when clients disconnect at capacity", async () => {
    let received = 0;
    const held: http.ServerResponse[] = [];
    const backend = http.createServer((_req, res) => {
      received++;
      if (received <= 48) held.push(res);
      else res.end("ok");
    });
    const backendPort = await listen(backend);
    const server = proxy(backendPort);
    let queuedArrived = 0;
    let queuedClosed = 0;
    server.on("request", (req, res) => {
      if (req.url !== "/queued") return;
      queuedArrived++;
      res.once("close", () => queuedClosed++);
    });
    const proxyPort = await listen(server);
    const initial = Promise.all(Array.from({ length: 48 }, () => response(get(proxyPort))));
    void initial.catch(() => {});
    await vi.waitFor(() => expect(received).toBe(48), { timeout: 10_000 });
    const queued = Array.from({ length: 10 }, () => get(proxyPort, "/queued"));
    await vi.waitFor(() => expect(queuedArrived).toBe(10), { timeout: 10_000 });
    expect(received).toBe(48);
    for (const req of queued) req.destroy();
    await vi.waitFor(() => expect(queuedClosed).toBe(10), { timeout: 10_000 });
    for (const res of held) res.end("ok");
    expect(await initial).toEqual(Array(48).fill({ status: 200, body: "ok" }));
    expect(await response(get(proxyPort))).toEqual({ status: 200, body: "ok" });
    expect(received).toBe(49);
  }, 30_000);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
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

function get(
  port: number,
  requestPath = "/",
  agent: http.Agent | false = false
): http.ClientRequest {
  const req = http.get({
    host: "127.0.0.1",
    port,
    path: requestPath,
    headers: { host: "app.localhost" },
    agent,
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

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100_000; i++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Condition was not reached");
}

class FakeServerResponse extends Writable {
  readonly socket: Pick<net.Socket, "remoteAddress"> | undefined;
  readonly stream: { session: { socket: Pick<net.Socket, "remoteAddress"> } } | undefined;
  headersSent = false;
  statusCode = 0;
  headers: http.OutgoingHttpHeaders = {};
  body = "";

  constructor(remoteAddress: string, viaSession = false) {
    super();
    if (viaSession) this.stream = { session: { socket: { remoteAddress } } };
    else this.socket = { remoteAddress };
  }

  writeHead(statusCode: number, headers: http.OutgoingHttpHeaders = {}): this {
    this.statusCode = statusCode;
    this.headers = { ...headers };
    this.headersSent = true;
    return this;
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    callback();
  }
}

function openPausedResponse(port: number, requestPath: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      headers: { host: "app.localhost" },
      agent: false,
    });
    requests.add(req);
    req.once("close", () => requests.delete(req));
    req.on("error", () => {});
    req.once("response", (res) => {
      res.on("error", () => {});
      res.pause();
      resolve(res);
    });
    req.once("error", reject);
    req.end();
  });
}

function dispatchAndPipe(
  pool: UpstreamPool,
  route: RouteInfo,
  downstream: http.ServerResponse | FakeServerResponse,
  requestPath: string
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    downstream.once("finish", done);
    downstream.once("close", done);
    pool.dispatch(
      route,
      { headers: { host: "app.localhost" }, path: requestPath },
      downstream as http.ServerResponse,
      (upstream) => {
        upstream.once("response", (proxyRes) => {
          downstream.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.once("error", () => {});
          proxyRes.pipe(downstream);
        });
        upstream.once("error", () => {});
        upstream.end();
      }
    );
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
  vi.useRealTimers();
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

    const clientAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
    let results: { status: number; body: string }[];
    try {
      results = await Promise.all(
        Array.from({ length: 300 }, () => response(get(proxyPort, "/", clientAgent)))
      );
    } finally {
      clientAgent.destroy();
    }

    expect(results).toEqual(Array(300).fill({ status: 200, body: "ok" }));
    expect(errors).toEqual([]);
    expect(peak).toBeLessThanOrEqual(48);
  }, 30_000);

  it("promotes streaming media-type responses out of the request cap", async () => {
    const backend = http.createServer((req, res) => {
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        res.write('{"ok":true}\n');
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
              if (res.statusCode !== 200)
                return reject(new Error(`Unexpected status ${res.statusCode}`));
              res.setEncoding("utf8");
              let body = "";
              res.on("data", (chunk: string) => {
                body += chunk;
                if (body.includes('{"ok":true}\n')) resolve();
              });
              res.once("error", reject);
            });
          })
      )
    );
    expect(await response(get(proxyPort, "/health"))).toEqual({ status: 200, body: "ok" });
    for (const stream of streams) stream.destroy();
  }, 30_000);

  it("keeps finite chunked responses inside the request cap", async () => {
    let active = 0;
    let peak = 0;
    const errors: string[] = [];
    const backend = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.write("// chunk\n");
      const timer = setTimeout(() => res.end("export default 1;"), 25);
      res.once("close", () => clearTimeout(timer));
    });
    backend.on("connection", (socket) => {
      active++;
      peak = Math.max(peak, active);
      socket.once("close", () => (active -= 1));
    });
    const backendPort = await listen(backend, 128);
    const proxyPort = await listen(proxy(backendPort, (error) => errors.push(error)));

    const clientAgent = new http.Agent({ keepAlive: true, maxSockets: 100 });
    let results: { status: number; body: string }[];
    try {
      results = await Promise.all(
        Array.from({ length: 200 }, () => response(get(proxyPort, "/", clientAgent)))
      );
    } finally {
      clientAgent.destroy();
    }

    expect(results).toEqual(Array(200).fill({ status: 200, body: "// chunk\nexport default 1;" }));
    expect(errors).toEqual([]);
    expect(peak).toBeLessThanOrEqual(48);
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

  it("evicts a backpressured non-streaming response after the progress deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pool = new UpstreamPool();
    pools.push(pool);
    let finiteBackpressure = false;
    let finiteBackendClosed = false;
    let finiteProxyClosed = false;
    let sseBackendClosed = false;
    let sseProxyClosed = false;
    let resolveFiniteProxyRes: ((res: http.IncomingMessage) => void) | undefined;
    let resolveSseProxyRes: ((res: http.IncomingMessage) => void) | undefined;
    const finiteProxyResReady = new Promise<http.IncomingMessage>((resolve) => {
      resolveFiniteProxyRes = resolve;
    });
    const sseProxyResReady = new Promise<http.IncomingMessage>((resolve) => {
      resolveSseProxyRes = resolve;
    });
    const backend = http.createServer((req, res) => {
      if (req.url === "/finite") {
        const size = 32 * 1024 * 1024;
        let sent = 0;
        res.once("close", () => {
          finiteBackendClosed = true;
        });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(size),
        });
        const chunk = Buffer.alloc(64 * 1024);
        const writeMore = () => {
          while (sent < size) {
            const next = Math.min(chunk.length, size - sent);
            const ok = res.write(chunk.subarray(0, next));
            sent += next;
            if (!ok) {
              finiteBackpressure = true;
              res.once("drain", writeMore);
              return;
            }
          }
        };
        writeMore();
        return;
      }
      if (req.url === "/sse") {
        res.once("close", () => {
          sseBackendClosed = true;
        });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        return;
      }
      res.end("ok");
    });
    const backendPort = await listen(backend);
    const route: RouteInfo = {
      hostname: "app.localhost",
      port: backendPort,
    };
    const gateway = http.createServer((req, res) => {
      pool.dispatch(
        route,
        { headers: { host: "app.localhost" }, path: req.url ?? "/" },
        res,
        (upstream) => {
          upstream.once("response", (proxyRes) => {
            if (req.url === "/finite") {
              resolveFiniteProxyRes?.(proxyRes);
              proxyRes.once("close", () => {
                finiteProxyClosed = true;
              });
            }
            if (req.url === "/sse") {
              resolveSseProxyRes?.(proxyRes);
              proxyRes.once("close", () => {
                sseProxyClosed = true;
              });
            }
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            res.flushHeaders();
            proxyRes.pipe(res);
          });
          upstream.once("error", () => res.destroy());
          upstream.end();
        }
      );
    });
    const gatewayPort = await listen(gateway);
    const [finiteClient, sseClient] = await Promise.all([
      openPausedResponse(gatewayPort, "/finite"),
      openPausedResponse(gatewayPort, "/sse"),
    ]);
    const finiteProxyRes = await finiteProxyResReady;
    const sseProxyRes = await sseProxyResReady;
    expect(finiteClient.isPaused()).toBe(true);
    expect(sseClient.isPaused()).toBe(true);
    await waitFor(
      () =>
        finiteClient.isPaused() &&
        finiteBackpressure &&
        finiteProxyRes.isPaused() &&
        finiteProxyRes.readableLength > 0
    );
    expect(finiteBackpressure).toBe(true);
    await vi.advanceTimersByTimeAsync(30_001);
    await waitFor(() => finiteProxyClosed && finiteBackendClosed);
    expect(finiteProxyClosed).toBe(true);
    expect(finiteBackendClosed).toBe(true);
    expect(sseProxyClosed).toBe(false);
    expect(sseBackendClosed).toBe(false);
    expect(sseProxyRes.destroyed).toBe(false);
    expect(await response(get(gatewayPort, "/followup"))).toEqual({ status: 200, body: "ok" });
    finiteClient.destroy();
    sseClient.destroy();
  }, 30_000);

  it("caps a single non-loopback peer below the shared backend limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pool = new UpstreamPool();
    pools.push(pool);
    let received = 0;
    const held: http.ServerResponse[] = [];
    let resolveFirstWave: (() => void) | undefined;
    const firstWave = new Promise<void>((resolve) => {
      resolveFirstWave = resolve;
    });
    const backend = http.createServer((_req, res) => {
      received++;
      if (received <= 16) {
        held.push(res);
        if (received === 16) resolveFirstWave?.();
        return;
      }
      res.end("ok");
    });
    const backendPort = await listen(backend);
    const route: RouteInfo = {
      hostname: "app.localhost",
      port: backendPort,
    };
    const samePeer = Array.from({ length: 20 }, (_, index) => {
      const downstream = new FakeServerResponse(
        index < 10 ? "192.168.1.50" : "::ffff:192.168.1.50",
        index % 2 === 1
      );
      const done = dispatchAndPipe(pool, route, downstream, `/same-peer/${index}`);
      return { downstream, done };
    });
    await firstWave;
    expect(received).toBe(16);
    const otherPeer = new FakeServerResponse("192.168.1.51");
    const loopback = new FakeServerResponse("127.0.0.1");
    const otherDone = dispatchAndPipe(pool, route, otherPeer, "/other-peer");
    const loopbackDone = dispatchAndPipe(pool, route, loopback, "/loopback");
    await Promise.all([otherDone, loopbackDone]);
    expect(received).toBe(18);
    expect(otherPeer.statusCode).toBe(200);
    expect(otherPeer.body).toBe("ok");
    expect(loopback.statusCode).toBe(200);
    expect(loopback.body).toBe("ok");
    for (const res of held) res.end("ok");
    await Promise.all(samePeer.map(({ done }) => done));
    expect(samePeer.map(({ downstream }) => downstream.statusCode)).toEqual(
      Array.from({ length: 20 }, () => 200)
    );
    expect(samePeer.map(({ downstream }) => downstream.body)).toEqual(
      Array.from({ length: 20 }, () => "ok")
    );
  }, 30_000);

  it("returns 503 when a queued request exceeds the wait deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let received = 0;
    const held: http.ServerResponse[] = [];
    let resolveFirstWave: () => void = () => {};
    const firstWave = new Promise<void>((resolve) => {
      resolveFirstWave = resolve;
    });
    const backend = http.createServer((_req, res) => {
      received++;
      held.push(res);
      if (received === 48) resolveFirstWave();
    });
    const backendPort = await listen(backend);
    const server = proxy(backendPort);
    let resolveQueued: () => void = () => {};
    const queuedArrived = new Promise<void>((resolve) => {
      resolveQueued = resolve;
    });
    server.on("request", (req) => {
      if (req.url === "/queued") resolveQueued();
    });
    const proxyPort = await listen(server);
    const initial = Promise.all(Array.from({ length: 48 }, () => response(get(proxyPort))));
    await firstWave;
    const queued = response(get(proxyPort, "/queued"));
    await queuedArrived;
    expect(received).toBe(48);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await queued).toEqual({
      status: 503,
      body: "Service Unavailable: upstream request queue timed out\n",
    });
    expect(received).toBe(48);
    for (const res of held) res.end("ok");
    expect(await initial).toEqual(Array(48).fill({ status: 200, body: "ok" }));
  }, 30_000);
});

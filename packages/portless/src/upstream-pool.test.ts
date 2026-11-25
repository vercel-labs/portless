import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as http2 from "node:http2";
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
const fakeResponses = new Set<FakeServerResponse>();
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

function createPool(): UpstreamPool {
  const pool = new UpstreamPool();
  pools.push(pool);
  return pool;
}

function createTlsCerts(prefix: string): { cert: Buffer; key: Buffer; ca: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  const certs = ensureCerts(dir);
  return {
    cert: fs.readFileSync(certs.certPath),
    key: fs.readFileSync(certs.keyPath),
    ca: fs.readFileSync(certs.caPath),
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function trackPeakConnections(server: net.Server): () => number {
  let active = 0;
  let peak = 0;
  server.on("connection", (socket) => {
    active++;
    peak = Math.max(peak, active);
    socket.once("close", () => (active -= 1));
  });
  return () => peak;
}

function streamLargeBody(res: http.ServerResponse, size: number, onBackpressure: () => void): void {
  let sent = 0;
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(size),
  });
  const chunk = Buffer.alloc(64 * 1024, "a");
  const writeMore = () => {
    while (sent < size) {
      const next = Math.min(chunk.length, size - sent);
      const ok = res.write(chunk.subarray(0, next));
      sent += next;
      if (!ok) {
        onBackpressure();
        res.once("drain", writeMore);
        return;
      }
    }
  };
  writeMore();
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
  destroyedError: Error | undefined;

  constructor(remoteAddress: string, viaSession = false) {
    super();
    this.on("error", (err) => {
      this.destroyedError = err;
    });
    fakeResponses.add(this);
    this.once("close", () => fakeResponses.delete(this));
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
  for (const res of fakeResponses) res.destroy();
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
    const errors: string[] = [];
    const backend = http.createServer((_req, res) => {
      const timer = setTimeout(() => res.end("ok"), 25);
      res.once("close", () => clearTimeout(timer));
    });
    const peakConnections = trackPeakConnections(backend);
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
    expect(peakConnections()).toBeLessThanOrEqual(48);
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
    const errors: string[] = [];
    const backend = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.write("// chunk\n");
      const timer = setTimeout(() => res.end("export default 1;"), 25);
      res.once("close", () => clearTimeout(timer));
    });
    const peakConnections = trackPeakConnections(backend);
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
    expect(peakConnections()).toBeLessThanOrEqual(48);
  }, 30_000);

  it("does not let a waiting fresh-connection replay block a normal request when an idle socket is free", async () => {
    const tls = createTlsCerts("portless-pool-test-");
    const backend = https.createServer({ cert: tls.cert, key: tls.key }, (_req, res) =>
      res.end("ok")
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
    const pool = createPool();
    let finiteBackpressure = false;
    let finiteBackendClosed = false;
    let finiteProxyClosed = false;
    let sseBackendClosed = false;
    let sseProxyClosed = false;
    let longPollRes: http.ServerResponse | undefined;
    const finiteProxyResReady = deferred<http.IncomingMessage>();
    const sseProxyResReady = deferred<http.IncomingMessage>();
    const longPollHeadersReady = deferred();
    const backend = http.createServer((req, res) => {
      if (req.url === "/finite") {
        res.once("close", () => (finiteBackendClosed = true));
        streamLargeBody(res, 32 * 1024 * 1024, () => (finiteBackpressure = true));
        return;
      }
      if (req.url === "/sse") {
        res.once("close", () => (sseBackendClosed = true));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        return;
      }
      if (req.url === "/long-poll") {
        longPollRes = res;
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        return;
      }
      res.end("ok");
    });
    const backendPort = await listen(backend);
    const route: RouteInfo = { hostname: "app.localhost", port: backendPort };
    const gateway = http.createServer((req, res) => {
      pool.dispatch(
        route,
        { headers: { host: "app.localhost" }, path: req.url ?? "/" },
        res,
        (upstream) => {
          upstream.once("response", (proxyRes) => {
            if (req.url === "/finite") {
              finiteProxyResReady.resolve(proxyRes);
              proxyRes.once("close", () => (finiteProxyClosed = true));
            }
            if (req.url === "/sse") {
              sseProxyResReady.resolve(proxyRes);
              proxyRes.once("close", () => (sseProxyClosed = true));
            }
            if (req.url === "/long-poll") longPollHeadersReady.resolve();
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
    const longPollPromise = response(get(gatewayPort, "/long-poll"));
    const [finiteClient, sseClient] = await Promise.all([
      openPausedResponse(gatewayPort, "/finite"),
      openPausedResponse(gatewayPort, "/sse"),
    ]);
    await longPollHeadersReady.promise;
    const finiteProxyRes = await finiteProxyResReady.promise;
    const sseProxyRes = await sseProxyResReady.promise;
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
    longPollRes!.end('{"ready":true}');
    expect(await longPollPromise).toEqual({ status: 200, body: '{"ready":true}' });
    expect(await response(get(gatewayPort, "/followup"))).toEqual({ status: 200, body: "ok" });
    finiteClient.destroy();
    sseClient.destroy();
  }, 30_000);

  it("caps a single non-loopback peer below the shared backend limit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pool = createPool();
    let received = 0;
    const held: http.ServerResponse[] = [];
    const firstWave = deferred();
    const backend = http.createServer((_req, res) => {
      received++;
      if (received <= 16) {
        held.push(res);
        if (received === 16) firstWave.resolve();
        return;
      }
      res.end("ok");
    });
    const backendPort = await listen(backend);
    const route: RouteInfo = { hostname: "app.localhost", port: backendPort };
    const samePeer = Array.from({ length: 20 }, (_, index) => {
      const downstream = new FakeServerResponse(
        index < 10 ? "192.168.1.50" : "::ffff:192.168.1.50",
        index % 2 === 1
      );
      return { downstream, done: dispatchAndPipe(pool, route, downstream, `/same-peer/${index}`) };
    });
    await firstWave.promise;
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

  it("evicts stalled upstream requests after first-byte and body inactivity deadlines while preserving 60s long polls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = new Set<string>();
    let longPoll: http.ServerResponse | undefined;
    let bodyClosed = false;
    const backend = http.createServer((req, res) => {
      started.add(req.url ?? "");
      if (req.url === "/hang-headers") return;
      if (req.url === "/hang-body") {
        res.once("close", () => (bodyClosed = true));
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        return;
      }
      if (req.url === "/long-poll") {
        longPoll = res;
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
        return;
      }
      res.end("ok");
    });
    const backendPort = await listen(backend);
    const server = proxy(backendPort);
    const proxyResponses = new Map<string, http.ServerResponse>();
    server.on("request", (req, res) => proxyResponses.set(req.url ?? "", res));
    const proxyPort = await listen(server);
    const headersResult = response(get(proxyPort, "/hang-headers"));
    void headersResult.catch(() => {});
    const bodyRequest = get(proxyPort, "/hang-body");
    bodyRequest.once("response", (res) => {
      res.on("error", () => {});
      res.resume();
    });
    const longPollResult = response(get(proxyPort, "/long-poll"));
    void longPollResult.catch(() => {});
    await waitFor(
      () =>
        started.size === 3 &&
        proxyResponses.get("/hang-body")?.headersSent === true &&
        proxyResponses.get("/long-poll")?.headersSent === true &&
        longPoll !== undefined
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(longPoll!.destroyed).toBe(false);
    expect(longPoll!.writableEnded).toBe(false);
    longPoll!.end('{"ok":true}');
    expect(await longPollResult).toEqual({ status: 200, body: '{"ok":true}' });
    await vi.advanceTimersByTimeAsync(61_000);
    const rejected = await headersResult;
    expect(rejected.status).toBe(504);
    expect(JSON.parse(rejected.body).error).toBe("gateway_timeout");
    await waitFor(() => bodyClosed);
    expect(await response(get(proxyPort, "/health"))).toEqual({ status: 200, body: "ok" });
  }, 30_000);

  it("shares the 48-request admission cap across host overrides and separate proxy instances on the same backend port while keeping shutdown isolated", async () => {
    const held: http.ServerResponse[] = [];
    const hosts: (string | undefined)[] = [];
    const backend = http.createServer((req, res) => {
      hosts.push(req.headers.host);
      held.push(res);
    });
    const backendPort = await listen(backend);
    const makeProxy = (host: string) =>
      createProxyServer({
        getRoutes: () => [{ hostname: "app.localhost", port: backendPort, upstream: { host } }],
        proxyPort: 1355,
        onError: () => {},
      }) as http.Server;
    const firstServer = makeProxy("a.internal");
    const secondServer = makeProxy("b.internal");
    let secondArrived = 0;
    secondServer.on("request", () => secondArrived++);
    const firstPort = await listen(firstServer);
    const secondPort = await listen(secondServer);
    let firstFinished = 0;
    const first = Array.from({ length: 30 }, () =>
      response(get(firstPort)).then((result) => {
        firstFinished++;
        return result;
      })
    );
    for (const result of first) void result.catch(() => {});
    await waitFor(() => held.length === 30);
    let aborted = 0;
    const second = Array.from({ length: 30 }, () =>
      response(get(secondPort)).catch(() => {
        aborted++;
        return null;
      })
    );
    await waitFor(() => secondArrived === 30 && held.length >= 48);
    for (let i = 0; i < 10; i++) await settle();
    expect(held.length).toBe(48);
    expect(hosts.slice(0, 30)).toEqual(Array(30).fill("a.internal"));
    expect(hosts.slice(30)).toEqual(Array(18).fill("b.internal"));
    secondServer.close();
    await waitFor(() => aborted === 12);
    expect(firstFinished).toBe(0);
    expect(held.slice(0, 30).every((res) => !res.destroyed)).toBe(true);
    for (const res of held) res.end("ok");
    expect(await Promise.all(first)).toEqual(Array(30).fill({ status: 200, body: "ok" }));
    const secondResults = await Promise.all(second);
    expect(secondResults.filter((result) => result === null)).toHaveLength(12);
    expect(secondResults.filter((result) => result?.status === 200)).toHaveLength(18);
  }, 30_000);

  it("treats 127.0.0.2 as loopback instead of applying the remote-peer cap", async () => {
    const held: http.ServerResponse[] = [];
    const backend = http.createServer((_req, res) => held.push(res));
    const backendPort = await listen(backend);
    const pool = new UpstreamPool();
    pools.push(pool);
    const route: RouteInfo = { hostname: "app.localhost", port: backendPort };
    const dispatched = Array.from({ length: 20 }, (_, index) => {
      const downstream = new FakeServerResponse("127.0.0.2");
      return { downstream, done: dispatchAndPipe(pool, route, downstream, `/${index}`) };
    });
    await waitFor(() => held.length === 20);
    expect(held).toHaveLength(20);
    for (const res of held) res.end("ok");
    await Promise.all(dispatched.map(({ done }) => done));
    expect(dispatched.every(({ downstream }) => downstream.statusCode === 200)).toBe(true);
    expect(dispatched.every(({ downstream }) => downstream.body === "ok")).toBe(true);
  }, 30_000);

  it("keeps the request slot and client disconnect handling active when the backend replies before an upload finishes", async () => {
    const held: http.ServerResponse[] = [];
    let afterReceived = false;
    let earlyClosed = false;
    const backend = http.createServer((req, res) => {
      if (req.url === "/early") {
        req.socket.once("close", () => (earlyClosed = true));
        res.writeHead(413);
        res.end("too large");
        return;
      }
      if (req.url === "/after") {
        afterReceived = true;
        res.end("ok");
        return;
      }
      held.push(res);
    });
    const backendPort = await listen(backend);
    const pool = new UpstreamPool();
    pools.push(pool);
    const route: RouteInfo = { hostname: "app.localhost", port: backendPort };
    let afterArrived = false;
    const server = http.createServer((req, res) => {
      if (req.url === "/after") afterArrived = true;
      pool.dispatch(
        route,
        { method: req.method, path: req.url, headers: { ...req.headers } },
        res,
        (upstream) => {
          upstream.once("response", (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          });
          upstream.once("error", () => {});
          req.pipe(upstream);
        }
      );
    });
    const proxyPort = await listen(server);
    const initial = Promise.all(Array.from({ length: 47 }, () => response(get(proxyPort))));
    void initial.catch(() => {});
    await waitFor(() => held.length === 47);
    const upload = net.connect(proxyPort, "127.0.0.1");
    trackSocket(upload);
    let earlyResponse = "";
    upload.on("data", (chunk) => (earlyResponse += chunk.toString()));
    upload.write("POST /early HTTP/1.1\r\nHost: app.localhost\r\nContent-Length: 10\r\n\r\na");
    await waitFor(() => earlyResponse.includes("too large"));
    expect(earlyResponse).toContain("413");
    expect(earlyClosed).toBe(false);
    const after = response(get(proxyPort, "/after"));
    void after.catch(() => {});
    await waitFor(() => afterArrived);
    for (let i = 0; i < 10; i++) await settle();
    expect(afterReceived).toBe(false);
    upload.destroy();
    await waitFor(() => earlyClosed && afterReceived);
    expect(await after).toEqual({ status: 200, body: "ok" });
    expect(afterReceived).toBe(true);
    for (const res of held) res.end("ok");
    expect(await initial).toEqual(Array(47).fill({ status: 200, body: "ok" }));
  }, 30_000);

  it("rejects queue overflow immediately with 503 once 512 requests are waiting", async () => {
    const held: http.ServerResponse[] = [];
    const backend = http.createServer((_req, res) => held.push(res));
    const backendPort = await listen(backend);
    const pool = new UpstreamPool();
    pools.push(pool);
    const route: RouteInfo = { hostname: "app.localhost", port: backendPort };
    const active = Array.from({ length: 48 }, (_, index) => {
      const downstream = new FakeServerResponse("127.0.0.1");
      return { downstream, done: dispatchAndPipe(pool, route, downstream, `/active/${index}`) };
    });
    await waitFor(() => held.length === 48);
    const queued = Array.from({ length: 512 }, (_, index) => {
      const downstream = new FakeServerResponse("127.0.0.1");
      return { downstream, done: dispatchAndPipe(pool, route, downstream, `/queued/${index}`) };
    });
    expect(queued.every(({ downstream }) => downstream.statusCode === 0)).toBe(true);
    const overflow = new FakeServerResponse("127.0.0.1");
    const overflowDone = dispatchAndPipe(pool, route, overflow, "/overflow");
    expect(overflow.statusCode).toBe(503);
    await overflowDone;
    pool.destroy();
    for (const { downstream } of active) downstream.destroy();
    await Promise.all([...active.map(({ done }) => done), ...queued.map(({ done }) => done)]);
  }, 30_000);

  it("admits WebSocket upgrades while all 48 HTTP request slots are occupied", async () => {
    const held: http.ServerResponse[] = [];
    const backend = http.createServer((_req, res) => held.push(res));
    backend.on("upgrade", (_req, socket, head) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"
      );
      if (head.length) socket.write(head);
      socket.on("data", (chunk) => socket.write(chunk));
    });
    const backendPort = await listen(backend);
    const proxyPort = await listen(proxy(backendPort));
    let finished = 0;
    const initial = Promise.all(
      Array.from({ length: 48 }, () =>
        response(get(proxyPort)).then((result) => {
          finished++;
          return result;
        })
      )
    );
    void initial.catch(() => {});
    await waitFor(() => held.length === 48);
    const socket = net.connect(proxyPort, "127.0.0.1");
    trackSocket(socket);
    let received = "";
    socket.on("data", (chunk) => (received += chunk.toString()));
    socket.write(
      "GET /socket HTTP/1.1\r\n" +
        "Host: app.localhost\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    await waitFor(() => received.includes("\r\n\r\n"));
    expect(received).toContain("101 Switching Protocols");
    socket.write("ping");
    await waitFor(() => received.includes("ping"));
    expect(finished).toBe(0);
    expect(held.every((res) => !res.destroyed && !res.writableEnded)).toBe(true);
    socket.destroy();
    for (const res of held) res.end("ok");
    expect(await initial).toEqual(Array(48).fill({ status: 200, body: "ok" }));
  }, 30_000);

  it("returns 503 when a queued request exceeds the wait deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let received = 0;
    const held: http.ServerResponse[] = [];
    const firstWave = deferred();
    const backend = http.createServer((_req, res) => {
      received++;
      held.push(res);
      if (received === 48) firstWave.resolve();
    });
    const backendPort = await listen(backend);
    const server = proxy(backendPort);
    const queuedArrived = deferred();
    server.on("request", (req) => {
      if (req.url === "/queued") queuedArrived.resolve();
    });
    const proxyPort = await listen(server);
    const initial = Promise.all(Array.from({ length: 48 }, () => response(get(proxyPort))));
    await firstWave.promise;
    const queued = response(get(proxyPort, "/queued"));
    await queuedArrived.promise;
    expect(received).toBe(48);
    await vi.advanceTimersByTimeAsync(30_000);
    const rejected = await queued;
    expect(rejected.status).toBe(503);
    expect(JSON.parse(rejected.body).error).toBe("service_unavailable");
    expect(received).toBe(48);
    for (const res of held) res.end("ok");
    expect(await initial).toEqual(Array(48).fill({ status: 200, body: "ok" }));
  }, 30_000);

  it("resets HTTP/2 streams with an error on stalled readers, body-idle timeouts, and shutdown of queued requests", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const tls = createTlsCerts("portless-h2-abort-");
    const held: http.ServerResponse[] = [];
    let stalledBackpressure = false;
    let bodyIdleHeadersSent = false;
    const backend = http.createServer((req, res) => {
      if (req.url === "/stalled") {
        streamLargeBody(res, 64 * 1024 * 1024, () => (stalledBackpressure = true));
        return;
      }
      if (req.url === "/body-idle") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": "1048576",
        });
        res.write("partial", () => (bodyIdleHeadersSent = true));
        return;
      }
      held.push(res);
    });
    const backendPort = await listen(backend);
    const server = createProxyServer({
      getRoutes: () => [{ hostname: "app.localhost", port: backendPort }],
      proxyPort: 1355,
      onError: () => {},
      tls,
    });
    const proxyPort = await listen(server);
    const client = http2.connect(`https://127.0.0.1:${proxyPort}`, {
      ca: tls.ca,
      servername: "app.localhost",
      rejectUnauthorized: false,
    });
    client.on("error", () => {});
    try {
      const watchStream = (stream: http2.ClientHttp2Stream) => {
        let ended = false;
        let errorCode: string | undefined;
        let bytes = 0;
        const closed = new Promise<void>((resolve) => {
          stream.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
          });
          stream.once("end", () => {
            ended = true;
          });
          stream.once("error", (err: NodeJS.ErrnoException) => {
            errorCode = err.code;
          });
          stream.once("close", resolve);
        });
        return {
          closed,
          result: () => ({ ended, errorCode, rstCode: stream.rstCode, bytes }),
        };
      };

      const stalledStream = client.request({
        ":path": "/stalled",
        ":authority": "app.localhost",
      });
      const stalledWatcher = watchStream(stalledStream);
      stalledStream.pause();
      stalledStream.end();

      const bodyIdleStream = client.request({
        ":path": "/body-idle",
        ":authority": "app.localhost",
      });
      const bodyIdleWatcher = watchStream(bodyIdleStream);
      bodyIdleStream.end();

      await waitFor(() => stalledBackpressure && bodyIdleHeadersSent);

      await vi.advanceTimersByTimeAsync(30_001);
      await stalledWatcher.closed;
      expect(stalledWatcher.result().ended).toBe(false);
      expect(stalledWatcher.result().errorCode).toBe("ERR_HTTP2_STREAM_ERROR");
      expect(stalledWatcher.result().rstCode).toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);

      await vi.advanceTimersByTimeAsync(90_001);
      await bodyIdleWatcher.closed;
      expect(bodyIdleWatcher.result().ended).toBe(false);
      expect(bodyIdleWatcher.result().errorCode).toBe("ERR_HTTP2_STREAM_ERROR");
      expect(bodyIdleWatcher.result().rstCode).toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);

      const activeStreams = Array.from({ length: 48 }, (_, index) => {
        const s = client.request({
          ":path": `/hold/${index}`,
          ":authority": "app.localhost",
        });
        s.on("error", () => {});
        s.end();
        return s;
      });
      await waitFor(() => held.length === 48);

      const queuedStream = client.request({
        ":path": "/queued",
        ":authority": "app.localhost",
      });
      const queuedWatcher = watchStream(queuedStream);
      queuedStream.end();
      for (let i = 0; i < 20; i++) await settle();

      server.close();
      await queuedWatcher.closed;
      expect(queuedWatcher.result().ended).toBe(false);
      expect(queuedWatcher.result().errorCode).toBe("ERR_HTTP2_STREAM_ERROR");
      expect(queuedWatcher.result().rstCode).toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);
      for (const s of activeStreams) s.destroy();
    } finally {
      for (const res of held) res.destroy();
      client.destroy();
    }
  }, 30_000);
});

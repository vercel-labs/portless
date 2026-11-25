import * as http from "node:http";
import * as net from "node:net";
import * as nodeTls from "node:tls";
import type { RouteInfo } from "./types.js";
import { createLoopbackConnection, isLoopbackPeer } from "./utils.js";

const MAX_PENDING_DIALS = 8;
const MAX_REQUEST_SOCKETS = 48;
const MAX_REMOTE_PEER_SOCKETS = 16;
const MAX_QUEUED_REQUESTS = 512;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;
const RESPONSE_STALL_TIMEOUT_MS = 30_000;
const UPSTREAM_FIRST_BYTE_TIMEOUT_MS = 120_000;
const UPSTREAM_BODY_IDLE_TIMEOUT_MS = 120_000;
const QUEUE_WAIT_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;

export type UpstreamRejectReason = "queue_timeout" | "queue_full" | "gateway_timeout";

/** Options for dispatching an HTTP request through an upstream pool. */
export interface UpstreamDispatchOptions {
  method?: string;
  path?: string;
  headers: http.OutgoingHttpHeaders;
  freshConnection?: boolean;
  onReject?: (reason: UpstreamRejectReason) => void;
}

type BackendState = "idle" | "dialing" | "atCapacity";
type WaitingDispatch = {
  pool: UpstreamPool;
  socketKey: string;
  freshConnection: boolean;
  peerKey: string | null;
  res: http.ServerResponse;
  waitTimer: ReturnType<typeof setTimeout>;
  cancelWait: () => void;
  start: () => void;
};
type BackendAdmission = {
  port: number;
  activeRequests: number;
  peerActive: Map<string, number>;
  dialing: number;
  longLived: number;
  waiting: WaitingDispatch[];
};

const admissions = new Map<number, BackendAdmission>();

function getAdmission(port: number): BackendAdmission {
  let admission = admissions.get(port);
  if (!admission) {
    admission = {
      port,
      activeRequests: 0,
      peerActive: new Map(),
      dialing: 0,
      longLived: 0,
      waiting: [],
    };
    admissions.set(port, admission);
  }
  return admission;
}

function getAdmissionState(admission: BackendAdmission): BackendState {
  if (admission.activeRequests >= MAX_REQUEST_SOCKETS) return "atCapacity";
  if (admission.dialing >= MAX_PENDING_DIALS) return "dialing";
  return "idle";
}

function peerHasCapacity(admission: BackendAdmission, peerKey: string | null): boolean {
  return peerKey === null || (admission.peerActive.get(peerKey) ?? 0) < MAX_REMOTE_PEER_SOCKETS;
}

function pruneAdmission(admission: BackendAdmission): void {
  if (
    admission.activeRequests === 0 &&
    admission.peerActive.size === 0 &&
    admission.dialing === 0 &&
    admission.longLived === 0 &&
    admission.waiting.length === 0 &&
    admissions.get(admission.port) === admission
  ) {
    admissions.delete(admission.port);
  }
}

function removeWaiter(admission: BackendAdmission, waiting: WaitingDispatch): void {
  clearTimeout(waiting.waitTimer);
  const index = admission.waiting.indexOf(waiting);
  if (index !== -1) admission.waiting.splice(index, 1);
  waiting.res.removeListener("close", waiting.cancelWait);
}

/** Destroy a downstream response with an error so HTTP/2 resets the stream instead of ending it cleanly. */
function abortResponse(res: http.ServerResponse, error: Error): void {
  if (res.destroyed) return;
  res.destroy(error);
}

function rejectError(reason: UpstreamRejectReason): NodeJS.ErrnoException {
  if (reason === "gateway_timeout") {
    return Object.assign(new Error("Gateway Timeout: upstream did not respond in time"), {
      code: "ETIMEDOUT",
    });
  }
  if (reason === "queue_full") {
    return Object.assign(new Error("Service Unavailable: upstream request queue is full"), {
      code: "ECONNABORTED",
    });
  }
  return Object.assign(new Error("Service Unavailable: upstream request queue timed out"), {
    code: "ETIMEDOUT",
  });
}

function closingError(): NodeJS.ErrnoException {
  return Object.assign(new Error("Upstream pool is closing"), { code: "ABORT_ERR" });
}

function sendFallbackReject(res: http.ServerResponse, reason: UpstreamRejectReason): void {
  if (res.destroyed) return;
  if (res.headersSent) {
    abortResponse(res, rejectError(reason));
    return;
  }
  if (reason === "gateway_timeout") {
    res.writeHead(504, { "Content-Type": "text/plain" });
    res.end("Gateway Timeout: upstream did not respond in time\n");
  } else if (reason === "queue_full") {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Service Unavailable: upstream request queue is full\n");
  } else {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Service Unavailable: upstream request queue timed out\n");
  }
}

type DialRef = { cancel?: () => void; onDialError: () => void };
type UpstreamOptions = http.RequestOptions & {
  upstreamRoute: RouteInfo;
  upstreamDial: DialRef;
};

const STREAMING_MEDIA_TYPES = new Set([
  "text/event-stream",
  "application/x-ndjson",
  "application/stream+json",
  "multipart/x-mixed-replace",
]);

function isLongLivedResponse(res: http.IncomingMessage): boolean {
  const mediaType = res.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  return mediaType !== undefined && STREAMING_MEDIA_TYPES.has(mediaType);
}

function remotePeerKey(res: http.ServerResponse): string | null {
  const addr =
    res.socket?.remoteAddress ??
    (res as unknown as { stream?: { session?: { socket?: net.Socket } } }).stream?.session?.socket
      ?.remoteAddress;
  if (!addr || isLoopbackPeer(addr)) return null;
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

/** Manages per-backend upstream pooling, dial pacing, fresh-connection replay, and shutdown. */
export class UpstreamPool {
  private readonly keepAliveAgent = new http.Agent({ keepAlive: true });
  private readonly freshSockets = new Set<net.Socket>();
  private readonly longLivedRequests = new Set<http.ClientRequest>();
  private readonly pendingDials = new Set<() => void>();
  private closing = false;
  private shutdownTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const originalAgentName = this.keepAliveAgent.getName.bind(this.keepAliveAgent);
    this.keepAliveAgent.getName = (options) => {
      const route = (options as UpstreamOptions).upstreamRoute;
      return `${originalAgentName(options)}:${JSON.stringify([!!route?.upstream?.tls, route?.upstream?.host ?? ""])}`;
    };
    this.keepAliveAgent.createConnection = (options, callback) => {
      const { upstreamRoute: route, upstreamDial: dialRef } = options as UpstreamOptions;
      dialRef.cancel = this.dial(
        getAdmission(route.port),
        route,
        false,
        callback!,
        dialRef.onDialError
      );
      return undefined;
    };
    this.keepAliveAgent.on("free", (_socket, options) => {
      const route = (options as UpstreamOptions).upstreamRoute;
      if (route) {
        const admission = admissions.get(route.port);
        if (admission) UpstreamPool.drainAdmission(admission);
      }
    });
  }

  private socketKey(route: RouteInfo): string {
    return this.keepAliveAgent.getName({
      port: route.port,
      upstreamRoute: route,
    } as UpstreamOptions);
  }

  private hasIdleSocket(key: string): boolean {
    return (this.keepAliveAgent.freeSockets[key]?.length ?? 0) > 0;
  }

  private static canDispatchTo(
    admission: BackendAdmission,
    pool: UpstreamPool,
    socketKey: string,
    freshConnection: boolean,
    peerKey: string | null
  ): boolean {
    switch (getAdmissionState(admission)) {
      case "atCapacity":
        return false;
      case "dialing":
        return (
          !freshConnection && pool.hasIdleSocket(socketKey) && peerHasCapacity(admission, peerKey)
        );
      case "idle":
        return peerHasCapacity(admission, peerKey);
    }
  }

  private static drainAdmission(admission: BackendAdmission): void {
    for (let i = 0; i < admission.waiting.length; ) {
      if (getAdmissionState(admission) === "atCapacity") break;
      const item = admission.waiting[i];
      if (item.pool.closing) {
        removeWaiter(admission, item);
        abortResponse(item.res, closingError());
        continue;
      }
      if (
        !UpstreamPool.canDispatchTo(
          admission,
          item.pool,
          item.socketKey,
          item.freshConnection,
          item.peerKey
        )
      ) {
        i++;
        continue;
      }
      removeWaiter(admission, item);
      item.start();
    }
    pruneAdmission(admission);
  }

  /** Open a raw or TLS-wrapped loopback socket to `route` outside the HTTP request pool. */
  connect(
    route: RouteInfo,
    callback: (error: NodeJS.ErrnoException | null, socket: net.Socket) => void
  ): () => void {
    if (this.closing) {
      queueMicrotask(() => {
        callback(
          Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }),
          undefined!
        );
      });
      return () => undefined;
    }
    let settled = false;
    let tlsSocket: nodeTls.TLSSocket | undefined;
    let cancelDial = () => {};
    const timer = setTimeout(() => {
      finish(Object.assign(new Error("Upstream connection timed out"), { code: "ETIMEDOUT" }));
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    const finish = (error: NodeJS.ErrnoException | null, socket?: net.Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.pendingDials.delete(cancel);
      if (error) {
        cancelDial();
        if (tlsSocket) {
          tlsSocket.on("error", () => {});
          tlsSocket.destroy();
        }
      }
      callback(error, socket!);
    };
    const cancel = () => {
      finish(Object.assign(new Error("The operation was aborted"), { code: "ABORT_ERR" }));
    };
    this.pendingDials.add(cancel);
    cancelDial = createLoopbackConnection(route.port, (error, socket) => {
      if (settled) {
        socket?.destroy();
        return;
      }
      if (error || !socket) {
        finish(
          error ?? Object.assign(new Error("Upstream connection failed"), { code: "ECONNRESET" })
        );
        return;
      }
      if (!route.upstream?.tls) {
        finish(null, socket);
        return;
      }
      const authority = route.upstream.host;
      const hostname = authority?.startsWith("[")
        ? authority.slice(1, authority.indexOf("]"))
        : authority?.split(":")[0];
      try {
        tlsSocket = nodeTls.connect({
          socket,
          ...(hostname && !net.isIP(hostname) ? { servername: hostname } : {}),
          ALPNProtocols: ["http/1.1"],
          rejectUnauthorized: false,
        });
        tlsSocket.once("secureConnect", () => finish(null, tlsSocket));
        tlsSocket.once("error", (err) => finish(err));
        tlsSocket.once("close", () =>
          finish(Object.assign(new Error("Upstream TLS handshake closed"), { code: "ECONNRESET" }))
        );
      } catch (err) {
        socket.destroy();
        finish(err as NodeJS.ErrnoException);
      }
    });
    return cancel;
  }

  private dial(
    admission: BackendAdmission,
    route: RouteInfo,
    freshConnection: boolean,
    callback: (error: NodeJS.ErrnoException | null, socket: net.Socket) => void,
    onDialError: () => void
  ): () => void {
    admission.dialing++;
    return this.connect(route, (error, socket) => {
      admission.dialing--;
      if (error) onDialError();
      if (!error && freshConnection) {
        this.freshSockets.add(socket);
        socket.once("close", () => this.freshSockets.delete(socket));
      }
      callback(error, socket);
      UpstreamPool.drainAdmission(admission);
    });
  }

  /** Dispatch an HTTP request to `route`, respecting request capacity and dial pacing. */
  dispatch(
    route: RouteInfo,
    options: UpstreamDispatchOptions,
    res: http.ServerResponse,
    onRequest: (request: http.ClientRequest) => void
  ): void {
    if (res.destroyed) return;
    if (this.closing) {
      abortResponse(res, closingError());
      return;
    }
    const admission = getAdmission(route.port);
    const socketKey = this.socketKey(route);
    const freshConnection = Boolean(options.freshConnection);
    const peerKey = remotePeerKey(res);
    const reject = (reason: UpstreamRejectReason) => {
      if (options.onReject) options.onReject(reason);
      else sendFallbackReject(res, reason);
    };
    const start = () => {
      if (res.destroyed) return;
      if (this.closing) {
        abortResponse(res, closingError());
        return;
      }
      let slotPhase: "active" | "longLived" | "released" = "active";
      let hasResponse = false;
      let requestFinished = false;
      let socketConnected = false;
      let requestClosed = false;
      let responseClosed = false;
      admission.activeRequests++;
      if (peerKey !== null) {
        admission.peerActive.set(peerKey, (admission.peerActive.get(peerKey) ?? 0) + 1);
      }
      let proxyReq: http.ClientRequest;
      let proxyResponse: http.IncomingMessage | undefined;
      let firstByteTimer: ReturnType<typeof setTimeout> | undefined;
      let bodyIdleTimer: ReturnType<typeof setTimeout> | undefined;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const clearFirstByteTimer = () => {
        clearTimeout(firstByteTimer);
        firstByteTimer = undefined;
      };
      const maybeStartFirstByteTimer = () => {
        if (
          hasResponse ||
          slotPhase !== "active" ||
          firstByteTimer !== undefined ||
          !requestFinished ||
          !socketConnected
        ) {
          return;
        }
        firstByteTimer = setTimeout(() => {
          firstByteTimer = undefined;
          reject("gateway_timeout");
          proxyReq.destroy();
          release();
        }, UPSTREAM_FIRST_BYTE_TIMEOUT_MS);
      };
      const clearBodyIdleTimer = () => {
        clearTimeout(bodyIdleTimer);
        bodyIdleTimer = undefined;
        proxyResponse?.removeListener("data", resetBodyIdleTimer);
      };
      const resetBodyIdleTimer = () => {
        clearTimeout(bodyIdleTimer);
        if (slotPhase !== "active") return;
        bodyIdleTimer = setTimeout(() => {
          bodyIdleTimer = undefined;
          proxyReq.destroy();
          abortResponse(
            res,
            Object.assign(new Error("Upstream response body timed out"), { code: "ETIMEDOUT" })
          );
          release();
        }, UPSTREAM_BODY_IDLE_TIMEOUT_MS);
      };
      const clearStallTimer = () => {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      };
      const startStallTimer = () => {
        if (stallTimer !== undefined || slotPhase !== "active") return;
        stallTimer = setTimeout(() => {
          stallTimer = undefined;
          proxyReq.destroy();
          abortResponse(
            res,
            Object.assign(new Error("Downstream response stalled"), { code: "ETIMEDOUT" })
          );
          release();
        }, RESPONSE_STALL_TIMEOUT_MS);
      };
      const detachResponseTimers = () => {
        clearFirstByteTimer();
        clearBodyIdleTimer();
        clearStallTimer();
        proxyResponse?.removeListener("pause", startStallTimer);
        proxyResponse?.removeListener("resume", clearStallTimer);
        proxyResponse?.removeListener("data", resetBodyIdleTimer);
        res.removeListener("drain", clearStallTimer);
      };
      const clientChannel =
        (
          res as unknown as {
            stream?: {
              once?: (event: string, listener: () => void) => void;
              removeListener?: (event: string, listener: () => void) => void;
            };
          }
        ).stream ?? res.socket;
      const onClientAbort = () => {
        dialRef.cancel?.();
        if (!proxyReq.destroyed) proxyReq.destroy();
      };
      const onClientClose = () => {
        if (!res.writableFinished) onClientAbort();
      };
      const releaseActiveSlot = () => {
        admission.activeRequests--;
        if (peerKey !== null) {
          const count = admission.peerActive.get(peerKey)! - 1;
          if (count === 0) admission.peerActive.delete(peerKey);
          else admission.peerActive.set(peerKey, count);
        }
      };
      const release = () => {
        if (slotPhase === "released") return;
        detachResponseTimers();
        this.longLivedRequests.delete(proxyReq);
        const prev = slotPhase;
        slotPhase = "released";
        if (prev === "active") releaseActiveSlot();
        else admission.longLived--;
        res.removeListener("close", onClientClose);
        if (typeof clientChannel?.removeListener === "function") {
          clientChannel.removeListener("close", onClientAbort);
        }
        UpstreamPool.drainAdmission(admission);
      };
      const promoteToLongLived = () => {
        if (slotPhase !== "active") return;
        detachResponseTimers();
        slotPhase = "longLived";
        this.longLivedRequests.add(proxyReq);
        releaseActiveSlot();
        admission.longLived++;
        if (this.closing) proxyReq.destroy();
        else UpstreamPool.drainAdmission(admission);
      };
      const dialRef: DialRef = { onDialError: release };
      const requestOptions = {
        port: route.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      };
      try {
        proxyReq = freshConnection
          ? http.request({
              ...requestOptions,
              createConnection: (_opts, callback) => {
                dialRef.cancel = this.dial(admission, route, true, callback, release);
                return undefined;
              },
            })
          : http.request({
              ...requestOptions,
              agent: this.keepAliveAgent,
              upstreamRoute: route,
              upstreamDial: dialRef,
            } as UpstreamOptions);
      } catch (error) {
        release();
        throw error;
      }
      proxyReq.once("socket", () => {
        socketConnected = true;
        maybeStartFirstByteTimer();
      });
      proxyReq.once("finish", () => {
        requestFinished = true;
        maybeStartFirstByteTimer();
      });
      proxyReq.once("response", (proxyRes) => {
        hasResponse = true;
        proxyResponse = proxyRes;
        clearFirstByteTimer();
        if (isLongLivedResponse(proxyRes)) {
          promoteToLongLived();
        } else {
          resetBodyIdleTimer();
          proxyRes.once("end", detachResponseTimers);
          queueMicrotask(() => {
            if (slotPhase !== "active" || proxyRes.complete || proxyRes.destroyed) return;
            proxyRes.on("data", resetBodyIdleTimer);
            proxyRes.on("pause", startStallTimer);
            proxyRes.on("resume", clearStallTimer);
            res.on("drain", clearStallTimer);
            if (proxyRes.isPaused() || res.writableNeedDrain) startStallTimer();
          });
        }
        proxyRes.once("close", () => {
          responseClosed = true;
          if (requestClosed) release();
        });
      });
      proxyReq.once("error", release);
      proxyReq.once("close", () => {
        requestClosed = true;
        dialRef.cancel?.();
        if (!hasResponse || responseClosed) release();
      });
      res.once("close", onClientClose);
      if (typeof clientChannel?.once === "function") {
        clientChannel.once("close", onClientAbort);
      }
      onRequest(proxyReq);
    };
    if (UpstreamPool.canDispatchTo(admission, this, socketKey, freshConnection, peerKey)) {
      start();
      pruneAdmission(admission);
      return;
    }
    if (admission.waiting.length >= MAX_QUEUED_REQUESTS) {
      reject("queue_full");
      pruneAdmission(admission);
      return;
    }
    const cancelWait = () => {
      removeWaiter(admission, waiting);
      pruneAdmission(admission);
    };
    const waiting: WaitingDispatch = {
      pool: this,
      socketKey,
      freshConnection,
      peerKey,
      res,
      cancelWait,
      start,
      waitTimer: setTimeout(() => {
        removeWaiter(admission, waiting);
        pruneAdmission(admission);
        reject("queue_timeout");
      }, QUEUE_WAIT_TIMEOUT_MS),
    };
    admission.waiting.push(waiting);
    res.once("close", cancelWait);
  }

  /** Stop dispatching new requests and cancel pending dials while in-flight sockets finish. */
  close(): void {
    this.closing = true;
    for (const admission of admissions.values()) {
      for (const item of [...admission.waiting]) {
        if (item.pool !== this) continue;
        removeWaiter(admission, item);
        abortResponse(item.res, closingError());
      }
      pruneAdmission(admission);
    }
    for (const cancel of [...this.pendingDials]) cancel();
    for (const sockets of Object.values(this.keepAliveAgent.freeSockets)) {
      for (const socket of sockets ?? []) socket.destroy();
    }
    for (const req of this.longLivedRequests) req.destroy();
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = undefined;
    if (
      this.freshSockets.size > 0 ||
      Object.values(this.keepAliveAgent.sockets).some((sockets) => (sockets?.length ?? 0) > 0)
    ) {
      this.shutdownTimer = setTimeout(() => {
        this.shutdownTimer = undefined;
        this.destroy();
      }, SHUTDOWN_GRACE_MS);
      this.shutdownTimer.unref?.();
    }
  }

  /** Stop all work and destroy every pooled, fresh, and pending upstream socket. */
  destroy(): void {
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = undefined;
    this.close();
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = undefined;
    this.keepAliveAgent.destroy();
    for (const socket of this.freshSockets) socket.destroy();
    this.freshSockets.clear();
    for (const req of this.longLivedRequests) req.destroy();
    this.longLivedRequests.clear();
  }

  /** Re-enable dispatching when a closed proxy server listens again. */
  reopen(): void {
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = undefined;
    this.closing = false;
  }
}

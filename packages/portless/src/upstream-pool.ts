import * as http from "node:http";
import * as net from "node:net";
import * as nodeTls from "node:tls";
import type { RouteInfo } from "./types.js";
import { createLoopbackConnection } from "./utils.js";

const MAX_PENDING_DIALS = 8;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

/** Options for dispatching an HTTP request through an upstream pool. */
export interface UpstreamDispatchOptions {
  method?: string;
  path?: string;
  headers: http.OutgoingHttpHeaders;
  freshConnection?: boolean;
}

type BackendState = "idle" | "dialing";
type WaitingDispatch = {
  freshConnection: boolean;
  res: http.ServerResponse;
  cancelWait: () => void;
  start: () => void;
};
type BackendEntry = { key: string; dialing: number; waiting: WaitingDispatch[] };
type DialRef = { cancel?: () => void };
type UpstreamOptions = http.RequestOptions & {
  upstreamRoute: RouteInfo;
  upstreamDial: DialRef;
};

/** Manages per-backend upstream pooling, dial pacing, fresh-connection replay, and shutdown. */
export class UpstreamPool {
  private readonly keepAliveAgent = new http.Agent({ keepAlive: true });
  private readonly freshSockets = new Set<net.Socket>();
  private readonly pendingDials = new Set<() => void>();
  private readonly backends = new Map<string, BackendEntry>();
  private closing = false;

  constructor() {
    const originalAgentName = this.keepAliveAgent.getName.bind(this.keepAliveAgent);
    this.keepAliveAgent.getName = (options) => {
      const route = (options as UpstreamOptions).upstreamRoute;
      return `${originalAgentName(options)}:${JSON.stringify([!!route?.upstream?.tls, route?.upstream?.host ?? ""])}`;
    };
    this.keepAliveAgent.createConnection = (options, callback) => {
      const { upstreamRoute: route, upstreamDial: dialRef } = options as UpstreamOptions;
      dialRef.cancel = this.dial(this.getBackend(route), route, false, callback!);
      return undefined;
    };
  }

  private getBackend(route: RouteInfo): BackendEntry {
    const key = this.keepAliveAgent.getName({ port: route.port, upstreamRoute: route } as UpstreamOptions);
    let entry = this.backends.get(key);
    if (!entry) {
      entry = { key, dialing: 0, waiting: [] };
      this.backends.set(key, entry);
    }
    return entry;
  }

  private getBackendState(entry: BackendEntry): BackendState {
    return entry.dialing >= MAX_PENDING_DIALS ? "dialing" : "idle";
  }

  private hasIdleSocket(key: string): boolean {
    return (this.keepAliveAgent.freeSockets[key]?.length ?? 0) > 0;
  }

  private canDispatch(entry: BackendEntry, freshConnection: boolean): boolean {
    switch (this.getBackendState(entry)) {
      case "dialing":
        return !freshConnection && this.hasIdleSocket(entry.key);
      case "idle":
        return true;
    }
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
        finish(error ?? Object.assign(new Error("Upstream connection failed"), { code: "ECONNRESET" }));
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
    entry: BackendEntry,
    route: RouteInfo,
    freshConnection: boolean,
    callback: (error: NodeJS.ErrnoException | null, socket: net.Socket) => void
  ): () => void {
    entry.dialing++;
    return this.connect(route, (error, socket) => {
      entry.dialing--;
      if (!error && freshConnection) {
        this.freshSockets.add(socket);
        socket.once("close", () => this.freshSockets.delete(socket));
      }
      callback(error, socket);
      if (this.closing) this.prune(entry);
      else this.drain(entry);
    });
  }

  /** Dispatch an HTTP request to `route`, queueing when dial slots are saturated. */
  dispatch(
    route: RouteInfo,
    options: UpstreamDispatchOptions,
    res: http.ServerResponse,
    onRequest: (request: http.ClientRequest) => void
  ): void {
    if (res.destroyed) return;
    if (this.closing) {
      res.destroy();
      return;
    }
    const entry = this.getBackend(route);
    const freshConnection = Boolean(options.freshConnection);
    const start = () => {
      if (res.destroyed) return;
      if (this.closing) {
        res.destroy();
        return;
      }
      const dialRef: DialRef = {};
      const requestOptions = {
        port: route.port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      };
      const proxyReq = freshConnection
        ? http.request({
            ...requestOptions,
            createConnection: (_opts, callback) => {
              dialRef.cancel = this.dial(entry, route, true, callback);
              return undefined;
            },
          })
        : http.request({
            ...requestOptions,
            agent: this.keepAliveAgent,
            upstreamRoute: route,
            upstreamDial: dialRef,
          } as UpstreamOptions);
      const onClientClose = () => {
        dialRef.cancel?.();
        if (!proxyReq.destroyed) proxyReq.destroy();
      };
      const detach = () => res.removeListener("close", onClientClose);
      const onProxyClose = () => {
        dialRef.cancel?.();
        detach();
      };
      res.once("close", onClientClose);
      proxyReq.once("error", detach);
      proxyReq.once("close", onProxyClose);
      onRequest(proxyReq);
    };
    if (this.canDispatch(entry, freshConnection)) {
      start();
      this.prune(entry);
      return;
    }
    const cancelWait = () => {
      const index = entry.waiting.indexOf(waiting);
      if (index !== -1) entry.waiting.splice(index, 1);
      this.prune(entry);
    };
    const waiting: WaitingDispatch = { freshConnection, res, cancelWait, start };
    entry.waiting.push(waiting);
    res.once("close", cancelWait);
  }

  private drain(entry: BackendEntry): void {
    if (this.closing) return;
    for (let i = 0; i < entry.waiting.length;) {
      const item = entry.waiting[i];
      if (!this.canDispatch(entry, item.freshConnection)) {
        i++;
        continue;
      }
      entry.waiting.splice(i, 1);
      item.res.removeListener("close", item.cancelWait);
      item.start();
    }
    this.prune(entry);
  }

  private prune(entry: BackendEntry): void {
    if (entry.dialing === 0 && entry.waiting.length === 0 && this.backends.get(entry.key) === entry) {
      this.backends.delete(entry.key);
    }
  }

  /** Stop dispatching new requests and cancel pending dials while in-flight sockets finish. */
  close(): void {
    this.closing = true;
    for (const entry of this.backends.values()) {
      for (const item of entry.waiting.splice(0)) {
        item.res.removeListener("close", item.cancelWait);
        item.res.destroy();
      }
      this.prune(entry);
    }
    for (const cancel of [...this.pendingDials]) cancel();
  }

  /** Stop all work and destroy every pooled, fresh, and pending upstream socket. */
  destroy(): void {
    this.close();
    this.keepAliveAgent.destroy();
    for (const socket of this.freshSockets) socket.destroy();
    this.freshSockets.clear();
  }

  /** Re-enable dispatching when a closed proxy server listens again. */
  reopen(): void {
    this.closing = false;
  }
}

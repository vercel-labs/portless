import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import type { ProxyServerOptions, RouteInfo } from "./types.js";
import { escapeHtml, formatUrl } from "./utils.js";
import { ARROW_SVG, renderPage } from "./pages.js";

/** Response header used to identify a portless proxy (for health checks). */
export const PORTLESS_HEADER = "X-Portless";

/**
 * HTTP/1.1 hop-by-hop headers that are forbidden in HTTP/2 responses.
 * These must be stripped when proxying an HTTP/1.1 backend response
 * back to an HTTP/2 client.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers that must not be forwarded to an HTTP/2 upstream. "host" is
 * replaced by the :authority pseudo-header and the hop-by-hop headers
 * are illegal in HTTP/2 framing.
 */
const H2_FORBIDDEN_UPSTREAM_HEADERS = new Set([...HOP_BY_HOP_HEADERS, "host"]);

/**
 * Get the effective host value from a request.
 * HTTP/2 uses the :authority pseudo-header; HTTP/1.1 uses Host.
 */
function getRequestHost(req: http.IncomingMessage): string {
  // HTTP/2 :authority pseudo-header (available via compatibility API)
  const authority = req.headers[":authority"];
  if (typeof authority === "string" && authority) return authority;
  return req.headers.host || "";
}

/**
 * Detect whether a request arrived over an encrypted (TLS) connection.
 * Works for both native TLS sockets and HTTP/2 streams.
 */
function isEncrypted(req: http.IncomingMessage): boolean {
  return !!(req.socket as net.Socket & { encrypted?: boolean }).encrypted;
}

/**
 * Build X-Forwarded-* headers for a proxied request.
 */
function buildForwardedHeaders(req: http.IncomingMessage, tls: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const remoteAddress = req.socket.remoteAddress || "127.0.0.1";
  const proto = tls ? "https" : "http";
  const defaultPort = tls ? "443" : "80";
  const hostHeader = getRequestHost(req);

  headers["x-forwarded-for"] = req.headers["x-forwarded-for"]
    ? `${req.headers["x-forwarded-for"]}, ${remoteAddress}`
    : remoteAddress;
  headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string) || proto;
  headers["x-forwarded-host"] = (req.headers["x-forwarded-host"] as string) || hostHeader;
  headers["x-forwarded-port"] =
    (req.headers["x-forwarded-port"] as string) || hostHeader.split(":")[1] || defaultPort;

  return headers;
}

/**
 * Request header tracking how many times a request has passed through a
 * portless proxy. Used to detect forwarding loops (e.g. a frontend dev
 * server proxying back through portless without rewriting the Host header).
 */
const PORTLESS_HOPS_HEADER = "x-portless-hops";

/**
 * Maximum number of times a request may pass through the portless proxy
 * before it is rejected as a loop. Two hops is normal when a frontend
 * proxies API calls to a separate portless-managed backend; five gives
 * comfortable headroom for multi-tier setups while catching loops quickly.
 */
const MAX_PROXY_HOPS = 5;

/**
 * Find the route matching a given host. Matches exact hostname first, then
 * falls back to wildcard subdomain matching (e.g. tenant.myapp.localhost
 * matches a route registered for myapp.localhost).
 *
 * When `strict` is true, only exact matches are returned; unregistered
 * subdomain prefixes will not fall back to the base service.
 */
function findRoute(routes: RouteInfo[], host: string, strict?: boolean): RouteInfo | undefined {
  return (
    routes.find((r) => r.hostname === host) ||
    (strict ? undefined : routes.find((r) => host.endsWith("." + r.hostname)))
  );
}

/**
 * Cache of h2c (cleartext HTTP/2) client sessions, keyed by "host:port".
 * HTTP/2 multiplexes many streams over one connection, so we want to
 * reuse the session for as long as the backend keeps it alive.
 *
 * The cache is module-scoped because proxy instances are long-lived and
 * there's no meaningful per-instance isolation to protect.
 */
const h2cSessions = new Map<string, http2.ClientHttp2Session>();

function getH2cSession(
  host: string,
  port: number,
  onError: (message: string) => void
): http2.ClientHttp2Session {
  const key = `${host}:${port}`;
  const existing = h2cSessions.get(key);
  if (existing && !existing.closed && !existing.destroyed) {
    return existing;
  }

  const session = http2.connect(`http://${host}:${port}`);
  session.on("error", (err) => {
    onError(`h2c session error to ${key}: ${err.message}`);
    h2cSessions.delete(key);
  });
  session.on("close", () => {
    if (h2cSessions.get(key) === session) h2cSessions.delete(key);
  });
  // Silently absorb session-level GOAWAY etc. so we can reconnect on the next request.
  session.on("goaway", () => {
    if (h2cSessions.get(key) === session) h2cSessions.delete(key);
  });
  h2cSessions.set(key, session);
  return session;
}

/**
 * Proxy a request to an h2c (HTTP/2 cleartext) backend. Required for
 * gRPC and any backend that only speaks HTTP/2 on its non-TLS listener.
 *
 * Preserves bidirectional streaming, trailers (grpc-status/grpc-message),
 * and backpressure, which are all essential for gRPC to work end-to-end.
 */
function proxyH2c(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  route: RouteInfo,
  forwardedHeaders: Record<string, string>,
  hops: number,
  onError: (message: string) => void
): void {
  const session = getH2cSession("127.0.0.1", route.port, onError);

  // Build HTTP/2 request headers: pseudo-headers + regular headers.
  const h2Headers: http2.OutgoingHttpHeaders = {
    ":method": req.method || "GET",
    ":path": req.url || "/",
    ":scheme": "http",
    ":authority": `${route.hostname}:${route.port}`,
  };

  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower.startsWith(":")) continue;
    if (H2_FORBIDDEN_UPSTREAM_HEADERS.has(lower)) continue;
    h2Headers[lower] = value;
  }
  for (const [key, value] of Object.entries(forwardedHeaders)) {
    h2Headers[key] = value;
  }
  h2Headers[PORTLESS_HOPS_HEADER] = String(hops + 1);

  const stream = session.request(h2Headers, { endStream: false });

  // Trailers arrive as a separate event after the body; buffer them so we
  // can call res.addTrailers() before res.end(). Required for gRPC, which
  // carries grpc-status/grpc-message in trailers.
  let pendingTrailers: Record<string, string | string[]> | undefined;
  let pendingResponseHeaders: http2.IncomingHttpHeaders | undefined;
  let headersWritten = false;

  // Extract the downstream HTTP/2 server stream (only present when the
  // client connection is HTTP/2). We need it to emit a "trailers-only"
  // response — a single HEADERS frame with END_STREAM — which some gRPC
  // clients require when grpc-status is carried in initial response
  // headers rather than trailers. Node's res.writeHead() + res.end() with
  // no body sends HEADERS then empty DATA+END_STREAM (two frames), which
  // violates the gRPC trailers-only wire form.
  const downstreamStream = (res as unknown as { stream?: http2.ServerHttp2Stream }).stream;

  function copyBackendHeaders(source: http2.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const out: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith(":")) continue;
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      if (value === undefined) continue;
      out[key] = value as string | string[];
    }
    return out;
  }

  function flushResponseHeaders(status: number): void {
    if (headersWritten || !pendingResponseHeaders) return;
    headersWritten = true;
    const outHeaders = copyBackendHeaders(pendingResponseHeaders);
    res.writeHead(status, outHeaders);
  }

  stream.on("response", (responseHeaders) => {
    pendingResponseHeaders = responseHeaders;
    // Deliberately do NOT write headers here: we need to see whether the
    // backend sends any DATA before END_STREAM so we can distinguish a
    // trailers-only response from a normal one.
  });

  stream.on("trailers", (trailers) => {
    const trailerPairs: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(trailers)) {
      if (key.startsWith(":")) continue;
      if (value === undefined) continue;
      trailerPairs[key] = value as string | string[];
    }
    if (Object.keys(trailerPairs).length > 0) {
      pendingTrailers = trailerPairs;
    }
  });

  stream.on("data", (chunk: Buffer) => {
    if (!headersWritten && pendingResponseHeaders) {
      const status =
        typeof pendingResponseHeaders[":status"] === "number"
          ? (pendingResponseHeaders[":status"] as number)
          : 502;
      flushResponseHeaders(status);
    }
    const keepGoing = res.write(chunk);
    if (!keepGoing) {
      stream.pause();
      res.once("drain", () => stream.resume());
    }
  });

  stream.on("end", () => {
    // Trailers-only response: backend sent HEADERS+END_STREAM with no body.
    // Forward as a single HEADERS frame with END_STREAM to preserve gRPC
    // semantics when grpc-status is carried inline in the headers.
    if (!headersWritten && pendingResponseHeaders && downstreamStream) {
      headersWritten = true;
      const outHeaders: http2.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(pendingResponseHeaders)) {
        if (key === ":status") {
          outHeaders[":status"] = value as unknown as number;
          continue;
        }
        if (key.startsWith(":")) continue;
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        if (value === undefined) continue;
        outHeaders[key] = value as string | string[];
      }
      try {
        downstreamStream.respond(outHeaders, { endStream: true });
      } catch {
        // Stream may have been destroyed already; best-effort.
      }
      return;
    }

    if (!headersWritten && pendingResponseHeaders) {
      const status =
        typeof pendingResponseHeaders[":status"] === "number"
          ? (pendingResponseHeaders[":status"] as number)
          : 502;
      flushResponseHeaders(status);
    }

    if (pendingTrailers) {
      try {
        res.addTrailers(pendingTrailers);
      } catch {
        // Trailers are best-effort; HTTP/1.1 clients may not support them.
      }
    }
    res.end();
  });

  stream.on("error", (err) => {
    onError(`h2c stream error for ${getRequestHost(req)}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("h2c upstream error");
    } else {
      res.destroy();
    }
  });

  req.on("error", () => {
    if (!stream.destroyed) stream.destroy();
  });

  res.on("close", () => {
    if (!stream.destroyed) stream.destroy();
  });

  req.pipe(stream);
}

/** Server type returned by createProxyServer (plain HTTP/1.1 or net.Server TLS wrapper). */
export type ProxyServer = http.Server | net.Server;

/**
 * Create an HTTP proxy server that routes requests based on the Host header.
 *
 * Uses Node's built-in http module for proxying (no external dependencies).
 * The `getRoutes` callback is invoked on every request so callers can provide
 * either a static list or a live-updating one.
 *
 * When `tls` is provided, creates an HTTP/2 secure server with HTTP/1.1
 * fallback (`allowHTTP1: true`). This enables HTTP/2 multiplexing for
 * browsers while keeping WebSocket upgrades working over HTTP/1.1.
 */
export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  const {
    getRoutes,
    proxyPort,
    tld = "localhost",
    strict = true,
    onError = (msg: string) => console.error(msg),
    tls,
  } = options;
  const tldSuffix = `.${tld}`;

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const reqTls = isEncrypted(req);
    res.setHeader(PORTLESS_HEADER, "1");

    const routes = getRoutes();
    const host = getRequestHost(req).split(":")[0];

    if (!host) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing Host header");
      return;
    }

    const hops = parseInt(req.headers[PORTLESS_HOPS_HEADER] as string, 10) || 0;
    if (hops >= MAX_PROXY_HOPS) {
      onError(
        `Loop detected for ${host}: request has passed through portless ${hops} times. ` +
          `This usually means a backend is proxying back through portless without rewriting ` +
          `the Host header. If you use Vite/webpack proxy, set changeOrigin: true.`
      );
      res.writeHead(508, { "Content-Type": "text/html" });
      res.end(
        renderPage(
          508,
          "Loop Detected",
          `<div class="content"><p class="desc">This request has passed through portless ${hops} times. This usually means a dev server (Vite, webpack, etc.) is proxying requests back through portless without rewriting the Host header.</p><div class="section"><p class="label">Fix: add changeOrigin to your proxy config</p><pre class="terminal">proxy: {
  "/api": {
    target: "${reqTls ? "https" : "http"}://&lt;backend&gt;${escapeHtml(tldSuffix)}${reqTls ? "" : ":&lt;port&gt;"}",
    changeOrigin: true,
  },
}</pre></div></div>`
        )
      );
      return;
    }

    const route = findRoute(routes, host, strict);

    if (!route) {
      const safeHost = escapeHtml(host);
      const strippedHost = host.endsWith(tldSuffix) ? host.slice(0, -tldSuffix.length) : host;
      const safeSuggestion = escapeHtml(strippedHost);
      const routesList =
        routes.length > 0
          ? `<div class="section"><p class="label">Active apps</p><ul class="card">${routes.map((r) => `<li><a href="${escapeHtml(formatUrl(r.hostname, proxyPort, reqTls))}" class="card-link"><span class="name">${escapeHtml(r.hostname)}</span><span class="meta"><code class="port">127.0.0.1:${escapeHtml(String(r.port))}</code><span class="arrow">${ARROW_SVG}</span></span></a></li>`).join("")}</ul></div>`
          : '<p class="empty">No apps running.</p>';
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(
        renderPage(
          404,
          "Not Found",
          `<div class="content"><p class="desc">No app registered for <strong>${safeHost}</strong></p>${routesList}<div class="section"><div class="terminal"><span class="prompt">$ </span>portless ${safeSuggestion} your-command</div></div></div>`
        )
      );
      return;
    }

    const forwardedHeaders = buildForwardedHeaders(req, reqTls);

    if (route.protocol === "h2c") {
      proxyH2c(req, res, route, forwardedHeaders, hops, onError);
      return;
    }

    const proxyReqHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      proxyReqHeaders[key] = value;
    }
    proxyReqHeaders[PORTLESS_HOPS_HEADER] = String(hops + 1);
    // Remove HTTP/2 pseudo-headers before forwarding to HTTP/1.1 backend
    for (const key of Object.keys(proxyReqHeaders)) {
      if (key.startsWith(":")) {
        delete proxyReqHeaders[key];
      }
    }

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: route.port,
        path: req.url,
        method: req.method,
        headers: proxyReqHeaders,
      },
      (proxyRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };
        if (reqTls) {
          for (const h of HOP_BY_HOP_HEADERS) {
            delete responseHeaders[h];
          }
        }
        res.writeHead(proxyRes.statusCode || 502, responseHeaders);
        proxyRes.on("error", () => {
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end();
          } else {
            // Headers already sent (mid-stream): destroy instead of end to
            // send RST_STREAM. Calling res.end() here can cause a
            // content-length mismatch that Chrome treats as a session error.
            res.destroy();
          }
        });
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      onError(`Proxy error for ${getRequestHost(req)}: ${err.message}`);
      if (!res.headersSent) {
        const errWithCode = err as NodeJS.ErrnoException;
        const detail =
          errWithCode.code === "ECONNREFUSED"
            ? "The target app is not responding. It may have crashed."
            : "The target app may not be running.";
        res.writeHead(502, { "Content-Type": "text/html" });
        res.end(
          renderPage(
            502,
            "Bad Gateway",
            `<div class="content"><p class="desc">${escapeHtml(detail)}</p></div>`
          )
        );
      }
    });

    // Abort the outgoing request if the client disconnects
    res.on("close", () => {
      if (!proxyReq.destroyed) {
        proxyReq.destroy();
      }
    });

    req.on("error", () => {
      if (!proxyReq.destroyed) {
        proxyReq.destroy();
      }
    });

    req.pipe(proxyReq);
  };

  const handleUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());

    const hops = parseInt(req.headers[PORTLESS_HOPS_HEADER] as string, 10) || 0;
    if (hops >= MAX_PROXY_HOPS) {
      const host = getRequestHost(req).split(":")[0];
      onError(
        `WebSocket loop detected for ${host}: request has passed through portless ${hops} times. ` +
          `Set changeOrigin: true in your proxy config.`
      );
      socket.end(
        "HTTP/1.1 508 Loop Detected\r\n" +
          "Content-Type: text/plain\r\n" +
          "\r\n" +
          "Loop Detected: request has passed through portless too many times.\n" +
          "Add changeOrigin: true to your dev server proxy config.\n"
      );
      return;
    }

    const routes = getRoutes();
    const host = getRequestHost(req).split(":")[0];
    const route = findRoute(routes, host, strict);

    if (!route) {
      socket.destroy();
      return;
    }

    const forwardedHeaders = buildForwardedHeaders(req, isEncrypted(req));
    const proxyReqHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      proxyReqHeaders[key] = value;
    }
    proxyReqHeaders[PORTLESS_HOPS_HEADER] = String(hops + 1);
    // Remove HTTP/2 pseudo-headers before forwarding to HTTP/1.1 backend
    for (const key of Object.keys(proxyReqHeaders)) {
      if (key.startsWith(":")) {
        delete proxyReqHeaders[key];
      }
    }

    const proxyReq = http.request({
      hostname: "127.0.0.1",
      port: route.port,
      path: req.url,
      method: req.method,
      headers: proxyReqHeaders,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      // Forward the backend's actual 101 response including Sec-WebSocket-Accept,
      // subprotocol negotiation, and extension headers.
      let response = `HTTP/1.1 101 Switching Protocols\r\n`;
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        response += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
      }
      response += "\r\n";
      socket.write(response);

      if (proxyHead.length > 0) {
        socket.write(proxyHead);
      }
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);

      // Tear down both sockets when either side disconnects. destroy() is
      // idempotent, so duplicate calls from multiple events are harmless.
      const cleanup = () => {
        proxySocket.destroy();
        socket.destroy();
      };
      proxySocket.on("error", cleanup);
      socket.on("error", cleanup);
      proxySocket.on("close", cleanup);
      socket.on("close", cleanup);
      proxySocket.on("end", cleanup);
      socket.on("end", cleanup);
    });

    proxyReq.on("error", (err) => {
      onError(`WebSocket proxy error for ${getRequestHost(req)}: ${err.message}`);
      socket.destroy();
    });

    proxyReq.on("response", (res) => {
      // The backend responded with a normal HTTP response instead of upgrading.
      // Forward the rejection to the client.
      if (!socket.destroyed) {
        let response = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          response += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
        }
        response += "\r\n";
        socket.write(response);
        res.on("error", () => socket.destroy());
        res.pipe(socket);
      }
    });

    if (head.length > 0) {
      proxyReq.write(head);
    }
    proxyReq.end();
  };

  if (tls) {
    const h2Server = http2.createSecureServer({
      cert: tls.ca ? Buffer.concat([tls.cert, tls.ca]) : tls.cert,
      key: tls.key,
      allowHTTP1: true,
      // Tolerate high rates of RST_STREAM from browsers during HMR and
      // page navigations. Without this, Node sends GOAWAY INTERNAL_ERROR
      // after ~1000 cumulative stream resets and kills the session,
      // surfacing as ERR_HTTP2_PROTOCOL_ERROR in Chrome. Available in
      // Node 22.11+; silently ignored on older versions.
      ...({ streamResetBurst: 10000, streamResetRate: 100 } as Record<string, unknown>),
      ...(tls.SNICallback ? { SNICallback: tls.SNICallback } : {}),
    });

    // Absorb session-level errors (connection resets, protocol errors from
    // abrupt client disconnects) so they don't crash the proxy.
    h2Server.on("sessionError", () => {});

    // With allowHTTP1, the 'request' event receives objects compatible with
    // http.IncomingMessage / http.ServerResponse. Cast explicitly to satisfy TypeScript.
    h2Server.on("request", (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
      // Absorb RST_STREAM errors from cancelled requests (browser navigation,
      // HMR) so they don't propagate to the HTTP/2 session.
      req.stream?.on("error", () => {});
      handleRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
    });
    // WebSocket upgrades arrive over HTTP/1.1 connections (allowHTTP1)
    h2Server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      handleUpgrade(req, socket, head);
    });

    // Plain HTTP on a TLS-enabled port -> 302 redirect to HTTPS.
    // The redirect targets the same port because the wrapper net.Server
    // demuxes TLS and plain HTTP on a single listener (peek at first byte).
    const plainServer = http.createServer((req, res) => {
      const host = getRequestHost(req).split(":")[0] || "localhost";
      const location = `https://${host}${proxyPort === 443 ? "" : `:${proxyPort}`}${req.url || "/"}`;
      res.writeHead(302, { Location: location, [PORTLESS_HEADER]: "1" });
      res.end();
    });
    plainServer.on("upgrade", (req: http.IncomingMessage, socket: net.Socket) => {
      const host = getRequestHost(req);
      console.warn(
        `[portless] Dropped plain-HTTP WebSocket upgrade for ${host}; use wss:// instead`
      );
      socket.destroy();
    });

    // Wrap both in a net.Server that peeks at the first byte to decide
    // whether the connection is TLS (0x16 = ClientHello) or plain HTTP.
    const wrapper = net.createServer((socket) => {
      // Absorb connection errors (ECONNRESET, EPIPE, etc.) from abrupt
      // client disconnects (tab close, page reload, HMR) so they don't
      // bubble up as uncaught exceptions and crash the proxy (#111).
      socket.on("error", () => {
        socket.destroy();
      });
      socket.once("readable", () => {
        const buf: Buffer | null = socket.read(1);
        if (!buf) {
          socket.destroy();
          return;
        }
        socket.unshift(buf);
        if (buf[0] === 0x16) {
          // TLS handshake -> HTTP/2 secure server
          h2Server.emit("connection", socket);
        } else {
          // Plain HTTP -> redirect to HTTPS
          plainServer.emit("connection", socket);
        }
      });
    });

    // Proxy close() through to inner servers so tests and cleanup work.
    const origClose = wrapper.close.bind(wrapper);
    wrapper.close = function (cb?: (err?: Error) => void) {
      h2Server.close();
      plainServer.close();
      return origClose(cb);
    } as typeof wrapper.close;

    return wrapper;
  }

  const httpServer = http.createServer(handleRequest);
  httpServer.on("upgrade", handleUpgrade);

  return httpServer;
}

/**
 * Create a minimal HTTP server that 302-redirects every request to HTTPS.
 * Meant to run on port 80 alongside an HTTPS proxy on port 443.
 */
export function createHttpRedirectServer(httpsPort: number): http.Server {
  return http.createServer((req, res) => {
    const host = (req.headers.host || "localhost").split(":")[0];
    const portSuffix = httpsPort === 443 ? "" : `:${httpsPort}`;
    const location = `https://${host}${portSuffix}${req.url || "/"}`;
    res.writeHead(302, { Location: location, [PORTLESS_HEADER]: "1" });
    res.end();
  });
}

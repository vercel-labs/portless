import * as crypto from "node:crypto";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import type { ProxyServerOptions } from "./types.js";
import { createLoopbackConnection, escapeHtml, formatUrl } from "./utils.js";
import { ARROW_SVG, renderPage } from "./pages.js";

/** Response header used to identify a portless proxy (for health checks). */
export const PORTLESS_HEADER = "X-Portless";

/**
 * RFC 6455 magic GUID: a compliant WebSocket backend answers an upgrade with
 * Sec-WebSocket-Accept = base64(sha1(Sec-WebSocket-Key + WS_GUID)).
 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

/** Authority (hostname, plus port when non-default) of a route's tailscaleUrl, or undefined if unset or invalid. */
function tailscaleAuthority(tailscaleUrl: string | undefined): string | undefined {
  if (!tailscaleUrl) return undefined;
  try {
    // `URL` lowercases the host and drops the default `:443`, so the value is
    // already in the normalized form findRoute compares against.
    return new URL(tailscaleUrl).host;
  } catch {
    return undefined;
  }
}

/**
 * Normalize a request authority for comparison: lowercase it (Host is
 * case-insensitive) and drop an explicit `:443`, the default HTTPS port that
 * `URL` strips from a route's stored tailscale authority. Without this a
 * mixed-case Host never matches, and an explicit `dev.ts.net:443` misses the
 * authority tier and falls through to the port-insensitive hostname tier,
 * resolving to the wrong app when several routes share a `.ts.net` hostname on
 * different ports.
 */
function normalizeAuthority(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(":443") ? lower.slice(0, -":443".length) : lower;
}

/**
 * Find the route matching a request's host, which may include a port. Match
 * order: local hostname, tailscale authority (hostname and port), tailscale
 * hostname ignoring port, then wildcard subdomain. The authority tier
 * disambiguates apps sharing a `.ts.net` hostname on different ports; the
 * hostname tier keeps other-port requests resolving. `strict` drops the wildcard.
 * All comparisons run against the normalized authority so they are
 * case-insensitive and treat an explicit `:443` as the default HTTPS port.
 */
function findRoute(
  routes: { hostname: string; port: number; tailscaleUrl?: string }[],
  host: string,
  strict?: boolean
): { hostname: string; port: number } | undefined {
  const authority = normalizeAuthority(host);
  const hostname = authority.split(":")[0];
  return (
    routes.find((r) => r.hostname.toLowerCase() === hostname) ||
    routes.find((r) => tailscaleAuthority(r.tailscaleUrl) === authority) ||
    routes.find((r) => tailscaleAuthority(r.tailscaleUrl)?.split(":")[0] === hostname) ||
    (strict ? undefined : routes.find((r) => hostname.endsWith("." + r.hostname.toLowerCase())))
  );
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
 * browsers. WebSockets work over both protocol versions: HTTP/1.1 Upgrade
 * requests are forwarded as-is, and HTTP/2 extended CONNECT (RFC 8441) is
 * bridged to an HTTP/1.1 handshake against the backend.
 */
export function createProxyServer(options: ProxyServerOptions): ProxyServer {
  const {
    getRoutes,
    proxyPort,
    tld = "localhost",
    tlds = [tld],
    strict = true,
    onError = (msg: string) => console.error(msg),
    tls,
  } = options;
  const tldSuffixes = [...new Set(tlds.length > 0 ? tlds : [tld])].map((value) => `.${value}`);
  const primaryTldSuffix = tldSuffixes[0] ?? ".localhost";

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const reqTls = isEncrypted(req);
    res.setHeader(PORTLESS_HEADER, "1");

    const routes = getRoutes();
    const rawHost = getRequestHost(req);
    const host = rawHost.split(":")[0];

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
    target: "${reqTls ? "https" : "http"}://&lt;backend&gt;${escapeHtml(primaryTldSuffix)}${reqTls ? "" : ":&lt;port&gt;"}",
    changeOrigin: true,
  },
}</pre></div></div>`
        )
      );
      return;
    }

    const route = findRoute(routes, rawHost, strict);

    if (!route) {
      const safeHost = escapeHtml(host);
      const matchedSuffix = tldSuffixes
        .filter((suffix) => host.endsWith(suffix))
        .sort((a, b) => b.length - a.length)[0];
      const strippedHost =
        matchedSuffix && matchedSuffix.length < host.length
          ? host.slice(0, -matchedSuffix.length)
          : host;
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
    // HTTP/2 carries the hostname only in :authority (stripped above); restore
    // it as Host so Host-dependent backends (multi-tenant vhosts, framework
    // host allow-lists) see the original hostname instead of 127.0.0.1.
    if (!proxyReqHeaders.host) {
      proxyReqHeaders.host = getRequestHost(req);
    }

    const proxyReq = http.request(
      {
        // Dial via createLoopbackConnection so ::1-only backends work too.
        createConnection: () => createLoopbackConnection(route.port),
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
    const route = findRoute(routes, getRequestHost(req), strict);

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
    // HTTP/2 carries the hostname only in :authority (stripped above); restore
    // it as Host so Host-dependent backends (multi-tenant vhosts, framework
    // host allow-lists) see the original hostname instead of 127.0.0.1.
    if (!proxyReqHeaders.host) {
      proxyReqHeaders.host = getRequestHost(req);
    }

    const proxyReq = http.request({
      // Dial via createLoopbackConnection so ::1-only backends work too.
      createConnection: () => createLoopbackConnection(route.port),
      path: req.url,
      method: req.method,
      headers: proxyReqHeaders,
    });

    // Whether the backend's handshake answer (101 or a rejection) has been
    // relayed to the client. Gates the error handler below: before relay a
    // proper 502 can still be written; after it the stream may carry
    // WebSocket frames, so the only safe reaction is to drop the socket.
    let handshakeRelayed = false;

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      handshakeRelayed = true;
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
      // A dead backend (ECONNREFUSED) or a malformed rejection (e.g. Next.js
      // dev writes a bare "Unauthorized" with no status line when an Origin
      // is not allow-listed, which surfaces here as a parse error) would
      // otherwise close the connection with no response, leaving the client
      // nothing to diagnose. Answer with a real 502 while that is still safe.
      if (!handshakeRelayed && socket.writable) {
        socket.end(
          "HTTP/1.1 502 Bad Gateway\r\n" +
            "Content-Type: text/plain\r\n" +
            "Connection: close\r\n" +
            "\r\n" +
            "Bad Gateway: the target app is not responding or sent an invalid response to the WebSocket handshake.\n"
        );
      } else {
        socket.destroy();
      }
    });

    proxyReq.on("response", (res) => {
      handshakeRelayed = true;
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

  /**
   * Handle an RFC 8441 extended CONNECT request (WebSocket over HTTP/2).
   * Browsers open WebSockets this way when the connection is HTTP/2 and the
   * server advertises SETTINGS_ENABLE_CONNECT_PROTOCOL. The h2 stream is
   * bridged to a regular HTTP/1.1 Upgrade handshake against the backend:
   * the client never sends Sec-WebSocket-Key over h2, so one is synthesized
   * for the backend hop and the backend's Accept answer is dropped.
   */
  const handleExtendedConnect = (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
    const compatReq = req as unknown as http.IncomingMessage;
    req.stream.on("error", () => {});
    res.setHeader(PORTLESS_HEADER, "1");

    // Classic CONNECT tunneling is not a portless feature; only WebSocket
    // bridging is supported.
    if (req.headers[":protocol"] !== "websocket") {
      res.writeHead(501, { "content-type": "text/plain" });
      res.end("CONNECT is only supported for WebSockets (RFC 8441)\n");
      return;
    }

    const hops = parseInt(req.headers[PORTLESS_HOPS_HEADER] as string, 10) || 0;
    if (hops >= MAX_PROXY_HOPS) {
      const host = getRequestHost(compatReq).split(":")[0];
      onError(
        `WebSocket loop detected for ${host}: request has passed through portless ${hops} times. ` +
          `Set changeOrigin: true in your proxy config.`
      );
      res.writeHead(508, { "content-type": "text/plain" });
      res.end(
        "Loop Detected: request has passed through portless too many times.\n" +
          "Add changeOrigin: true to your dev server proxy config.\n"
      );
      return;
    }

    const route = findRoute(getRoutes(), getRequestHost(compatReq), strict);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`No app registered for ${getRequestHost(compatReq)}\n`);
      return;
    }

    const forwardedHeaders = buildForwardedHeaders(compatReq, isEncrypted(compatReq));
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
    proxyReqHeaders.host = getRequestHost(compatReq);
    // Translate the extended CONNECT into the HTTP/1.1 Upgrade handshake the
    // backend expects. Sec-WebSocket-Protocol/-Extensions pass through from
    // the copied headers so subprotocol and compression negotiation stay
    // end-to-end between client and backend.
    proxyReqHeaders.connection = "Upgrade";
    proxyReqHeaders.upgrade = "websocket";
    const wsKey = crypto.randomBytes(16).toString("base64");
    proxyReqHeaders["sec-websocket-key"] = wsKey;
    if (!proxyReqHeaders["sec-websocket-version"]) {
      proxyReqHeaders["sec-websocket-version"] = "13";
    }

    const proxyReq = http.request({
      // Dial via createLoopbackConnection so ::1-only backends work too.
      createConnection: () => createLoopbackConnection(route.port),
      path: req.url,
      method: "GET",
      headers: proxyReqHeaders,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      // The h2 client never sees the synthesized key, so this proxy is the
      // only party that can verify the backend's accept hash. A 101 with the
      // wrong hash is not a WebSocket server speaking RFC 6455; bridging it
      // would hand the client a broken tunnel with nothing to diagnose.
      const expectedAccept = crypto
        .createHash("sha1")
        .update(wsKey + WS_GUID)
        .digest("base64");
      if (proxyRes.headers["sec-websocket-accept"] !== expectedAccept) {
        onError(
          `WebSocket proxy error for ${getRequestHost(compatReq)}: backend answered the handshake with an invalid Sec-WebSocket-Accept`
        );
        proxySocket.destroy();
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(
          "Bad Gateway: the target app sent an invalid response to the WebSocket handshake.\n"
        );
        return;
      }
      const responseHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };
      for (const h of HOP_BY_HOP_HEADERS) {
        delete responseHeaders[h];
      }
      // The Accept answers the key this proxy synthesized, not anything the
      // h2 client sent; RFC 8441 has no equivalent handshake header.
      delete responseHeaders["sec-websocket-accept"];
      // RFC 8441 signals a successful handshake with :status 200, not 101.
      res.writeHead(200, responseHeaders);
      if (proxyHead.length > 0) {
        res.write(proxyHead);
      }
      proxySocket.pipe(res);
      req.pipe(proxySocket);

      // Tear down both sides when either disconnects. pipe() already
      // propagates graceful ends; these catch aborts and errors. destroy()
      // is idempotent, so duplicate calls are harmless.
      const cleanup = () => {
        proxySocket.destroy();
        req.stream.destroy();
      };
      proxySocket.on("error", cleanup);
      proxySocket.on("close", cleanup);
      req.stream.on("close", cleanup);
    });

    proxyReq.on("response", (proxyRes) => {
      // The backend answered with a normal HTTP response instead of
      // upgrading (auth middleware redirects, 4xx, etc.). Forward it so the
      // client sees the rejection instead of a hung handshake.
      const responseHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };
      for (const h of HOP_BY_HOP_HEADERS) {
        delete responseHeaders[h];
      }
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      proxyRes.on("error", () => req.stream.destroy());
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (err) => {
      onError(`WebSocket proxy error for ${getRequestHost(compatReq)}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("Bad Gateway: the target app is not responding\n");
      } else {
        req.stream.destroy();
      }
    });

    // Abort the backend handshake if the client goes away first.
    req.stream.on("close", () => {
      if (!proxyReq.destroyed) {
        proxyReq.destroy();
      }
    });

    proxyReq.end();
  };

  if (tls) {
    const h2Server = http2.createSecureServer({
      cert: tls.ca ? Buffer.concat([tls.cert, tls.ca]) : tls.cert,
      key: tls.key,
      allowHTTP1: true,
      // Advertise RFC 8441 extended CONNECT so browsers can open WebSockets
      // over the existing HTTP/2 session (handled below via the 'connect'
      // event) instead of failing the wss:// handshake.
      settings: { enableConnectProtocol: true },
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
    // WebSocket-over-HTTP/2 arrives as an extended CONNECT stream, which the
    // compat layer surfaces via the 'connect' event (never 'request'; without
    // a listener Node auto-responds 405 and the handshake dies).
    h2Server.on(
      "connect",
      (
        req: http2.Http2ServerRequest | http.IncomingMessage,
        resOrSocket: http2.Http2ServerResponse | net.Socket
      ) => {
        // With allowHTTP1, an HTTP/1.1 CONNECT fires this same event with a
        // (req, socket, head) signature. Classic CONNECT tunneling is not
        // supported on either protocol version.
        if (resOrSocket instanceof net.Socket) {
          resOrSocket.destroy();
          return;
        }
        handleExtendedConnect(req as http2.Http2ServerRequest, resOrSocket);
      }
    );

    // Plain HTTP on a TLS-enabled port -> 302 redirect to HTTPS.
    // The redirect targets the same port because the wrapper net.Server
    // demuxes TLS and plain HTTP on a single listener (peek at first byte).
    const plainServer = http.createServer((req, res) => {
      const host = getRequestHost(req).split(":")[0] || "localhost";
      const location = `https://${host}${proxyPort === 443 ? "" : `:${proxyPort}`}${req.url || "/"}`;
      res.writeHead(302, { Location: location, [PORTLESS_HEADER]: "1" });
      res.end();
    });
    // WebSocket clients cannot follow the 302 redirect a normal request
    // gets, so proxy plain-HTTP upgrades directly instead of dropping them.
    plainServer.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      handleUpgrade(req, socket, head);
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

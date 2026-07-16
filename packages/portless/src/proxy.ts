import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as crypto from "node:crypto";
import type { ProxyServerOptions } from "./types.js";
import { createLoopbackConnection, escapeHtml, formatUrl } from "./utils.js";
import { ARROW_SVG, renderPage } from "./pages.js";

/**
 * RFC 6455 magic GUID — used to derive Sec-WebSocket-Accept from
 * Sec-WebSocket-Key when bridging HTTP/2 Extended CONNECT (RFC 8441) to an
 * HTTP/1.1 backend that expects the classic WebSocket handshake.
 */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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
 * browsers while keeping WebSocket upgrades working over HTTP/1.1.
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
      const matchedSuffix = tldSuffixes.find((suffix) => host.endsWith(suffix));
      const strippedHost = matchedSuffix ? host.slice(0, -matchedSuffix.length) : host;
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

  /**
   * Bridge an incoming HTTP/2 Extended CONNECT (RFC 8441) WebSocket request
   * to an HTTP/1.1 backend that speaks classic RFC 6455.
   *
   * Flow:
   *   browser → portless (h2 stream, :method=CONNECT, :protocol=websocket)
   *   portless → backend (raw net.Socket + manual HTTP/1.1 Upgrade request)
   *   backend → portless (101 Switching Protocols + Sec-WebSocket-Accept)
   *   portless → browser (HTTP/2 :status=200, no Sec-WebSocket-Accept needed
   *                       per RFC 8441 §4)
   *   ↔ pipe raw WebSocket frames in both directions
   *
   * Raw net.Socket (not http.request) because Node 24's ClientRequest tears
   * down the socket prematurely when used in this CONNECT-bridging context;
   * see comment on backendSocket below for details.
   */
  const handleH2WebSocket = (
    stream: http2.ServerHttp2Stream,
    headers: http2.IncomingHttpHeaders
  ) => {
    stream.on("error", () => stream.destroy());

    const authority = (headers[":authority"] as string) || "";
    const host = authority.split(":")[0];
    const path = (headers[":path"] as string) || "/";

    // CRITICAL: respond synchronously *now* to claim the stream. When both a
    // 'request' and a 'stream' listener are registered (our case — the
    // 'request' listener serves regular HTTPS), Node's HTTP/2 compatibility
    // layer auto-responds 405 to CONNECT requests if the stream hasn't been
    // responded to yet. Our async backend wiring below would lose that race.
    // Per RFC 8441, the server responds `:status: 200` to accept the
    // WebSocket; we then bridge to the HTTP/1.1 backend and pipe frames.
    // If the backend rejects, we destroy the stream — the client treats it
    // as a disconnect and retries, same as any transient WS failure.
    try {
      stream.respond({ ":status": 200 });
    } catch {
      stream.destroy();
      return;
    }

    if (!host) {
      stream.destroy();
      return;
    }

    const hops = parseInt(headers[PORTLESS_HOPS_HEADER] as string, 10) || 0;
    if (hops >= MAX_PROXY_HOPS) {
      onError(
        `WebSocket loop detected for ${host}: request has passed through portless ${hops} times.`
      );
      stream.destroy();
      return;
    }

    const routes = getRoutes();
    const route = findRoute(routes, host, strict);
    if (!route) {
      stream.destroy();
      return;
    }

    // Build classic WebSocket Upgrade headers for the HTTP/1.1 backend. The
    // browser-supplied Sec-WebSocket-Key (if any) isn't strictly meaningful
    // under RFC 8441, but pass it through if present for diagnostic clarity;
    // otherwise generate one.
    const wsKey =
      (headers["sec-websocket-key"] as string) || crypto.randomBytes(16).toString("base64");

    const fakeReq = {
      socket: stream.session?.socket,
      headers: { ...headers, host: authority },
    } as unknown as http.IncomingMessage;
    const forwardedHeaders = buildForwardedHeaders(fakeReq, true);

    const backendHeaders: http.OutgoingHttpHeaders = {
      host: authority,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": (headers["sec-websocket-version"] as string) || "13",
      "sec-websocket-key": wsKey,
    };
    if (headers["sec-websocket-protocol"]) {
      backendHeaders["sec-websocket-protocol"] = headers["sec-websocket-protocol"] as string;
    }
    if (headers["sec-websocket-extensions"]) {
      backendHeaders["sec-websocket-extensions"] = headers["sec-websocket-extensions"] as string;
    }
    if (headers["origin"]) {
      backendHeaders["origin"] = headers["origin"] as string;
    }
    if (headers["user-agent"]) {
      backendHeaders["user-agent"] = headers["user-agent"] as string;
    }
    if (headers["cookie"]) {
      backendHeaders["cookie"] = headers["cookie"] as string;
    }
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      backendHeaders[key] = value;
    }
    backendHeaders[PORTLESS_HOPS_HEADER] = String(hops + 1);

    // Open a raw TCP socket to the backend and write the WebSocket upgrade
    // request ourselves. We avoid http.request here because Node 24's
    // ClientRequest closes the socket prematurely when used in this CONNECT-
    // bridging context (it detects "no body / GET" and tears down before the
    // server's 101 response arrives). Manual framing gives us tight control
    // over the upgrade lifecycle.
    const backendSocket = net.connect(route.port, "127.0.0.1");
    backendSocket.on("error", () => {
      backendSocket.destroy();
      if (!stream.destroyed) stream.destroy();
    });

    let upgradeHandshakeBuffer = Buffer.alloc(0);
    let upgraded = false;

    const onBackendData = (chunk: Buffer) => {
      if (upgraded) return; // shouldn't fire — pipes take over
      upgradeHandshakeBuffer = Buffer.concat([upgradeHandshakeBuffer, chunk]);
      const headerEnd = upgradeHandshakeBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // wait for more
      const headerBlock = upgradeHandshakeBuffer.slice(0, headerEnd).toString("utf8");
      const remaining = upgradeHandshakeBuffer.slice(headerEnd + 4);
      const lines = headerBlock.split("\r\n");
      const statusLine = lines[0];
      // Status line: "HTTP/1.1 101 Switching Protocols"
      const statusMatch = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      if (status !== 101) {
        // Backend rejected; we already told the client :status 200, so the
        // only graceful out is to drop the stream. Client retries.
        backendSocket.destroy();
        if (!stream.destroyed) stream.destroy();
        return;
      }

      // Validate Sec-WebSocket-Accept matches what we sent.
      const acceptHeader = lines
        .slice(1)
        .map((l) => l.split(":"))
        .find(([k]) => k && k.trim().toLowerCase() === "sec-websocket-accept");
      const acceptValue = acceptHeader ? acceptHeader.slice(1).join(":").trim() : "";
      const expectedAccept = crypto
        .createHash("sha1")
        .update(wsKey + WS_GUID)
        .digest("base64");
      if (acceptValue !== expectedAccept) {
        backendSocket.destroy();
        if (!stream.destroyed) stream.destroy();
        return;
      }

      upgraded = true;
      backendSocket.removeListener("data", onBackendData);

      // Flush any WS frame bytes that arrived in the same TCP packet as the
      // 101 response (rare but possible) before piping.
      if (remaining.length > 0 && !stream.destroyed) {
        stream.write(remaining);
      }

      // Pipe raw WS frames both directions. HTTP/2 DATA frames carry the
      // bytes transparently — same byte stream as HTTP/1.1 after upgrade.
      backendSocket.pipe(stream);
      stream.pipe(backendSocket);

      const cleanup = () => {
        backendSocket.destroy();
        if (!stream.destroyed) stream.close();
      };
      backendSocket.on("error", cleanup);
      backendSocket.on("close", cleanup);
      backendSocket.on("end", cleanup);
      stream.on("close", cleanup);
      stream.on("aborted", cleanup);
    };

    backendSocket.once("connect", () => {
      backendSocket.on("data", onBackendData);

      // Build the HTTP/1.1 WebSocket upgrade request manually.
      let req = `GET ${path} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(backendHeaders)) {
        if (value === undefined) continue;
        req += `${name}: ${value}\r\n`;
      }
      req += "\r\n";
      backendSocket.write(req);
    });

    stream.on("close", () => {
      if (!backendSocket.destroyed) backendSocket.destroy();
    });
  };

  if (tls) {
    const h2Server = http2.createSecureServer({
      cert: tls.ca ? Buffer.concat([tls.cert, tls.ca]) : tls.cert,
      key: tls.key,
      allowHTTP1: true,
      // Advertise RFC 8441 Extended CONNECT support to clients. Required so
      // browsers send `:method=CONNECT, :protocol=websocket` for WebSockets
      // over an existing HTTP/2 connection (instead of opening a separate
      // HTTP/1.1 connection, which they don't anymore on Chrome/Firefox).
      // Without this setting, the h2 server RST_STREAMs Extended CONNECT
      // requests, the browser reports the WebSocket as failed, and Next.js
      // Turbopack / Vite HMR breaks (manifests as random page reloads when
      // the HMR client gives up reconnecting).
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
      // RFC 8441 Extended CONNECT (WebSocket-over-HTTP/2) fires both 'stream'
      // and 'request' events; the 'stream' listener handles bridging. Here
      // we neutralize the compat-layer Http2ServerResponse so it doesn't
      // end the underlying stream — without this, the compat layer's
      // implicit response lifecycle closes the stream's writable side
      // immediately after the listener returns, killing the WS tunnel.
      if (req.method === "CONNECT") {
        const noop = () => res;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (res as any).end = noop;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (res as any).writeHead = noop;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (res as any).write = noop;
        return;
      }
      handleRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
    });

    // RFC 8441 Extended CONNECT: WebSocket-over-HTTP/2 from modern browsers.
    // Bridges to the HTTP/1.1 backend (Next.js/Vite/etc. dev servers) by
    // synthesizing a classic WebSocket Upgrade request and piping bytes
    // both directions once the backend confirms the upgrade.
    //
    // prependListener is critical: Node http2's compatibility layer also
    // listens for 'stream' and auto-responds 405 to CONNECT requests when a
    // 'request' listener is registered (because compat layer can't route
    // CONNECT to a normal request handler). Without prepending, the compat
    // layer wins the race, sets headers, and our stream.respond throws
    // "Response has already been initiated".
    h2Server.prependListener(
      "stream",
      (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
        if (headers[":method"] !== "CONNECT" || headers[":protocol"] !== "websocket") {
          // Regular request — handled by the 'request' event listener above.
          return;
        }
        // Node's HTTP/2 compatibility layer (internal/http2/compat.js)
        // unconditionally calls `response.end()` on CONNECT streams when a
        // 'request' listener is registered, because the compat API's
        // request/response abstraction doesn't model CONNECT. That call
        // sends END_STREAM on our writable side and breaks WebSocket
        // tunneling. Override `stream.end` to a no-op so the compat layer's
        // shutdown attempt is harmless; the WebSocket bridge below pipes
        // raw bytes via stream.write directly. The stream is destroyed
        // (RST_STREAM) at the end of the WS lifecycle on disconnect, so we
        // never need stream.end() for graceful shutdown.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (stream as any).end = function (this: http2.ServerHttp2Stream) {
          return this;
        };
        handleH2WebSocket(stream, headers);
      }
    );

    // HTTP/1.1 fallback: legacy clients (curl, older browsers) that never
    // upgrade to HTTP/2 use the classic Upgrade: websocket flow. Still
    // possible because allowHTTP1 is true.
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

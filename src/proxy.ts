import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import type { ProxyServerOptions } from "./types.js";
import { escapeHtml, formatUrl } from "./utils.js";

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
  const { getRoutes, proxyPort, onError = (msg: string) => console.error(msg), tls } = options;

  const isTls = !!tls;

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader(PORTLESS_HEADER, "1");

    const routes = getRoutes();
    const host = getRequestHost(req).split(":")[0];

    if (!host) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing Host header");
      return;
    }

    const route = routes.find((r) => r.hostname === host);

    if (!route) {
      const safeHost = escapeHtml(host);
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(`
        <html>
          <head><title>portless - Not Found</title></head>
          <body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1>Not Found</h1>
            <p>No app registered for <strong>${safeHost}</strong></p>
            ${
              routes.length > 0
                ? `
              <h2>Active apps:</h2>
              <ul>
                ${routes.map((r) => `<li><a href="${escapeHtml(formatUrl(r.hostname, proxyPort, isTls))}">${escapeHtml(r.hostname)}</a> - localhost:${escapeHtml(String(r.port))}</li>`).join("")}
              </ul>
            `
                : "<p><em>No apps running.</em></p>"
            }
            <p>Start an app with: <code>portless ${safeHost.replace(".localhost", "")} your-command</code></p>
          </body>
        </html>
      `);
      return;
    }

    const forwardedHeaders = buildForwardedHeaders(req, isTls);
    const proxyReqHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      proxyReqHeaders[key] = value;
    }
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
        if (isTls) {
          for (const h of HOP_BY_HOP_HEADERS) {
            delete responseHeaders[h];
          }
        }
        res.writeHead(proxyRes.statusCode || 502, responseHeaders);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      onError(`Proxy error for ${getRequestHost(req)}: ${err.message}`);
      if (!res.headersSent) {
        const errWithCode = err as NodeJS.ErrnoException;
        const message =
          errWithCode.code === "ECONNREFUSED"
            ? "Bad Gateway: the target app is not responding. It may have crashed."
            : "Bad Gateway: the target app may not be running.";
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(message);
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
    const routes = getRoutes();
    const host = getRequestHost(req).split(":")[0];
    const route = routes.find((r) => r.hostname === host);

    if (!route) {
      socket.destroy();
      return;
    }

    const forwardedHeaders = buildForwardedHeaders(req, isTls);
    const proxyReqHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      proxyReqHeaders[key] = value;
    }
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

      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
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
      cert: tls.cert,
      key: tls.key,
      allowHTTP1: true,
      ...(tls.SNICallback ? { SNICallback: tls.SNICallback } : {}),
    });
    // With allowHTTP1, the 'request' event receives objects compatible with
    // http.IncomingMessage / http.ServerResponse. Cast explicitly to satisfy TypeScript.
    h2Server.on("request", (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
      handleRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
    });
    // WebSocket upgrades arrive over HTTP/1.1 connections (allowHTTP1)
    h2Server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      handleUpgrade(req, socket, head);
    });

    // Plain HTTP server using the same proxy handlers (no TLS, no redirect)
    const plainServer = http.createServer(handleRequest);
    plainServer.on("upgrade", handleUpgrade);

    // Wrap both in a net.Server that peeks at the first byte to decide
    // whether the connection is TLS (0x16 = ClientHello) or plain HTTP.
    const wrapper = net.createServer((socket) => {
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
          // Plain HTTP -> proxy normally over HTTP/1.1
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

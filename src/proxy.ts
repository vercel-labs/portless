import * as http from "node:http";
import * as net from "node:net";
import type { ProxyServerOptions } from "./types.js";
import { escapeHtml, formatUrl } from "./utils.js";

/** Response header used to identify a portless proxy (for health checks). */
export const PORTLESS_HEADER = "X-Portless";

/**
 * Build X-Forwarded-* headers for a proxied request.
 */
function buildForwardedHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  const remoteAddress = req.socket.remoteAddress || "127.0.0.1";
  const proto = "http";
  const hostHeader = req.headers.host || "";

  headers["x-forwarded-for"] = req.headers["x-forwarded-for"]
    ? `${req.headers["x-forwarded-for"]}, ${remoteAddress}`
    : remoteAddress;
  headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] as string) || proto;
  headers["x-forwarded-host"] = (req.headers["x-forwarded-host"] as string) || hostHeader;
  headers["x-forwarded-port"] =
    (req.headers["x-forwarded-port"] as string) || hostHeader.split(":")[1] || "80";

  return headers;
}

/**
 * Create an HTTP proxy server that routes requests based on the Host header.
 *
 * Uses Node's built-in http module for proxying (no external dependencies).
 * The `getRoutes` callback is invoked on every request so callers can provide
 * either a static list or a live-updating one.
 */
export function createProxyServer(options: ProxyServerOptions): http.Server {
  const { getRoutes, proxyPort, onError = (msg: string) => console.error(msg) } = options;

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader(PORTLESS_HEADER, "1");

    const routes = getRoutes();
    const host = (req.headers.host || "").split(":")[0];

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
                ${routes.map((r) => `<li><a href="${escapeHtml(formatUrl(r.hostname, proxyPort))}">${escapeHtml(r.hostname)}</a> - localhost:${escapeHtml(String(r.port))}</li>`).join("")}
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

    const forwardedHeaders = buildForwardedHeaders(req);
    const proxyReqHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      proxyReqHeaders[key] = value;
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
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      onError(`Proxy error for ${req.headers.host}: ${err.message}`);
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
    const host = (req.headers.host || "").split(":")[0];
    const route = routes.find((r) => r.hostname === host);

    if (!route) {
      socket.destroy();
      return;
    }

    const forwardedHeaders = buildForwardedHeaders(req);
    const proxyReqHeaders: http.OutgoingHttpHeaders = { ...req.headers };
    for (const [key, value] of Object.entries(forwardedHeaders)) {
      proxyReqHeaders[key] = value;
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
      onError(`WebSocket proxy error for ${req.headers.host}: ${err.message}`);
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

  const httpServer = http.createServer(handleRequest);
  httpServer.on("upgrade", handleUpgrade);

  return httpServer;
}

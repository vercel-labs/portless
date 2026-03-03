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

    const hops = parseInt(req.headers[PORTLESS_HOPS_HEADER] as string, 10) || 0;
    if (hops >= MAX_PROXY_HOPS) {
      onError(
        `Loop detected for ${host}: request has passed through portless ${hops} times. ` +
          `This usually means a backend is proxying back through portless without rewriting ` +
          `the Host header. If you use Vite/webpack proxy, set changeOrigin: true.`
      );
      res.writeHead(508, { "Content-Type": "text/plain" });
      res.end(
        `Loop Detected: this request has passed through portless ${hops} times.\n\n` +
          "This usually means a dev server (Vite, webpack, etc.) is proxying\n" +
          "requests back through portless without rewriting the Host header.\n\n" +
          "Fix: add changeOrigin: true to your proxy config, e.g.:\n\n" +
          "  proxy: {\n" +
          '    "/api": {\n' +
          '      target: "http://<backend>.localhost:<port>",\n' +
          "      changeOrigin: true,\n" +
          "    },\n" +
          "  }\n"
      );
      return;
    }

    const route = routes.find((r) => r.hostname === host);

    if (!route) {
      const safeHost = escapeHtml(host);
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>portless - Not Found</title>
            <style>
              :root {
                --background: #ffffff;
                --foreground: #171717;
                --muted: #737373;
                --border: #e5e5e5;
                --card-bg: #fafafa;
                --link: #0070f3;
                --link-hover: #0051cc;
                --code-bg: #f5f5f5;
                --toggle-bg: #e5e5e5;
                --toggle-hover: #d4d4d4;
              }

              @media (prefers-color-scheme: dark) {
                :root:not([data-theme="light"]) {
                  --background: #0a0a0a;
                  --foreground: #ededed;
                  --muted: #a3a3a3;
                  --border: #262626;
                  --card-bg: #171717;
                  --link: #3b82f6;
                  --link-hover: #60a5fa;
                  --code-bg: #262626;
                  --toggle-bg: #262626;
                  --toggle-hover: #404040;
                }
              }

              [data-theme="dark"] {
                --background: #0a0a0a;
                --foreground: #ededed;
                --muted: #a3a3a3;
                --border: #262626;
                --card-bg: #171717;
                --link: #3b82f6;
                --link-hover: #60a5fa;
                --code-bg: #262626;
                --toggle-bg: #262626;
                --toggle-hover: #404040;
              }

              * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
              }

              body {
                font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                background-color: var(--background);
                color: var(--foreground);
                padding: 40px 20px;
                line-height: 1.6;
                transition: background-color 0.2s, color 0.2s;
              }

              .container {
                max-width: 600px;
                margin: 0 auto;
              }

              .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 32px;
              }

              h1 {
                font-size: 28px;
                font-weight: 600;
                margin-bottom: 16px;
              }

              h2 {
                font-size: 20px;
                font-weight: 600;
                margin-top: 32px;
                margin-bottom: 16px;
              }

              p {
                margin-bottom: 16px;
                color: var(--foreground);
              }

              em {
                color: var(--muted);
              }

              strong {
                font-weight: 600;
                color: var(--foreground);
              }

              code {
                background-color: var(--code-bg);
                padding: 2px 8px;
                border-radius: 4px;
                font-family: 'SF Mono', Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
                font-size: 14px;
                color: var(--foreground);
              }

              ul {
                list-style: none;
                background-color: var(--card-bg);
                border: 1px solid var(--border);
                border-radius: 8px;
                padding: 16px;
                margin-bottom: 16px;
              }

              li {
                padding: 8px 0;
                border-bottom: 1px solid var(--border);
              }

              li:last-child {
                border-bottom: none;
              }

              a {
                color: var(--link);
                text-decoration: none;
                transition: color 0.2s;
              }

              a:hover {
                color: var(--link-hover);
                text-decoration: underline;
              }

              .theme-toggle {
                background: var(--toggle-bg);
                border: 1px solid var(--border);
                border-radius: 6px;
                width: 36px;
                height: 36px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: background-color 0.2s;
              }

              .theme-toggle:hover {
                background: var(--toggle-hover);
              }

              .theme-toggle svg {
                width: 18px;
                height: 18px;
                stroke: var(--foreground);
              }

              .sun-icon {
                display: none;
              }

              [data-theme="dark"] .sun-icon {
                display: block;
              }

              [data-theme="dark"] .moon-icon {
                display: none;
              }

              @media (prefers-color-scheme: dark) {
                :root:not([data-theme="light"]) .sun-icon {
                  display: block;
                }
                :root:not([data-theme="light"]) .moon-icon {
                  display: none;
                }
              }
            </style>
            <script>
              // Apply saved theme immediately (before render) to prevent flash
              (function() {
                const savedTheme = localStorage.getItem('portless-theme');
                if (savedTheme) {
                  document.documentElement.setAttribute('data-theme', savedTheme);
                }
              })();
            </script>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>Not Found</h1>
                <button class="theme-toggle" id="theme-toggle" aria-label="Toggle theme">
                  <svg class="sun-icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="4"/>
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>
                  </svg>
                  <svg class="moon-icon" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                  </svg>
                </button>
              </div>
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
            </div>
            <script>
              // Theme toggle functionality
              const toggle = document.getElementById('theme-toggle');
              const root = document.documentElement;
              
              function getEffectiveTheme() {
                const savedTheme = localStorage.getItem('portless-theme');
                if (savedTheme) return savedTheme;
                
                // Check system preference
                if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
                  return 'dark';
                }
                return 'light';
              }
              
              function setTheme(theme) {
                root.setAttribute('data-theme', theme);
                localStorage.setItem('portless-theme', theme);
              }
              
              toggle.addEventListener('click', function() {
                const currentTheme = getEffectiveTheme();
                const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
                setTheme(newTheme);
              });
              
              // Update theme when system preference changes
              if (window.matchMedia) {
                window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
                  if (!localStorage.getItem('portless-theme')) {
                    root.setAttribute('data-theme', e.matches ? 'dark' : 'light');
                  }
                });
              }
            </script>
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

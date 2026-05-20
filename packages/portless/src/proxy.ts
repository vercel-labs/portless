import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as zlib from "node:zlib";
import type { ProxyServerOptions } from "./types.js";
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

const SELECTOR_COOKIE = "portless_app";
const CONTROL_PREFIX = "/__portless__";
const MAX_SWITCHER_INJECTION_BYTES = 2 * 1024 * 1024;

type ProxyRoute = {
  id?: string;
  hostname: string;
  port: number;
  pid?: number;
  cwd?: string;
  folder?: string;
  gitBranch?: string;
  command?: string;
};

function getRouteId(route: ProxyRoute): string {
  return route.id || `${route.hostname}:${route.port}:${route.pid ?? 0}`;
}

/**
 * Find the route matching a given host. Matches exact hostname first, then
 * falls back to wildcard subdomain matching (e.g. tenant.myapp.localhost
 * matches a route registered for myapp.localhost).
 *
 * When `strict` is true, only exact matches are returned; unregistered
 * subdomain prefixes will not fall back to the base service.
 */
function findRoutes(routes: ProxyRoute[], host: string, strict?: boolean): ProxyRoute[] {
  const exact = routes.filter((r) => r.hostname === host);
  if (exact.length > 0 || strict) return exact;
  return routes.filter((r) => host.endsWith("." + r.hostname));
}

function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join(";") : header || "";
  const cookies: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function isPortlessPath(url: string | undefined): boolean {
  return (url || "/").startsWith(CONTROL_PREFIX);
}

function getRouteDetails(route: ProxyRoute): [string, string][] {
  const pid = route.pid === 0 ? "alias" : String(route.pid ?? "unknown");
  return [
    ["host", route.hostname],
    ["port", `127.0.0.1:${route.port}`],
    ["pid", pid],
    ["branch", route.gitBranch || "unknown"],
    ["folder", route.cwd || route.folder || "unknown"],
    ["command", route.command || "unknown"],
  ];
}

function renderSelectorPage(
  status: number,
  host: string,
  routes: ProxyRoute[],
  currentId?: string,
  next = "/"
): string {
  const safeHost = escapeHtml(host);
  const safeNext = encodeURIComponent(next || "/");
  const items = routes
    .map((route) => {
      const id = getRouteId(route);
      const selected = currentId === id ? " selected" : "";
      const href = `${CONTROL_PREFIX}/select?id=${encodeURIComponent(id)}&next=${safeNext}`;
      const detailRows = getRouteDetails(route)
        .map(
          ([label, value]) =>
            `<span class="selector-row"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></span>`
        )
        .join("");
      return `<li><div class="selector-app${selected}"><div class="selector-top"><span class="name">${escapeHtml(route.folder || route.hostname)}</span><code class="port">${escapeHtml(String(route.port))}</code></div><div class="selector-details">${detailRows}</div><div class="selector-actions"><a class="selector-button" href="${href}">${selected ? "Selected" : "Select"}</a></div></div></li>`;
    })
    .join("");
  const body = `<style>
.selector-app{display:block;padding:14px 16px;color:inherit}
.selector-app.selected{background:var(--surface)}
.selector-top{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px}
.selector-details{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin-top:12px}
.selector-row{min-width:0}
.selector-row span{display:block;margin-bottom:2px;color:var(--text-3);font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0}
.selector-row code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg);font-family:var(--font-mono);font-size:12px}
.selector-actions{display:flex;justify-content:flex-end;margin-top:12px}
.selector-button{display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:0 12px;border-radius:6px;background:var(--fg);color:var(--bg);font-size:13px;font-weight:500;text-decoration:none}
.selector-app.selected .selector-button{border:1px solid var(--border);background:transparent;color:var(--fg)}
@media (max-width:520px){.selector-details{grid-template-columns:1fr}}
</style><div class="content"><p class="desc">Multiple apps are registered for <strong>${safeHost}</strong>. Choose which one this browser should use.</p><div class="section"><p class="label">Available apps</p><ul class="card">${items}</ul></div></div>`;
  return renderPage(status, "Select App", body);
}

function routeFromCookie(routes: ProxyRoute[], cookieHeader: string | string[] | undefined) {
  const selected = parseCookies(cookieHeader)[SELECTOR_COOKIE];
  if (!selected) return undefined;
  return routes.find((route) => getRouteId(route) === selected);
}

function setSelectionCookie(res: http.ServerResponse, routeId: string): void {
  res.setHeader(
    "Set-Cookie",
    `${SELECTOR_COOKIE}=${encodeURIComponent(routeId)}; Path=/; HttpOnly; SameSite=Lax`
  );
}

function clearSelectionCookie(res: http.ServerResponse): void {
  res.setHeader("Set-Cookie", `${SELECTOR_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function getRedirectTarget(reqUrl: string | undefined): string {
  try {
    const parsed = new URL(reqUrl || "/", "http://portless.local");
    const next = parsed.searchParams.get("next") || "/";
    return next.startsWith("/") && !next.startsWith("//") ? next : "/";
  } catch {
    return "/";
  }
}

function handlePortlessControl(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  host: string,
  routes: ProxyRoute[]
): boolean {
  const url = req.url || "/";
  if (!isPortlessPath(url)) return false;
  if (url.startsWith(`${CONTROL_PREFIX}/select`)) {
    const parsed = new URL(url, "http://portless.local");
    const id = parsed.searchParams.get("id");
    const route = routes.find((candidate) => getRouteId(candidate) === id);
    if (route) {
      setSelectionCookie(res, getRouteId(route));
      res.writeHead(302, { Location: getRedirectTarget(url) });
      res.end();
      return true;
    }
  }
  if (url.startsWith(`${CONTROL_PREFIX}/clear`)) {
    clearSelectionCookie(res);
    res.writeHead(302, { Location: getRedirectTarget(url) });
    res.end();
    return true;
  }
  const currentId = parseCookies(req.headers.cookie)[SELECTOR_COOKIE];
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(renderSelectorPage(200, host, routes, currentId, getRedirectTarget(url)));
  return true;
}

function decodeBody(body: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (encoding === "gzip")
      zlib.gunzip(body, (err, result) => (err ? reject(err) : resolve(result)));
    else if (encoding === "br")
      zlib.brotliDecompress(body, (err, result) => (err ? reject(err) : resolve(result)));
    else if (encoding === "deflate")
      zlib.inflate(body, (err, result) => (err ? reject(err) : resolve(result)));
    else resolve(body);
  });
}

function encodeBody(body: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (encoding === "gzip")
      zlib.gzip(body, (err, result) => (err ? reject(err) : resolve(result)));
    else if (encoding === "br")
      zlib.brotliCompress(body, (err, result) => (err ? reject(err) : resolve(result)));
    else if (encoding === "deflate")
      zlib.deflate(body, (err, result) => (err ? reject(err) : resolve(result)));
    else resolve(body);
  });
}

async function injectSwitcher(
  chunks: Buffer[],
  headers: http.OutgoingHttpHeaders,
  host: string,
  routes: ProxyRoute[],
  currentRoute: ProxyRoute,
  reqUrl: string | undefined
): Promise<Buffer> {
  const encoding = String(headers["content-encoding"] || "").toLowerCase();
  const raw = Buffer.concat(chunks);
  const decoded = await decodeBody(raw, encoding);
  const html = decoded.toString("utf-8");
  const next = encodeURIComponent(reqUrl || "/");
  const currentId = getRouteId(currentRoute);
  const routeCount = String(routes.length);
  const clearHref = `${CONTROL_PREFIX}/clear?next=${next}`;
  const links = routes
    .map((route) => {
      const id = getRouteId(route);
      const selected = id === currentId;
      const href = `${CONTROL_PREFIX}/select?id=${encodeURIComponent(id)}&next=${next}`;
      const detailRows = getRouteDetails(route)
        .map(
          ([label, value]) =>
            `<span class="pl-row"><span>${escapeHtml(label)}</span><code>${escapeHtml(value)}</code></span>`
        )
        .join("");
      return `<div class="pl-app${selected ? " pl-active" : ""}"><div class="pl-app-top"><span class="pl-dot"></span><span class="pl-title">${escapeHtml(route.folder || route.hostname)}</span><span class="pl-port">${escapeHtml(String(route.port))}</span></div><div class="pl-details">${detailRows}</div><div class="pl-actions"><a class="pl-select" href="${href}">${selected ? "Selected" : "Select"}</a></div></div>`;
    })
    .join("");
  const widget = `<div class="pl-switcher" aria-label="Portless app switcher"><input id="pl-switcher-toggle" type="checkbox" class="pl-toggle"><label for="pl-switcher-toggle" class="pl-icon" title="Switch portless app"><span class="pl-mark">p</span><span class="pl-count">${escapeHtml(routeCount)}</span></label><div class="pl-panel"><div class="pl-head"><div><p>portless</p><strong>${escapeHtml(host)}</strong></div><label for="pl-switcher-toggle" aria-label="Collapse portless app switcher">close</label></div><div class="pl-list">${links}</div><div class="pl-foot"><a class="pl-clear" href="${clearHref}">Clear selection</a></div></div><style>
.pl-switcher{--pl-bg:#fff;--pl-fg:#111;--pl-muted:#666;--pl-soft:#f6f6f6;--pl-border:rgba(0,0,0,.13);--pl-active:#eef6ff;--pl-active-border:#60a5fa;position:fixed;right:16px;bottom:16px;z-index:2147483647;font:13px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--pl-fg)}
@media (prefers-color-scheme:dark){.pl-switcher{--pl-bg:#0b0b0b;--pl-fg:#f4f4f5;--pl-muted:#a1a1aa;--pl-soft:#18181b;--pl-border:rgba(255,255,255,.16);--pl-active:#082f49;--pl-active-border:#38bdf8}}
.pl-switcher *{box-sizing:border-box}
.pl-toggle{position:absolute;inline-size:1px;block-size:1px;opacity:0;pointer-events:none}
.pl-icon{display:flex;align-items:center;justify-content:center;inline-size:46px;block-size:46px;border:1px solid var(--pl-border);border-radius:999px;background:var(--pl-bg);box-shadow:0 14px 40px rgba(0,0,0,.22);cursor:pointer;user-select:none}
.pl-mark{font-weight:700;letter-spacing:0;color:var(--pl-fg)}
.pl-count{position:absolute;right:-2px;top:-3px;min-inline-size:18px;block-size:18px;padding:0 5px;border-radius:999px;background:var(--pl-fg);color:var(--pl-bg);font-size:11px;font-weight:700;line-height:18px;text-align:center}
.pl-panel{display:none;inline-size:min(440px,calc(100vw - 32px));max-block-size:min(620px,calc(100vh - 32px));overflow:hidden;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-bg);box-shadow:0 22px 70px rgba(0,0,0,.28)}
.pl-toggle:checked~.pl-icon{display:none}
.pl-toggle:checked~.pl-panel{display:block}
.pl-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:14px 14px 12px;border-bottom:1px solid var(--pl-border)}
.pl-head p{margin:0 0 2px;color:var(--pl-muted);font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:0}
.pl-head strong{display:block;max-inline-size:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px}
.pl-head label{color:var(--pl-muted);font-size:12px;cursor:pointer}
.pl-list{display:grid;gap:8px;max-block-size:520px;overflow:auto;padding:10px}
.pl-app{display:block;padding:10px;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-soft);color:inherit}
.pl-app:hover{border-color:var(--pl-active-border)}
.pl-active{background:var(--pl-active);border-color:var(--pl-active-border)}
.pl-app-top{display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;gap:8px}
.pl-dot{inline-size:7px;block-size:7px;border-radius:999px;background:var(--pl-muted)}
.pl-active .pl-dot{background:var(--pl-active-border)}
.pl-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700}
.pl-port{color:var(--pl-muted);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.pl-details{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;margin-top:10px}
.pl-row{min-width:0}
.pl-row span{display:block;margin-bottom:2px;color:var(--pl-muted);font-size:10px;font-weight:650;text-transform:uppercase;letter-spacing:0}
.pl-row code{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--pl-fg);font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
.pl-actions{display:flex;justify-content:flex-end;margin-top:10px}
.pl-select,.pl-clear{display:inline-flex;align-items:center;justify-content:center;min-block-size:30px;border-radius:6px;text-decoration:none;font-weight:700}
.pl-select{padding:0 11px;background:var(--pl-fg);color:var(--pl-bg)}
.pl-active .pl-select{border:1px solid var(--pl-border);background:transparent;color:var(--pl-fg)}
.pl-foot{display:flex;justify-content:flex-end;padding:0 10px 10px}
.pl-clear{padding:0 10px;border:1px solid var(--pl-border);color:var(--pl-muted);background:transparent}
.pl-clear:hover{color:var(--pl-fg);border-color:var(--pl-active-border)}
@media (max-width:460px){.pl-switcher{right:10px;bottom:10px}.pl-details{grid-template-columns:1fr}.pl-head strong{max-inline-size:230px}}
</style></div>`;
  const injected = html.includes("</body>")
    ? html.replace("</body>", `${widget}</body>`)
    : `${html}${widget}`;
  return encodeBody(Buffer.from(injected), encoding);
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
    multiplex = false,
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

    const matchingRoutes = findRoutes(routes, host, strict);
    if (multiplex && matchingRoutes.length > 1) {
      if (handlePortlessControl(req, res, host, matchingRoutes)) {
        return;
      }
    }
    const route =
      multiplex && matchingRoutes.length > 1
        ? routeFromCookie(matchingRoutes, req.headers.cookie)
        : matchingRoutes[0];

    if (!route) {
      if (multiplex && matchingRoutes.length > 1) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(renderSelectorPage(200, host, matchingRoutes, undefined, req.url || "/"));
        return;
      }
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
        const contentType = String(proxyRes.headers["content-type"] || "");
        const contentEncoding = String(proxyRes.headers["content-encoding"] || "").toLowerCase();
        const canInject =
          multiplex &&
          matchingRoutes.length > 1 &&
          req.method !== "HEAD" &&
          !isPortlessPath(req.url) &&
          contentType.includes("text/html") &&
          ["", "gzip", "br", "deflate"].includes(contentEncoding);
        if (!canInject) {
          res.writeHead(proxyRes.statusCode || 502, responseHeaders);
        }
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
        if (canInject) {
          const chunks: Buffer[] = [];
          let bufferedBytes = 0;
          let passthrough = false;
          const startPassthrough = () => {
            passthrough = true;
            delete responseHeaders["content-length"];
            res.writeHead(proxyRes.statusCode || 502, responseHeaders);
            for (const buffered of chunks) {
              res.write(buffered);
            }
            chunks.length = 0;
          };
          proxyRes.on("data", (chunk: Buffer) => {
            if (passthrough) {
              res.write(chunk);
              return;
            }
            bufferedBytes += chunk.length;
            chunks.push(chunk);
            if (bufferedBytes > MAX_SWITCHER_INJECTION_BYTES) {
              startPassthrough();
            }
          });
          proxyRes.on("end", () => {
            if (passthrough) {
              res.end();
              return;
            }
            injectSwitcher(chunks, responseHeaders, host, matchingRoutes, route, req.url)
              .then((body) => {
                delete responseHeaders["transfer-encoding"];
                responseHeaders["content-length"] = String(body.length);
                res.writeHead(proxyRes.statusCode || 502, responseHeaders);
                res.end(body);
              })
              .catch(() => {
                delete responseHeaders["content-length"];
                res.writeHead(proxyRes.statusCode || 502, responseHeaders);
                for (const chunk of chunks) res.write(chunk);
                res.end();
              });
          });
        } else {
          proxyRes.pipe(res);
        }
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
    const matchingRoutes = findRoutes(routes, host, strict);
    const route =
      multiplex && matchingRoutes.length > 1
        ? routeFromCookie(matchingRoutes, req.headers.cookie)
        : matchingRoutes[0];

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

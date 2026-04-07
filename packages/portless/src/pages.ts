import { GEIST_SANS_400, GEIST_SANS_500, GEIST_MONO_400, GEIST_PIXEL } from "./fonts.js";

export const ARROW_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 3.5L11 8l-4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const COPY_SVG =
  '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/></svg>';

const PAGE_STYLES = `
  @font-face {
    font-family: 'Geist';
    src: url('${GEIST_SANS_400}') format('woff2');
    font-weight: 400;
    font-display: swap;
  }
  @font-face {
    font-family: 'Geist';
    src: url('${GEIST_SANS_500}') format('woff2');
    font-weight: 500;
    font-display: swap;
  }
  @font-face {
    font-family: 'Geist Mono';
    src: url('${GEIST_MONO_400}') format('woff2');
    font-weight: 400;
    font-display: swap;
  }
  @font-face {
    font-family: 'Geist Pixel';
    src: url('${GEIST_PIXEL}') format('woff2');
    font-weight: 400;
    font-display: swap;
  }
  *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --bg: #fff;
    --fg: #171717;
    --border: #eaeaea;
    --surface: #fafafa;
    --text-2: #666;
    --text-3: #a1a1a1;
    --accent: #0070f3;
    --font-sans: 'Geist', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    --font-mono: 'Geist Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000;
      --fg: #ededed;
      --border: rgba(255,255,255,0.1);
      --surface: #111;
      --text-2: #888;
      --text-3: #666;
      --accent: #3291ff;
    }
  }
  html { height: 100%; }
  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--fg);
    min-height: 100%;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .page {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 24px;
  }
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .hero h1 {
    font-family: 'Geist Pixel', var(--font-mono);
    font-size: clamp(80px, 15vw, 144px);
    font-weight: 400;
    line-height: 1;
    letter-spacing: -0.04em;
    color: var(--fg);
  }
  .hero h2 {
    font-size: 13px;
    font-weight: 400;
    color: var(--text-3);
    margin-top: 16px;
    text-transform: uppercase;
    letter-spacing: 0.15em;
  }
  .content {
    margin-top: 56px;
    width: 100%;
    max-width: 480px;
  }
  .desc {
    font-size: 14px;
    color: var(--text-2);
    text-align: center;
    line-height: 1.7;
  }
  .desc strong {
    color: var(--fg);
    font-weight: 500;
  }
  .section { margin-top: 32px; }
  .label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-3);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin-bottom: 10px;
  }
  .card {
    list-style: none;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
  }
  .card > li {
    border-bottom: 1px solid var(--border);
  }
  .card > li:last-child { border-bottom: none; }
  .card-link {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    text-decoration: none;
    color: inherit;
    transition: background 0.15s ease;
  }
  .card-link:hover { background: var(--surface); }
  .card-link .name {
    font-size: 14px;
    font-weight: 500;
    transition: color 0.15s ease;
  }
  .card-link:hover .name { color: var(--accent); }
  .card-link .meta {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .card-link .port {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-3);
  }
  .card-link .arrow {
    color: var(--text-3);
    display: flex;
    transition: transform 0.2s ease, color 0.2s ease;
  }
  .card-link:hover .arrow {
    transform: translateX(2px);
    color: var(--text-2);
  }
  .terminal {
    font-family: var(--font-mono);
    font-size: 13px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 20px;
    line-height: 1.7;
    color: var(--fg);
  }
  .terminal .prompt {
    color: var(--text-3);
    user-select: none;
  }
  pre.terminal { white-space: pre-wrap; }
  .empty {
    font-size: 14px;
    color: var(--text-3);
    text-align: center;
    padding: 32px 0;
  }
  .footer {
    margin-top: 64px;
    font-size: 11px;
    color: var(--text-3);
    font-family: var(--font-mono);
    letter-spacing: 0.08em;
  }
  .dashboard-page {
    min-height: 100vh;
    padding: 32px 24px;
  }
  .dashboard-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    max-width: 720px;
    margin: 0 auto 32px;
  }
  .dashboard-header .brand {
    font-family: 'Geist Pixel', var(--font-mono);
    font-size: 18px;
    font-weight: 400;
    color: var(--fg);
  }
  .dashboard-header .version {
    font-size: 11px;
    color: var(--text-3);
    font-family: var(--font-mono);
  }
  .dashboard-content {
    max-width: 720px;
    margin: 0 auto;
  }
  .status-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-2);
    margin-bottom: 32px;
    flex-wrap: wrap;
  }
  .status-bar .dot {
    width: 8px;
    height: 8px;
    background: #10b981;
    border-radius: 50%;
  }
  .status-bar .separator {
    color: var(--border);
  }
  .route-count {
    color: var(--text-3);
  }
  .dashboard-section {
    margin-bottom: 32px;
  }
  .route-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    gap: 16px;
  }
  .route-item:last-child {
    border-bottom: none;
  }
  .route-info {
    display: flex;
    align-items: center;
    gap: 16px;
    flex: 1;
    min-width: 0;
  }
  .route-hostname {
    font-size: 14px;
    font-weight: 500;
    color: var(--fg);
    font-family: var(--font-sans);
    white-space: nowrap;
  }
  .route-meta {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-3);
    white-space: nowrap;
  }
  .route-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .icon-btn:hover {
    background: var(--surface);
    color: var(--text-2);
    border-color: var(--text-3);
  }
  .icon-btn.copied {
    color: #10b981;
    border-color: #10b981;
  }
  .open-link {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: transparent;
    color: var(--text-3);
    text-decoration: none;
    transition: all 0.15s ease;
  }
  .open-link:hover {
    background: var(--surface);
    color: var(--accent);
    border-color: var(--accent);
    transform: translateX(1px);
  }
  .empty-state {
    text-align: center;
    padding: 48px 24px;
    color: var(--text-3);
  }
  .empty-state p {
    font-size: 14px;
    margin-bottom: 16px;
  }
`;

export function renderPage(status: number, statusText: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${status} - ${statusText}</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
<div class="page">
<div class="hero"><h1>${status}</h1><h2>${statusText}</h2></div>
${body}
<p class="footer">portless</p>
</div>
</body>
</html>`;
}

export interface RouteInfo {
  hostname: string;
  port: number;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;")
    .replace(/'/g, "\u0026#39;");
}

function formatUrl(hostname: string, port: number, tls: boolean): string {
  const defaultPort = tls ? 443 : 80;
  const portSuffix = port === defaultPort ? "" : `:${port}`;
  return `${tls ? "https" : "http"}://${hostname}${portSuffix}`;
}

export function renderDashboardPage(
  routes: RouteInfo[],
  proxyPort: number,
  tls: boolean,
  tld: string
): string {
  const proto = tls ? "https" : "http";
  const protocolLabel = tls ? "HTTPS" : "HTTP";
  const portLabel = proxyPort === 443 || proxyPort === 80 ? "" : `:${proxyPort}`;
  const tldDisplay = tld === "localhost" ? ".localhost" : `.${tld}`;

  const routeCountText = routes.length === 0
    ? "No active routes"
    : routes.length === 1
    ? "1 active route"
    : `${routes.length} active routes`;

  const routesList = routes.length > 0
    ? `<ul class="card">${routes.map((r) => {
        const url = formatUrl(r.hostname, proxyPort, tls);
        const escapedHostname = escapeHtml(r.hostname);
        const escapedPort = escapeHtml(String(r.port));
        const escapedUrl = escapeHtml(url);
        return `<li class="route-item">
  <div class="route-info">
    <span class="route-hostname">${escapedHostname}</span>
    <span class="route-meta">127.0.0.1:${escapedPort}</span>
  </div>
  <div class="route-actions">
    <button class="icon-btn" onclick="copyToClipboard('${escapedUrl}', this)" title="Copy URL">${COPY_SVG}</button>
    <a href="${escapedUrl}" class="open-link" target="_blank" title="Open">${ARROW_SVG}</a>
  </div>
</li>`;
      }).join("")}</ul>`
    : `<div class="card empty-state"><p>No apps running.</p><div class="terminal"><span class="prompt">$ </span>portless myapp your-command</div></div>`;

  const body = `<div class="dashboard-content">
<div class="status-bar">
  <span class="dot"></span>
  <span>${protocolLabel} on port ${proxyPort}</span>
  <span class="separator">|</span>
  <span>TLD: ${escapeHtml(tldDisplay)}</span>
  <span class="separator">|</span>
  <span class="route-count">${routeCountText}</span>
</div>
<div class="dashboard-section">
  <p class="label">Active Apps</p>
  ${routesList}
</div>
</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>portless dashboard</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
<div class="dashboard-page">
<div class="dashboard-header">
  <span class="brand">portless</span>
  <span class="version">v0.10.0</span>
</div>
${body}
</div>
<script>
function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1500);
  });
}
</script>
</body>
</html>`;
}
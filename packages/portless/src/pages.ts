import { GEIST_SANS_400, GEIST_SANS_500, GEIST_MONO_400, GEIST_PIXEL } from "./fonts.js";

export const ARROW_SVG =
  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 3.5L11 8l-4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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

/**
 * Detect the client OS from a User-Agent string.
 * Returns "mac", "windows", "linux", or "unknown".
 */
export function detectOS(userAgent: string): "mac" | "windows" | "linux" | "unknown" {
  const ua = userAgent.toLowerCase();
  if (ua.includes("mac") || ua.includes("darwin") || ua.includes("iphone") || ua.includes("ipad"))
    return "mac";
  if (ua.includes("windows") || ua.includes("win32") || ua.includes("win64")) return "windows";
  if (ua.includes("linux") || ua.includes("android")) return "linux";
  return "unknown";
}

const CERT_PAGE_STYLES = `
  .cert-header { text-align: center; }
  .cert-header h2 { font-size: 20px; font-weight: 500; margin-bottom: 8px; }
  .cert-header p { font-size: 14px; color: var(--text-2); }
  .download-btn {
    display: inline-block;
    margin-top: 20px;
    padding: 10px 24px;
    background: var(--accent);
    color: #fff;
    border-radius: 8px;
    text-decoration: none;
    font-size: 14px;
    font-weight: 500;
    transition: opacity 0.15s;
  }
  .download-btn:hover { opacity: 0.85; }
  .os-tabs {
    display: flex;
    gap: 0;
    margin-top: 32px;
    border-bottom: 1px solid var(--border);
  }
  .os-tab {
    padding: 10px 16px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-3);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
    font-family: var(--font-sans);
  }
  .os-tab.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .os-panel { display: none; margin-top: 20px; }
  .os-panel.active { display: block; }
  .os-panel ol {
    font-size: 14px;
    color: var(--text-2);
    line-height: 1.8;
    padding-left: 20px;
  }
  .os-panel li { margin-bottom: 4px; }
  .ssh-hint {
    margin-top: 32px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
  }
  .ssh-hint p {
    font-size: 13px;
    color: var(--text-3);
    margin-bottom: 8px;
  }
`;

function macInstructions(): string {
  return `<ol>
    <li>Click the download button above to save <strong>portless-ca.pem</strong></li>
    <li>Double-click the downloaded file to open it in <strong>Keychain Access</strong></li>
    <li>If prompted, select the <strong>login</strong> keychain and click Add</li>
    <li>Find "portless Local CA" in the list and double-click it</li>
    <li>Expand the <strong>Trust</strong> section</li>
    <li>Set "When using this certificate" to <strong>Always Trust</strong></li>
    <li>Close the window and authenticate when prompted</li>
  </ol>
  <p class="label" style="margin-top:16px">Or from the terminal:</p>
  <pre class="terminal">sudo security add-trusted-cert -d -r trustRoot \\
  -k /Library/Keychains/System.keychain portless-ca.pem</pre>`;
}

function windowsInstructions(): string {
  return `<ol>
    <li>Click the download button above to save <strong>portless-ca.pem</strong></li>
    <li>Double-click the downloaded file to open the certificate dialog</li>
    <li>Click <strong>Install Certificate...</strong></li>
    <li>Choose <strong>Current User</strong> (or Local Machine for all users)</li>
    <li>Select <strong>Place all certificates in the following store</strong></li>
    <li>Click <strong>Browse</strong> and select <strong>Trusted Root Certification Authorities</strong></li>
    <li>Click Next, then Finish</li>
    <li>Accept the security warning</li>
  </ol>
  <p class="label" style="margin-top:16px">Or from the terminal (PowerShell):</p>
  <pre class="terminal">certutil -addstore -user Root portless-ca.pem</pre>`;
}

function linuxInstructions(): string {
  return `<ol>
    <li>Click the download button above to save <strong>portless-ca.pem</strong></li>
    <li>Copy it to the system CA directory and update the trust store</li>
  </ol>
  <p class="label" style="margin-top:16px">Debian / Ubuntu:</p>
  <pre class="terminal">sudo cp portless-ca.pem /usr/local/share/ca-certificates/portless-ca.crt
sudo update-ca-certificates</pre>
  <p class="label" style="margin-top:16px">Fedora / RHEL:</p>
  <pre class="terminal">sudo cp portless-ca.pem /etc/pki/ca-trust/source/anchors/portless-ca.crt
sudo update-ca-trust</pre>
  <p class="label" style="margin-top:16px">Arch:</p>
  <pre class="terminal">sudo cp portless-ca.pem /etc/ca-certificates/trust-source/anchors/portless-ca.crt
sudo update-ca-trust</pre>`;
}

/**
 * Render the CA certificate download and trust instructions page.
 * Shows OS-specific instructions based on the User-Agent, with
 * tabs to switch between operating systems.
 */
export function renderCertPage(detectedOs: "mac" | "windows" | "linux" | "unknown"): string {
  const osOrder: Array<"mac" | "windows" | "linux"> =
    detectedOs === "unknown"
      ? ["mac", "windows", "linux"]
      : [detectedOs, ...(["mac", "windows", "linux"] as const).filter((os) => os !== detectedOs)];

  const osLabels: Record<string, string> = {
    mac: "macOS",
    windows: "Windows",
    linux: "Linux",
  };

  const osPanels: Record<string, string> = {
    mac: macInstructions(),
    windows: windowsInstructions(),
    linux: linuxInstructions(),
  };

  const tabsHtml = osOrder
    .map(
      (os, i) =>
        `<button class="os-tab${i === 0 ? " active" : ""}" data-os="${os}">${osLabels[os]}</button>`
    )
    .join("");

  const panelsHtml = osOrder
    .map(
      (os, i) =>
        `<div class="os-panel${i === 0 ? " active" : ""}" data-os="${os}">${osPanels[os]}</div>`
    )
    .join("");

  const detectedLabel =
    detectedOs !== "unknown" ? `<p>Detected OS: <strong>${osLabels[detectedOs]}</strong></p>` : "";

  const body = `<div class="content">
    <div class="cert-header">
      <h2>Install the portless CA Certificate</h2>
      ${detectedLabel}
      <a class="download-btn" href="/download">Download Certificate</a>
    </div>
    <div class="os-tabs">${tabsHtml}</div>
    ${panelsHtml}
    <div class="ssh-hint">
      <p>Alternatively, copy the certificate from a remote machine via SSH:</p>
      <pre class="terminal">ssh &lt;remote-host&gt; portless cert &gt; portless-ca.pem</pre>
    </div>
  </div>`;

  const js = `<script>
  document.querySelectorAll('.os-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var os = this.getAttribute('data-os');
      document.querySelectorAll('.os-tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.os-panel').forEach(function(p) { p.classList.remove('active'); });
      this.classList.add('active');
      document.querySelector('.os-panel[data-os="' + os + '"]').classList.add('active');
    });
  });
  </script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Install CA Certificate</title>
<style>${PAGE_STYLES}${CERT_PAGE_STYLES}</style>
</head>
<body>
<div class="page">
${body}
<p class="footer">portless</p>
</div>
${js}
</body>
</html>`;
}

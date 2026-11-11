import { createHash, X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { encode, renderUnicodeCompact } from "uqr";
import { renderBrandedPage } from "./pages.js";
import { escapeHtml } from "./utils.js";

/** How long `portless trust --device` serves the CA before it exits. */
export const DEVICE_TRUST_MS = 10 * 60 * 1000;

export interface DeviceCA {
  name: string;
  pem: string;
  der: Buffer;
  /** SHA-256 of the DER certificate, as colon-separated hex. */
  fingerprint: string;
}

export type DevicePlatform = "ios" | "android" | "other";

const FILES = {
  profile: "portless-ca.mobileconfig",
  der: "portless-ca.crt",
  pem: "portless-ca.pem",
} as const;

/** Reads the CA certificate in a state directory. Never reads the key. */
export function readDeviceCA(stateDir: string): DeviceCA {
  const pem = fs.readFileSync(path.join(stateDir, "ca.pem"), "utf-8");
  const cert = new X509Certificate(pem);
  const name = /CN=([^,\n]+)/.exec(cert.subject)?.[1] ?? "portless Local CA";
  return { name, pem, der: cert.raw, fingerprint: cert.fingerprint256 };
}

/**
 * iPadOS reports a desktop Safari user agent, so it is detected as "other" and
 * still finds the profile among the other formats.
 */
export function detectPlatform(userAgent: string | undefined): DevicePlatform {
  if (!userAgent) return "other";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return "other";
}

/**
 * The QR code as terminal text, two module rows per line. With color it is black
 * on white whatever the terminal theme, and cells dark in both rows are drawn as
 * background, so rows join without the gaps block glyphs leave in many fonts.
 * Without color it falls back to half blocks drawn for a dark terminal.
 */
export function renderTerminalQr(text: string, color: boolean): string {
  if (!color) return renderUnicodeCompact(text, { border: 2 });
  const { data } = encode(text, { border: 2 });
  const lines: string[] = [];
  for (let y = 0; y < data.length; y += 2) {
    let line = "";
    for (let x = 0; x < data.length; x++) {
      const top = data[y][x];
      const bottom = data[y + 1]?.[x] ?? false;
      if (top && bottom) line += "\x1b[40m ";
      else if (top) line += "\x1b[30;107m\u2580";
      else if (bottom) line += "\x1b[30;107m\u2584";
      else line += "\x1b[107m ";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

/** A stable UUID derived from the CA, so installing the profile again replaces it. */
function uuidFrom(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `a${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** An iOS configuration profile with the CA as a trusted root payload. */
export function mobileconfig(ca: DeviceCA): string {
  const name = escapeHtml(ca.name);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key><string>portless-ca.cer</string>
      <key>PayloadContent</key><data>${ca.der.toString("base64")}</data>
      <key>PayloadDescription</key><string>Trusts HTTPS from the portless proxy on a developer's machine.</string>
      <key>PayloadDisplayName</key><string>${name}</string>
      <key>PayloadIdentifier</key><string>sh.portless.ca.certificate</string>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadUUID</key><string>${uuidFrom(`certificate:${ca.fingerprint}`)}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>${name}</string>
  <key>PayloadIdentifier</key><string>sh.portless.ca</string>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuidFrom(`profile:${ca.fingerprint}`)}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}

function steps(platform: DevicePlatform, name: string, base: string): string {
  if (platform === "ios") {
    return `<ol class="steps">
<li><a class="button" href="${base}${FILES.profile}">Download the profile</a>Tap <strong>Allow</strong>. iOS saves the profile and installs it from Settings.</li>
<li>Open <strong>Settings</strong>, tap <strong>Profile Downloaded</strong>, then <strong>Install</strong>.</li>
<li>Go to <strong>Settings &gt; General &gt; About &gt; Certificate Trust Settings</strong> and turn on <strong>${name}</strong>. Safari keeps warning until you do.</li>
<li>Open your app at its <strong>.local</strong> address.</li>
</ol>`;
  }
  if (platform === "android") {
    return `<ol class="steps">
<li><a class="button" href="${base}${FILES.der}">Download the certificate</a>Android saves the file but installs a CA certificate only from Settings.</li>
<li>Open <strong>Settings</strong> and search for <strong>CA certificate</strong>. The path differs by phone, usually under Security, then Encryption &amp; credentials.</li>
<li>Tap <strong>Install anyway</strong> and pick <strong>${FILES.der}</strong> from Downloads.</li>
<li>Restart Chrome, then open your app at its <strong>.local</strong> address. Most apps other than browsers ignore certificates you add.</li>
</ol>`;
  }
  return `<ol class="steps">
<li><a class="button" href="${base}${FILES.pem}">Download the certificate</a>A PEM file, for computers and other devices.</li>
<li>Add it to the device's trusted root certificates. On a Mac, open it and set it to <strong>Always Trust</strong> in Keychain Access.</li>
<li>Open your app at its <strong>.local</strong> address.</li>
</ol>`;
}

/** The page a device opens from the QR code. `base` is the served path, ending in "/". */
export function deviceTrustPage(ca: DeviceCA, platform: DevicePlatform, base: string): string {
  const name = escapeHtml(ca.name);
  const body = `<div class="content">
<p class="desc">Trust <strong>${name}</strong> on this device to open apps served by portless in LAN mode over HTTPS.</p>
<div class="section">
<p class="label">Fingerprint (SHA-256)</p>
<p class="terminal">${escapeHtml(ca.fingerprint).replaceAll(":", ":<wbr>")}</p>
<p class="hint">Check that it matches the one in the terminal.</p>
</div>
<div class="section">
<p class="label">Install</p>
${steps(platform, name, base)}
</div>
<p class="formats section">Other formats: <a href="${base}${FILES.profile}">iOS profile</a> &middot; <a href="${base}${FILES.der}">DER</a> &middot; <a href="${base}${FILES.pem}">PEM</a></p>
</div>`;
  return renderBrandedPage(`Trust ${name}`, "portless", "Trust the local CA", body);
}

/**
 * Serves the page and the CA's certificate in each format under `/<token>/`.
 * Anything else is 404. `onServe` hears each file served, "" for the page.
 */
export function createDeviceTrustHandler(
  ca: DeviceCA,
  token: string,
  onServe?: (file: string, userAgent: string | undefined) => void
): (req: IncomingMessage, res: ServerResponse) => void {
  const base = `/${token}/`;
  return (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://device").pathname;
    const file = pathname.startsWith(base) ? pathname.slice(base.length) : null;
    const userAgent = req.headers["user-agent"];
    const send = (type: string, body: string | Buffer, download?: string) => {
      res.writeHead(200, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(download ? { "Content-Disposition": `attachment; filename="${download}"` } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      onServe?.(file ?? "", userAgent);
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    if (file === "") {
      send("text/html; charset=utf-8", deviceTrustPage(ca, detectPlatform(userAgent), base));
    } else if (file === FILES.profile) {
      send("application/x-apple-aspen-config", mobileconfig(ca));
    } else if (file === FILES.der) {
      send("application/x-x509-ca-cert", ca.der, FILES.der);
    } else if (file === FILES.pem) {
      send("application/x-pem-file", ca.pem, FILES.pem);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    }
  };
}

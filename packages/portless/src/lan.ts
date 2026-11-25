import { createHash, randomBytes, X509Certificate } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { encode, renderUnicodeCompact } from "uqr";
import colors, { stdoutColor } from "./colors.js";
import { getLocalNetworkIp } from "./lan-ip.js";
import { getMdnsDaemonProblem } from "./mdns.js";
import { renderBrandedPage } from "./pages.js";
import { escapeHtml } from "./utils.js";

export { getLocalNetworkIp } from "./lan-ip.js";
export {
  getMdnsDaemonProblem,
  isMdnsSupported,
  LAN_IP_POLL_INTERVAL_MS,
  reconcile as reconcileMdns,
  startLanIpMonitor,
} from "./mdns.js";

export function describeMdnsDiscovery(): string {
  const mdnsDaemonProblem = getMdnsDaemonProblem();
  return mdnsDaemonProblem
    ? colors.yellow(
        `Services will be discoverable as <name>.local once the mDNS daemon is available: ${mdnsDaemonProblem}`
      )
    : colors.gray("Services are discoverable as <name>.local on your network");
}

export const DEVICE_TRUST_MS = 10 * 60 * 1000;

export interface DeviceCA {
  name: string;
  pem: string;
  der: Buffer;
  fingerprint: string;
}

export type DevicePlatform = "ios" | "android" | "other";

const FILES = {
  profile: "portless-ca.mobileconfig",
  der: "portless-ca.crt",
  pem: "portless-ca.pem",
} as const;

export function readDeviceCA(stateDir: string): DeviceCA {
  const raw = fs.readFileSync(path.join(stateDir, "ca.pem"), "utf-8");
  const cert = new X509Certificate(raw);
  const name = /CN=([^,\n]+)/.exec(cert.subject)?.[1] ?? "portless Local CA";
  return { name, pem: cert.toString(), der: cert.raw, fingerprint: cert.fingerprint256 };
}

export function detectDevicePlatform(userAgent: string | undefined): DevicePlatform {
  if (!userAgent) return "other";
  if (/iPhone|iPad|iPod/.test(userAgent)) return "ios";
  if (/Android/.test(userAgent)) return "android";
  return "other";
}

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

export function buildMobileConfig(ca: DeviceCA): string {
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

export function renderDeviceTrustPage(
  ca: DeviceCA,
  platform: DevicePlatform,
  base: string
): string {
  const name = escapeHtml(ca.name);
  base = escapeHtml(base);
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

export function createDeviceTrustHandler(
  ca: DeviceCA,
  token: string,
  onServe?: (file: string, userAgent: string | undefined) => void
): (req: IncomingMessage, res: ServerResponse) => void {
  const base = `/${token}/`;
  return (req, res) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://device").pathname;
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" }).end("Bad request");
      return;
    }
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
      send(
        "text/html; charset=utf-8",
        renderDeviceTrustPage(ca, detectDevicePlatform(userAgent), base)
      );
    } else if (file === FILES.profile) {
      send("application/x-apple-aspen-config", buildMobileConfig(ca));
    } else if (file === FILES.der) {
      send("application/x-x509-ca-cert", ca.der, FILES.der);
    } else if (file === FILES.pem) {
      send("application/x-pem-file", ca.pem, FILES.pem);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    }
  };
}

export async function serveDeviceTrust(stateDir: string): Promise<boolean> {
  const ca = readDeviceCA(stateDir);
  const ip = await getLocalNetworkIp();
  if (!ip) {
    console.error(colors.red("No LAN address found for a device to reach."));
    console.error(
      colors.blue("Connect this machine to the same network as the device and try again.")
    );
    return false;
  }

  const token = randomBytes(16).toString("base64url");
  const server = http.createServer(
    createDeviceTrustHandler(ca, token, (file, userAgent) => {
      const agent = (userAgent ?? "unknown device").slice(0, 60).replace(/\p{Cc}/gu, " ");
      console.log(`${new Date().toISOString()} ${agent}: ${file || "opened the page"}`);
    })
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine server port");
  const url = `http://${ip}:${address.port}/${token}/`;
  console.log("Scan this QR code with your device:");
  console.log(renderTerminalQr(url, stdoutColor));
  console.log(colors.cyan(url));
  console.log(`SHA-256 ${ca.fingerprint}`);
  console.log("Start the proxy in LAN mode with portless proxy start --lan.");
  console.log("Serving for ten minutes. Press Ctrl+C to stop sooner.");

  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timeout);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    };
    const timeout = setTimeout(stop, DEVICE_TRUST_MS);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return true;
}

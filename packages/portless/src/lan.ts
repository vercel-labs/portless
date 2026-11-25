import { randomBytes, X509Certificate } from "node:crypto";
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
  ios: "portless-ca.cer",
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

function steps(platform: DevicePlatform, name: string, base: string): string {
  if (platform === "ios") {
    return `<ol class="steps">
<li><a class="button" href="${base}${FILES.ios}">Download the certificate</a>Tap <strong>Allow</strong>. iOS saves the certificate so you can install it from Settings.</li>
<li>Open <strong>Settings</strong>, tap <strong>Profile Downloaded</strong>, verify the SHA-256 fingerprint under <strong>More Details</strong> against the terminal, then tap <strong>Install</strong>.</li>
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
<p class="hint">Compare the fingerprint in the terminal with the downloaded certificate details before trusting it.</p>
</div>
<div class="section">
<p class="label">Install</p>
${steps(platform, name, base)}
</div>
<p class="formats section">Other formats: <a href="${base}${FILES.ios}">iOS (DER)</a> &middot; <a href="${base}${FILES.der}">Android (DER)</a> &middot; <a href="${base}${FILES.pem}">PEM</a></p>
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
    } else if (file === FILES.ios) {
      send("application/x-x509-ca-cert", ca.der);
    } else if (file === FILES.der) {
      send("application/x-x509-ca-cert", ca.der, FILES.der);
    } else if (file === FILES.pem) {
      send("application/x-pem-file", ca.pem, FILES.pem);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    }
  };
}

type DeviceTrustServerState =
  | { state: "starting" }
  | { state: "listening"; server: http.Server }
  | { state: "stopping"; done: Promise<void> }
  | { state: "stopped" };

export type DeviceTrustStartResult =
  | {
      ok: true;
      ca: DeviceCA;
      ip: string;
      port: number;
      url: string;
      closed: Promise<void>;
      stop: () => Promise<void>;
    }
  | { ok: false; code: "no-lan-ip" | "bind-failed"; message: string };

export interface DeviceTrustServerOptions {
  resolveIp?: () => Promise<string | null>;
  onServe?: (file: string, userAgent: string | undefined) => void;
}

function formatUrlHost(ip: string): string {
  return ip.includes(":") && !ip.startsWith("[") ? `[${ip}]` : ip;
}

/**
 * Start the ephemeral HTTP onboarding server bound strictly to the resolved LAN IP.
 */
export async function startDeviceTrustServer(
  stateDir: string,
  options: DeviceTrustServerOptions = {}
): Promise<DeviceTrustStartResult> {
  const ca = readDeviceCA(stateDir);
  const ip = await (options.resolveIp ?? getLocalNetworkIp)();
  if (!ip) {
    return {
      ok: false,
      code: "no-lan-ip",
      message: "No LAN address found for a device to reach.",
    };
  }

  let lifecycle: DeviceTrustServerState = { state: "starting" };
  const token = randomBytes(16).toString("base64url");
  const server = http.createServer(createDeviceTrustHandler(ca, token, options.onServe));
  let markClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const stop = (): Promise<void> => {
    if (lifecycle.state === "stopped") return Promise.resolve();
    if (lifecycle.state === "stopping") return lifecycle.done;
    if (lifecycle.state === "starting") {
      lifecycle = { state: "stopped" };
      markClosed();
      return Promise.resolve();
    }
    const activeServer = lifecycle.server;
    const done = new Promise<void>((resolve) => {
      activeServer.close(() => {
        lifecycle = { state: "stopped" };
        markClosed();
        resolve();
      });
      activeServer.closeAllConnections();
    });
    lifecycle = { state: "stopping", done };
    return done;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, ip);
    });
  } catch (error) {
    lifecycle = { state: "stopped" };
    markClosed();
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "bind-failed",
      message: `Could not bind device trust server on ${ip}: ${detail}`,
    };
  }

  lifecycle = { state: "listening", server };
  server.on("error", () => {
    void stop();
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await stop();
    return {
      ok: false,
      code: "bind-failed",
      message: `Could not determine bound port on ${ip}.`,
    };
  }

  const boundIp = address.address;
  const url = `http://${formatUrlHost(boundIp)}:${address.port}/${token}/`;
  return { ok: true, ca, ip: boundIp, port: address.port, url, closed, stop };
}

export async function serveDeviceTrust(stateDir: string): Promise<boolean> {
  const started = await startDeviceTrustServer(stateDir, {
    onServe: (file, userAgent) => {
      const agent = (userAgent ?? "unknown device").slice(0, 60).replace(/\p{Cc}/gu, " ");
      console.log(`${new Date().toISOString()} ${agent}: ${file || "opened the page"}`);
    },
  });
  if (!started.ok) {
    console.error(colors.red(started.message));
    if (started.code === "no-lan-ip") {
      console.error(
        colors.blue("Connect this machine to the same network as the device and try again.")
      );
    }
    return false;
  }

  console.log("Scan this QR code with your device on a trusted local network:");
  console.log(renderTerminalQr(started.url, stdoutColor));
  console.log(colors.cyan(started.url));
  console.log(`SHA-256 ${started.ca.fingerprint}`);
  console.log(
    "Before trusting the downloaded CA, compare this SHA-256 fingerprint against the certificate details in device settings (do not rely on the webpage alone)."
  );
  console.log("Start the proxy in LAN mode with portless proxy start --lan.");
  console.log("Serving for ten minutes. Press Ctrl+C to stop sooner.");

  const onSignal = () => {
    void started.stop();
  };
  const timeout = setTimeout(onSignal, DEVICE_TRUST_MS);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await started.closed;
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  return true;
}

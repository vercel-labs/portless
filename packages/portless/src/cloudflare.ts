import { writeFileSync } from "node:fs";
import {
  ensureTunnelAvailable,
  normalizeSpace,
  startTunnel,
  type StartNgrokOptions,
  type TunnelCommandRunner,
  type TunnelProvider,
} from "./tunnel.js";

export function buildCloudflareArgs(port: number, host: string, config: string) {
  const flags = ["--no-autoupdate", "--grace-period", "1s", "--config", config];
  return ["tunnel", ...flags, "--url", `http://127.0.0.1:${port}`, "--http-host-header", host];
}

export function extractCloudflareUrl(output: string) {
  const url = output.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  return url && /Registered tunnel connection|Connection \S+ registered/.test(output) ? url : null;
}

const cloudflare = (host = "", config = ""): TunnelProvider => ({
  binary: "cloudflared",
  versionArgs: ["--version"],
  buildArgs: (port) => buildCloudflareArgs(port, host, config),
  extractUrl: extractCloudflareUrl,
  formatOutputError: (output) => {
    const errors = output.match(/.* ERR .*/g) ?? [];
    const details = errors.map(normalizeSpace).join(" ") || "cloudflared exited before connecting";
    return new Error(`Failed to start Cloudflare tunnel: ${details}`);
  },
  notFound:
    "cloudflared CLI not found. Install cloudflared (https://developers.cloudflare.com/tunnel/downloads/) and ensure `cloudflared` is on PATH.",
  timeout:
    "Timed out waiting for cloudflared to connect. Check that outbound UDP port 7844 is open, or set TUNNEL_TRANSPORT_PROTOCOL=http2 and try again.",
});

export function ensureCloudflaredAvailable(runner?: TunnelCommandRunner): void {
  ensureTunnelAvailable(cloudflare(), runner);
}

export async function startCloudflare(
  port: number,
  options: StartNgrokOptions & { configPath: string }
) {
  writeFileSync(options.configPath, "{}");
  return startTunnel(cloudflare(options.hostHeader, options.configPath), port, options);
}

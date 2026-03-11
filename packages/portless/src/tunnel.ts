import { type ChildProcess, spawn, execFileSync } from "node:child_process";

/** Timeout (ms) waiting for a tunnel URL to become available. */
const TUNNEL_URL_TIMEOUT_MS = 30_000;

/** Polling interval (ms) when checking ngrok's local API for the tunnel URL. */
const NGROK_POLL_INTERVAL_MS = 500;

export interface TunnelProvider {
  /** Display name of the provider (e.g. "ngrok", "cloudflare"). */
  readonly name: string;

  /** Check if the tunnel CLI binary is installed and accessible. */
  isAvailable(): boolean;

  /**
   * Start a tunnel pointing at the given local port.
   * Resolves once the public URL is known.
   */
  start(localPort: number): Promise<TunnelInstance>;
}

export interface TunnelInstance {
  /** The public tunnel URL (e.g. https://abc123.ngrok-free.app). */
  url: string;

  /** The tunnel's child process. */
  process: ChildProcess;

  /** Gracefully stop the tunnel. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isCommandAvailable(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function waitForOutput(
  proc: ChildProcess,
  pattern: RegExp,
  stream: "stdout" | "stderr",
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for tunnel URL (${timeoutMs}ms)`));
    }, timeoutMs);

    const source = stream === "stdout" ? proc.stdout : proc.stderr;
    if (!source) {
      clearTimeout(timer);
      reject(new Error(`No ${stream} stream on tunnel process`));
      return;
    }

    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = pattern.exec(buffer);
      if (match) {
        clearTimeout(timer);
        source.removeListener("data", onData);
        resolve(match[1] || match[0]);
      }
    };
    source.on("data", onData);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      source.removeListener("data", onData);
      reject(new Error(`Tunnel process exited with code ${code} before URL was available`));
    });
  });
}

// ---------------------------------------------------------------------------
// ngrok provider
// ---------------------------------------------------------------------------

/**
 * ngrok tunnel provider.
 *
 * Starts `ngrok http <port>` and discovers the public URL by polling ngrok's
 * local management API at http://127.0.0.1:4040/api/tunnels.
 */
export const ngrokProvider: TunnelProvider = {
  name: "ngrok",

  isAvailable(): boolean {
    return isCommandAvailable("ngrok");
  },

  async start(localPort: number): Promise<TunnelInstance> {
    const proc = spawn("ngrok", ["http", String(localPort), "--log=stdout", "--log-format=json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // ngrok exposes a local API -- poll it for the tunnel URL
    const url = await pollNgrokApi(proc, TUNNEL_URL_TIMEOUT_MS);

    return {
      url,
      process: proc,
      stop() {
        if (!proc.killed) {
          proc.kill("SIGTERM");
        }
      },
    };
  },
};

async function pollNgrokApi(proc: ChildProcess, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Check if process died
    if (proc.exitCode !== null) {
      throw new Error(`ngrok exited with code ${proc.exitCode} before tunnel was ready`);
    }

    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (res.ok) {
        const data = (await res.json()) as {
          tunnels: Array<{ public_url: string; proto: string }>;
        };
        // Prefer HTTPS tunnel
        const httpsTunnel = data.tunnels.find((t) => t.proto === "https");
        const tunnel = httpsTunnel || data.tunnels[0];
        if (tunnel?.public_url) {
          return tunnel.public_url;
        }
      }
    } catch {
      // API not ready yet; retry
    }

    await new Promise((resolve) => setTimeout(resolve, NGROK_POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for ngrok tunnel URL (${timeoutMs}ms)`);
}

// ---------------------------------------------------------------------------
// Cloudflare Tunnel provider
// ---------------------------------------------------------------------------

/**
 * Cloudflare Tunnel (cloudflared) provider.
 *
 * Starts `cloudflared tunnel --url http://localhost:<port>` and parses the
 * public URL from stderr output (cloudflared prints it during startup).
 */
export const cloudflareProvider: TunnelProvider = {
  name: "cloudflare",

  isAvailable(): boolean {
    return isCommandAvailable("cloudflared");
  },

  async start(localPort: number): Promise<TunnelInstance> {
    const proc = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${localPort}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // cloudflared prints the URL to stderr like:
    //   ... | INF +-----------------------------------------------------------+
    //   ... | INF |  Your quick Tunnel has been created! Visit it at (it may   |
    //   ... | INF |  take some time to be reachable):                          |
    //   ... | INF |  https://random-words.trycloudflare.com                    |
    //   ... | INF +-----------------------------------------------------------+
    const url = await waitForOutput(
      proc,
      /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      "stderr",
      TUNNEL_URL_TIMEOUT_MS
    );

    return {
      url,
      process: proc,
      stop() {
        if (!proc.killed) {
          proc.kill("SIGTERM");
        }
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const providers: Record<string, TunnelProvider> = {
  ngrok: ngrokProvider,
  cloudflare: cloudflareProvider,
};

/** Known provider names. */
export const TUNNEL_PROVIDERS = Object.keys(providers);

/**
 * Get a tunnel provider by name.
 * Returns undefined if the provider is not known.
 */
export function getTunnelProvider(name: string): TunnelProvider | undefined {
  return providers[name];
}

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { triggerHostsSync } from "./cli-utils.js";
import { ensureCerts } from "./certs.js";
import {
  HOSTS_SYNC_AUTH_CHALLENGE_HEADER,
  HOSTS_SYNC_AUTH_PROOF_HEADER,
  createHostsSyncProof,
  writeHostsSyncToken,
} from "./hosts-sync-auth.js";
import { createProxyServer } from "./proxy.js";
import type { ProxyServer } from "./proxy.js";

describe("hosts-sync internal client", () => {
  const servers: ProxyServer[] = [];
  const dirs: string[] = [];
  let tls: { cert: Buffer; key: Buffer };

  function createDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-client-"));
    dirs.push(dir);
    return dir;
  }

  async function listenHttp(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
  ): Promise<{ port: number }> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");
    return { port: address.port };
  }

  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-tls-"));
    dirs.push(dir);
    const certs = ensureCerts(dir);
    tls = {
      cert: fs.readFileSync(certs.certPath),
      key: fs.readFileSync(certs.keyPath),
    };
  }, 30_000);

  afterEach(async () => {
    for (const server of servers) {
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers.length = 0;
  });

  async function start(
    stateDir: string,
    options: {
      clientToken?: string;
      daemonToken?: string;
      encrypted?: boolean;
      result?: "acted" | "disabled";
    } = {}
  ): Promise<{ port: number; calls: () => number }> {
    const daemonToken = options.daemonToken ?? "a".repeat(64);
    if (options.clientToken !== undefined) {
      writeHostsSyncToken(stateDir, options.clientToken);
    }
    let calls = 0;
    const server = createProxyServer({
      getRoutes: () => [],
      proxyPort: 1355,
      hostsSyncToken: daemonToken,
      onHostsSyncRequest: () => {
        calls += 1;
        return options.result ?? "acted";
      },
      ...(options.encrypted ? { tls } : {}),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");
    return { port: address.port, calls: () => calls };
  }

  it.each([
    ["acted over HTTP", false, "acted"],
    ["acted over HTTPS", true, "acted"],
    ["disabled", false, "disabled"],
  ] as const)("preserves the %s result", async (_name, encrypted, result) => {
    const dir = createDir();
    const token = "a".repeat(64);
    const running = await start(dir, { clientToken: token, encrypted, result });

    expect(await triggerHostsSync(running.port, encrypted, dir)).toBe(result);
    expect(running.calls()).toBe(1);
  });

  it.each([
    ["stale authorization", "a".repeat(64), "b".repeat(64)],
    ["missing authorization", undefined, "a".repeat(64)],
  ])("rejects %s", async (_name, clientToken, daemonToken) => {
    const dir = createDir();
    const running = await start(dir, { clientToken, daemonToken });

    expect(await triggerHostsSync(running.port, false, dir)).toBe("mute");
    expect(running.calls()).toBe(0);
  });

  it("does not disclose authorization to an older or marker-copying service", async () => {
    const dir = createDir();
    writeHostsSyncToken(dir, "a".repeat(64));
    let posts = 0;
    const server = await listenHttp((req, res) => {
      res.setHeader("X-Portless", "1");
      if (req.method === "POST") posts += 1;
      res.writeHead(req.method === "HEAD" ? 200 : 204);
      res.end();
    });

    expect(await triggerHostsSync(server.port, false, dir)).toBe("mute");
    expect(posts).toBe(0);
  });

  it("does not disclose authorization when the proof header is duplicated", async () => {
    const dir = createDir();
    const token = "a".repeat(64);
    writeHostsSyncToken(dir, token);
    let posts = 0;
    const server = await listenHttp((req, res) => {
      res.setHeader("X-Portless", "1");
      const challenge = req.headers[HOSTS_SYNC_AUTH_CHALLENGE_HEADER];
      if (req.method === "HEAD" && typeof challenge === "string") {
        const proof = createHostsSyncProof(token, challenge)!;
        res.setHeader(HOSTS_SYNC_AUTH_PROOF_HEADER, [proof, proof]);
      }
      if (req.method === "POST") posts += 1;
      res.writeHead(req.method === "HEAD" ? 200 : 204);
      res.end();
    });

    expect(await triggerHostsSync(server.port, false, dir)).toBe("mute");
    expect(posts).toBe(0);
  });

  it("shares one 500 ms deadline across capability discovery and the privileged request", async () => {
    const dir = createDir();
    const token = "a".repeat(64);
    writeHostsSyncToken(dir, token);
    const server = await listenHttp((req, res) => {
      res.setHeader("X-Portless", "1");
      const challenge = req.headers[HOSTS_SYNC_AUTH_CHALLENGE_HEADER];
      if (req.method === "HEAD" && typeof challenge === "string") {
        res.setHeader(HOSTS_SYNC_AUTH_PROOF_HEADER, createHostsSyncProof(token, challenge)!);
      }
      setTimeout(() => {
        res.writeHead(req.method === "POST" ? 204 : 200);
        res.end();
      }, 300);
    });
    const started = Date.now();

    expect(await triggerHostsSync(server.port, false, dir)).toBe("mute");
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(800);
  });

  it("uses the configured state directory by default", async () => {
    const dir = createDir();
    const previous = process.env.PORTLESS_STATE_DIR;
    process.env.PORTLESS_STATE_DIR = dir;
    const running = await start(dir, { clientToken: "a".repeat(64) });
    try {
      expect(await triggerHostsSync(running.port)).toBe("acted");
    } finally {
      if (previous === undefined) delete process.env.PORTLESS_STATE_DIR;
      else process.env.PORTLESS_STATE_DIR = previous;
    }
  });

  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });
});

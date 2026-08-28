import * as fs from "node:fs";
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
    ["HTTP", false],
    ["HTTPS", true],
  ])("preserves the current client result over %s", async (_name, encrypted) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-client-"));
    dirs.push(dir);
    const token = "a".repeat(64);
    const running = await start(dir, { clientToken: token, encrypted });

    expect(await triggerHostsSync(running.port, encrypted, dir)).toBe("acted");
    expect(running.calls()).toBe(1);
  });

  it("preserves the disabled result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-client-"));
    dirs.push(dir);
    const token = "a".repeat(64);
    const running = await start(dir, { clientToken: token, result: "disabled" });

    expect(await triggerHostsSync(running.port, false, dir)).toBe("disabled");
    expect(running.calls()).toBe(1);
  });

  it("rejects stale authorization after daemon rotation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-client-"));
    dirs.push(dir);
    const running = await start(dir, {
      clientToken: "a".repeat(64),
      daemonToken: "b".repeat(64),
    });

    expect(await triggerHostsSync(running.port, false, dir)).toBe("mute");
    expect(running.calls()).toBe(0);
  });

  it("does not send the privileged request when authorization state is unavailable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-client-"));
    dirs.push(dir);
    const running = await start(dir);

    expect(await triggerHostsSync(running.port, false, dir)).toBe("mute");
    expect(running.calls()).toBe(0);
  });

  it("does not disclose authorization to a service that only copies public markers", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-client-"));
    dirs.push(dir);
    writeHostsSyncToken(dir, "a".repeat(64));
    let posts = 0;
    const server = (await import("node:http")).createServer((req, res) => {
      res.setHeader("X-Portless", "1");
      res.setHeader("x-portless-hosts-sync-auth", "1");
      if (req.method === "POST") posts += 1;
      res.writeHead(req.method === "HEAD" ? 200 : 204);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");

    expect(await triggerHostsSync(address.port, false, dir)).toBe("mute");
    expect(posts).toBe(0);
  });

  it("does not disclose authorization when the proof header is duplicated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-client-"));
    dirs.push(dir);
    const token = "a".repeat(64);
    writeHostsSyncToken(dir, token);
    let posts = 0;
    const server = (await import("node:http")).createServer((req, res) => {
      res.setHeader("X-Portless", "1");
      const challenge = req.headers[HOSTS_SYNC_AUTH_CHALLENGE_HEADER];
      if (req.method === "HEAD" && typeof challenge === "string") {
        const proof = createHostsSyncProof(token, challenge)!;
        res.setHeader("x-portless-hosts-sync-auth", "1");
        res.setHeader(HOSTS_SYNC_AUTH_PROOF_HEADER, [proof, proof]);
      }
      if (req.method === "POST") posts += 1;
      res.writeHead(req.method === "HEAD" ? 200 : 204);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");

    expect(await triggerHostsSync(address.port, false, dir)).toBe("mute");
    expect(posts).toBe(0);
  });

  it("shares one 500 ms deadline across capability discovery and the privileged request", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-client-"));
    dirs.push(dir);
    const token = "a".repeat(64);
    writeHostsSyncToken(dir, token);
    const server = (await import("node:http")).createServer((req, res) => {
      res.setHeader("X-Portless", "1");
      res.setHeader("x-portless-hosts-sync-auth", "1");
      const challenge = req.headers[HOSTS_SYNC_AUTH_CHALLENGE_HEADER];
      if (req.method === "HEAD" && typeof challenge === "string") {
        res.setHeader(HOSTS_SYNC_AUTH_PROOF_HEADER, createHostsSyncProof(token, challenge)!);
      }
      setTimeout(() => {
        res.writeHead(req.method === "POST" ? 204 : 200);
        res.end();
      }, 300);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server not listening");
    const started = Date.now();

    expect(await triggerHostsSync(address.port, false, dir)).toBe("mute");
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(800);
  });

  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });
});

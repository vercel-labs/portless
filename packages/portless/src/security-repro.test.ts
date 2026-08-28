import { afterEach, describe, expect, it } from "vitest";
import * as http from "node:http";
import { createProxyServer, HOSTS_SYNC_PATH } from "./proxy.js";
import type { ProxyServer } from "./proxy.js";
import { HOSTS_SYNC_AUTH_HEADER } from "./hosts-sync-auth.js";

function listen(server: ProxyServer): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function request(
  server: ProxyServer,
  options: {
    method: string;
    headers: http.OutgoingHttpHeaders;
  }
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: HOSTS_SYNC_PATH,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("hosts-sync browser trust-boundary reproduction", () => {
  const servers: ProxyServer[] = [];
  const token = "a".repeat(64);

  afterEach(async () => {
    for (const server of servers) {
      if ("closeAllConnections" in server) {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    servers.length = 0;
  });

  it("rejects a cross-site simple POST before the stubbed callback", async () => {
    let calls = 0;
    const server = createProxyServer({
      getRoutes: () => [],
      proxyPort: 1355,
      hostsSyncToken: token,
      onHostsSyncRequest: () => {
        calls += 1;
        return "acted";
      },
    });
    servers.push(server);
    await listen(server);

    const result = await request(server, {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "content-type": "text/plain",
      },
    });

    expect(result.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("does not dispatch an OPTIONS preflight", async () => {
    let calls = 0;
    const server = createProxyServer({
      getRoutes: () => [],
      proxyPort: 1355,
      hostsSyncToken: token,
      onHostsSyncRequest: () => {
        calls += 1;
        return "acted";
      },
    });
    servers.push(server);
    await listen(server);

    const result = await request(server, {
      method: "OPTIONS",
      headers: {
        host: "127.0.0.1",
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-portless-hosts-sync",
      },
    });

    expect(result.status).not.toBe(204);
    expect(result.headers["access-control-allow-origin"]).toBeUndefined();
    expect(result.headers["access-control-allow-methods"]).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("accepts the current internal client capability", async () => {
    let calls = 0;
    const server = createProxyServer({
      getRoutes: () => [],
      proxyPort: 1355,
      hostsSyncToken: token,
      onHostsSyncRequest: () => {
        calls += 1;
        return "acted";
      },
    });
    servers.push(server);
    await listen(server);

    const result = await request(server, {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        [HOSTS_SYNC_AUTH_HEADER]: token,
      },
    });

    expect(result.status).toBe(204);
    expect(calls).toBe(1);
  });

  it.each([
    ["missing", undefined],
    ["malformed", "not-a-token"],
    ["incorrect", "b".repeat(64)],
  ])("rejects %s authorization before the stubbed callback", async (_name, value) => {
    let calls = 0;
    const server = createProxyServer({
      getRoutes: () => [],
      proxyPort: 1355,
      hostsSyncToken: token,
      onHostsSyncRequest: () => {
        calls += 1;
        return "acted";
      },
    });
    servers.push(server);
    await listen(server);

    const headers: http.OutgoingHttpHeaders = { host: "127.0.0.1" };
    if (value) headers[HOSTS_SYNC_AUTH_HEADER] = value;
    const result = await request(server, { method: "POST", headers });

    expect(result.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("rejects duplicated authorization before the stubbed callback", async () => {
    let calls = 0;
    const server = createProxyServer({
      getRoutes: () => [],
      proxyPort: 1355,
      hostsSyncToken: token,
      onHostsSyncRequest: () => {
        calls += 1;
        return "acted";
      },
    });
    servers.push(server);
    await listen(server);

    const result = await request(server, {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        [HOSTS_SYNC_AUTH_HEADER]: [token, token],
      },
    });

    expect(result.status).toBe(401);
    expect(calls).toBe(0);
  });

  it.each([
    ["external Origin", { origin: "https://attacker.example" }],
    ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }],
    ["same-site fetch metadata", { "sec-fetch-site": "same-site" }],
    ["same-origin fetch metadata", { "sec-fetch-site": "same-origin" }],
    ["navigation fetch metadata", { "sec-fetch-site": "none" }],
  ])("rejects valid authorization with browser %s", async (_name, provenance) => {
    let calls = 0;
    const server = createProxyServer({
      getRoutes: () => [],
      proxyPort: 1355,
      hostsSyncToken: token,
      onHostsSyncRequest: () => {
        calls += 1;
        return "acted";
      },
    });
    servers.push(server);
    await listen(server);

    const result = await request(server, {
      method: "POST",
      headers: {
        host: "127.0.0.1",
        [HOSTS_SYNC_AUTH_HEADER]: token,
        ...provenance,
      },
    });

    expect(result.status).toBe(401);
    expect(calls).toBe(0);
  });
});

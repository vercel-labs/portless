/** Run with Bun: bun packages/portless/scripts/test-bun-tls.ts */
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { createHash } from "node:crypto";
import { createProxyServer } from "../src/proxy.ts";
import { ensureCerts, createSNICallback } from "../src/certs.ts";

assert.ok(process.versions.bun, "Run this regression with Bun");
const directory = mkdtempSync(join(tmpdir(), "portless-bun-tls-"));
const backend = http.createServer((_request, response) => response.end("ok"));
backend.on("upgrade", (request, socket) => {
  const accept = createHash("sha1")
    .update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.end(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n"
  );
});
await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
const address = backend.address();
assert.ok(address && typeof address !== "string");
const certificate = ensureCerts(directory);
const ca = readFileSync(certificate.caPath);
const cert = readFileSync(certificate.certPath);
const key = readFileSync(certificate.keyPath);
const select = createSNICallback(directory, cert, key, ["localhost", "test", "preview"], ca);
let failNext = false;
let calls = 0;
const routes = [{ hostname: "web.app.localhost", port: address.port }];
const proxy = createProxyServer({
  getRoutes: () => routes,
  proxyPort: 443,
  tlds: ["localhost", "test", "preview"],
  tls: {
    cert,
    key,
    ca,
    SNICallback(name, callback) {
      calls++;
      if (failNext) {
        failNext = false;
        callback(new Error("injected generation failure"));
        return;
      }
      select(name, callback);
    },
  },
});
try {
  assert.ok(proxy.refreshTlsContexts);
  await Promise.all([proxy.refreshTlsContexts(), proxy.refreshTlsContexts()]);
  assert.equal(calls, 1, "concurrent preparation reuses a pending context");
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const local = proxy.address();
  assert.ok(local && typeof local !== "string");
  const request = (hostname: string) =>
    new Promise<string>((resolve, reject) => {
      const req = https.get(
        {
          hostname: "127.0.0.1",
          port: local.port,
          servername: hostname,
          ca,
          agent: false,
          headers: { Host: hostname },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve(body));
        }
      );
      req.setTimeout(5000, () => req.destroy(new Error("TLS request timeout")));
      req.on("error", reject);
    });
  assert.equal(await request("web.app.localhost"), "ok");
  routes.push(
    { hostname: "trigon.test", port: address.port },
    { hostname: "trigon.preview", port: address.port }
  );
  failNext = true;
  await assert.rejects(proxy.refreshTlsContexts(), /injected generation failure/);
  await proxy.refreshTlsContexts();
  assert.equal(await request("trigon.test"), "ok");
  assert.equal(await request("trigon.preview"), "ok");
  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: "127.0.0.1",
        port: local.port,
        servername: "trigon.preview",
        ca,
        ALPNProtocols: ["http/1.1"],
      },
      () => {
        socket.write(
          "GET /socket HTTP/1.1\r\nHost: trigon.preview\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
      }
    );
    socket.setTimeout(5000, () => socket.destroy(new Error("WebSocket timeout")));
    let data = "";
    socket.on("data", (chunk) => {
      data += String(chunk);
      if (data.includes("\r\n\r\n")) {
        try {
          assert.match(data, /^HTTP\/1.1 101 /);
          socket.destroy();
          resolve();
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      }
    });
    socket.on("error", reject);
  });
  console.log(
    "Bun TLS: trusted nested/custom SANs, concurrent preload, failed-generation retry, dynamic routes and WSS passed"
  );
} finally {
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  backend.closeAllConnections();
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + "portless-bun-tls-"));
  rmSync(directory, { recursive: true, force: true });
}

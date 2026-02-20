import { describe, it, expect, afterAll, afterEach, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as http2 from "node:http2";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createProxyServer, PORTLESS_HEADER } from "./proxy.js";
import type { ProxyServer } from "./proxy.js";
import type { RouteInfo } from "./types.js";
import { ensureCerts } from "./certs.js";

const TEST_PROXY_PORT = 1355;

/** Helper type covering both http.Server and http2.Http2SecureServer */
type AnyServer = http.Server | ProxyServer;

function request(
  server: AnyServer,
  options: { host?: string; path?: string; method?: string }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      return reject(new Error("Server not listening"));
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: options.path || "/",
        method: options.method || "GET",
        headers: { host: options.host || "" },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function listen(server: AnyServer): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

describe("createProxyServer", () => {
  const servers: AnyServer[] = [];

  function trackServer<T extends AnyServer>(server: T): T {
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    servers.length = 0;
  });

  describe("request routing", () => {
    it("returns 404 when Host header has no matching route", async () => {
      const routes: RouteInfo[] = [];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const res = await request(server, { host: "nonexistent.localhost" });
      expect(res.status).toBe(404);
      expect(res.body).toContain("Not Found");
    });

    it("returns 404 with HTML page for unknown host", async () => {
      const routes: RouteInfo[] = [];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const res = await request(server, { host: "unknown.localhost" });
      expect(res.status).toBe(404);
      expect(res.headers["content-type"]).toBe("text/html");
      expect(res.body).toContain("Not Found");
      expect(res.body).toContain("unknown.localhost");
      expect(res.body).toContain("No apps running.");
    });

    it("shows active routes in 404 page when routes exist", async () => {
      const routes: RouteInfo[] = [
        { hostname: "myapp.localhost", port: 4001 },
        { hostname: "api.localhost", port: 4002 },
      ];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const res = await request(server, { host: "other.localhost" });
      expect(res.status).toBe(404);
      expect(res.body).toContain("Active apps:");
      expect(res.body).toContain("myapp.localhost");
      expect(res.body).toContain("api.localhost");
    });

    it("includes correct port in 404 page links", async () => {
      const routes: RouteInfo[] = [{ hostname: "myapp.localhost", port: 4001 }];
      const server = trackServer(createProxyServer({ getRoutes: () => routes, proxyPort: 8080 }));
      await listen(server);

      const res = await request(server, { host: "other.localhost" });
      expect(res.status).toBe(404);
      expect(res.body).toContain('href="http://myapp.localhost:8080"');
    });

    it("omits port 80 in 404 page links", async () => {
      const routes: RouteInfo[] = [{ hostname: "myapp.localhost", port: 4001 }];
      const server = trackServer(createProxyServer({ getRoutes: () => routes, proxyPort: 80 }));
      await listen(server);

      const res = await request(server, { host: "other.localhost" });
      expect(res.status).toBe(404);
      expect(res.body).toContain('href="http://myapp.localhost"');
      expect(res.body).not.toContain(":80");
    });

    it("proxies request to matching route", async () => {
      const backend = trackServer(
        http.createServer((_req, res) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("hello from backend");
        })
      );
      await listen(backend);
      const backendAddr = backend.address();
      if (!backendAddr || typeof backendAddr === "string") throw new Error("no addr");

      const routes: RouteInfo[] = [{ hostname: "myapp.localhost", port: backendAddr.port }];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const res = await request(server, { host: "myapp.localhost" });
      expect(res.status).toBe(200);
      expect(res.body).toBe("hello from backend");
    });

    it("strips port from Host header for matching", async () => {
      const backend = trackServer(
        http.createServer((_req, res) => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("matched");
        })
      );
      await listen(backend);
      const backendAddr = backend.address();
      if (!backendAddr || typeof backendAddr === "string") throw new Error("no addr");

      const routes: RouteInfo[] = [{ hostname: "myapp.localhost", port: backendAddr.port }];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const res = await request(server, { host: "myapp.localhost:80" });
      expect(res.status).toBe(200);
      expect(res.body).toBe("matched");
    });
  });

  describe("missing Host header", () => {
    it("returns 400 when Host header is missing", async () => {
      const routes: RouteInfo[] = [];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");

      // Use raw TCP to send HTTP request without a Host header
      const response = await new Promise<string>((resolve, reject) => {
        const socket = net.createConnection(addr.port, "127.0.0.1", () => {
          socket.write("GET / HTTP/1.0\r\n\r\n");
        });
        let data = "";
        socket.on("data", (chunk) => (data += chunk));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });

      expect(response).toContain("400");
      expect(response).toContain("Missing Host header");
    });
  });

  describe("error handling", () => {
    it("returns 502 when backend is not running", async () => {
      const errors: string[] = [];
      const routes: RouteInfo[] = [{ hostname: "dead.localhost", port: 59999 }];
      const server = trackServer(
        createProxyServer({
          getRoutes: () => routes,
          proxyPort: TEST_PROXY_PORT,
          onError: (msg) => errors.push(msg),
        })
      );
      await listen(server);

      const res = await request(server, { host: "dead.localhost" });
      expect(res.status).toBe(502);
      expect(res.body).toContain("Bad Gateway");
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("dead.localhost");
    });
  });

  describe("X-Portless header", () => {
    it("includes X-Portless header on 404 responses", async () => {
      const routes: RouteInfo[] = [];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const res = await request(server, { host: "unknown.localhost" });
      expect(res.headers[PORTLESS_HEADER.toLowerCase()]).toBe("1");
    });

    it("includes X-Portless header on 400 responses", async () => {
      const routes: RouteInfo[] = [];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const res = await request(server, { host: "" });
      expect(res.headers[PORTLESS_HEADER.toLowerCase()]).toBe("1");
    });
  });

  describe("XSS safety", () => {
    it("escapes hostname in 404 page", async () => {
      const routes: RouteInfo[] = [];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      // The proxy extracts hostname from the Host header before the colon
      const res = await request(server, { host: "<script>alert(1)</script>" });
      expect(res.status).toBe(404);
      expect(res.body).not.toContain("<script>alert(1)</script>");
      expect(res.body).toContain("&lt;script&gt;");
    });

    it("escapes route hostnames in active apps list", async () => {
      // Route hostnames come from the route store, but defense-in-depth matters
      const routes: RouteInfo[] = [{ hostname: '<img src=x onerror="alert(1)">', port: 4001 }];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const res = await request(server, { host: "other.localhost" });
      expect(res.status).toBe(404);
      expect(res.body).not.toContain("<img src=x");
      expect(res.body).toContain("&lt;img");
    });
  });

  describe("WebSocket upgrade", () => {
    it("proxies WebSocket upgrade to matching route", async () => {
      // Create a backend that accepts WebSocket upgrades
      const backend = trackServer(http.createServer());
      backend.on("upgrade", (req, socket) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "\r\n"
        );
        socket.end();
      });
      await listen(backend);
      const backendAddr = backend.address();
      if (!backendAddr || typeof backendAddr === "string") throw new Error("no addr");

      const routes: RouteInfo[] = [{ hostname: "ws.localhost", port: backendAddr.port }];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");

      const upgraded = await new Promise<boolean>((resolve) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/",
          headers: {
            host: "ws.localhost",
            connection: "Upgrade",
            upgrade: "websocket",
          },
        });
        req.on("error", () => resolve(false));
        req.on("upgrade", () => resolve(true));
        req.setTimeout(2000, () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });

      expect(upgraded).toBe(true);
    });

    it("forwards backend Sec-WebSocket-Accept and custom headers", async () => {
      const testAcceptValue = "dGhlIHNhbXBsZSBub25jZQ==";
      const testProtocol = "graphql-ws";

      const backend = trackServer(http.createServer());
      backend.on("upgrade", (_req, socket) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${testAcceptValue}\r\n` +
            `Sec-WebSocket-Protocol: ${testProtocol}\r\n` +
            "\r\n"
        );
        socket.end();
      });
      await listen(backend);
      const backendAddr = backend.address();
      if (!backendAddr || typeof backendAddr === "string") throw new Error("no addr");

      const routes: RouteInfo[] = [{ hostname: "ws.localhost", port: backendAddr.port }];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");

      const result = await new Promise<{
        upgraded: boolean;
        accept?: string;
        protocol?: string;
      }>((resolve) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/",
          headers: {
            host: "ws.localhost",
            connection: "Upgrade",
            upgrade: "websocket",
          },
        });
        req.on("error", () => resolve({ upgraded: false }));
        req.on("upgrade", (res) => {
          resolve({
            upgraded: true,
            accept: res.headers["sec-websocket-accept"],
            protocol: res.headers["sec-websocket-protocol"],
          });
        });
        req.setTimeout(2000, () => {
          req.destroy();
          resolve({ upgraded: false });
        });
        req.end();
      });

      expect(result.upgraded).toBe(true);
      expect(result.accept).toBe(testAcceptValue);
      expect(result.protocol).toBe(testProtocol);
    });

    it("destroys socket for unknown host on upgrade", async () => {
      const routes: RouteInfo[] = [];
      const server = trackServer(
        createProxyServer({ getRoutes: () => routes, proxyPort: TEST_PROXY_PORT })
      );
      await listen(server);

      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");

      // Attempt a WebSocket upgrade to an unknown host
      const destroyed = await new Promise<boolean>((resolve) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port: addr.port,
          path: "/",
          headers: {
            host: "unknown.localhost",
            connection: "Upgrade",
            upgrade: "websocket",
          },
        });
        req.on("error", () => resolve(true));
        req.on("close", () => resolve(true));
        req.on("upgrade", () => resolve(false));
        req.end();
      });

      expect(destroyed).toBe(true);
    });
  });
});

describe("createProxyServer with TLS (HTTP/2)", () => {
  let tlsCert: Buffer;
  let tlsKey: Buffer;
  let certDir: string;
  const servers: AnyServer[] = [];

  function trackServer<T extends AnyServer>(server: T): T {
    servers.push(server);
    return server;
  }

  beforeAll(() => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-proxy-test-"));
    const certs = ensureCerts(certDir);
    tlsCert = fs.readFileSync(certs.certPath);
    tlsKey = fs.readFileSync(certs.keyPath);
  });

  afterAll(() => {
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Force-close all servers with a timeout to avoid hanging on open HTTP/2 sessions
    await Promise.all(
      servers.map(
        (s) =>
          new Promise<void>((resolve) => {
            s.close(() => resolve());
            // Force resolve after 1s if connections don't drain
            setTimeout(resolve, 1000);
          })
      )
    );
    servers.length = 0;
  });

  function httpsRequest(
    server: AnyServer,
    options: { host?: string; path?: string; method?: string }
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        return reject(new Error("Server not listening"));
      }
      const req = https.request(
        {
          hostname: "127.0.0.1",
          port: addr.port,
          path: options.path || "/",
          method: options.method || "GET",
          headers: { host: options.host || "" },
          rejectUnauthorized: false,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("creates an HTTPS server that responds to requests", async () => {
    const routes: RouteInfo[] = [];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    const res = await httpsRequest(server, { host: "unknown.localhost" });
    expect(res.status).toBe(404);
    expect(res.body).toContain("Not Found");
  });

  it("includes X-Portless header on TLS responses", async () => {
    const routes: RouteInfo[] = [];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    const res = await httpsRequest(server, { host: "unknown.localhost" });
    expect(res.headers[PORTLESS_HEADER.toLowerCase()]).toBe("1");
  });

  it("proxies HTTPS request to matching route", async () => {
    const backend = trackServer(
      http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("hello from backend via h2");
      })
    );
    await listen(backend);
    const backendAddr = backend.address();
    if (!backendAddr || typeof backendAddr === "string") throw new Error("no addr");

    const routes: RouteInfo[] = [{ hostname: "myapp.localhost", port: backendAddr.port }];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    const res = await httpsRequest(server, { host: "myapp.localhost" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from backend via h2");
  });

  it("supports HTTP/2 connections", async () => {
    const routes: RouteInfo[] = [];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");

    const result = await new Promise<{ status: number; protocol: string }>((resolve, reject) => {
      const client = http2.connect(`https://127.0.0.1:${addr.port}`, {
        rejectUnauthorized: false,
      });
      client.on("error", reject);

      const req = client.request({
        ":method": "GET",
        ":path": "/",
        host: "test.localhost",
      });

      req.on("response", (headers) => {
        const status = headers[":status"] as number;
        req.close();
        client.close();
        resolve({ status, protocol: "h2" });
      });

      req.on("error", reject);
      req.end();
    });

    expect(result.status).toBe(404);
    expect(result.protocol).toBe("h2");
  });

  it("still accepts HTTP/1.1 connections over TLS (allowHTTP1)", async () => {
    const routes: RouteInfo[] = [];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    const res = await httpsRequest(server, { host: "fallback.localhost" });
    expect(res.status).toBe(404);
    expect(res.body).toContain("Not Found");
  });

  it("generates https:// URLs in 404 page", async () => {
    const routes: RouteInfo[] = [{ hostname: "myapp.localhost", port: 4001 }];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    const res = await httpsRequest(server, { host: "other.localhost" });
    expect(res.status).toBe(404);
    expect(res.body).toContain("https://myapp.localhost:1355");
  });

  it("sets x-forwarded-proto to https when proxying", async () => {
    let receivedProto = "";
    const backend = trackServer(
      http.createServer((req, res) => {
        receivedProto = req.headers["x-forwarded-proto"] as string;
        res.writeHead(200);
        res.end("ok");
      })
    );
    await listen(backend);
    const backendAddr = backend.address();
    if (!backendAddr || typeof backendAddr === "string") throw new Error("no addr");

    const routes: RouteInfo[] = [{ hostname: "myapp.localhost", port: backendAddr.port }];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    await httpsRequest(server, { host: "myapp.localhost" });
    expect(receivedProto).toBe("https");
  });

  it("proxies WebSocket upgrade over TLS", async () => {
    const backend = trackServer(http.createServer());
    backend.on("upgrade", (_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "\r\n"
      );
      socket.end();
    });
    await listen(backend);
    const backendAddr = backend.address();
    if (!backendAddr || typeof backendAddr === "string") throw new Error("no addr");

    const routes: RouteInfo[] = [{ hostname: "ws.localhost", port: backendAddr.port }];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");

    const upgraded = await new Promise<boolean>((resolve) => {
      const req = https.request({
        hostname: "127.0.0.1",
        port: addr.port,
        path: "/",
        headers: {
          host: "ws.localhost",
          connection: "Upgrade",
          upgrade: "websocket",
        },
        rejectUnauthorized: false,
      });
      req.on("error", () => resolve(false));
      req.on("upgrade", () => resolve(true));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    });

    expect(upgraded).toBe(true);
  });

  it("accepts plain HTTP on the TLS-enabled port", async () => {
    const routes: RouteInfo[] = [];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    // Plain HTTP request (not TLS) -- exercises the buf[0] !== 0x16 branch
    const res = await request(server, { host: "test.localhost" });
    expect(res.status).toBe(404);
    expect(res.body).toContain("Not Found");
  });

  it("strips hop-by-hop headers from proxied TLS responses (HTTP/2 client)", async () => {
    const backend = trackServer(
      http.createServer((_req, res) => {
        // Backend sends hop-by-hop headers that are invalid in HTTP/2
        res.writeHead(200, {
          "Content-Type": "text/plain",
          Connection: "keep-alive",
          "Keep-Alive": "timeout=5",
          "X-Custom": "preserved",
        });
        res.end("ok");
      })
    );
    await listen(backend);
    const backendAddr = backend.address();
    if (!backendAddr || typeof backendAddr === "string") throw new Error("no addr");

    const routes: RouteInfo[] = [{ hostname: "hop.localhost", port: backendAddr.port }];
    const server = trackServer(
      createProxyServer({
        getRoutes: () => routes,
        proxyPort: TEST_PROXY_PORT,
        tls: { cert: tlsCert, key: tlsKey },
      })
    );
    await listen(server);

    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");

    // Use HTTP/2 client -- hop-by-hop headers must be stripped for HTTP/2
    const result = await new Promise<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>((resolve, reject) => {
      const client = http2.connect(`https://127.0.0.1:${addr.port}`, {
        rejectUnauthorized: false,
      });
      client.on("error", reject);

      const req = client.request({
        ":method": "GET",
        ":path": "/",
        host: "hop.localhost",
      });

      let status = 0;
      const responseHeaders: Record<string, string> = {};
      req.on("response", (headers) => {
        status = headers[":status"] as number;
        for (const [key, value] of Object.entries(headers)) {
          if (key !== ":status" && typeof value === "string") {
            responseHeaders[key] = value;
          }
        }
      });

      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk));
      req.on("end", () => {
        client.close();
        resolve({ status, headers: responseHeaders, body });
      });
      req.on("error", reject);
      req.end();
    });

    expect(result.status).toBe(200);
    expect(result.headers["connection"]).toBeUndefined();
    expect(result.headers["keep-alive"]).toBeUndefined();
    expect(result.headers["x-custom"]).toBe("preserved");
    expect(result.body).toBe("ok");
  });
});

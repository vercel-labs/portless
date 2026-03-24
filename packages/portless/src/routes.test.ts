import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import { RouteStore } from "./routes.js";

describe("RouteStore", () => {
  let tmpDir: string;
  let store: RouteStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-routes-test-"));
    store = new RouteStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("ensureDir", () => {
    it("creates directory if it does not exist", () => {
      const nested = path.join(tmpDir, "sub", "dir");
      const s = new RouteStore(nested);
      s.ensureDir();
      expect(fs.existsSync(nested)).toBe(true);
    });

    it("does not throw if directory already exists", () => {
      store.ensureDir();
      expect(() => store.ensureDir()).not.toThrow();
    });
  });

  describe("loadRoutes", () => {
    it("returns empty array when routes file does not exist", () => {
      expect(store.loadRoutes()).toEqual([]);
    });

    it("returns empty array for invalid JSON", () => {
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), "not json");
      expect(store.loadRoutes()).toEqual([]);
    });

    it("calls onWarning for invalid JSON", () => {
      const warnings: string[] = [];
      const warnStore = new RouteStore(tmpDir, {
        onWarning: (msg) => warnings.push(msg),
      });
      warnStore.ensureDir();
      fs.writeFileSync(warnStore.getRoutesPath(), "not json");
      warnStore.loadRoutes();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("invalid JSON");
    });

    it("calls onWarning when routes file is not an array", () => {
      const warnings: string[] = [];
      const warnStore = new RouteStore(tmpDir, {
        onWarning: (msg) => warnings.push(msg),
      });
      warnStore.ensureDir();
      fs.writeFileSync(warnStore.getRoutesPath(), JSON.stringify({ not: "array" }));
      warnStore.loadRoutes();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("expected array");
    });

    it("filters out entries with invalid schema", () => {
      store.ensureDir();
      const routes = [
        { hostname: "valid.localhost", port: 4001, pid: process.pid },
        { hostname: "missing-port.localhost", pid: process.pid },
        { hostname: 123, port: 4002, pid: process.pid },
        "not an object",
        null,
      ];
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      const loaded = store.loadRoutes();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].hostname).toBe("valid.localhost");
    });

    it("loads routes from file", () => {
      const routes = [{ hostname: "app.localhost", port: 4001, pid: process.pid }];
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      const loaded = store.loadRoutes();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].hostname).toBe("app.localhost");
      expect(loaded[0].port).toBe(4001);
    });

    it("loads TCP routes with listen ports from file", () => {
      const routes = [
        {
          hostname: "postgres.localhost",
          port: 5432,
          pid: 0,
          type: "tcp",
          listenPort: 5500,
        },
      ];
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      const loaded = store.loadRoutes();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(routes[0]);
    });

    it("filters out routes with dead PIDs", () => {
      // Use a PID that is guaranteed not to exist
      const deadPid = 999999;
      const routes = [
        { hostname: "alive.localhost", port: 4001, pid: process.pid },
        { hostname: "dead.localhost", port: 4002, pid: deadPid },
      ];
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      const loaded = store.loadRoutes();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].hostname).toBe("alive.localhost");
    });

    it("keeps legacy routes without explicit type for backward compatibility", () => {
      const routes = [{ hostname: "legacy.localhost", port: 4001, pid: process.pid }];
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      const loaded = store.loadRoutes();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].type).toBeUndefined();
    });

    it("does not persist cleanup when persistCleanup is false (default)", () => {
      const deadPid = 999999;
      const routes = [
        { hostname: "alive.localhost", port: 4001, pid: process.pid },
        { hostname: "dead.localhost", port: 4002, pid: deadPid },
      ];
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      store.loadRoutes();

      // Re-read the file directly -- stale entries should still be on disk
      const raw = JSON.parse(fs.readFileSync(store.getRoutesPath(), "utf-8"));
      expect(raw).toHaveLength(2);
    });

    it("persists cleaned-up routes when persistCleanup is true", () => {
      const deadPid = 999999;
      const routes = [
        { hostname: "alive.localhost", port: 4001, pid: process.pid },
        { hostname: "dead.localhost", port: 4002, pid: deadPid },
      ];
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      store.loadRoutes(true);

      // Re-read the file directly to verify it was cleaned up
      const raw = JSON.parse(fs.readFileSync(store.getRoutesPath(), "utf-8"));
      expect(raw).toHaveLength(1);
      expect(raw[0].hostname).toBe("alive.localhost");
    });
  });

  describe("saveRoutes (via addRoute)", () => {
    it("persists routes to file", () => {
      store.addRoute("test.localhost", 4123, process.pid);
      const raw = JSON.parse(fs.readFileSync(store.getRoutesPath(), "utf-8"));
      expect(raw).toHaveLength(1);
      expect(raw[0].hostname).toBe("test.localhost");
      expect(raw[0].port).toBe(4123);
      expect(raw[0].pid).toBe(process.pid);
    });

    it("creates directory if it does not exist", () => {
      const nested = path.join(tmpDir, "nested");
      const s = new RouteStore(nested);
      s.addRoute("test.localhost", 4001, process.pid);
      expect(fs.existsSync(s.getRoutesPath())).toBe(true);
    });
  });

  describe("addRoute", () => {
    it("adds a route to empty store", () => {
      store.addRoute("myapp.localhost", 4001, process.pid);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({
        hostname: "myapp.localhost",
        port: 4001,
        pid: process.pid,
      });
    });

    it("adds a TCP route with listen port metadata", () => {
      store.addRoute("postgres.localhost", 5432, 0, false, { type: "tcp", listenPort: 5500 });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({
        hostname: "postgres.localhost",
        port: 5432,
        pid: 0,
        type: "tcp",
        listenPort: 5500,
      });
    });

    it("replaces existing route with same hostname", () => {
      store.addRoute("myapp.localhost", 4001, process.pid);
      store.addRoute("myapp.localhost", 4002, process.pid);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].port).toBe(4002);
    });

    it("preserves other routes when adding", () => {
      store.addRoute("app1.localhost", 4001, process.pid);
      store.addRoute("app2.localhost", 4002, process.pid);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(2);
      const hostnames = routes.map((r) => r.hostname).sort();
      expect(hostnames).toEqual(["app1.localhost", "app2.localhost"]);
    });
  });

  describe("addTcpRoute", () => {
    it("allocates distinct listen ports for distinct TCP aliases", async () => {
      const first = await store.addTcpRoute("db1.localhost", 5432, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5510,
      });
      const second = await store.addTcpRoute("db2.localhost", 5433, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5510,
      });

      expect(first).not.toBe(second);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(2);
      expect(routes[0].listenPort).not.toBe(routes[1].listenPort);
    });

    it("reuses the existing listen port when replacing a TCP alias", async () => {
      const first = await store.addTcpRoute("db.localhost", 5432, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5510,
      });
      const second = await store.addTcpRoute("db.localhost", 5433, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5510,
      });

      expect(second).toBe(first);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].port).toBe(5433);
      expect(routes[0].listenPort).toBe(first);
    });

    it("allocates a new listen port when the saved one is no longer bindable", async () => {
      const first = await store.addTcpRoute("db.localhost", 5432, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5510,
      });

      const blocker = net.createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(first, "127.0.0.1", () => resolve());
      });

      try {
        const second = await store.addTcpRoute("db.localhost", 5433, 0, false, {
          minListenPort: 5500,
          maxListenPort: 5510,
        });

        expect(second).not.toBe(first);
        const routes = store.loadRoutes();
        expect(routes).toHaveLength(1);
        expect(routes[0].port).toBe(5433);
        expect(routes[0].listenPort).toBe(second);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it("preserves the existing listen port while the proxy daemon is running", async () => {
      const first = await store.addTcpRoute("db.localhost", 5432, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5510,
      });

      fs.writeFileSync(store.pidPath, process.pid.toString());
      fs.writeFileSync(
        store.tcpListenersPath,
        JSON.stringify([{ hostname: "db.localhost", listenPort: first }], null, 2)
      );

      const second = await store.addTcpRoute("db.localhost", 5433, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5510,
      });

      expect(second).toBe(first);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].port).toBe(5433);
      expect(routes[0].listenPort).toBe(first);
    });

    it("allocates a new listen port when the daemon is running but the listener is not active", async () => {
      const first = await store.addTcpRoute("db.localhost", 5432, 0, false, {
        minListenPort: 5500,
        maxListenPort: 5510,
      });

      fs.writeFileSync(store.pidPath, process.pid.toString());

      const blocker = net.createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(first, "127.0.0.1", () => resolve());
      });

      try {
        const second = await store.addTcpRoute("db.localhost", 5433, 0, false, {
          minListenPort: 5500,
          maxListenPort: 5510,
        });

        expect(second).not.toBe(first);
        const routes = store.loadRoutes();
        expect(routes).toHaveLength(1);
        expect(routes[0].port).toBe(5433);
        expect(routes[0].listenPort).toBe(second);
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });

  describe("removeRoute", () => {
    it("removes an existing route", () => {
      store.addRoute("myapp.localhost", 4001, process.pid);
      store.removeRoute("myapp.localhost");
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(0);
    });

    it("does not fail when removing non-existent route", () => {
      store.addRoute("myapp.localhost", 4001, process.pid);
      expect(() => store.removeRoute("other.localhost")).not.toThrow();
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
    });

    it("preserves other routes when removing", () => {
      store.addRoute("app1.localhost", 4001, process.pid);
      store.addRoute("app2.localhost", 4002, process.pid);
      store.removeRoute("app1.localhost");
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].hostname).toBe("app2.localhost");
    });
  });

  describe("locking (via concurrent addRoute)", () => {
    it("handles stale lock by recovering and completing the operation", () => {
      store.ensureDir();
      const lockPath = path.join(tmpDir, "routes.lock");
      // Create a stale lock directory manually
      fs.mkdirSync(lockPath);
      // Backdate mtime to 11 seconds ago
      const staleTime = new Date(Date.now() - 11_000);
      fs.utimesSync(lockPath, staleTime, staleTime);
      // addRoute should recover from the stale lock
      expect(() => store.addRoute("test.localhost", 4001, process.pid)).not.toThrow();
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].hostname).toBe("test.localhost");
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { RouteStore, RouteConflictError } from "./routes.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) };
});

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

    it("does not persist cleanup when persistCleanup is false (default)", () => {
      const deadPid = 999999;
      const routes = [
        { hostname: "alive.localhost", port: 4001, pid: process.pid },
        { hostname: "dead.localhost", port: 4002, pid: deadPid },
      ];
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      store.loadRoutes();

      // Re-read the file directly; stale entries should still be on disk
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

    it("keeps routes whose process exists but cannot be signaled (EPERM)", () => {
      const deniedPid = 999998;
      const realKill = process.kill.bind(process);
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === deniedPid) {
          throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
        }
        return realKill(pid, signal);
      });
      try {
        const routes = [{ hostname: "denied.localhost", port: 4001, pid: deniedPid }];
        store.ensureDir();
        fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));

        expect(store.loadRoutes(true).map((r) => r.hostname)).toEqual(["denied.localhost"]);
        const raw = JSON.parse(fs.readFileSync(store.getRoutesPath(), "utf-8"));
        expect(raw).toHaveLength(1);
        expect(() => store.addRoute("denied.localhost", 4002, process.pid)).toThrow(
          RouteConflictError
        );
      } finally {
        kill.mockRestore();
      }
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
      const before = Date.now();
      store.addRoute("myapp.localhost", 4001, process.pid);
      const after = Date.now();
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0]).toEqual({
        hostname: "myapp.localhost",
        port: 4001,
        pid: process.pid,
        registeredAt: expect.any(Number),
      });
      expect(routes[0].registeredAt).toBeGreaterThanOrEqual(before);
      expect(routes[0].registeredAt).toBeLessThanOrEqual(after);
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

  describe("addRoute with force", () => {
    function spawnSleeper(): number {
      const child = spawn("node", ["-e", "setTimeout(()=>{},60000)"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return child.pid!;
    }

    function isAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    it("throws RouteConflictError without --force when route is owned by another live process", () => {
      const otherPid = spawnSleeper();
      try {
        store.addRoute("app.localhost", 4001, otherPid);
        expect(() => store.addRoute("app.localhost", 4002, process.pid)).toThrow(
          RouteConflictError
        );
      } finally {
        try {
          process.kill(otherPid, "SIGTERM");
        } catch {
          // already dead
        }
      }
    });

    it("kills the existing process and returns its PID when --force is used", async () => {
      const otherPid = spawnSleeper();
      try {
        store.addRoute("app.localhost", 4001, otherPid);
        const killedPid = store.addRoute("app.localhost", 4002, process.pid, true);
        expect(killedPid).toBe(otherPid);
        // Wait for signal delivery
        await new Promise((r) => setTimeout(r, 200));
        expect(isAlive(otherPid)).toBe(false);
      } finally {
        try {
          process.kill(otherPid, "SIGTERM");
        } catch {
          // already dead
        }
      }
    });

    it("replaces the route when --force kills the existing process", () => {
      const otherPid = spawnSleeper();
      try {
        store.addRoute("app.localhost", 4001, otherPid);
        store.addRoute("app.localhost", 4002, process.pid, true);
        const routes = store.loadRoutes();
        expect(routes).toHaveLength(1);
        expect(routes[0].port).toBe(4002);
        expect(routes[0].pid).toBe(process.pid);
      } finally {
        try {
          process.kill(otherPid, "SIGTERM");
        } catch {
          // already dead
        }
      }
    });

    it("refuses to replace a static alias without --force", () => {
      store.addRoute("db.localhost", 5432, 0);
      expect(() => store.addRoute("db.localhost", 4002, process.pid)).toThrow(
        '"db.localhost" is a static alias. Use --force to replace it; re-add the alias with "portless alias" afterwards.'
      );
    });

    it("replaces a static alias with --force without sending any signal", () => {
      const realKill = process.kill.bind(process);
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((pid, signal) => (signal ? true : realKill(pid, signal)));
      try {
        store.addRoute("db.localhost", 5432, 0);
        expect(store.addRoute("db.localhost", 4002, process.pid, true)).toBeUndefined();
        expect(kill.mock.calls.filter(([, signal]) => signal)).toEqual([]);
        const routes = store.loadRoutes();
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({ port: 4002, pid: process.pid });
      } finally {
        kill.mockRestore();
      }
    });

    it("returns undefined when no conflicting process exists", () => {
      const killedPid = store.addRoute("app.localhost", 4001, process.pid, true);
      expect(killedPid).toBeUndefined();
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

    it("removes the route when the caller still owns it", () => {
      store.addRoute("myapp.localhost", 4001, process.pid);
      store.removeRoute("myapp.localhost", process.pid);
      expect(store.loadRoutes()).toHaveLength(0);
    });

    it("does not remove a route the caller no longer owns (post --force takeover)", () => {
      // Simulate the state right after a --force takeover: the route is owned
      // by another live process. The killed process's exit cleanup (passing
      // its own pid) must not deregister the new owner's route.
      const newOwnerPid = process.ppid;
      store.addRoute("myapp.localhost", 4002, newOwnerPid);
      store.removeRoute("myapp.localhost", process.pid);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].pid).toBe(newOwnerPid);
    });
  });

  describe("transferRoute", () => {
    it("moves a route to another pid while the caller owns it", () => {
      store.addRoute("myapp.localhost", 4001, process.pid);
      expect(store.transferRoute("myapp.localhost", process.pid, process.ppid)).toBe(true);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].pid).toBe(process.ppid);
      expect(routes[0].port).toBe(4001);
    });

    it("drops sharing URLs, whose tunnels stop with the previous owner", () => {
      store.addRoute("myapp.localhost", 4001, process.pid);
      store.updateRoute("myapp.localhost", {
        ngrokUrl: "https://abc.ngrok.app",
        ngrokPid: 123,
        cloudflareUrl: "https://abc.trycloudflare.com",
        cloudflarePid: 456,
        tailscaleUrl: "https://dev.tail1234.ts.net",
        tailscaleHttpsPort: 8443,
        tailscaleFunnel: true,
      });
      store.transferRoute("myapp.localhost", process.pid, process.ppid);
      const route = store.loadRoutes()[0];
      expect(route.ngrokUrl).toBeUndefined();
      expect(route.ngrokPid).toBeUndefined();
      expect(route.cloudflareUrl).toBeUndefined();
      expect(route.cloudflarePid).toBeUndefined();
      expect(route.tailscaleUrl).toBeUndefined();
      expect(route.tailscaleHttpsPort).toBeUndefined();
      expect(route.tailscaleFunnel).toBeUndefined();
    });

    it("does not move a route owned by another pid", () => {
      store.addRoute("myapp.localhost", 4001, process.ppid);
      expect(store.transferRoute("myapp.localhost", process.pid, 1)).toBe(false);
      expect(store.loadRoutes()[0].pid).toBe(process.ppid);
    });
  });

  describe("locking (via concurrent addRoute)", () => {
    it.each([
      ["win32", "EPERM", true],
      ["linux", "EPERM", false],
      ["win32", "EACCES", false],
    ])("handles %s lock creation error %s", (platform, code, retries) => {
      const originalPlatform = process.platform;
      const mkdir = vi.mocked(fs.mkdirSync);
      mkdir.mockImplementationOnce(() => {
        throw Object.assign(new Error("lock creation failed"), { code });
      });
      Object.defineProperty(process, "platform", { value: platform });
      try {
        if (retries) {
          store.addRoute("retry.localhost", 4001, process.pid);
          expect(store.loadRoutes()).toEqual([
            expect.objectContaining({ hostname: "retry.localhost", port: 4001, pid: process.pid }),
          ]);
          expect(fs.existsSync(path.join(tmpDir, "routes.lock"))).toBe(false);
        } else {
          expect(() => store.addRoute("retry.localhost", 4001, process.pid)).toThrow(
            "Failed to acquire route lock"
          );
          expect(fs.existsSync(store.getRoutesPath())).toBe(false);
        }
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        mkdir.mockReset();
      }
    });

    it("handles stale lock by recovering and completing the operation", () => {
      store.ensureDir();
      const lockPath = path.join(tmpDir, "routes.lock");
      fs.mkdirSync(lockPath);
      const staleTime = new Date(Date.now() - 11_000);
      fs.utimesSync(lockPath, staleTime, staleTime);
      expect(() => store.addRoute("test.localhost", 4001, process.pid)).not.toThrow();
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].hostname).toBe("test.localhost");
    });

    it("handles many parallel addRoute calls without lock errors", async () => {
      const count = 20;
      const scriptPath = path.join(tmpDir, "worker.mjs");
      const pkgDir = path.resolve(import.meta.dirname, "..");
      const importUrl = pathToFileURL(path.join(pkgDir, "dist", "index.js")).href;
      fs.writeFileSync(
        scriptPath,
        [
          `import { RouteStore } from ${JSON.stringify(importUrl)};`,
          `const [dir, hostname, port] = process.argv.slice(2);`,
          `const store = new RouteStore(dir);`,
          `try { store.addRoute(hostname, Number(port), process.pid); console.log("ok"); }`,
          `catch (e) { console.log("error:" + e.message); process.exit(1); }`,
          `process.stdin.resume();`,
        ].join("\n")
      );

      const children: ReturnType<typeof spawn>[] = [];
      const ready: Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
        signal?: NodeJS.Signals | null;
      }>[] = [];
      for (let i = 0; i < count; i++) {
        const child = spawn(
          process.execPath,
          [scriptPath, tmpDir, `app${i}.localhost`, String(4000 + i)],
          { stdio: ["pipe", "pipe", "pipe"] }
        );
        children.push(child);
        ready.push(
          new Promise((resolve) => {
            let stdout = "";
            let stderr = "";
            child.stderr!.on("data", (d: Buffer) => {
              stderr += d.toString();
            });
            child.stdout!.on("data", (d: Buffer) => {
              stdout += d.toString();
              if (stdout.trim() === "ok") {
                resolve({ code: null, stdout: stdout.trim(), stderr: stderr.trim() });
              }
            });
            child.on("error", (error) => {
              resolve({ code: null, stdout: stdout.trim(), stderr: error.message });
            });
            child.on("close", (code, signal) =>
              resolve({ code, signal, stdout: stdout.trim(), stderr: stderr.trim() })
            );
          })
        );
      }

      const outcomes = await Promise.all(ready);
      const failures = outcomes.filter((o) => !o.stdout.startsWith("ok"));

      for (const child of children) {
        child.stdin!.end();
      }

      expect(failures).toEqual([]);

      const raw = JSON.parse(fs.readFileSync(store.getRoutesPath(), "utf-8"));
      expect(raw).toHaveLength(count);

      const hostnames = raw.map((r: { hostname: string }) => r.hostname).sort();
      const expected = Array.from({ length: count }, (_, i) => `app${i}.localhost`).sort();
      expect(hostnames).toEqual(expected);
    }, 30_000);

    it("survives sustained lock contention that defeats a naive retry strategy", async () => {
      store.ensureDir();
      const lockPath = path.join(tmpDir, "routes.lock");

      // A child process holds the lock for 1.5s, simulating a slow writer on
      // a loaded machine. The old strategy (20 retries * 50ms = 1s budget)
      // would time out; exponential backoff with a larger budget survives.
      const holdMs = 1500;
      const holder = spawn(
        process.execPath,
        [
          "-e",
          [
            `const fs = require("fs");`,
            `const lockPath = ${JSON.stringify(lockPath)};`,
            `fs.mkdirSync(lockPath, { recursive: true });`,
            `console.log("holding");`,
            `setTimeout(() => { try { fs.rmSync(lockPath, { recursive: true }); } catch {} console.log("released"); }, ${holdMs});`,
          ].join("\n"),
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );

      // Wait for the holder to acquire the lock
      await new Promise<void>((resolve) => {
        holder.stdout!.on("data", (d: Buffer) => {
          if (d.toString().includes("holding")) resolve();
        });
      });

      // addRoute must wait for the lock to be released (>1.5s)
      expect(() => store.addRoute("contended.localhost", 5000, process.pid)).not.toThrow();

      holder.kill("SIGTERM");

      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].hostname).toBe("contended.localhost");
    }, 10_000);
  });

  describe("tailscale metadata", () => {
    it("persists and loads tailscale fields via updateRoute", () => {
      store.addRoute("myapp.localhost", 4123, process.pid);
      store.updateRoute("myapp.localhost", {
        tailscaleUrl: "https://devbox.example.ts.net",
        tailscaleHttpsPort: 443,
      });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].tailscaleUrl).toBe("https://devbox.example.ts.net");
      expect(routes[0].tailscaleHttpsPort).toBe(443);
      expect(routes[0].tailscaleFunnel).toBeUndefined();
    });

    it("persists funnel flag via updateRoute", () => {
      store.addRoute("api.localhost", 4456, process.pid);
      store.updateRoute("api.localhost", {
        tailscaleUrl: "https://devbox.example.ts.net:8443",
        tailscaleHttpsPort: 8443,
        tailscaleFunnel: true,
      });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].tailscaleFunnel).toBe(true);
    });

    it("updateRoute keeps the original registeredAt", () => {
      store.addRoute("myapp.localhost", 4123, process.pid);
      const registeredAt = store.loadRoutes()[0].registeredAt;
      store.updateRoute("myapp.localhost", {
        tailscaleUrl: "https://devbox.example.ts.net",
      });
      const routes = store.loadRoutes();
      expect(routes[0].tailscaleUrl).toBe("https://devbox.example.ts.net");
      expect(routes[0].registeredAt).toBe(registeredAt);
    });

    it("loads routes with and without registeredAt unchanged (backward compat)", () => {
      const routes = [
        { hostname: "old.localhost", port: 4001, pid: process.pid },
        { hostname: "new.localhost", port: 4002, pid: process.pid, registeredAt: 1700000000000 },
        { hostname: "odd.localhost", port: 4003, pid: process.pid, registeredAt: "yesterday" },
      ];
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      expect(store.loadRoutes()).toEqual(routes);
    });

    it("loads routes without tailscale fields (backward compat)", () => {
      store.addRoute("legacy.localhost", 4000, process.pid);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].tailscaleUrl).toBeUndefined();
      expect(routes[0].tailscaleHttpsPort).toBeUndefined();
    });

    it("updateRoute is a no-op for nonexistent hostname", () => {
      store.addRoute("myapp.localhost", 4123, process.pid);
      store.updateRoute("noexist.localhost", {
        tailscaleUrl: "https://devbox.example.ts.net",
      });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].tailscaleUrl).toBeUndefined();
    });
  });

  describe("ngrok metadata", () => {
    it("persists and loads ngrok fields via updateRoute", () => {
      store.addRoute("myapp.localhost", 4123, process.pid);
      store.updateRoute("myapp.localhost", {
        ngrokUrl: "https://abc123.ngrok.app",
        ngrokPid: 12345,
      });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].ngrokUrl).toBe("https://abc123.ngrok.app");
      expect(routes[0].ngrokPid).toBe(12345);
    });

    it("clears ngrok fields via updateRoute", () => {
      store.addRoute("myapp.localhost", 4123, process.pid);
      store.updateRoute("myapp.localhost", {
        ngrokUrl: "https://abc123.ngrok.app",
        ngrokPid: 12345,
      });
      store.updateRoute("myapp.localhost", {
        ngrokUrl: null,
        ngrokPid: null,
      });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].ngrokUrl).toBeUndefined();
      expect(routes[0].ngrokPid).toBeUndefined();
    });

    it("loads routes without ngrok fields", () => {
      store.addRoute("legacy.localhost", 4000, process.pid);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].ngrokUrl).toBeUndefined();
      expect(routes[0].ngrokPid).toBeUndefined();
    });
  });
});

describe("RouteStore.claimAppPort", () => {
  let tmpDir: string;
  let store: RouteStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-claim-test-"));
    store = new RouteStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Picks the lowest port from 4000 that is not taken.
  const lowestFree = async (taken: ReadonlySet<number>) => {
    let port = 4000;
    while (taken.has(port)) port++;
    return port;
  };

  it("does not pick a port held by another live app", async () => {
    store.addRoute("other.localhost", 4000, process.pid);
    const { port } = await store.claimAppPort(["app.localhost"], process.pid, lowestFree);
    expect(port).toBe(4001);
    expect(store.loadRoutes().find((r) => r.hostname === "app.localhost")?.port).toBe(4001);
  });

  it("does not pick a port an alias points at", async () => {
    store.addRoute("db.localhost", 4000, 0);
    const { port } = await store.claimAppPort(["app.localhost"], process.pid, lowestFree);
    expect(port).toBe(4001);
  });

  it("registers every hostname of the app on one port", async () => {
    const { port } = await store.claimAppPort(
      ["app.localhost", "app.test"],
      process.pid,
      lowestFree
    );
    const routes = store.loadRoutes();
    expect(routes.map((r) => [r.hostname, r.port])).toEqual([
      ["app.localhost", port],
      ["app.test", port],
    ]);
  });

  it("does not exclude the app's own previous port", async () => {
    store.addRoute("app.localhost", 4000, process.pid);
    const { port } = await store.claimAppPort(["app.localhost"], process.pid, lowestFree);
    expect(port).toBe(4000);
    expect(store.loadRoutes()).toHaveLength(1);
  });

  it("reuses a port whose owner is dead", async () => {
    store.ensureDir();
    fs.writeFileSync(
      store.getRoutesPath(),
      JSON.stringify([{ hostname: "dead.localhost", port: 4000, pid: 999999 }])
    );
    const { port } = await store.claimAppPort(["app.localhost"], process.pid, lowestFree);
    expect(port).toBe(4000);
  });

  it("throws RouteConflictError and writes nothing when a hostname is taken", async () => {
    // A live process other than this one owns app.test; app.localhost is free.
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      store.addRoute("app.test", 4005, owner.pid!);
      await expect(
        store.claimAppPort(["app.localhost", "app.test"], process.pid, lowestFree)
      ).rejects.toBeInstanceOf(RouteConflictError);
      expect(store.loadRoutes().map((r) => r.hostname)).toEqual(["app.test"]);
    } finally {
      owner.kill();
    }
  });

  it("does not hold the lock while picking", async () => {
    // Another route operation in this process runs while pick awaits, as a
    // sibling app's exit handler would. It must not wait for the claim, and
    // the claim must not bring back the route it removed.
    store.addRoute("gone.localhost", 4100, process.pid);
    let removedAfterMs = -1;
    const started = Date.now();
    const pick = async (taken: ReadonlySet<number>) => {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          store.removeRoute("gone.localhost", process.pid);
          removedAfterMs = Date.now() - started;
          resolve();
        }, 20)
      );
      return lowestFree(taken);
    };
    await store.claimAppPort(["app.localhost"], process.pid, pick);
    expect(removedAfterMs).toBeLessThan(2000);
    expect(store.loadRoutes().map((r) => r.hostname)).toEqual(["app.localhost"]);
  });

  it("picks again when another run claims the port first", async () => {
    let calls = 0;
    const pick = async (taken: ReadonlySet<number>) => {
      calls++;
      if (calls === 1) {
        // Another run registers 4000 between this pick and the claim.
        store.addRoute("other.localhost", 4000, process.pid);
        return 4000;
      }
      return lowestFree(taken);
    };
    const { port } = await store.claimAppPort(["app.localhost"], process.pid, pick);
    expect(calls).toBe(2);
    expect(port).toBe(4001);
  });

  it("gives concurrent processes different ports", async () => {
    const count = 8;
    const scriptPath = path.join(tmpDir, "claim-worker.mjs");
    const pkgDir = path.resolve(import.meta.dirname, "..");
    const importUrl = pathToFileURL(path.join(pkgDir, "dist", "index.js")).href;
    // Each worker waits inside pick, as a real probe would, then takes the
    // lowest port that is not taken. Without the lock they would all pick 4000.
    fs.writeFileSync(
      scriptPath,
      [
        `import { RouteStore } from ${JSON.stringify(importUrl)};`,
        `const [dir, hostname] = process.argv.slice(2);`,
        `const store = new RouteStore(dir);`,
        `const pick = async (taken) => {`,
        `  await new Promise((r) => setTimeout(r, 50));`,
        `  let port = 4000;`,
        `  while (taken.has(port)) port++;`,
        `  return port;`,
        `};`,
        `const { port } = await store.claimAppPort([hostname], process.pid, pick);`,
        `console.log("port:" + port);`,
        `process.stdin.resume();`,
      ].join("\n")
    );

    const children = Array.from({ length: count }, (_, i) =>
      spawn(process.execPath, [scriptPath, tmpDir, `app${i}.localhost`], {
        stdio: ["pipe", "pipe", "pipe"],
      })
    );
    const ports = await Promise.all(
      children.map(
        (child) =>
          new Promise<number>((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            child.stdout!.on("data", (d: Buffer) => {
              stdout += d.toString();
              const m = stdout.match(/port:(\d+)/);
              if (m) resolve(Number(m[1]));
            });
            child.stderr!.on("data", (d: Buffer) => {
              stderr += d.toString();
            });
            child.on("close", (code) => reject(new Error(`worker exited ${code}: ${stderr}`)));
          })
      )
    );
    for (const child of children) child.stdin!.end();

    expect(new Set(ports).size).toBe(count);
    const routes = JSON.parse(fs.readFileSync(store.getRoutesPath(), "utf-8"));
    expect(new Set(routes.map((r: { port: number }) => r.port)).size).toBe(count);
  }, 30_000);
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
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
      const warnStore = new RouteStore(tmpDir, (msg) => warnings.push(msg));
      warnStore.ensureDir();
      fs.writeFileSync(warnStore.getRoutesPath(), "not json");
      warnStore.loadRoutes();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("invalid JSON");
    });

    it("calls onWarning when routes file is not an array", () => {
      const warnings: string[] = [];
      const warnStore = new RouteStore(tmpDir, (msg) => warnings.push(msg));
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

    it("rejects malformed or unknown upstream fields while retaining valid routes", () => {
      const valid = { hostname: "valid.localhost", port: 4001, pid: 0 };
      const upstreams = [
        null,
        [],
        "https",
        { tls: "true" },
        { host: 123 },
        { host: "" },
        { host: "api.internal:0" },
        { host: "api.internal:65536" },
        { host: "api.internal:000001" },
        { host: "256.1.1.1" },
        { host: "127.0.0" },
        { host: "127.00.0.1" },
        { host: "user@api.internal" },
        { host: "api.internal/path" },
        { host: "[not-ipv6]" },
        { tls: true, extra: 1 },
      ];
      const routes = [
        valid,
        { ...valid, hostname: "tls.localhost", upstream: { tls: true, host: "api.internal:8443" } },
        ...upstreams.map((upstream, index) => ({
          ...valid,
          hostname: `invalid${index}.localhost`,
          upstream,
        })),
      ];
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(routes));
      expect(store.loadRoutes()).toEqual(routes.slice(0, 2));
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

    it("keeps routes whose process exists but cannot be signaled (EPERM)", async () => {
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

        expect(store.loadRoutes().map((r) => r.hostname)).toEqual(["denied.localhost"]);
        await expect(
          store.register({ hostnames: ["denied.localhost"], pid: process.pid, port: 4002 })
        ).rejects.toThrow(RouteConflictError);
      } finally {
        kill.mockRestore();
      }
    });
  });

  describe("unsupported stored routes", () => {
    const unsupported = {
      hostname: "future.localhost",
      port: 4001,
      pid: 0,
      upstream: { tls: true, futureOption: { value: 1 } },
      extra: "preserve",
    };
    const malformed = { hostname: "malformed.localhost", port: 4002, pid: 0, upstream: null };
    const incomplete = { hostname: "incomplete.localhost", upstream: { tls: true } };
    const alias = { hostname: "alias.localhost", port: 4003, pid: 0 };
    const owned = { hostname: "owned.localhost", port: 4004, pid: process.pid };
    const stale = { hostname: "stale.localhost", port: 4005, pid: 999999 };

    function seed(): void {
      fs.writeFileSync(
        store.getRoutesPath(),
        JSON.stringify([unsupported, malformed, incomplete, alias, owned, stale])
      );
    }

    function disk(): unknown[] {
      return JSON.parse(fs.readFileSync(store.getRoutesPath(), "utf-8"));
    }

    it("preserves skipped entries while adding, updating, transferring and removing valid routes", async () => {
      seed();
      expect(store.loadRoutes()).toEqual([alias, owned]);
      expect(store.loadRoutes({ includeStale: true })).toEqual([alias, owned, stale]);

      await store.register({
        hostnames: ["new.localhost"],
        pid: 0,
        port: 4006,
        upstream: { tls: true },
      });
      expect(disk()).toEqual(
        expect.arrayContaining([unsupported, malformed, incomplete, alias, owned])
      );
      expect(disk()).not.toContainEqual(stale);
      store.updateRoute("owned.localhost", { ngrokUrl: "https://example.test" });
      expect(disk()).toContainEqual({ ...owned, ngrokUrl: "https://example.test" });
      expect(store.transferRoute("owned.localhost", process.pid, process.ppid)).toBe(true);
      store.remove(["alias.localhost"], 0);

      expect(disk()).toEqual(expect.arrayContaining([unsupported, malformed, incomplete]));
      expect(disk()).not.toContainEqual(alias);
      expect(store.loadRoutes()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ hostname: "new.localhost", upstream: { tls: true } }),
          expect.objectContaining({ hostname: "owned.localhost", pid: process.ppid }),
        ])
      );
      expect(store.loadRoutes().map((route) => route.hostname)).not.toContain("future.localhost");
    });

    it("prunes dead supported routes without removing skipped entries", () => {
      seed();
      const dead = store.findStaleRoutes();
      expect(dead).toEqual([stale]);
      expect(store.removeStaleRoute(dead[0]!.hostname, dead[0]!.pid)).toBe(true);
      expect(disk()).toEqual(
        expect.arrayContaining([unsupported, malformed, incomplete, alias, owned])
      );
      expect(disk()).not.toContainEqual(stale);
    });

    it.each([unsupported, malformed, incomplete])(
      "requires force to replace a skipped hostname",
      async (entry) => {
        seed();
        await expect(
          store.register({ hostnames: [entry.hostname], pid: 0, port: 4444 })
        ).rejects.toThrow("has an invalid or unsupported stored route. Use --force to replace it.");
        expect(disk()).toContainEqual(entry);
        await store.register({ hostnames: [entry.hostname], pid: 0, port: 4444, force: true });
        const matching = (disk() as { hostname?: string }[]).filter(
          (route) => route.hostname === entry.hostname
        );
        expect(matching).toHaveLength(1);
        expect(matching[0]).toMatchObject({ hostname: entry.hostname, port: 4444, pid: 0 });
        expect(matching[0]).not.toHaveProperty("upstream");
      }
    );

    it("continues to reject invalid new upstreams without changing the file", async () => {
      seed();
      await expect(
        store.register({
          hostnames: ["new.localhost"],
          pid: 0,
          port: 4444,
          upstream: { tls: "yes" } as never,
        })
      ).rejects.toThrow("Invalid upstream configuration");
      expect(disk()).toEqual([unsupported, malformed, incomplete, alias, owned, stale]);
    });
  });

  describe("register", () => {
    it("creates the state directory if it does not exist", async () => {
      const nested = path.join(tmpDir, "nested");
      const s = new RouteStore(nested);
      await s.register({ hostnames: ["test.localhost"], pid: process.pid, port: 4001 });
      expect(fs.existsSync(s.getRoutesPath())).toBe(true);
    });

    it("persists and reloads upstream settings and clears them on replacement", async () => {
      const upstream = { tls: true, host: "api.internal:8443" };
      await store.register({ hostnames: ["api.localhost"], pid: 0, port: 4001, upstream });
      const saved = JSON.parse(fs.readFileSync(store.getRoutesPath(), "utf-8"));
      expect(saved[0].upstream).toEqual(upstream);
      expect(new RouteStore(tmpDir).loadRoutes()[0].upstream).toEqual(upstream);

      await store.register({ hostnames: ["api.localhost"], pid: 0, port: 4002, force: true });
      expect(new RouteStore(tmpDir).loadRoutes()[0].upstream).toBeUndefined();
    });

    it("adds a route to empty store", async () => {
      const before = Date.now();
      const { port } = await store.register({
        hostnames: ["myapp.localhost"],
        pid: process.pid,
        port: 4001,
      });
      const after = Date.now();
      expect(port).toBe(4001);
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

    it("replaces existing route with same hostname", async () => {
      await store.register({ hostnames: ["myapp.localhost"], pid: process.pid, port: 4001 });
      await store.register({ hostnames: ["myapp.localhost"], pid: process.pid, port: 4002 });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].port).toBe(4002);
    });

    it("preserves other routes when adding", async () => {
      await store.register({ hostnames: ["app1.localhost"], pid: process.pid, port: 4001 });
      await store.register({ hostnames: ["app2.localhost"], pid: process.pid, port: 4002 });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(2);
      const hostnames = routes.map((r) => r.hostname).sort();
      expect(hostnames).toEqual(["app1.localhost", "app2.localhost"]);
    });
  });

  describe("register with force", () => {
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

    function stop(pid: number): void {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already dead
      }
    }

    it("throws RouteConflictError without --force when route is owned by another live process", async () => {
      const otherPid = spawnSleeper();
      try {
        await store.register({ hostnames: ["app.localhost"], pid: otherPid, port: 4001 });
        await expect(
          store.register({ hostnames: ["app.localhost"], pid: process.pid, port: 4002 })
        ).rejects.toThrow(RouteConflictError);
      } finally {
        stop(otherPid);
      }
    });

    it("kills the existing process with --force and replaces its route", async () => {
      const otherPid = spawnSleeper();
      try {
        await store.register({ hostnames: ["app.localhost"], pid: otherPid, port: 4001 });
        const { killedPids } = await store.register({
          hostnames: ["app.localhost"],
          pid: process.pid,
          port: 4002,
          force: true,
        });
        expect(killedPids).toEqual([otherPid]);
        const routes = store.loadRoutes();
        expect(routes).toHaveLength(1);
        expect(routes[0].port).toBe(4002);
        expect(routes[0].pid).toBe(process.pid);
        await new Promise((r) => setTimeout(r, 200));
        expect(isAlive(otherPid)).toBe(false);
      } finally {
        stop(otherPid);
      }
    });

    it("refuses to replace a static alias without --force", async () => {
      await store.register({ hostnames: ["db.localhost"], pid: 0, port: 5432 });
      await expect(
        store.register({ hostnames: ["db.localhost"], pid: process.pid, port: 4002 })
      ).rejects.toThrow(
        '"db.localhost" is a static alias. Use --force to replace it; re-add the alias with "portless alias" afterwards.'
      );
    });

    it("replaces a static alias with --force without sending any signal", async () => {
      const realKill = process.kill.bind(process);
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((pid, signal) => (signal ? true : realKill(pid, signal)));
      try {
        await store.register({ hostnames: ["db.localhost"], pid: 0, port: 5432 });
        const { killedPids } = await store.register({
          hostnames: ["db.localhost"],
          pid: process.pid,
          port: 4002,
          force: true,
        });
        expect(killedPids).toEqual([]);
        expect(kill.mock.calls.filter(([, signal]) => signal)).toEqual([]);
        const routes = store.loadRoutes();
        expect(routes).toHaveLength(1);
        expect(routes[0]).toMatchObject({ port: 4002, pid: process.pid });
      } finally {
        kill.mockRestore();
      }
    });
  });

  describe("remove", () => {
    it("removes the given hostnames and leaves the rest", async () => {
      await store.register({ hostnames: ["app1.localhost"], pid: process.pid, port: 4001 });
      await store.register({ hostnames: ["app2.localhost"], pid: process.pid, port: 4002 });
      store.remove(["app1.localhost", "never-registered.localhost"]);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].hostname).toBe("app2.localhost");
    });

    it("does not remove a route the caller no longer owns (post --force takeover)", async () => {
      const newOwnerPid = process.ppid;
      await store.register({ hostnames: ["myapp.localhost"], pid: newOwnerPid, port: 4002 });
      store.remove(["myapp.localhost"], process.pid);
      expect(store.loadRoutes()[0].pid).toBe(newOwnerPid);
      store.remove(["myapp.localhost"], newOwnerPid);
      expect(store.loadRoutes()).toHaveLength(0);
    });
  });

  describe("stale recovery records", () => {
    const deadPid = 999999;
    const staleRoute = {
      hostname: "stale.localhost",
      port: 4310,
      pid: deadPid,
      childPgid: 4242,
      childStartTime: "leader-start",
      tailscaleHttpsPort: 8443,
      ngrokPid: 5151,
      registeredAt: Date.now() - 60_000,
    };

    const writeRoutes = (routes: unknown[]) =>
      fs.writeFileSync(path.join(tmpDir, "routes.json"), JSON.stringify(routes));
    const readRaw = () =>
      JSON.parse(fs.readFileSync(path.join(tmpDir, "routes.json"), "utf-8")) as Array<{
        hostname: string;
        pid: number;
        port: number;
        orphanPid?: number;
        orphanStartTime?: string;
        ngrokUrl?: string;
      }>;

    it("keeps a stale record out of the active view", () => {
      store.ensureDir();
      writeRoutes([staleRoute]);

      expect(store.loadRoutes()).toEqual([]);
      expect(store.loadRoutes({ includeStale: true })).toEqual([staleRoute]);
    });

    it("keeps the record through register, update, transfer and remove of other routes", async () => {
      store.ensureDir();
      writeRoutes([staleRoute]);

      await store.register({ hostnames: ["other.localhost"], pid: process.pid, port: 4001 });
      store.updateRoute("other.localhost", { ngrokUrl: "https://other.ngrok.app" });
      expect(store.transferRoute("other.localhost", process.pid, process.ppid)).toBe(true);
      store.remove(["other.localhost"], process.ppid);

      expect(readRaw()).toEqual([staleRoute]);
      expect(store.loadRoutes()).toEqual([]);
    });

    it("keeps the record when the same hostname is registered again", async () => {
      store.ensureDir();
      writeRoutes([staleRoute]);

      await store.register({ hostnames: ["stale.localhost"], pid: process.pid, port: 4999 });

      expect(store.loadRoutes()).toHaveLength(1);
      expect(store.loadRoutes()[0]!.port).toBe(4999);
      expect(readRaw()).toHaveLength(2);
      expect(readRaw()[0]).toMatchObject({
        hostname: "stale.localhost",
        port: 4999,
        pid: process.pid,
      });
      expect(readRaw()[1]).toEqual(staleRoute);
    });

    it("returns the active entry first for a legacy file with a stale record first", () => {
      store.ensureDir();
      const live = { hostname: "stale.localhost", port: 4999, pid: process.pid };
      writeRoutes([staleRoute, live]);

      const all = store.loadRoutes({ includeStale: true });
      expect(all).toEqual([live, staleRoute]);
      expect(all.find((route) => route.hostname === "stale.localhost")).toEqual(live);
    });

    it("updates the live entry, not the stale record, for a shared hostname", () => {
      store.ensureDir();
      const live = { hostname: "stale.localhost", port: 4999, pid: process.pid };
      writeRoutes([staleRoute, live]);

      store.updateRoute("stale.localhost", { ngrokUrl: "https://live.ngrok.app" });

      const raw = readRaw();
      expect(raw[0]).toEqual({ ...live, ngrokUrl: "https://live.ngrok.app" });
      expect(raw[1]).toEqual(staleRoute);
    });

    it("records a verified member only on the matching stale record", () => {
      store.ensureDir();
      writeRoutes([staleRoute]);

      expect(store.recordStaleOrphan({ ...staleRoute, childStartTime: "other" }, 4343, "m")).toBe(
        false
      );
      expect(store.recordStaleOrphan(staleRoute, 4343, "member-start")).toBe(true);

      expect(readRaw()).toEqual([
        { ...staleRoute, orphanPid: 4343, orphanStartTime: "member-start" },
      ]);
    });

    it("removes only the dead owner's record", () => {
      store.ensureDir();
      const second = { ...staleRoute, hostname: "second.localhost", port: 4311 };
      writeRoutes([staleRoute, second]);

      expect(store.removeStaleRoute("stale.localhost", 111111)).toBe(false);
      expect(store.removeStaleRoute("stale.localhost", deadPid)).toBe(true);
      expect(readRaw()).toEqual([second]);
    });

    it("drops stale entries without recovery data on the next write", async () => {
      store.ensureDir();
      const plain = { hostname: "plain.localhost", port: 4312, pid: deadPid, registeredAt: 1 };
      writeRoutes([plain]);

      await store.register({ hostnames: ["other.localhost"], pid: process.pid, port: 4001 });

      expect(readRaw().map((route) => route.hostname)).toEqual(["other.localhost"]);
    });
  });

  describe("transferRoute", () => {
    it("moves a route to another pid while the caller owns it", async () => {
      await store.register({ hostnames: ["myapp.localhost"], pid: process.pid, port: 4001 });
      expect(store.transferRoute("myapp.localhost", process.pid, process.ppid)).toBe(true);
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].pid).toBe(process.ppid);
      expect(routes[0].port).toBe(4001);
    });

    it("drops sharing URLs, whose tunnels stop with the previous owner", async () => {
      await store.register({ hostnames: ["myapp.localhost"], pid: process.pid, port: 4001 });
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

    it("does not move a route owned by another pid", async () => {
      await store.register({ hostnames: ["myapp.localhost"], pid: process.ppid, port: 4001 });
      expect(store.transferRoute("myapp.localhost", process.pid, 1)).toBe(false);
      expect(store.loadRoutes()[0].pid).toBe(process.ppid);
    });
  });

  describe("concurrent register and lock ownership", () => {
    const lockPath = () => path.join(tmpDir, "routes.lock");
    const ownerPath = () => path.join(lockPath(), "owner");

    function writeLock(pid: number | undefined, ageMs = 0): void {
      fs.mkdirSync(lockPath(), { recursive: true });
      if (pid !== undefined) fs.writeFileSync(ownerPath(), JSON.stringify({ pid }));
      if (ageMs > 0) {
        const when = new Date(Date.now() - ageMs);
        fs.utimesSync(lockPath(), when, when);
      }
    }

    async function exitedPid(): Promise<number> {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise((resolve) => child.on("exit", resolve));
      return child.pid!;
    }

    it("gives each of 20 concurrent processes its own port", async () => {
      const count = 20;
      const scriptPath = path.join(tmpDir, "worker.mjs");
      const pkgDir = path.resolve(import.meta.dirname, "..");
      const importUrl = pathToFileURL(path.join(pkgDir, "dist", "index.js")).href;
      fs.writeFileSync(
        scriptPath,
        [
          `import { RouteStore } from ${JSON.stringify(importUrl)};`,
          `const [dir, hostname] = process.argv.slice(2);`,
          `const store = new RouteStore(dir);`,
          `try {`,
          `  const { port } = await store.register({ hostnames: [hostname], pid: process.pid });`,
          `  console.log("ok:" + port);`,
          `} catch (e) { console.log("error:" + e.message); process.exit(1); }`,
          `process.stdin.resume();`,
        ].join("\n")
      );

      const occupied: net.Server[] = [];
      try {
        for (let port = 4023; port <= 4999; port++) {
          const server = net.createServer();
          await new Promise<void>((resolve) => {
            server.once("error", () => resolve());
            server.listen(port, "127.0.0.1", () => {
              occupied.push(server);
              resolve();
            });
          });
        }

        const children = Array.from({ length: count }, (_, i) =>
          spawn(process.execPath, [scriptPath, tmpDir, `app${i}.localhost`], {
            stdio: ["pipe", "pipe", "pipe"],
          })
        );
        const outcomes = await Promise.all(
          children.map(
            (child) =>
              new Promise<string>((resolve) => {
                let out = "";
                child.stdout!.on("data", (data: Buffer) => {
                  out += data.toString();
                  if (out.includes("\n")) resolve(out.trim());
                });
                child.on("close", (code) => resolve(out.trim() || `exit:${code}`));
              })
          )
        );
        for (const child of children) child.stdin!.end();

        expect(outcomes.filter((outcome) => !outcome.startsWith("ok:"))).toEqual([]);
        const saved = JSON.parse(fs.readFileSync(store.getRoutesPath(), "utf-8")) as {
          port: number;
        }[];
        expect(saved).toHaveLength(count);
        expect(new Set(saved.map((route) => route.port)).size).toBe(count);
      } finally {
        for (const server of occupied) server.close();
      }
    }, 60_000);

    it.each([
      ["win32", "EPERM", true],
      ["linux", "EPERM", false],
      ["win32", "EACCES", false],
    ])("handles %s lock creation error %s", async (platform, code, retries) => {
      const mkdir = vi.mocked(fs.mkdirSync);
      const realMkdir = mkdir.getMockImplementation()!;
      const originalPlatform = process.platform;
      mkdir.mockImplementationOnce(() => {
        throw Object.assign(new Error("lock creation failed"), { code });
      });
      Object.defineProperty(process, "platform", { value: platform });
      const register = store.register({
        hostnames: ["retry.localhost"],
        pid: process.pid,
        port: 4001,
      });
      try {
        if (retries) {
          await expect(register).resolves.toEqual({ port: 4001, killedPids: [] });
          expect(store.loadRoutes()).toEqual([
            expect.objectContaining({ hostname: "retry.localhost", port: 4001 }),
          ]);
          expect(fs.existsSync(lockPath())).toBe(false);
        } else {
          await expect(register).rejects.toThrow("Failed to acquire route lock");
          expect(fs.existsSync(store.getRoutesPath())).toBe(false);
        }
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform });
        mkdir.mockReset();
        mkdir.mockImplementation(realMkdir);
      }
    });

    it("never allocates a port a live alias holds", async () => {
      const aliases = Array.from({ length: 999 }, (_, i) => ({
        hostname: `alias-${4001 + i}.localhost`,
        port: 4001 + i,
        pid: 0,
      }));
      store.ensureDir();
      fs.writeFileSync(store.getRoutesPath(), JSON.stringify(aliases));

      const { port } = await store.register({ hostnames: ["app.localhost"], pid: process.pid });
      expect(port).toBe(4000);
      expect(store.loadRoutes().find((route) => route.hostname === "app.localhost")?.port).toBe(
        4000
      );
    }, 60_000);

    it("does not reclaim a lock held by a live process", async () => {
      writeLock(process.pid, 20_000);
      await expect(
        store.register({ hostnames: ["waiting.localhost"], pid: process.pid, port: 4001 })
      ).rejects.toThrow("Failed to acquire route lock");
      expect(store.loadRoutes()).toEqual([]);
    }, 40_000);

    it("reclaims a lock whose holder is dead", async () => {
      writeLock(await exitedPid(), 20_000);
      const { port } = await store.register({
        hostnames: ["recovered.localhost"],
        pid: process.pid,
        port: 4001,
      });
      expect(port).toBe(4001);
      expect(store.loadRoutes().map((route) => route.hostname)).toEqual(["recovered.localhost"]);
    }, 30_000);

    it("reclaims a lock with no owner file", async () => {
      writeLock(undefined, 20_000);
      const { port } = await store.register({
        hostnames: ["recovered.localhost"],
        pid: process.pid,
        port: 4001,
      });
      expect(port).toBe(4001);
      expect(store.loadRoutes().map((route) => route.hostname)).toEqual(["recovered.localhost"]);
    }, 30_000);

    it("survives sustained lock contention that defeats a naive retry strategy", async () => {
      store.ensureDir();
      const holder = spawn(
        process.execPath,
        [
          "-e",
          [
            `const fs = require("fs");`,
            `const path = require("path");`,
            `const lockPath = ${JSON.stringify(lockPath())};`,
            `fs.mkdirSync(lockPath, { recursive: true });`,
            `fs.writeFileSync(path.join(lockPath, "owner"), JSON.stringify({ pid: process.pid }));`,
            `console.log("holding");`,
            `setTimeout(() => { try { fs.rmSync(lockPath, { recursive: true }); } catch {} }, 1500);`,
          ].join("\n"),
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      await new Promise<void>((resolve) => {
        holder.stdout!.on("data", (data: Buffer) => {
          if (data.toString().includes("holding")) resolve();
        });
      });

      const { port } = await store.register({
        hostnames: ["contended.localhost"],
        pid: process.pid,
        port: 5000,
      });

      holder.kill("SIGTERM");
      expect(port).toBe(5000);
      expect(store.loadRoutes().map((route) => route.hostname)).toEqual(["contended.localhost"]);
    }, 10_000);
  });

  describe("route metadata", () => {
    it("persists and loads tailscale fields via updateRoute", async () => {
      await store.register({ hostnames: ["myapp.localhost"], pid: process.pid, port: 4123 });
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

    it("persists funnel flag via updateRoute", async () => {
      await store.register({ hostnames: ["api.localhost"], pid: process.pid, port: 4456 });
      store.updateRoute("api.localhost", {
        tailscaleUrl: "https://devbox.example.ts.net:8443",
        tailscaleHttpsPort: 8443,
        tailscaleFunnel: true,
      });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].tailscaleFunnel).toBe(true);
    });

    it("updateRoute keeps the original registeredAt", async () => {
      await store.register({ hostnames: ["myapp.localhost"], pid: process.pid, port: 4123 });
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

    it("updateRoute is a no-op for nonexistent hostname", async () => {
      await store.register({ hostnames: ["myapp.localhost"], pid: process.pid, port: 4123 });
      store.updateRoute("noexist.localhost", {
        tailscaleUrl: "https://devbox.example.ts.net",
      });
      const routes = store.loadRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].tailscaleUrl).toBeUndefined();
    });

    it("persists, loads and clears ngrok fields via updateRoute", async () => {
      await store.register({ hostnames: ["myapp.localhost"], pid: process.pid, port: 4123 });
      store.updateRoute("myapp.localhost", {
        ngrokUrl: "https://abc123.ngrok.app",
        ngrokPid: 12345,
      });
      let routes = store.loadRoutes();
      expect(routes[0].ngrokUrl).toBe("https://abc123.ngrok.app");
      expect(routes[0].ngrokPid).toBe(12345);

      store.updateRoute("myapp.localhost", { ngrokUrl: null, ngrokPid: null });
      routes = store.loadRoutes();
      expect(routes[0].ngrokUrl).toBeUndefined();
      expect(routes[0].ngrokPid).toBeUndefined();
    });
  });
});

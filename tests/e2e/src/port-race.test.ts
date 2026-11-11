import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../../packages/portless/dist/cli.js");
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/slow-boot-server");
const PRELOAD = path.join(FIXTURE_DIR, "same-first-pick.cjs");
const PROXY_PORT = 19014;
const FIRST_PICK_PORT = 4777;
const APP_COUNT = 4;

const isWindows = process.platform === "win32";

function makeRequest(host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${PROXY_PORT}/`,
      { headers: { Host: host } },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

// #533: findFreePort releases its probe before the app binds, so runs started
// together can pick the same port. A dev server that keeps running after the
// bind fails (tsx watch, node --watch, nodemon) then leaves its route pointing
// at another app's server. The preload makes every run probe the same port
// first, and the fixture waits before binding, so the race happens every time.
describe.skipIf(isWindows)("concurrent runs that pick their own port", () => {
  const children: ChildProcess[] = [];
  let stateDir: string;
  let baseEnv: NodeJS.ProcessEnv;

  afterAll(async () => {
    for (const child of children) {
      try {
        // Each run is a process group leader, so this also stops its dev server.
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // already gone
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
    if (stateDir) {
      spawnSync(process.execPath, [CLI_PATH, "proxy", "stop"], { env: baseEnv, timeout: 10_000 });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("gives each run its own app port and routes each hostname to its own app", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-e2e-port-race-"));
    baseEnv = {
      ...process.env,
      PORTLESS_PORT: PROXY_PORT.toString(),
      PORTLESS_HTTPS: "0",
      PORTLESS_SYNC_HOSTS: "0",
      PORTLESS_STATE_DIR: stateDir,
      NO_COLOR: "1",
      FIRST_PICK_PORT: FIRST_PICK_PORT.toString(),
      BOOT_DELAY_MS: "1500",
    };

    spawnSync(
      process.execPath,
      [CLI_PATH, "proxy", "start", "--no-tls", "-p", String(PROXY_PORT)],
      {
        env: baseEnv,
        timeout: 15_000,
      }
    );

    const names = Array.from({ length: APP_COUNT }, (_, i) => `race-app-${i}`);
    for (const name of names) {
      children.push(
        spawn(process.execPath, ["-r", PRELOAD, CLI_PATH, name, "node", "server.js"], {
          cwd: FIXTURE_DIR,
          env: { ...baseEnv, APP_NAME: name },
          stdio: "ignore",
          detached: true,
        })
      );
    }

    // Wait until every app has booted and its route is registered.
    const routesPath = path.join(stateDir, "routes.json");
    const deadline = Date.now() + 30_000;
    let routes: { hostname: string; port: number }[] = [];
    while (Date.now() < deadline) {
      try {
        routes = JSON.parse(fs.readFileSync(routesPath, "utf-8"));
      } catch {
        routes = [];
      }
      if (routes.length === APP_COUNT) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(routes.map((r) => r.hostname).sort()).toEqual(names.map((n) => `${n}.localhost`).sort());
    await new Promise((r) => setTimeout(r, 2500)); // let every dev server finish booting

    // No two apps share a port.
    const ports = routes.map((r) => r.port);
    expect(new Set(ports).size).toBe(APP_COUNT);

    // Each hostname reaches its own app, not another app on a shared port.
    for (const name of names) {
      const { status, body } = await makeRequest(`${name}.localhost`);
      expect(status).toBe(200);
      expect(body).toBe(`ok:${name}`);
    }
  });
});

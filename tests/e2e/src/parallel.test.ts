import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../../packages/portless/dist/cli.js");
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/minimal-server");
const PROXY_PORT = 19012;

const isWindows = process.platform === "win32";

function killPort(port: number): void {
  try {
    if (isWindows) {
      const output = execSync("netstat -ano -p tcp", {
        encoding: "utf-8",
        timeout: 5000,
      });
      const myPid = process.pid;
      for (const line of output.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const localAddr = parts[1];
        const lastColon = localAddr.lastIndexOf(":");
        if (lastColon === -1) continue;
        const addrPort = parseInt(localAddr.substring(lastColon + 1), 10);
        if (addrPort !== port) continue;
        const pid = parseInt(parts[parts.length - 1], 10);
        if (isNaN(pid) || pid <= 0 || pid === myPid) continue;
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already dead
        }
      }
    } else {
      const pids = execSync(`lsof -ti tcp:${port}`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      if (pids) {
        const myPid = process.pid;
        for (const raw of pids.split("\n")) {
          const pid = parseInt(raw, 10);
          if (isNaN(pid) || pid === myPid) continue;
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // already dead
          }
        }
      }
    }
  } catch {
    // no process on port
  }
}

function makeRequest(url: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

describe("parallel route registration", () => {
  // Matches real-world monorepo scale (json-render has 19 parallel portless commands)
  const APP_COUNT = 20;
  const children: ChildProcess[] = [];
  let stateDir: string;

  afterAll(async () => {
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 1000));
    for (const child of children) {
      if (!child.killed) child.kill("SIGKILL");
    }

    if (stateDir) {
      spawnSync(process.execPath, [CLI_PATH, "proxy", "stop"], {
        env: {
          ...process.env,
          PORTLESS_PORT: PROXY_PORT.toString(),
          PORTLESS_STATE_DIR: stateDir,
          NO_COLOR: "1",
        },
        timeout: 10_000,
      });
    }

    killPort(PROXY_PORT);

    if (stateDir) {
      try {
        fs.rmSync(stateDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("registers all routes when many portless run commands start in parallel", async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-e2e-parallel-"));

    const baseEnv = {
      ...process.env,
      PORTLESS_PORT: PROXY_PORT.toString(),
      PORTLESS_HTTPS: "0",
      PORTLESS_STATE_DIR: stateDir,
      NO_COLOR: "1",
    };

    // Start the proxy explicitly first so all parallel runs don't race to start it
    spawnSync(
      process.execPath,
      [CLI_PATH, "proxy", "start", "--no-tls", "-p", PROXY_PORT.toString()],
      {
        env: baseEnv,
        timeout: 15_000,
      }
    );

    interface AppResult {
      name: string;
      hostname: string;
      stdout: string;
      stderr: string;
      exited: boolean;
      exitCode: number | null;
    }

    const apps: AppResult[] = [];

    // Launch all apps in parallel, just like a monorepo task runner would
    for (let i = 0; i < APP_COUNT; i++) {
      const name = `parallel-app-${i}`;
      const hostname = `${name}.localhost`;
      const app: AppResult = {
        name,
        hostname,
        stdout: "",
        stderr: "",
        exited: false,
        exitCode: null,
      };
      apps.push(app);

      const appPort = 17100 + i;
      const child = spawn(
        process.execPath,
        [CLI_PATH, name, "--app-port", String(appPort), "node", "server.js"],
        {
          cwd: FIXTURE_DIR,
          env: { ...baseEnv, APP_NAME: name },
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      children.push(child);

      child.stdout!.on("data", (chunk: Buffer) => {
        app.stdout += chunk.toString();
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        app.stderr += chunk.toString();
      });
      child.on("exit", (code) => {
        app.exited = true;
        app.exitCode = code;
      });
    }

    // Wait for all apps to be registered (or for early failures)
    const deadline = Date.now() + 60_000;
    const registered = new Set<number>();

    while (registered.size < APP_COUNT && Date.now() < deadline) {
      for (let i = 0; i < APP_COUNT; i++) {
        if (registered.has(i)) continue;

        // If the process exited early, that's a failure we'll catch below
        if (apps[i].exited) {
          registered.add(i);
          continue;
        }

        try {
          const { status } = await makeRequest(`http://127.0.0.1:${PROXY_PORT}/`, apps[i].hostname);
          if (status >= 200 && status < 400) {
            registered.add(i);
          }
        } catch {
          // not ready yet
        }
      }
      if (registered.size < APP_COUNT) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // Verify no app crashed with a lock error
    const lockFailures = apps.filter(
      (a) =>
        a.stderr.includes("Failed to acquire route lock") ||
        a.stdout.includes("Failed to acquire route lock")
    );
    expect(lockFailures.map((a) => a.name)).toEqual([]);

    // Verify no app exited unexpectedly
    const crashedApps = apps.filter((a) => a.exited && a.exitCode !== 0);
    expect(crashedApps.map((a) => ({ name: a.name, code: a.exitCode, stderr: a.stderr }))).toEqual(
      []
    );

    // Verify all apps are reachable through the proxy
    for (let i = 0; i < APP_COUNT; i++) {
      const { status, body } = await makeRequest(
        `http://127.0.0.1:${PROXY_PORT}/`,
        apps[i].hostname
      );
      expect(status).toBe(200);
      expect(body).toContain(`ok:parallel-app-${i}`);
    }

    // Verify the routes file has all entries
    const routesPath = path.join(stateDir, "routes.json");
    const routes = JSON.parse(fs.readFileSync(routesPath, "utf-8"));
    const registeredHostnames = routes.map((r: { hostname: string }) => r.hostname).sort();
    const expectedHostnames = Array.from(
      { length: APP_COUNT },
      (_, i) => `parallel-app-${i}.localhost`
    ).sort();
    expect(registeredHostnames).toEqual(expectedHostnames);
  });
});

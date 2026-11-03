import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureDir } from "./harness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../../packages/portless/dist/cli.js");
const PROXY_PORT = 19012;
const PROJECT = "portless-e2e-compose";

// Skipped where no Docker daemon is available, such as the macOS and Windows CI runners.
const hasDocker = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasDocker)("compose", () => {
  const cwd = fixtureDir("compose-app");
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-e2e-compose-"));
  const env = {
    ...process.env,
    PORTLESS_PORT: String(PROXY_PORT),
    PORTLESS_HTTPS: "0",
    PORTLESS_STATE_DIR: stateDir,
    NO_COLOR: "1",
  };
  const portless = (...args: string[]) =>
    spawnSync(process.execPath, [CLI_PATH, ...args], { cwd, env, encoding: "utf8" });

  // fetch() drops the Host header, so use http.request.
  function status(host: string): Promise<number> {
    return new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: PROXY_PORT, path: "/", headers: { Host: host } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", () => resolve(0));
      req.setTimeout(2000, () => req.destroy());
      req.end();
    });
  }

  async function waitFor(host: string, timeoutMs = 30_000): Promise<number> {
    const start = Date.now();
    let last = 0;
    while (Date.now() - start < timeoutMs) {
      last = await status(host);
      if (last === 200) return last;
      await new Promise((r) => setTimeout(r, 500));
    }
    return last;
  }

  beforeAll(() => {
    const up = portless("compose", "up", "-d");
    expect(up.status, up.stdout + up.stderr).toBe(0);
  });

  afterAll(() => {
    spawnSync("docker", ["compose", "-p", PROJECT, "down", "--remove-orphans"], {
      stdio: "ignore",
    });
    portless("proxy", "stop", "-p", String(PROXY_PORT));
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("routes two services that publish the same host port", async () => {
    expect(await waitFor(`web.${PROJECT}.localhost`)).toBe(200);
    expect(await waitFor(`backend.${PROJECT}.localhost`)).toBe(200);
  });

  it("follows a recreated container to its new port", async () => {
    const recreate = portless("compose", "up", "-d", "--force-recreate", "web");
    expect(recreate.status, recreate.stdout + recreate.stderr).toBe(0);
    expect(await waitFor(`web.${PROJECT}.localhost`)).toBe(200);
  });

  it("removes the routes on down", async () => {
    const down = portless("compose", "down");
    expect(down.status, down.stdout + down.stderr).toBe(0);
    const list = portless("list");
    expect(list.stdout).not.toContain(PROJECT);
  });
});

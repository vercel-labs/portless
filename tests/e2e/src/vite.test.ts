import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  createTailscaleShim,
  fixtureDir,
  requestWithHost,
  startApp,
  type E2EContext,
} from "./harness.js";

describe("vite", () => {
  let ctx: E2EContext | undefined;
  let shim: ReturnType<typeof createTailscaleShim> | undefined;

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = undefined;
    shim?.cleanup();
    shim = undefined;
  });

  it("serves through the proxy", async () => {
    ctx = await startApp({
      name: "vite-test",
      command: ["vite"],
      cwd: fixtureDir("vite-app"),
      proxyPort: 19001,
    });
    const res = await fetch(ctx.proxyUrl);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from vite");
  });

  it.skipIf(process.platform === "win32")(
    "accepts the generated Tailscale host directly",
    async () => {
      const testShim = createTailscaleShim();
      shim = testShim;
      ctx = await startApp({
        name: "vite-tailscale-test",
        command: ["vite"],
        cwd: fixtureDir("vite-app"),
        proxyPort: 19014,
        env: {
          PATH: `${testShim.directory}${path.delimiter}${process.env.PATH ?? ""}`,
          PORTLESS_TAILSCALE: "1",
          PORTLESS_TEST_TAILSCALE_LOG: testShim.logPath,
        },
      });

      const routes = JSON.parse(
        fs.readFileSync(path.join(ctx.stateDir, "routes.json"), "utf-8")
      ) as Array<{ hostname: string; port: number; tailscaleUrl?: string }>;
      const route = routes.find((entry) => entry.hostname === "vite-tailscale-test.localhost");
      expect(route?.tailscaleUrl).toBe("https://devbox.example.ts.net:8443");
      expect(route).toBeDefined();

      const status = await requestWithHost(
        `http://127.0.0.1:${route!.port}/`,
        "devbox.example.ts.net:8443"
      );
      expect(status).toBe(200);
    }
  );
});

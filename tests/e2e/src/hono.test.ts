import { describe, it, expect, afterAll } from "vitest";
import { startApp, fixtureDir, type E2EContext } from "./harness.js";

describe("hono", () => {
  let ctx: E2EContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("serves through the proxy", async () => {
    ctx = await startApp({
      name: "hono-test",
      command: ["node", "server.js"],
      cwd: fixtureDir("hono-app"),
      proxyPort: 19009,
    });
    const res = await fetch(ctx.proxyUrl);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from hono");
  });
});

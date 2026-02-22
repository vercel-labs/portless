import { describe, it, expect, afterAll } from "vitest";
import { startApp, fixtureDir, type E2EContext } from "./harness.js";

describe("nuxt", () => {
  let ctx: E2EContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("serves through the proxy", async () => {
    ctx = await startApp({
      name: "nuxt-test",
      command: ["nuxt", "dev"],
      cwd: fixtureDir("nuxt-app"),
      proxyPort: 19006,
    });
    const res = await fetch(ctx.proxyUrl);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from nuxt");
  });
});

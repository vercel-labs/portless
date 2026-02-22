import { describe, it, expect, afterAll } from "vitest";
import { startApp, fixtureDir, type E2EContext } from "./harness.js";

describe("remix (react-router v7)", () => {
  let ctx: E2EContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("serves through the proxy", async () => {
    ctx = await startApp({
      name: "remix-test",
      command: ["react-router", "dev"],
      cwd: fixtureDir("remix-app"),
      proxyPort: 19004,
    });
    const res = await fetch(ctx.proxyUrl);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("__reactRouterContext");
  });
});

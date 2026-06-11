import { describe, it, expect, afterAll } from "vitest";
import { startApp, fixtureDir, type E2EContext } from "./harness.js";

describe("rsbuild", () => {
  let ctx: E2EContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("serves through the proxy", async () => {
    ctx = await startApp({
      name: "rsbuild-test",
      command: ["rsbuild"],
      cwd: fixtureDir("rsbuild-app"),
      proxyPort: 19013,
    });
    const res = await fetch(ctx.proxyUrl);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from rsbuild");
  });
});

import * as fs from "node:fs";
import { describe, it, expect, afterAll } from "vitest";
import { startApp, fixtureDir, PYTHON_BIN, type E2EContext } from "./harness.js";

describe("flask", () => {
  let ctx: E2EContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it.skipIf(!fs.existsSync(PYTHON_BIN))("serves through the proxy", async () => {
    ctx = await startApp({
      name: "flask-test",
      command: [PYTHON_BIN, "app.py"],
      cwd: fixtureDir("flask-app"),
      proxyPort: 19011,
    });
    const res = await fetch(ctx.proxyUrl);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from flask");
  });
});

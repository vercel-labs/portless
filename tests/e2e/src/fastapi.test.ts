import * as fs from "node:fs";
import { describe, it, expect, afterAll } from "vitest";
import { startApp, fixtureDir, PYTHON_BIN, type E2EContext } from "./harness.js";

describe("fastapi", () => {
  let ctx: E2EContext;

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it.skipIf(!fs.existsSync(PYTHON_BIN))("serves through the proxy", async () => {
    ctx = await startApp({
      name: "fastapi-test",
      command: [PYTHON_BIN, "main.py"],
      cwd: fixtureDir("fastapi-app"),
      proxyPort: 19010,
    });
    const res = await fetch(ctx.proxyUrl);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("hello from fastapi");
  });
});

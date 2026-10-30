import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { testTimeout: process.platform === "win32" ? 30_000 : 5_000 },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Each test binds to a unique TCP port; sequential execution avoids
    // port collisions when cleanup from one test overlaps startup of the next.
    fileParallelism: false,
  },
});

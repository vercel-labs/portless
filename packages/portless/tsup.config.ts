import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  // api.ts is the public package entry (see package.json "exports").
  // index.ts is kept as an internal bundle: routes.test.ts spawns worker
  // processes that import RouteStore from dist/index.js to exercise
  // cross-process file locking.
  entry: ["src/cli.ts", "src/index.ts", "src/api.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  shims: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});

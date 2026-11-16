import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  // Declaration files come from tsc (tsconfig.build.json), which needs no TypeScript API.
  dts: false,
  clean: true,
  shims: true,
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
});

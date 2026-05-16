/* global process */
// Wrapper that spawns server.js as a child process, mimicking how
// `npm run dev` creates a grandchild. Prevents /bin/sh from exec-ing
// directly, which is required to reproduce the orphaned-grandchild bug.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

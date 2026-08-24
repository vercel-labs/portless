/* global process */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  detached: true,
  stdio: "inherit",
  env: process.env,
});

process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

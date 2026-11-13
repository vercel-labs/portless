import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

process.on("SIGTERM", () => {});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
spawn(process.execPath, [path.join(__dirname, "server.js")], {
  stdio: "inherit",
  env: process.env,
});

setInterval(() => {}, 1000);

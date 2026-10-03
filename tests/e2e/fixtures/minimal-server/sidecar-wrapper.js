/* global process */
// Spawns server.js plus an idle sidecar that does not listen on the app port,
// mimicking task runners (e.g. turbo) whose processes sit outside the route
// port. Writes the sidecar PID to SIDECAR_PID_FILE so tests can track it.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sidecar = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
fs.writeFileSync(process.env.SIDECAR_PID_FILE, String(sidecar.pid));

const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

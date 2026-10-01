import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");
const server = spawn(process.execPath, [serverPath], {
  detached: true,
  env: process.env,
  stdio: ["ignore", "pipe", "ignore"],
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.stdout.once("data", resolve);
});

server.stdout.destroy();
server.unref();

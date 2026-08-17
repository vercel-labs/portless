import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { findFreePort, isPortListening } from "./cli-utils.js";
import colors from "./colors.js";

/**
 * Docker Compose auto-port handling - portless for Docker
 * Intercepts `portless compose` to auto-assign free host ports when defaults are taken,
 * reusing portless's free-port logic instead of failing with
 * "Bind for 127.0.0.1:5432 failed: port is already allocated"
 */

const COMPOSE_PORT_VARS: Array<{ envVar: string; defaultPort: number; description: string }> = [
  { envVar: "DB_PORT", defaultPort: 5432, description: "Postgres" },
  { envVar: "REDIS_PORT", defaultPort: 6379, description: "Redis" },
  { envVar: "FRONTEND_PORT", defaultPort: 3000, description: "Frontend" },
  { envVar: "API_PORT", defaultPort: 8000, description: "API" },
  { envVar: "FLOWER_PORT", defaultPort: 5555, description: "Flower" },
  { envVar: "SVIX_PORT", defaultPort: 8071, description: "Svix" },
];

async function findAvailablePort(preferred: number): Promise<number> {
  if (!(await isPortListening(preferred))) {
    return preferred;
  }
  // Use portless's findFreePort (4000-4999 range) or nearby free port
  // Try to keep DB-ish ports near original for familiarity
  for (let p = preferred + 1; p < preferred + 100; p++) {
    if (!(await isPortListening(p))) return p;
  }
  return await findFreePort();
}

export async function handleCompose(args: string[]): Promise<void> {
  // Strip leading "compose" if present
  if (args[0] === "compose") args = args.slice(1);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printComposeHelp();
    return;
  }

  // Check if we're in a directory with docker-compose.yml
  const cwd = process.cwd();
  const composeFiles = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  let foundCompose = false;
  for (const f of composeFiles) {
    if (fs.existsSync(path.join(cwd, f))) {
      foundCompose = true;
      break;
    }
  }
  if (!foundCompose) {
    console.warn(colors.yellow(`Warning: No docker-compose.yml found in ${cwd}`));
  }

  // Auto-assign free ports for any taken defaults
  const envOverrides: Record<string, string> = {};
  for (const { envVar, defaultPort } of COMPOSE_PORT_VARS) {
    if (process.env[envVar]) {
      // User already exported - respect it
      continue;
    }
    if (await isPortListening(defaultPort)) {
      const free = await findAvailablePort(defaultPort);
      envOverrides[envVar] = String(free);
      console.log(colors.yellow(`portless compose: ${defaultPort} taken, using ${envVar}=${free}`));
    }
  }

  // Spawn docker compose with overrides
  const child = spawn("docker", ["compose", ...args], {
    stdio: "inherit",
    env: { ...process.env, ...envOverrides },
  });

  const exitCode: number | null = await new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", (err) => {
      console.error(colors.red(`Error: Failed to run docker compose: ${err.message}`));
      console.error(colors.blue("Is Docker installed and running?"));
      process.exit(1);
    });
  });

  if (exitCode !== 0 && exitCode !== null) {
    process.exit(exitCode);
  }

  // If this was an `up` command, also hint about portless alias for HTTP services
  if (args[0] === "up") {
    const aliased = Object.entries(envOverrides)
      .filter(([k]) => k === "FRONTEND_PORT" || k === "API_PORT")
      .map(([k, v]) => `  ${k}=${v}`);
    if (aliased.length > 0) {
      console.log(colors.gray("\nTip: Web services are now on different host ports. Use:"));
      for (const line of aliased) {
        console.log(colors.gray(line));
      }
      console.log(colors.gray("Or access via Docker network: db:5432, redis:6379"));
    }
  }
}

function printComposeHelp(): void {
  console.log(`
${colors.bold("portless compose")} - Docker Compose with automatic port conflict handling

Usage:
  portless compose <docker compose args...>
  portless compose up -d              # auto-assigns free ports if 5432/6379/3000 taken
  portless compose up -d --build      # pass through any docker compose flags

How it works:
  Checks if default host ports are already listening (5432, 6379, 3000, 8000, etc).
  If taken, picks a free port and exports DB_PORT, REDIS_PORT etc. for this run.
  Your docker-compose.yml uses \${DB_PORT:-5432}:5432 so the container still
  listens on 5432 internally, but the host mapping uses the free port.

Examples:
  portless compose up -d
  portless compose down
  portless compose logs -f

This reuses portless's proxy/CA work - for HTTP services you can also do:
  portless alias myapp 3000   # -> https://myapp.localhost
`);
}

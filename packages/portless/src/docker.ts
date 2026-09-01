import { spawn, spawnSync } from "node:child_process";
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
  for (let p = preferred + 1; p < preferred + 100; p++) {
    if (!(await isPortListening(p))) return p;
  }
  return await findFreePort();
}

function readEnvFile(cwd: string): Record<string, string> {
  const envPaths = [path.join(cwd, ".env"), path.join(cwd, "backend/config/.env")];
  const result: Record<string, string> = {};
  for (const p of envPaths) {
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n#]+)"?\s*$/);
      if (m) result[m[1]] = m[2].trim();
    }
  }
  return result;
}

function updateCorsForFrontend(cwd: string, newFrontendPort: number): void {
  const backendEnv = path.join(cwd, "backend/config/.env");
  if (!fs.existsSync(backendEnv)) return;
  let content = fs.readFileSync(backendEnv, "utf-8");
  const orig = content;
  if (content.includes('CORS_ORIGINS=["http://localhost:3000"]')) {
    content = content.replace(
      'CORS_ORIGINS=["http://localhost:3000"]',
      `CORS_ORIGINS=["http://localhost:${newFrontendPort}","http://localhost:3000"]`
    );
  } else if (
    !content.includes(`http://localhost:${newFrontendPort}`) &&
    content.includes("CORS_ORIGINS=")
  ) {
    content = content.replace(/CORS_ORIGINS=\[([^\]]+)\]/, (match, inner) => {
      if (inner.includes(String(newFrontendPort))) return match;
      return `CORS_ORIGINS=[${inner},"http://localhost:${newFrontendPort}"]`;
    });
  }
  if (content.includes("FRONTEND_URL=http://localhost:3000")) {
    content = content.replace(
      "FRONTEND_URL=http://localhost:3000",
      `FRONTEND_URL=http://localhost:${newFrontendPort}`
    );
  }
  if (content !== orig) {
    fs.writeFileSync(backendEnv, content);
    console.log(
      colors.gray(`  Updated backend/config/.env FRONTEND_URL/CORS for :${newFrontendPort}`)
    );
  }
}

async function getProjectHostPorts(cwd: string): Promise<Set<number>> {
  try {
    const result = spawnSync("docker", ["compose", "ps", "--format", "json"], {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status !== 0 || !result.stdout) return new Set();
    const ports = new Set<number>();
    for (const line of result.stdout.trim().split("\n")) {
      if (!line) continue;
      try {
        const data = JSON.parse(line);
        const publishers = data.Publishers || data.publishers || [];
        for (const p of publishers) {
          if (p.PublishedPort) ports.add(Number(p.PublishedPort));
        }
        if (data.Ports) {
          const m = String(data.Ports).match(/(\d+)->/g);
          if (m) m.forEach((s) => ports.add(Number(s.replace("->", ""))));
        }
      } catch {
        /* ignore non-JSON line */ void 0;
      }
    }
    return ports;
  } catch {
    return new Set();
  }
}

async function isPortTakenForCompose(port: number, projectPorts: Set<number>): Promise<boolean> {
  if (projectPorts.has(port)) return false;
  return await isPortListening(port);
}

export async function handleCompose(args: string[]): Promise<void> {
  if (args[0] === "compose") args = args.slice(1);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printComposeHelp();
    return;
  }

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

  // Only auto-assign ports for commands that create containers (up/create). For restart/down/logs etc, reuse existing.
  const subCommand = args[0];
  const shouldAutoAssign = subCommand === "up" || subCommand === "create" || subCommand === "start";
  const envOverrides: Record<string, string> = {};

  if (shouldAutoAssign) {
    const existingEnv = readEnvFile(cwd);
    const projectPorts = await getProjectHostPorts(cwd);

    for (const { envVar, defaultPort } of COMPOSE_PORT_VARS) {
      if (process.env[envVar]) continue;

      // If we already have a custom port in .env, reuse it if it's either free or is our own project's port
      if (existingEnv[envVar] && existingEnv[envVar] !== String(defaultPort)) {
        const customPort = parseInt(existingEnv[envVar], 10);
        if (!isNaN(customPort)) {
          const isCustomTaken = await isPortTakenForCompose(customPort, projectPorts);
          // Keep custom if: custom is free, or custom is ours, or default is taken
          if (
            !isCustomTaken ||
            projectPorts.has(customPort) ||
            (await isPortTakenForCompose(defaultPort, projectPorts))
          ) {
            envOverrides[envVar] = existingEnv[envVar];
            // Ensure CORS matches if frontend
            if (envVar === "FRONTEND_PORT") updateCorsForFrontend(cwd, customPort);
            continue;
          }
        }
      }

      if (await isPortTakenForCompose(defaultPort, projectPorts)) {
        const free = await findAvailablePort(defaultPort);
        if (existingEnv[envVar] === String(free)) {
          envOverrides[envVar] = existingEnv[envVar];
        } else {
          envOverrides[envVar] = String(free);
          console.log(
            colors.yellow(`portless compose: ${defaultPort} taken, using ${envVar}=${free}`)
          );
          if (envVar === "FRONTEND_PORT") updateCorsForFrontend(cwd, free);
        }
      } else if (existingEnv[envVar] && envVar === "FRONTEND_PORT") {
        const customPort = parseInt(existingEnv[envVar], 10);
        if (!isNaN(customPort) && customPort !== defaultPort) {
          updateCorsForFrontend(cwd, customPort);
          envOverrides[envVar] = existingEnv[envVar];
        }
      }
    }
  }

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

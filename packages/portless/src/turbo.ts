import * as fs from "node:fs";
import * as path from "node:path";
import { isProcessAlive } from "./utils.js";

export interface ManifestEntry {
  PORT: string;
  HOST: string;
  PORTLESS_URL: string;
  __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS?: string;
  NODE_EXTRA_CA_CERTS?: string;
}

/** Path of the env loader owned by this portless run. */
export function loaderPath(baseDir: string): string {
  return path.resolve(baseDir, `turbo-env-loader-${process.pid}.cjs`);
}

/**
 * Generate a CJS loader that sets the env vars of the package directory a
 * Node process starts in. Keys are absolute paths to package directories.
 */
export function loaderSource(entries: Record<string, ManifestEntry>): string {
  return `"use strict";
var entry = ${JSON.stringify(entries)}[process.cwd()];
if (entry) Object.assign(process.env, entry);
`;
}

/** Write this run's loader and remove loaders left by runs that are no longer alive. */
export function writeEnvLoader(entries: Record<string, ManifestEntry>, baseDir: string): void {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o755 });
  for (const name of fs.readdirSync(baseDir)) {
    const pid = /^turbo-env-loader-(\d+)\.cjs$/.exec(name)?.[1];
    if (pid && !isProcessAlive(Number(pid))) fs.rmSync(path.join(baseDir, name), { force: true });
  }
  fs.writeFileSync(loaderPath(baseDir), loaderSource(entries), { mode: 0o644 });
}

/** Remove this run's loader. */
export function removeEnvLoader(baseDir: string): void {
  fs.rmSync(loaderPath(baseDir), { force: true });
}

/**
 * Build the NODE_OPTIONS value with the --require loader prepended.
 * Preserves any existing NODE_OPTIONS value.
 */
export function buildNodeOptions(baseDir: string): string {
  const existing = process.env.NODE_OPTIONS || "";
  const lp = loaderPath(baseDir);
  const requireFlag = lp.includes(" ") ? `--require "${lp}"` : `--require ${lp}`;
  return existing ? `${requireFlag} ${existing}` : requireFlag;
}

/** Check whether a readable turbo.json or turbo.jsonc exists at the given workspace root. */
export function hasTurboConfig(wsRoot: string): boolean {
  for (const configName of ["turbo.json", "turbo.jsonc"]) {
    try {
      fs.accessSync(path.join(wsRoot, configName), fs.constants.R_OK);
      return true;
    } catch {
      // Try the next supported Turbo configuration filename.
    }
  }

  return false;
}

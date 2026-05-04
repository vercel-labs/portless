import * as fs from "node:fs";
import * as path from "node:path";
import { USER_STATE_DIR } from "./cli-utils.js";

export const LOADER_FILENAME = "turbo-env-loader.cjs";
export const MANIFEST_FILENAME = "dev-manifest.json";

export function loaderPath(baseDir: string = USER_STATE_DIR): string {
  return path.join(baseDir, LOADER_FILENAME);
}

export function manifestPath(baseDir: string = USER_STATE_DIR): string {
  return path.join(baseDir, MANIFEST_FILENAME);
}

/**
 * Generate the CJS loader script source. The manifest path is resolved
 * relative to the given base directory at runtime.
 */
export function loaderSource(baseDir: string = USER_STATE_DIR): string {
  return `"use strict";
var fs = require("fs");
var path = require("path");
var manifestPath = path.join(${JSON.stringify(baseDir)}, "dev-manifest.json");
try {
  var raw = fs.readFileSync(manifestPath, "utf-8");
  var manifest = JSON.parse(raw);
  var cwd = process.cwd();
  var entry = manifest[cwd];
  if (entry && typeof entry === "object") {
    var keys = Object.keys(entry);
    for (var i = 0; i < keys.length; i++) {
      process.env[keys[i]] = entry[keys[i]];
    }
  }
} catch (_) {}
`;
}

/** Ensure the loader script exists. */
export function ensureEnvLoader(baseDir: string = USER_STATE_DIR): void {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o755 });
  const target = loaderPath(baseDir);
  const source = loaderSource(baseDir);

  try {
    const existing = fs.readFileSync(target, "utf-8");
    if (existing === source) return;
  } catch {
    // doesn't exist yet
  }
  fs.writeFileSync(target, source, { mode: 0o644 });
}

export interface ManifestEntry {
  PORT: string;
  HOST: string;
  PORTLESS_URL: string;
  NODE_EXTRA_CA_CERTS?: string;
}

/**
 * Write the dev-manifest.json mapping package directories to env vars.
 * Keys are absolute paths to package directories.
 */
export function writeManifest(
  entries: Record<string, ManifestEntry>,
  baseDir: string = USER_STATE_DIR
): void {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o755 });
  fs.writeFileSync(manifestPath(baseDir), JSON.stringify(entries, null, 2) + "\n", { mode: 0o644 });
}

/** Remove the dev-manifest.json file. */
export function removeManifest(baseDir: string = USER_STATE_DIR): void {
  try {
    fs.unlinkSync(manifestPath(baseDir));
  } catch {
    // already gone
  }
}

/**
 * Build the NODE_OPTIONS value with the --require loader prepended.
 * Preserves any existing NODE_OPTIONS value.
 */
export function buildNodeOptions(baseDir: string = USER_STATE_DIR): string {
  const existing = process.env.NODE_OPTIONS || "";
  const lp = loaderPath(baseDir);
  const requireFlag = lp.includes(" ") ? `--require "${lp}"` : `--require ${lp}`;
  return existing ? `${requireFlag} ${existing}` : requireFlag;
}

/** Check whether turbo.json exists at the given workspace root. */
export function hasTurboConfig(wsRoot: string): boolean {
  try {
    fs.accessSync(path.join(wsRoot, "turbo.json"), fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

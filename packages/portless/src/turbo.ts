import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildEnvMap } from "./child-env.js";
import { isProcessAlive } from "./utils.js";

export type ManifestEntry = ChildEnvMap;

const DATA_FILE_PATTERN = /^turbo-env-(\d+)\.json$/;

const LOADER_SOURCE = `"use strict";
var fs = require("fs");
var path = require("path");
var cwd = process.cwd();
var names = fs.readdirSync(__dirname);
for (var i = 0; i < names.length; i++) {
  var match = ${DATA_FILE_PATTERN}.exec(names[i]);
  if (!match || !isAlive(Number(match[1]))) continue;
  var entry = readData(path.join(__dirname, names[i]))[cwd];
  if (entry) {
    Object.assign(process.env, entry);
    break;
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function readData(file) {
  var raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  return JSON.parse(raw);
}
`;

/** Path of the env loader shared by every portless run using a state directory. */
export function loaderPath(baseDir: string): string {
  return path.resolve(baseDir, "turbo-env-loader.cjs");
}

function dataPath(baseDir: string): string {
  return path.resolve(baseDir, `turbo-env-${process.pid}.json`);
}

function writeFileAtomic(file: string, content: string): void {
  const tempPath = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, content, { mode: 0o644 });
  fs.renameSync(tempPath, file);
}

type EnvPublicationState = "unpublished" | "published" | "retired";

/**
 * Lifecycle of this run's env data file for the shared loader:
 * unpublished, then published, then retired. Retire is idempotent and final.
 */
export class EnvPublication {
  private state: EnvPublicationState = "unpublished";

  constructor(private readonly baseDir: string) {}

  /** Write the shared loader and this run's entries, removing data left by dead runs. */
  publish(entries: Record<string, ManifestEntry>): void {
    if (this.state !== "unpublished") {
      throw new Error(`Cannot publish Turbo env entries in state ${this.state}`);
    }
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o755 });
    for (const name of fs.readdirSync(this.baseDir)) {
      const pid = DATA_FILE_PATTERN.exec(name)?.[1];
      if (pid && !isProcessAlive(Number(pid))) {
        fs.rmSync(path.join(this.baseDir, name), { force: true });
      }
    }
    writeFileAtomic(loaderPath(this.baseDir), LOADER_SOURCE);
    writeFileAtomic(dataPath(this.baseDir), JSON.stringify(entries));
    this.state = "published";
  }

  /** Remove this run's entries. The shared loader stays for processes that outlive the run. */
  retire(): void {
    if (this.state === "published") fs.rmSync(dataPath(this.baseDir), { force: true });
    this.state = "retired";
  }
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

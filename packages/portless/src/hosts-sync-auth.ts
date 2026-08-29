import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fixOwnership } from "./utils.js";

export const HOSTS_SYNC_AUTH_FILE = "proxy.hosts-sync-token";
export const HOSTS_SYNC_AUTH_TEMP_FILE = `${HOSTS_SYNC_AUTH_FILE}.tmp`;
export const HOSTS_SYNC_AUTH_HEADER = "x-portless-hosts-sync-token";
export const HOSTS_SYNC_AUTH_CHALLENGE_HEADER = "x-portless-hosts-sync-challenge";
export const HOSTS_SYNC_AUTH_PROOF_HEADER = "x-portless-hosts-sync-proof";

const HOSTS_SYNC_AUTH_PATTERN = /^[a-f0-9]{64}$/;

export function isValidHostsSyncToken(value: string): boolean {
  return HOSTS_SYNC_AUTH_PATTERN.test(value);
}

export function generateHostsSyncToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export const generateHostsSyncChallenge = generateHostsSyncToken;

export function createHostsSyncProof(token: string, challenge: string): string | null {
  if (!isValidHostsSyncToken(token) || !HOSTS_SYNC_AUTH_PATTERN.test(challenge)) return null;
  return crypto.createHmac("sha256", token).update(challenge).digest("hex");
}

export function writeHostsSyncToken(dir: string, token: string): boolean {
  if (!isValidHostsSyncToken(token)) return false;
  const tokenPath = path.join(dir, HOSTS_SYNC_AUTH_FILE);
  const tempPath = path.join(dir, HOSTS_SYNC_AUTH_TEMP_FILE);
  try {
    fs.rmSync(tempPath, { force: true });
    fs.writeFileSync(tempPath, token, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    fixOwnership(tempPath);
    fs.renameSync(tempPath, tokenPath);
    return true;
  } catch {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      return false;
    }
    return false;
  }
}

export function readHostsSyncToken(dir: string): string | null {
  try {
    const token = fs.readFileSync(path.join(dir, HOSTS_SYNC_AUTH_FILE), "utf-8").trim();
    return isValidHostsSyncToken(token) ? token : null;
  } catch {
    return null;
  }
}

export function removeHostsSyncToken(dir: string): void {
  for (const filename of [HOSTS_SYNC_AUTH_FILE, HOSTS_SYNC_AUTH_TEMP_FILE]) {
    try {
      fs.rmSync(path.join(dir, filename), { force: true });
    } catch {
      continue;
    }
  }
}

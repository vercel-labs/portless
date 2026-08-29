import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HOSTS_SYNC_AUTH_FILE,
  HOSTS_SYNC_AUTH_TEMP_FILE,
  createHostsSyncProof,
  generateHostsSyncChallenge,
  generateHostsSyncToken,
  readHostsSyncToken,
  removeHostsSyncToken,
  writeHostsSyncToken,
} from "./hosts-sync-auth.js";

describe("hosts-sync authorization state", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-hosts-sync-auth-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates private per-daemon authorization state", () => {
    const token = generateHostsSyncToken();
    expect(writeHostsSyncToken(dir, token)).toBe(true);
    const tokenPath = path.join(dir, HOSTS_SYNC_AUTH_FILE);

    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(readHostsSyncToken(dir)).toBe(token);
    if (process.platform !== "win32") {
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
    }
  });

  it("rotates authorization state", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    writeHostsSyncToken(dir, first);
    writeHostsSyncToken(dir, second);

    expect(second).not.toBe(first);
    expect(readHostsSyncToken(dir)).toBe(second);
  });

  it("does not publish malformed authorization state", () => {
    expect(writeHostsSyncToken(dir, "not-a-token")).toBe(false);
    expect(readHostsSyncToken(dir)).toBeNull();
  });

  it("fails closed when authorization state cannot be published", () => {
    const missingDir = path.join(dir, "missing", "state");
    expect(writeHostsSyncToken(missingDir, "a".repeat(64))).toBe(false);
    expect(readHostsSyncToken(missingDir)).toBeNull();
  });

  it("preserves the active authorization state when replacement fails", () => {
    const activeToken = "a".repeat(64);
    const replacementToken = "b".repeat(64);
    expect(writeHostsSyncToken(dir, activeToken)).toBe(true);
    fs.mkdirSync(path.join(dir, `${HOSTS_SYNC_AUTH_FILE}.tmp`));

    expect(writeHostsSyncToken(dir, replacementToken)).toBe(false);
    expect(readHostsSyncToken(dir)).toBe(activeToken);
  });

  it("creates a challenge-bound proof of authorization", () => {
    const token = "a".repeat(64);
    const challenge = generateHostsSyncChallenge();

    expect(createHostsSyncProof(token, challenge)).toMatch(/^[a-f0-9]{64}$/);
    expect(createHostsSyncProof(token, "not-a-challenge")).toBeNull();
  });

  it.each(["", "not-a-token", "a".repeat(63), "A".repeat(64)])(
    "rejects malformed authorization state %j",
    (value) => {
      fs.writeFileSync(path.join(dir, HOSTS_SYNC_AUTH_FILE), value);
      expect(readHostsSyncToken(dir)).toBeNull();
    }
  );

  it("removes authorization state", () => {
    writeHostsSyncToken(dir, generateHostsSyncToken());
    fs.writeFileSync(path.join(dir, HOSTS_SYNC_AUTH_TEMP_FILE), "stale");
    removeHostsSyncToken(dir);
    expect(readHostsSyncToken(dir)).toBeNull();
    expect(fs.existsSync(path.join(dir, HOSTS_SYNC_AUTH_TEMP_FILE))).toBe(false);
  });
});

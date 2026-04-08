import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { collectStateDirsForCleanup, removePortlessStateFiles } from "./clean-utils.js";

describe("collectStateDirsForCleanup", () => {
  const prevState = process.env.PORTLESS_STATE_DIR;

  afterEach(() => {
    if (prevState === undefined) delete process.env.PORTLESS_STATE_DIR;
    else process.env.PORTLESS_STATE_DIR = prevState;
  });

  it("includes PORTLESS_STATE_DIR when the directory exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-collect-"));
    process.env.PORTLESS_STATE_DIR = tmp;
    const dirs = collectStateDirsForCleanup();
    expect(dirs).toContain(path.resolve(tmp));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("removePortlessStateFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-rm-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes allowlisted files and host-certs directory", () => {
    fs.writeFileSync(path.join(tmpDir, "routes.json"), "[]");
    fs.writeFileSync(path.join(tmpDir, "ca.pem"), "pem");
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "443");
    fs.mkdirSync(path.join(tmpDir, "host-certs"));
    fs.writeFileSync(path.join(tmpDir, "host-certs", "x.pem"), "x");

    fs.writeFileSync(path.join(tmpDir, "user-notes.txt"), "keep me");

    removePortlessStateFiles(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "routes.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "ca.pem"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "host-certs"))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "user-notes.txt"), "utf-8")).toBe("keep me");
  });

  it("does not throw when paths are missing", () => {
    expect(() => removePortlessStateFiles(tmpDir)).not.toThrow();
  });
});

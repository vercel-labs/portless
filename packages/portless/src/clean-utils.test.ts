import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  attemptCATrustRemovalForCleanup,
  collectStateDirsForCleanup,
  removePortlessStateFiles,
} from "./clean-utils.js";

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
    fs.writeFileSync(path.join(tmpDir, "ca.trusted"), "fingerprint");
    fs.writeFileSync(path.join(tmpDir, "ca.trust-refresh-pending"), "1");
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "443");
    fs.writeFileSync(path.join(tmpDir, "proxy.custom-cert"), "1");
    fs.writeFileSync(path.join(tmpDir, "proxy.tlds"), "localhost\ntest\n");
    fs.mkdirSync(path.join(tmpDir, "host-certs"));
    fs.writeFileSync(path.join(tmpDir, "host-certs", "x.pem"), "x");

    fs.writeFileSync(path.join(tmpDir, "user-notes.txt"), "keep me");

    removePortlessStateFiles(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "routes.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "ca.pem"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "ca.trusted"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "ca.trust-refresh-pending"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "proxy.custom-cert"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "proxy.tlds"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "host-certs"))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "user-notes.txt"), "utf-8")).toBe("keep me");
  });

  it("does not throw when paths are missing", () => {
    expect(() => removePortlessStateFiles(tmpDir)).not.toThrow();
  });

  it("retains the CA identity when trust removal must be retried", () => {
    fs.writeFileSync(path.join(tmpDir, "routes.json"), "[]");
    fs.writeFileSync(path.join(tmpDir, "ca.pem"), "certificate");
    fs.writeFileSync(path.join(tmpDir, "ca-key.pem"), "private key");
    fs.writeFileSync(path.join(tmpDir, "ca.trusted"), "stale marker");
    fs.writeFileSync(path.join(tmpDir, "ca.trust-refresh-pending"), "1");
    fs.writeFileSync(path.join(tmpDir, "server.pem"), "server certificate");

    removePortlessStateFiles(tmpDir, { preserveCAIdentity: true });

    expect(fs.readFileSync(path.join(tmpDir, "ca.pem"), "utf-8")).toBe("certificate");
    expect(fs.readFileSync(path.join(tmpDir, "ca-key.pem"), "utf-8")).toBe("private key");
    expect(fs.existsSync(path.join(tmpDir, "ca.trusted"))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "ca.trust-refresh-pending"), "utf-8")).toBe("1");
    expect(fs.existsSync(path.join(tmpDir, "routes.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "server.pem"))).toBe(false);
  });
});

describe("attemptCATrustRemovalForCleanup", () => {
  it("attempts removal even when only one WSL trust store may contain the CA", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-trust-"));
    const untrust = vi.fn(() => ({
      removed: false,
      error: "Windows CA query failed after Linux trust removal",
    }));

    try {
      fs.writeFileSync(path.join(tmpDir, "ca.pem"), "certificate");

      const results = attemptCATrustRemovalForCleanup([tmpDir], untrust);

      expect(untrust).toHaveBeenCalledWith(tmpDir);
      expect(results.get(tmpDir)).toEqual({
        removed: false,
        error: "Windows CA query failed after Linux trust removal",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

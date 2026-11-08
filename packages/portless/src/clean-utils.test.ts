import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  attemptCATrustRemovalForCleanup,
  collectStateDirsForCleanup,
  collectStateDirsForCleanupWithFailures,
  isCleanableStateDir,
  removePortlessStateFiles,
} from "./clean-utils.js";
import { LEGACY_SYSTEM_STATE_DIR } from "./cli-utils.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

vi.mock("./cli-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli-utils.js")>();
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = join(tmpdir(), `portless-clean-defaults-${process.pid}`);
  return {
    ...actual,
    USER_STATE_DIR: join(root, "user"),
    LEGACY_SYSTEM_STATE_DIR: join(root, "legacy"),
  };
});

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

  it.skipIf(process.platform === "win32")(
    "resolves a symlinked state directory and cleans its physical target",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-collect-link-"));
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-collect-target-"));
      const link = path.join(tmp, "state");
      const canonical = fs.realpathSync(target);
      fs.symlinkSync(target, link, "dir");
      process.env.PORTLESS_STATE_DIR = link;
      try {
        expect(isCleanableStateDir(link)).toBe(false);
        const dirs = collectStateDirsForCleanup();
        expect(dirs).toContain(canonical);
        expect(dirs).not.toContain(link);

        fs.writeFileSync(path.join(canonical, "routes.json"), "[]");
        fs.writeFileSync(path.join(canonical, "keep.txt"), "keep");
        expect(removePortlessStateFiles(canonical)).toEqual([]);
        expect(fs.existsSync(path.join(canonical, "routes.json"))).toBe(false);
        expect(fs.readFileSync(path.join(canonical, "keep.txt"), "utf-8")).toBe("keep");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "leaves a symlinked legacy system state directory and its target alone",
    () => {
      delete process.env.PORTLESS_STATE_DIR;
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-legacy-target-"));
      const untrust = vi.fn(() => ({ removed: true }));
      try {
        fs.writeFileSync(path.join(target, "routes.json"), "[]");
        fs.writeFileSync(path.join(target, "ca.pem"), "certificate");
        fs.mkdirSync(path.join(target, "host-certs"));
        fs.writeFileSync(path.join(target, "host-certs", "x.pem"), "x");
        fs.rmSync(LEGACY_SYSTEM_STATE_DIR, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(LEGACY_SYSTEM_STATE_DIR), { recursive: true });
        fs.symlinkSync(target, LEGACY_SYSTEM_STATE_DIR, "dir");

        const { dirs } = collectStateDirsForCleanupWithFailures();
        for (const dir of dirs) removePortlessStateFiles(dir);
        attemptCATrustRemovalForCleanup(dirs, untrust);

        expect(dirs).not.toContain(fs.realpathSync(target));
        expect(untrust).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(target, "routes.json"), "utf-8")).toBe("[]");
        expect(fs.existsSync(path.join(target, "ca.pem"))).toBe(true);
        expect(fs.existsSync(path.join(target, "host-certs", "x.pem"))).toBe(true);
      } finally {
        fs.rmSync(LEGACY_SYSTEM_STATE_DIR, { recursive: true, force: true });
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  );

  it("reports an existing configured path that is not a directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-collect-file-"));
    const configured = path.join(tmp, "state");
    fs.writeFileSync(configured, "not a directory");
    process.env.PORTLESS_STATE_DIR = configured;
    try {
      const collected = collectStateDirsForCleanupWithFailures();
      expect(collected.dirs).not.toContain(configured);
      expect(collected.failures).toContain(configured);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
    fs.writeFileSync(path.join(tmpDir, "proxy.hosts-sync-token"), "token");
    fs.writeFileSync(path.join(tmpDir, "proxy.hosts-sync-token.tmp"), "token");
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
    expect(fs.existsSync(path.join(tmpDir, "proxy.hosts-sync-token"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "proxy.hosts-sync-token.tmp"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "host-certs"))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, "user-notes.txt"), "utf-8")).toBe("keep me");
  });

  it("does not throw when paths are missing", () => {
    expect(() => removePortlessStateFiles(tmpDir)).not.toThrow();
  });

  it("preserves proxy runtime files while the proxy still owns them", () => {
    fs.writeFileSync(path.join(tmpDir, "proxy.pid"), "123");
    fs.writeFileSync(path.join(tmpDir, "proxy.port"), "443");
    fs.writeFileSync(path.join(tmpDir, "proxy.log"), "log");
    fs.writeFileSync(path.join(tmpDir, "proxy.tls"), "1");
    fs.writeFileSync(path.join(tmpDir, "proxy.custom-cert"), "1");
    fs.writeFileSync(path.join(tmpDir, "proxy.tld"), "localhost");
    fs.writeFileSync(path.join(tmpDir, "proxy.tlds"), "localhost\ntest\n");
    fs.writeFileSync(path.join(tmpDir, "proxy.lan"), "192.0.2.10");
    fs.writeFileSync(path.join(tmpDir, "routes.json"), "[]");

    removePortlessStateFiles(tmpDir, { preserveProxyRuntime: true });

    expect(fs.existsSync(path.join(tmpDir, "proxy.pid"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "proxy.port"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "proxy.log"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "proxy.tls"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "proxy.custom-cert"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "proxy.tld"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "proxy.tlds"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "proxy.lan"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "routes.json"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked state directory", () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-target-"));
    const link = path.join(tmpDir, "state-link");
    fs.writeFileSync(path.join(target, "routes.json"), "[]");
    fs.symlinkSync(target, link, "dir");
    try {
      expect(removePortlessStateFiles(link)).toEqual([link]);
      expect(fs.existsSync(path.join(target, "routes.json"))).toBe(true);
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "removes a host-certs symlink without touching its target",
    () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-host-certs-"));
      const link = path.join(tmpDir, "host-certs");
      fs.writeFileSync(path.join(target, "outside.pem"), "keep");
      fs.symlinkSync(target, link, "dir");
      try {
        expect(removePortlessStateFiles(tmpDir)).toEqual([]);
        expect(fs.existsSync(link)).toBe(false);
        expect(fs.readFileSync(path.join(target, "outside.pem"), "utf-8")).toBe("keep");
      } finally {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  );

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

  it("reports a statSync EACCES for the CA path without calling untrust", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-trust-eacces-"));
    const caPath = path.join(tmpDir, "ca.pem");
    const untrust = vi.fn(() => ({ removed: true }));
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const statSyncMock = vi.mocked(fs.statSync);
    statSyncMock.mockImplementation(((file: fs.PathLike) => {
      if (String(file) === caPath) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return actualFs.statSync(file);
    }) as typeof fs.statSync);
    try {
      fs.writeFileSync(caPath, "certificate");

      const results = attemptCATrustRemovalForCleanup([tmpDir], untrust);

      expect(statSyncMock).toHaveBeenCalledWith(caPath);
      expect(untrust).not.toHaveBeenCalled();
      expect(results.get(tmpDir)).toMatchObject({ removed: false });
      expect(results.get(tmpDir)?.error).toContain("Could not inspect CA certificate");
    } finally {
      statSyncMock.mockImplementation(actualFs.statSync);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a real unreadable CA path on POSIX",
    () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-trust-denied-"));
      const untrust = vi.fn(() => ({ removed: true }));
      try {
        fs.writeFileSync(path.join(tmpDir, "ca.pem"), "certificate");
        fs.chmodSync(tmpDir, 0o000);

        const results = attemptCATrustRemovalForCleanup([tmpDir], untrust);

        expect(untrust).not.toHaveBeenCalled();
        expect(results.get(tmpDir)).toMatchObject({ removed: false });
        expect(results.get(tmpDir)?.error).toContain("Could not inspect CA certificate");
      } finally {
        fs.chmodSync(tmpDir, 0o700);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );

  it("skips a directory when ca.pem is absent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-clean-trust-missing-"));
    const untrust = vi.fn(() => ({ removed: true }));
    try {
      expect(attemptCATrustRemovalForCleanup([tmpDir], untrust).size).toBe(0);
      expect(untrust).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

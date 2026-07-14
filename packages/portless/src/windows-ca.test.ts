import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCerts } from "./certs.js";
import {
  isWSL,
  isWindowsCATrusted,
  trustWindowsCA,
  untrustWindowsCA,
  wslWindowsCAStoreOptions,
  type WindowsCACommandRunner,
} from "./windows-ca.js";

describe("isWSL", () => {
  it("detects the WSL environment variables", () => {
    expect(isWSL({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, release: "linux" })).toBe(
      true
    );
    expect(
      isWSL({ platform: "linux", env: { WSL_INTEROP: "/run/WSL/1_interop" }, release: "linux" })
    ).toBe(true);
  });

  it("detects a Microsoft WSL kernel release", () => {
    expect(
      isWSL({ platform: "linux", env: {}, release: "5.15.90.1-microsoft-standard-WSL2" })
    ).toBe(true);
  });

  it("does not classify native Linux or Windows as WSL", () => {
    expect(isWSL({ platform: "linux", env: {}, release: "6.8.0-generic" })).toBe(false);
    expect(
      isWSL({ platform: "win32", env: { WSL_DISTRO_NAME: "Ubuntu" }, release: "microsoft" })
    ).toBe(false);
  });
});

describe("Windows CA store", () => {
  let tmpDir: string;
  let caPath: string;
  let fingerprint: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-windows-ca-test-"));
    caPath = ensureCerts(tmpDir).caPath;
    fingerprint = new crypto.X509Certificate(fs.readFileSync(caPath)).fingerprint.replace(/:/g, "");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("checks the Windows user Root store by certificate fingerprint", () => {
    const run = vi.fn<WindowsCACommandRunner>(() => `Cert Hash(sha1): ${fingerprint}`);

    expect(isWindowsCATrusted(caPath, { command: "certutil.exe", run })).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "certutil.exe",
      ["-store", "-user", "Root"],
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("adds a WSL certificate through the Windows certutil executable", () => {
    const run = vi.fn<WindowsCACommandRunner>((command, args) => {
      if (command === "wslpath" && args[0] === "-u") {
        return "/mnt/c/Windows/System32/certutil.exe\n";
      }
      if (command === "wslpath" && args[0] === "-w") {
        return "\\\\wsl.localhost\\Ubuntu\\home\\alice\\.portless\\ca.pem\n";
      }
      return "";
    });
    const options = wslWindowsCAStoreOptions(run);

    trustWindowsCA(caPath, options);

    expect(run).toHaveBeenCalledWith(
      "/mnt/c/Windows/System32/certutil.exe",
      ["-addstore", "-user", "Root", "\\\\wsl.localhost\\Ubuntu\\home\\alice\\.portless\\ca.pem"],
      expect.objectContaining({ timeout: 30_000 })
    );
  });

  it("removes the exact certificate by SHA-1 fingerprint", () => {
    let trusted = true;
    const run = vi.fn<WindowsCACommandRunner>((_command, args) => {
      if (args[0] === "-store") return trusted ? fingerprint : "";
      if (args[0] === "-delstore") trusted = false;
      return "";
    });

    expect(untrustWindowsCA(caPath, { command: "certutil.exe", run })).toEqual({
      removed: true,
    });
    expect(run).toHaveBeenCalledWith(
      "certutil.exe",
      ["-delstore", "-user", "Root", fingerprint.toLowerCase()],
      expect.any(Object)
    );
  });

  it("reports a Root store query failure instead of successful removal", () => {
    const run = vi.fn<WindowsCACommandRunner>(() => {
      throw new Error("certutil query timed out");
    });

    expect(untrustWindowsCA(caPath, { command: "certutil.exe", run })).toEqual({
      removed: false,
      error: "certutil query timed out",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a verification query failure after deletion", () => {
    let storeQueries = 0;
    const run = vi.fn<WindowsCACommandRunner>((_command, args) => {
      if (args[0] === "-store") {
        storeQueries += 1;
        if (storeQueries === 1) return fingerprint;
        throw new Error("certutil verification failed");
      }
      return "";
    });

    expect(untrustWindowsCA(caPath, { command: "certutil.exe", run })).toEqual({
      removed: false,
      error: "certutil verification failed",
    });
    expect(run).toHaveBeenCalledWith(
      "certutil.exe",
      ["-delstore", "-user", "Root", fingerprint.toLowerCase()],
      expect.any(Object)
    );
  });
});

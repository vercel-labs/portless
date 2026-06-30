import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { isWSL, wslToWindowsPath, runPowerShellFromWSL, getPowerShellPath } from "./wsl-utils.js";

const mockExecFileSync = vi.mocked(execFileSync);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("isWSL", () => {
  it("returns true when wslinfo succeeds", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    expect(isWSL()).toBe(true);
  });

  it("returns false when wslinfo is not available", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(isWSL()).toBe(false);
  });
});

describe("wslToWindowsPath", () => {
  it("converts a WSL path to a Windows path via wslpath", () => {
    mockExecFileSync.mockReturnValue("\\\\wsl.localhost\\home\\user\\.portless\\ca.pem\n");
    const result = wslToWindowsPath("/home/user/.portless/ca.pem");
    expect(result).toMatch(/^\\\\wsl[.$]/);
    expect(result).toContain("\\home\\user\\.portless\\ca.pem");
  });

  it("throws when wslpath fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("wslpath not found");
    });
    expect(() => wslToWindowsPath("/home/user/file")).toThrow();
  });
});

describe("runPowerShellFromWSL", () => {
  it("executes a PowerShell command and returns stdout", () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("")) // getPowerShellPath calls execFileSync("test", ...)
      .mockReturnValueOnce("hello\n"); // actual powershell.exe call
    const result = runPowerShellFromWSL(["-NoProfile", "-Command", "Write-Output hello"]);
    expect(result.trim()).toBe("hello");
  });

  it("does not throw when interop is enabled", () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("")) // getPowerShellPath succeeds
      .mockReturnValueOnce(""); // powershell returns nothing
    expect(() => runPowerShellFromWSL(["-NoProfile", "-Command", "exit 0"])).not.toThrow();
  });

  it("throws when getPowerShellPath fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => runPowerShellFromWSL(["-NoProfile", "-Command", "Write-Output hello"])).toThrow(
      "PowerShell executable not found"
    );
  });

  it("throws when PowerShell command fails", () => {
    mockExecFileSync
      .mockReturnValueOnce(Buffer.from("")) // getPowerShellPath succeeds
      .mockImplementationOnce(() => {
        throw new Error("command failed");
      });
    expect(() => runPowerShellFromWSL(["-NoProfile", "-Command", "exit 1"])).toThrow(
      "command failed"
    );
  });
});

describe("getPowerShellPath", () => {
  it("returns the PowerShell path when interop is enabled", () => {
    mockExecFileSync.mockReturnValue(Buffer.from(""));
    expect(getPowerShellPath()).toBe(
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    );
  });

  it("throws when interop is disabled", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(() => getPowerShellPath()).toThrow("PowerShell executable not found");
  });
});

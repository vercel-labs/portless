import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// WSL detection
// ---------------------------------------------------------------------------

/**
 * Detect whether we are running inside WSL (Windows Subsystem for Linux).
 * Checks for the presence of the `wslinfo` binary and verifies it can be executed.
 */
export function isWSL(): boolean {
  try {
    execFileSync("wslinfo", ["--version"], {
      stdio: "pipe",
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PowerShell interop
// ---------------------------------------------------------------------------

/**
 * Resolve the path to powershell.exe.
 * Throws if the binary is not found (WSL interop may be disabled).
 */
export function getPowerShellPath(): string {
  const psPath = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  try {
    execFileSync("test", ["-f", psPath], { timeout: 5_000 });
    return psPath;
  } catch {
    throw new Error("PowerShell executable not found. Ensure interop is enabled in WSL config.");
  }
}

/**
 * Run a PowerShell command from WSL via interop and return stdout.
 */
export function runPowerShellFromWSL(args: string[], options?: { timeout?: number }): string {
  const psPath = getPowerShellPath();
  return execFileSync(psPath, args, {
    encoding: "utf-8",
    timeout: options?.timeout ?? 30_000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------------
// Path conversion
// ---------------------------------------------------------------------------

/**
 * Convert a WSL path to a Windows path using the `wslpath` utility.
 */
export function wslToWindowsPath(wslPath: string): string {
  return execFileSync("wslpath", ["-w", wslPath], {
    encoding: "utf-8",
    timeout: 5_000,
  }).trim();
}

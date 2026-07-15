import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";

const WINDOWS_COMMAND_TIMEOUT_MS = 30_000;

export type WindowsCACommandRunner = (
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding
) => string;

export type WindowsCAStoreOptions = {
  command?: string;
  certificatePath?: (certificatePath: string) => string;
  run?: WindowsCACommandRunner;
};

type WSLDetectionOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  release?: string;
};

const commandOptions: ExecFileSyncOptionsWithStringEncoding = {
  encoding: "utf-8",
  timeout: WINDOWS_COMMAND_TIMEOUT_MS,
  stdio: ["pipe", "pipe", "pipe"],
};

const defaultRunner: WindowsCACommandRunner = (command, args, options) =>
  execFileSync(command, args, options);

/** Return whether the current Linux process is running inside WSL. */
export function isWSL(options: WSLDetectionOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return false;

  const env = options.env ?? process.env;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;

  const release = options.release ?? os.release();
  return release.toLowerCase().includes("microsoft");
}

/**
 * Build Windows CA store options for WSL. The absolute executable path avoids
 * relying on Windows PATH entries that sudo may remove, while wslpath exposes
 * the Linux certificate path to certutil.
 */
export function wslWindowsCAStoreOptions(
  run: WindowsCACommandRunner = defaultRunner
): WindowsCAStoreOptions {
  const command = run(
    "wslpath",
    ["-u", String.raw`C:\Windows\System32\certutil.exe`],
    commandOptions
  ).trim();

  return {
    command,
    certificatePath: (certificatePath) =>
      run("wslpath", ["-w", certificatePath], commandOptions).trim(),
    run,
  };
}

function certificateFingerprint(certificatePath: string): string {
  const certificate = new crypto.X509Certificate(fs.readFileSync(certificatePath));
  return certificate.fingerprint.replace(/:/g, "").toLowerCase();
}

function storeOptions(options: WindowsCAStoreOptions): {
  command: string;
  certificatePath: (certificatePath: string) => string;
  run: WindowsCACommandRunner;
} {
  return {
    command: options.command ?? "certutil",
    certificatePath: options.certificatePath ?? ((certificatePath) => certificatePath),
    run: options.run ?? defaultRunner,
  };
}

type ResolvedWindowsCAStoreOptions = ReturnType<typeof storeOptions>;

function storeContainsFingerprint(
  fingerprint: string,
  resolved: ResolvedWindowsCAStoreOptions
): boolean {
  const listing = resolved.run(resolved.command, ["-store", "-user", "Root"], commandOptions);
  return listing.replace(/\s/g, "").toLowerCase().includes(fingerprint);
}

/** Return whether the certificate is present in the Windows user Root store. */
export function isWindowsCATrusted(
  caCertPath: string,
  options: WindowsCAStoreOptions = {}
): boolean {
  try {
    const resolved = storeOptions(options);
    const fingerprint = certificateFingerprint(caCertPath);
    return storeContainsFingerprint(fingerprint, resolved);
  } catch {
    return false;
  }
}

/** Add the certificate to the Windows user Root store. */
export function trustWindowsCA(caCertPath: string, options: WindowsCAStoreOptions = {}): void {
  const resolved = storeOptions(options);
  resolved.run(
    resolved.command,
    ["-addstore", "-user", "Root", resolved.certificatePath(caCertPath)],
    commandOptions
  );
}

/** Remove the certificate from the Windows user Root store. */
export function untrustWindowsCA(
  caCertPath: string,
  options: WindowsCAStoreOptions = {}
): { removed: boolean; error?: string } {
  try {
    const resolved = storeOptions(options);
    const fingerprint = certificateFingerprint(caCertPath);
    if (!storeContainsFingerprint(fingerprint, resolved)) return { removed: true };

    resolved.run(resolved.command, ["-delstore", "-user", "Root", fingerprint], commandOptions);

    return storeContainsFingerprint(fingerprint, resolved)
      ? { removed: false, error: "certutil could not remove the portless CA from Root" }
      : { removed: true };
  } catch (error: unknown) {
    return { removed: false, error: error instanceof Error ? error.message : String(error) };
  }
}

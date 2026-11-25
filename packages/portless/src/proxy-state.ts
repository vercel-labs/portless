import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { HOSTS_SYNC_AUTH_FILE, HOSTS_SYNC_AUTH_TEMP_FILE } from "./hosts-sync-auth.js";
import { parseIdleExitSeconds } from "./idle-exit.js";
import { fixOwnership, isErrnoException } from "./utils.js";

/** Default TLD when PORTLESS_TLD is not set. */
export const DEFAULT_TLD = "localhost";

/** State file that holds the running proxy's process id. */
export const PID_FILE = "proxy.pid";

/** State file that holds the running proxy's port. */
export const PORT_FILE = "proxy.port";

export const START_FILE = "proxy.start";
const START_TEMP_FILE = `${START_FILE}.tmp`;

const LOG_FILE = "proxy.log";
const TLS_FILE = "proxy.tls";
const CUSTOM_CERT_FILE = "proxy.custom-cert";
const UNPRIVILEGED_FILE = "proxy.unprivileged";
const LAN_FILE = "proxy.lan";
const TLD_FILE = "proxy.tld";
const TLDS_FILE = "proxy.tlds";
const IDLE_EXIT_FILE = "proxy.idle-exit";
const MAX_STATE_FILE_BYTES = 64 * 1024;

/** Every file name the proxy owns inside a state directory. */
export const PROXY_FILES: readonly string[] = [
  PID_FILE,
  PORT_FILE,
  START_FILE,
  START_TEMP_FILE,
  LOG_FILE,
  TLS_FILE,
  CUSTOM_CERT_FILE,
  UNPRIVILEGED_FILE,
  TLD_FILE,
  TLDS_FILE,
  LAN_FILE,
  IDLE_EXIT_FILE,
  HOSTS_SYNC_AUTH_FILE,
  HOSTS_SYNC_AUTH_TEMP_FILE,
];

/** Proxy settings persisted in a state directory. */
export type ProxySettings = {
  port: number | null;
  tls: boolean;
  customCert: boolean;
  unprivileged: boolean;
  lanIp: string | null;
  tlds: string[];
};

function hasEntry(dir: string, name: string): boolean {
  try {
    return fs.lstatSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
}

export function readProxyStateFile(file: string): string | null {
  try {
    const entry = fs.lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Unsafe proxy state file: ${file}`);
    }
    const flags =
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const fd = fs.openSync(file, flags);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_STATE_FILE_BYTES) {
        throw new Error(`Unsafe proxy state file: ${file}`);
      }
      return fs.readFileSync(fd, "utf-8").trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function readEntry(dir: string, name: string): string | null {
  try {
    return readProxyStateFile(path.join(dir, name)) || null;
  } catch {
    return null;
  }
}

function writeEntry(dir: string, name: string, contents: string): void {
  const file = path.join(dir, name);
  const tempPath = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW ?? 0);
    const fd = fs.openSync(tempPath, flags, 0o644);
    created = true;
    try {
      fs.writeFileSync(fd, contents);
    } finally {
      fs.closeSync(fd);
    }
    fixOwnership(tempPath);
    fs.renameSync(tempPath, file);
  } catch (error) {
    if (created) fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function removeEntry(dir: string, name: string): void {
  try {
    fs.unlinkSync(path.join(dir, name));
  } catch {
    return;
  }
}

function setMarker(dir: string, name: string, enabled: boolean): void {
  if (enabled) {
    writeEntry(dir, name, "1");
  } else {
    removeEntry(dir, name);
  }
}

/** Reads and writes the proxy's state directory. */
export class ProxyState {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Read the persisted settings, falling back to defaults for absent files. */
  read(): ProxySettings {
    return {
      port: this.readPort(),
      tls: this.readTls(),
      customCert: this.readCustomCert(),
      unprivileged: this.readUnprivileged(),
      lanIp: this.readLanIp(),
      tlds: this.readTlds(),
    };
  }

  publishListener(pid: number, port: number, startTime: string | null): void {
    const startPath = path.join(this.dir, START_FILE);
    const tempPath = path.join(this.dir, START_TEMP_FILE);
    const discardTemp = () => {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        return;
      }
    };
    try {
      discardTemp();
      if (startTime === null) {
        fs.rmSync(startPath, { force: true });
      } else {
        fs.writeFileSync(tempPath, startTime, { encoding: "utf-8", mode: 0o644, flag: "wx" });
        fixOwnership(tempPath);
        fs.renameSync(tempPath, startPath);
      }
    } catch {
      discardTemp();
    }
    writeEntry(this.dir, PID_FILE, String(pid));
    writeEntry(this.dir, PORT_FILE, String(port));
    fixOwnership(this.dir);
  }

  /** Persist what a freshly started proxy is serving. */
  publish(settings: {
    tls: boolean;
    customCert: boolean;
    unprivileged: boolean;
    lanIp: string | null;
    tlds: readonly string[];
  }): void {
    setMarker(this.dir, TLS_FILE, settings.tls);
    setMarker(this.dir, CUSTOM_CERT_FILE, settings.tls && settings.customCert);
    this.writeTlds(settings.tlds);
    this.setLanIp(settings.lanIp);
    setMarker(this.dir, UNPRIVILEGED_FILE, settings.unprivileged);
  }

  /** Record the last known LAN IP, or clear the LAN marker with null. */
  setLanIp(ip: string | null): void {
    if (ip) {
      writeEntry(this.dir, LAN_FILE, ip);
    } else {
      removeEntry(this.dir, LAN_FILE);
    }
  }

  /** Clear the runtime markers a stopped proxy leaves behind, keeping the TLS marker an unprivileged proxy needs to stay HTTPS. */
  reset(): void {
    for (const name of [START_FILE, START_TEMP_FILE]) {
      try {
        fs.rmSync(path.join(this.dir, name), { force: true });
      } catch {
        continue;
      }
    }
    if (!hasEntry(this.dir, UNPRIVILEGED_FILE)) {
      setMarker(this.dir, TLS_FILE, false);
    }
    setMarker(this.dir, CUSTOM_CERT_FILE, false);
    this.writeTlds([DEFAULT_TLD]);
    this.setLanIp(null);
  }

  readPort(): number | null {
    const raw = readEntry(this.dir, PORT_FILE);
    if (raw === null) return null;
    const port = parseInt(raw, 10);
    return isNaN(port) ? null : port;
  }

  readTls(): boolean {
    return hasEntry(this.dir, TLS_FILE);
  }

  readCustomCert(): boolean {
    return hasEntry(this.dir, CUSTOM_CERT_FILE);
  }

  readUnprivileged(): boolean {
    return hasEntry(this.dir, UNPRIVILEGED_FILE);
  }

  readLanIp(): string | null {
    return readEntry(this.dir, LAN_FILE);
  }

  /** Idle-exit linger in seconds; 0 when idle exit is off. Survives a stop, so an auto-start keeps the mode. */
  readIdleExit(): number {
    const raw = readEntry(this.dir, IDLE_EXIT_FILE);
    return raw === null ? 0 : (parseIdleExitSeconds(raw) ?? 0);
  }

  /** Remember the idle-exit linger, or forget it with 0. */
  setIdleExit(seconds: number): void {
    if (seconds > 0) {
      writeEntry(this.dir, IDLE_EXIT_FILE, String(seconds));
    } else {
      removeEntry(this.dir, IDLE_EXIT_FILE);
    }
  }

  private readLegacyTld(): string {
    return readEntry(this.dir, TLD_FILE) ?? DEFAULT_TLD;
  }

  readTlds(): string[] {
    const raw = readEntry(this.dir, TLDS_FILE);
    if (raw === null) return [this.readLegacyTld()];
    try {
      const parsed: unknown = raw.startsWith("[")
        ? JSON.parse(raw)
        : raw
            .split(/\r?\n/)
            .flatMap((line) => line.split(","))
            .map((line) => line.trim())
            .filter(Boolean);
      if (!Array.isArray(parsed)) return [this.readLegacyTld()];
      const tlds: string[] = parsed.flatMap((value: unknown) => {
        if (typeof value !== "string") return [];
        try {
          return parseTldList(value);
        } catch {
          console.warn(`Warning: ignoring invalid TLD entry in ${TLDS_FILE}`);
          return [];
        }
      });
      return tlds.length > 0 ? [...new Set(tlds)] : [DEFAULT_TLD];
    } catch {
      return [this.readLegacyTld()];
    }
  }

  private writeTlds(tlds: readonly string[]): void {
    const unique = [...new Set(tlds)];
    if (unique.length === 1 && unique[0] === DEFAULT_TLD) {
      removeEntry(this.dir, TLDS_FILE);
      removeEntry(this.dir, TLD_FILE);
      return;
    }
    writeEntry(this.dir, TLDS_FILE, unique.join("\n") + "\n");
    writeEntry(this.dir, TLD_FILE, unique[0] ?? DEFAULT_TLD);
  }
}

/**
 * Validate a TLD string. Returns an error message if invalid, or null if OK.
 * Does not check for risky TLDs (those produce warnings, not errors).
 */
export function validateTld(tld: string): string | null {
  if (!tld) return "TLD cannot be empty";
  if (tld.length > 253) {
    return `Invalid TLD "${tld}": exceeds 253-character DNS limit`;
  }

  const labelRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  const labels = tld.split(".");
  for (const label of labels) {
    if (!label) {
      return `Invalid TLD "${tld}": labels cannot be empty`;
    }
    if (label.length > 63) {
      return `Invalid TLD "${tld}": label "${label}" exceeds 63-character DNS limit`;
    }
    if (!labelRe.test(label)) {
      return `Invalid TLD "${tld}": labels must contain only lowercase letters, digits, and interior hyphens`;
    }
  }
  return null;
}

/** Parse a comma separated TLD list and remove duplicates in order. */
export function parseTldList(value: string, source = "TLD"): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const tlds: string[] = [];
  const seen = new Set<string>();
  for (const rawPart of trimmed.split(",")) {
    const tld = rawPart.trim().toLowerCase();
    const err = validateTld(tld);
    if (err) throw new Error(source === "TLD" ? err : `${source}: ${err}`);
    if (!seen.has(tld)) {
      seen.add(tld);
      tlds.push(tld);
    }
  }
  return tlds;
}

import * as fs from "node:fs";
import * as path from "node:path";
import { HOSTS_SYNC_AUTH_FILE, HOSTS_SYNC_AUTH_TEMP_FILE } from "./hosts-sync-auth.js";

/** Default TLD when PORTLESS_TLD is not set. */
export const DEFAULT_TLD = "localhost";

/** State file that holds the running proxy's process id. */
export const PID_FILE = "proxy.pid";

/** State file that holds the running proxy's port. */
export const PORT_FILE = "proxy.port";

const LOG_FILE = "proxy.log";
const TLS_FILE = "proxy.tls";
const CUSTOM_CERT_FILE = "proxy.custom-cert";
const UNPRIVILEGED_FILE = "proxy.unprivileged";
const LAN_FILE = "proxy.lan";
const TLD_FILE = "proxy.tld";
const TLDS_FILE = "proxy.tlds";

/** Every file name the proxy owns inside a state directory. */
export const PROXY_FILES: readonly string[] = [
  PID_FILE,
  PORT_FILE,
  LOG_FILE,
  TLS_FILE,
  CUSTOM_CERT_FILE,
  UNPRIVILEGED_FILE,
  TLD_FILE,
  TLDS_FILE,
  LAN_FILE,
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
    return fs.existsSync(path.join(dir, name));
  } catch {
    return false;
  }
}

function readEntry(dir: string, name: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, name), "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

function writeEntry(dir: string, name: string, contents: string): void {
  fs.writeFileSync(path.join(dir, name), contents, { mode: 0o644 });
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
      tls: hasEntry(this.dir, TLS_FILE),
      customCert: hasEntry(this.dir, CUSTOM_CERT_FILE),
      unprivileged: hasEntry(this.dir, UNPRIVILEGED_FILE),
      lanIp: readEntry(this.dir, LAN_FILE),
      tlds: this.readTlds(),
    };
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
    if (!hasEntry(this.dir, UNPRIVILEGED_FILE)) {
      setMarker(this.dir, TLS_FILE, false);
    }
    setMarker(this.dir, CUSTOM_CERT_FILE, false);
    this.writeTlds([DEFAULT_TLD]);
    this.setLanIp(null);
  }

  private readPort(): number | null {
    const raw = readEntry(this.dir, PORT_FILE);
    if (raw === null) return null;
    const port = parseInt(raw, 10);
    return isNaN(port) ? null : port;
  }

  private readLegacyTld(): string {
    return readEntry(this.dir, TLD_FILE) ?? DEFAULT_TLD;
  }

  private readTlds(): string[] {
    try {
      const raw = fs.readFileSync(path.join(this.dir, TLDS_FILE), "utf-8").trim();
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
        } catch (err) {
          console.warn(
            `Warning: ignoring invalid TLD entry in ${TLDS_FILE}: ${err instanceof Error ? err.message : String(err)}`
          );
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

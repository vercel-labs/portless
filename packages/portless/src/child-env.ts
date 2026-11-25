import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_PORT_VAR = "PORT";
export const DEFAULT_HOST_VAR = "HOST";
export const PEER_URL_ENV_PREFIX = "PORTLESS_URL_";
export const CA_BUNDLE_PREFIX = "ca-bundle-";

export interface EnvVarNaming {
  portVar: string;
  hostVar: string;
}

export interface EnvVarOverrides {
  portVar?: string;
  hostVar?: string;
}

export interface PeerApp {
  baseName: string;
  url: string;
}

export type ChildEnvMap = Record<string, string>;

export interface ChildEnvEntry {
  port?: number;
  host?: string;
  url?: string;
  tlds?: readonly string[];
  childPrefix?: string;
  lan?: boolean;
  shareEnv?: Readonly<Record<string, string>>;
  namedUrls?: Readonly<Record<string, string>>;
}

export interface ChildEnvOptions {
  peers?: readonly PeerApp[];
  naming?: EnvVarNaming;
  shareUrl?: string;
  caPath?: string;
  parentEnv?: NodeJS.ProcessEnv;
  onWarning?: (message: string) => void;
}

export interface ChildEnvResult {
  env: ChildEnvMap;
  display: string;
}

export class ChildEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChildEnvError";
  }
}

export function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function resolveEnvVarNaming(
  overrides?: EnvVarOverrides,
  config?: EnvVarOverrides,
  parentEnv: NodeJS.ProcessEnv = process.env
): EnvVarNaming {
  function resolve(
    override: string | undefined,
    envValue: string | undefined,
    configValue: string | undefined,
    envName: string,
    fallback: string
  ): string {
    const source = override !== undefined ? "override" : envValue ? envName : "config";
    const value = override ?? (envValue || undefined) ?? configValue ?? fallback;
    if (!isValidEnvVarName(value)) {
      throw new ChildEnvError(
        `Invalid environment variable name "${value}" from ${source}. Names must start with a letter or underscore and contain only letters, digits, and underscores.`
      );
    }
    return value;
  }

  const portVar = resolve(
    overrides?.portVar,
    parentEnv.PORTLESS_PORT_VAR,
    config?.portVar,
    "PORTLESS_PORT_VAR",
    DEFAULT_PORT_VAR
  );
  const hostVar = resolve(
    overrides?.hostVar,
    parentEnv.PORTLESS_HOST_VAR,
    config?.hostVar,
    "PORTLESS_HOST_VAR",
    DEFAULT_HOST_VAR
  );
  if (portVar === hostVar) {
    throw new ChildEnvError(
      `Port and host environment variables cannot use the same name ("${portVar}").`
    );
  }
  return { portVar, hostVar };
}

export function formatViteAllowedHosts(tlds: readonly string[], shareUrl?: string): string {
  if (shareUrl) {
    try {
      const hostname = new URL(shareUrl).hostname;
      if (hostname) return hostname;
    } catch {
      return tlds.map((t) => `.${t}`).join(",");
    }
  }
  return tlds.map((t) => `.${t}`).join(",");
}

export function peerUrlEnvName(baseName: string): string {
  return PEER_URL_ENV_PREFIX + baseName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export function buildPeerUrlEnv(
  peers: readonly PeerApp[],
  onWarning?: (message: string) => void
): ChildEnvMap {
  const env: ChildEnvMap = {};
  const owners = new Map<string, string>();
  for (const peer of peers) {
    if (!/[a-z0-9]/i.test(peer.baseName)) continue;
    const name = peerUrlEnvName(peer.baseName);
    const owner = owners.get(name);
    if (owner !== undefined) {
      if (owner !== peer.baseName) {
        onWarning?.(
          `Environment variable ${name} is already used by "${owner}"; skipping "${peer.baseName}".`
        );
      }
      continue;
    }
    owners.set(name, peer.baseName);
    env[name] = peer.url;
  }
  return env;
}

function matchesCaBundle(target: string, combined: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    return !stat.isSymbolicLink() && stat.isFile() && fs.readFileSync(target, "utf-8") === combined;
  } catch {
    return false;
  }
}

function writeCaBundle(dir: string, filename: string, combined: string, mode: number): string {
  const target = path.join(dir, filename);
  if (matchesCaBundle(target, combined)) return target;
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let written = false;
  try {
    fs.writeFileSync(tmp, combined, { mode, flag: "wx" });
    written = true;
    fs.renameSync(tmp, target);
    return target;
  } catch (error) {
    if (written || (error as NodeJS.ErrnoException).code !== "EEXIST") {
      try {
        fs.unlinkSync(tmp);
      } catch {
        throw error;
      }
    }
    throw error;
  }
}

export function resolveExtraCaCerts(
  caPath: string | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env
): string | undefined {
  if (!caPath || !fs.existsSync(caPath)) return undefined;
  let portlessPem: string;
  try {
    portlessPem = fs.readFileSync(caPath, "utf-8");
  } catch {
    return undefined;
  }
  if (!portlessPem.trim()) return undefined;
  const existing = parentEnv.NODE_EXTRA_CA_CERTS?.trim();
  if (!existing || path.resolve(existing) === path.resolve(caPath)) return caPath;
  let existingPem: string;
  try {
    existingPem = fs.readFileSync(existing, "utf-8");
  } catch {
    return caPath;
  }
  if (existingPem.includes(portlessPem.trim())) return existing;
  let combined = `${existingPem.trimEnd()}\n${portlessPem.trimStart()}`;
  if (!combined.endsWith("\n")) combined += "\n";
  const hash = crypto.createHash("sha256").update(combined).digest("hex").slice(0, 16);
  const filename = `${CA_BUNDLE_PREFIX}${hash}.pem`;
  try {
    return writeCaBundle(path.dirname(caPath), filename, combined, 0o644);
  } catch {
    try {
      const uid = process.getuid?.();
      const dir = path.join(os.tmpdir(), `portless-ca-${uid ?? "user"}`);
      fs.mkdirSync(dir, { mode: 0o700, recursive: true });
      const stat = fs.lstatSync(dir);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        (uid !== undefined && stat.uid !== uid) ||
        (stat.mode & 0o077) !== 0
      ) {
        return caPath;
      }
      return writeCaBundle(dir, filename, combined, 0o600);
    } catch {
      return caPath;
    }
  }
}

function setEnv(env: ChildEnvMap, key: string, value: string): void {
  Object.defineProperty(env, key, { value, writable: true, enumerable: true, configurable: true });
}

export function childEnv(entry: ChildEnvEntry, options: ChildEnvOptions = {}): ChildEnvResult {
  const naming = options.naming ?? { portVar: DEFAULT_PORT_VAR, hostVar: DEFAULT_HOST_VAR };
  const env: ChildEnvMap = {};
  if (options.peers?.length) Object.assign(env, buildPeerUrlEnv(options.peers, options.onWarning));
  if (entry.namedUrls) {
    for (const [key, value] of Object.entries(entry.namedUrls)) setEnv(env, key, value);
  }
  if (entry.childPrefix !== undefined) env.PORTLESS_PREFIX = entry.childPrefix;
  if (entry.port !== undefined) setEnv(env, naming.portVar, String(entry.port));
  if (entry.host !== undefined) setEnv(env, naming.hostVar, entry.host);
  if (entry.url !== undefined) env.PORTLESS_URL = entry.url;
  if (entry.tlds && entry.tlds.length > 0) {
    const shareUrl =
      options.shareUrl ??
      entry.shareEnv?.PORTLESS_TAILSCALE_URL ??
      (entry.shareEnv ? Object.values(entry.shareEnv)[0] : undefined);
    env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = formatViteAllowedHosts(entry.tlds, shareUrl);
  }
  if (entry.lan) env.PORTLESS_LAN = "1";
  if (entry.shareEnv) Object.assign(env, entry.shareEnv);
  if (options.caPath) {
    const resolvedCa = resolveExtraCaCerts(options.caPath, options.parentEnv);
    if (resolvedCa) env.NODE_EXTRA_CA_CERTS = resolvedCa;
  }
  const parts: string[] = [];
  if (entry.port !== undefined) parts.push(`${naming.portVar}=${entry.port}`);
  if (entry.host !== undefined) parts.push(`${naming.hostVar}=${entry.host}`);
  if (entry.url !== undefined) parts.push(`PORTLESS_URL=${entry.url}`);
  if (env.NODE_EXTRA_CA_CERTS) parts.push(`NODE_EXTRA_CA_CERTS="${env.NODE_EXTRA_CA_CERTS}"`);
  return { env, display: parts.join(" ") };
}

export function formatShellExports(env: Readonly<Record<string, string>>): string {
  const lines = Object.entries(env).map(
    ([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'`
  );
  return lines.length ? `${lines.join("\n")}\n` : "";
}

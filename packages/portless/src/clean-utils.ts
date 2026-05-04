import * as fs from "node:fs";
import * as path from "node:path";
import { LEGACY_SYSTEM_STATE_DIR, USER_STATE_DIR } from "./cli-utils.js";

/** Filenames portless creates under a state directory (allowlisted for clean). */
const PORTLESS_STATE_FILES = [
  "routes.json",
  "routes.lock",
  "proxy.pid",
  "proxy.port",
  "proxy.log",
  "proxy.tls",
  "proxy.tld",
  "proxy.lan",
  "ca-key.pem",
  "ca.pem",
  "server-key.pem",
  "server.pem",
  "server.csr",
  "server-ext.cnf",
  "ca.srl",
] as const;

const HOST_CERTS_DIR = "host-certs";

/**
 * Unique existing state directories to consider for cleanup: user dir, system
 * dir, and PORTLESS_STATE_DIR when set.
 */
export function collectStateDirsForCleanup(): string[] {
  const dirs = new Set<string>();
  const add = (d: string | undefined) => {
    const trimmed = d?.trim();
    if (!trimmed) return;
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved)) dirs.add(resolved);
  };
  add(USER_STATE_DIR);
  add(LEGACY_SYSTEM_STATE_DIR);
  add(process.env.PORTLESS_STATE_DIR);
  return [...dirs];
}

/**
 * Best-effort removal of portless state files under dir. Only known filenames
 * are deleted; other files in the directory are left intact.
 */
export function removePortlessStateFiles(dir: string): void {
  for (const f of PORTLESS_STATE_FILES) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      // ENOENT or permission; non-fatal
    }
  }
  try {
    fs.rmSync(path.join(dir, HOST_CERTS_DIR), { recursive: true, force: true });
  } catch {
    // non-fatal
  }
}

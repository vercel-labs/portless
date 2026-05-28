import { discoverState } from "./cli-utils.js";
import { detectWorktreePrefix } from "./auto.js";
import { parseHostname, formatUrl } from "./utils.js";

/**
 * Service URL information returned by {@link getUrl}.
 *
 * The object has a non-enumerable `toString()` method that returns
 * {@link url}, so a `ServiceUrl` can be used directly wherever a URL string
 * is expected (template literals, `String(value)`, `new URL(value)`).
 *
 * `JSON.stringify` produces a plain `{ url, hostname, port, tls, tld }`
 * payload, matching the shape of `portless list --json` and
 * `portless get --json` (see #257).
 */
export interface ServiceUrl {
  /** The full URL, including protocol and (when non-default) port. */
  url: string;
  /** The resolved hostname including TLD, with any worktree prefix applied. */
  hostname: string;
  /** The proxy port. */
  port: number;
  /** Whether the proxy is serving over HTTPS. */
  tls: boolean;
  /** The TLD configured on the proxy (e.g. `localhost`, `test`). */
  tld: string;
  /** Returns {@link url}; lets the object coerce to its URL string. */
  toString(): string;
}

/**
 * Options for {@link getUrl}.
 */
export interface GetUrlOptions {
  /**
   * When `false`, skip git worktree prefix detection. Use this for URLs that
   * must remain stable across branches (e.g. registered OAuth callbacks).
   * Defaults to `true`.
   */
  worktree?: boolean;
  /**
   * Working directory used for git worktree detection. Defaults to
   * `process.cwd()`.
   */
  cwd?: string;
}

/**
 * Resolve the URL for a portless-managed service by name.
 *
 * Equivalent to the `portless get <name>` CLI command. Reads the active
 * proxy's port, TLS mode, and TLD from persisted state, applies the same
 * hostname and worktree logic as `portless run`, and returns the resulting
 * URL plus the components used to build it.
 *
 * The returned object has a `toString()` so it can be used directly wherever
 * a URL string is expected. Access fields like `.port` or `.tls` when the
 * components matter.
 *
 * Returned URLs stay stable across reboots and TLS/TLD config changes.
 * In linked git worktrees the branch name is prepended as a subdomain
 * (e.g. `https://feature-x.cms.localhost`), so apps running in the same
 * worktree automatically address the matching peer service. Pass
 * `worktree: false` to opt out.
 *
 * @example
 * ```ts
 * import { getUrl } from "portless";
 *
 * // From any config file (Playwright, Vite proxy, next.config.js, ...)
 * const cms = await getUrl("cms");
 * // cms.url      -> "https://cms.localhost"
 * //                  ("https://feature-x.cms.localhost" inside a linked worktree)
 * // cms.hostname -> "cms.localhost"
 * // cms.port     -> 443
 * // cms.tls      -> true
 *
 * // toString() means the value coerces to its URL string:
 * await fetch(`${cms}/api/health`);
 *
 * // OAuth-callback-safe (no worktree prefix):
 * const stable = await getUrl("cms", { worktree: false });
 * ```
 *
 * @param name The service name (with or without a TLD suffix).
 * @param options See {@link GetUrlOptions}.
 * @returns A {@link ServiceUrl} describing the service.
 */
export async function getUrl(name: string, options?: GetUrlOptions): Promise<ServiceUrl> {
  const skipWorktree = options?.worktree === false;
  const worktree = skipWorktree ? null : detectWorktreePrefix(options?.cwd);
  const effectiveName = worktree ? `${worktree.prefix}.${name}` : name;

  const { port, tls, tld } = await discoverState();
  const hostname = parseHostname(effectiveName, tld);
  const url = formatUrl(hostname, port, tls);

  const result = { url, hostname, port, tls, tld } as ServiceUrl;
  Object.defineProperty(result, "toString", {
    value: () => url,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return result;
}

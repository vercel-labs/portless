/** Route info used by the proxy server to map hostnames to ports. */
export interface RouteInfo {
  hostname: string;
  port: number;
  /**
   * Public Tailscale Serve/Funnel URL for this route, when one is active
   * (e.g. "https://my-device.tail1234.ts.net"). Requests whose Host header
   * matches this URL's hostname are routed to the same upstream.
   */
  tailscaleUrl?: string;
}

/**
 * Result of a hosts sync the daemon performed on request.
 *
 * `synced` means the hostnames resolve now. `disabled` means this daemon was
 * started with syncing off, so nothing was attempted and the user opted out.
 * `failed` carries the message the CLI prints.
 */
export type HostsSyncOutcome =
  | { state: "synced" }
  | { state: "disabled" }
  | { state: "failed"; message: string };

export interface ProxyServerOptions {
  /** Called on each request to get the current route table. */
  getRoutes: () => RouteInfo[];
  /** The port the proxy is listening on (used to build correct URLs). */
  proxyPort: number;
  /** TLD suffix used for hostnames (default: "localhost"). */
  tld?: string;
  /** All TLD suffixes used for hostnames. The first one is used for examples. */
  tlds?: string[];
  /**
   * When true, only exact hostname matches are used. Unregistered subdomain
   * prefixes return 404 instead of falling back to the base service.
   * Defaults to true.
   */
  strict?: boolean;
  /** Optional error logger; defaults to console.error. */
  onError?: (message: string) => void;
  /**
   * Sync the hosts file now and report the outcome, for a CLI attached to the
   * user's terminal that just registered a route.
   *
   * The daemon owns this because it owns the privileges the write needs and the
   * configuration that decides whether to write at all; a CLI reading its own
   * environment is describing a process it did not start. Returning the answer
   * on the request that asked for it is what keeps the outcome from needing a
   * timestamp, an owner, or a schema version to be attributable.
   *
   * Omitted when the caller has no hosts file to manage, and the route then
   * behaves as if it does not exist.
   */
  onHostsSyncRequest?: () => HostsSyncOutcome;
  /** When provided, enables HTTP/2 over TLS (HTTPS). */
  tls?: {
    cert: Buffer;
    key: Buffer;
    /** CA certificate to include in the chain so clients can verify the leaf. */
    ca?: Buffer;
    /** SNI callback for per-hostname certificate selection. */
    SNICallback?: (
      servername: string,
      cb: (err: Error | null, ctx?: import("node:tls").SecureContext) => void
    ) => void;
  };
}

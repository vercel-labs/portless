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
  /** Epoch milliseconds when the route was registered. Absent on routes from older versions. */
  registeredAt?: number;
  /** Owning process id. Static aliases use 0. */
  pid?: number;
}

export interface ProxyServerOptions {
  /** Called on each request to get the current route table. */
  getRoutes: () => RouteInfo[];
  /**
   * Whether a route's owner is still running. Checked on the route a request
   * resolves to, not on the whole table, so the cost does not grow with the
   * number of routes. A route it rejects is skipped: the lookup continues with
   * the next match, such as a wildcard parent, and the 404 page leaves it out.
   * Defaults to treating every route as live.
   */
  isRouteLive?: (route: RouteInfo) => boolean;
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
  /**
   * When true, refuse every connection whose peer is not a loopback address:
   * at accept time, and again per request and per upgrade. Set when the proxy
   * binds the wildcard address only to take a privileged port without root.
   */
  loopbackOnly?: boolean;
  /** Optional error logger; defaults to console.error. */
  onError?: (message: string) => void;
  /** Run the daemon-owned hosts sync for the current route table. */
  onHostsSyncRequest?: () => "acted" | "disabled";
  hostsSyncToken?: string;
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

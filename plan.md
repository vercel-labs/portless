# Plan: Tailscale IP & MagicDNS Support for Portless

## Context

Currently, portless:
- Routes incoming requests by matching the `Host` header against `*.localhost` hostnames
- Always proxies to `127.0.0.1:<port>` (hardcoded in `proxy.ts:85-87` and `proxy.ts:144-146`)
- Only validates hostnames ending in `.localhost` (`utils.ts:47`)
- Binds the proxy server on a port without specifying a bind address (defaults to all interfaces)

To support Tailscale, there are two independent dimensions:

| Dimension | Current | With Tailscale |
|---|---|---|
| **Backend target** (where proxy forwards to) | `127.0.0.1:<port>` | `100.x.y.z:<port>` or `machine.tailnet.ts.net:<port>` |
| **Frontend access** (how users reach the proxy) | `http://myapp.localhost:1355` | `http://myapp.machine.tailnet.ts.net:1355` (from other devices) |

---

## Step 1: Extend `RouteInfo` to support a target host

**File: `src/types.ts`**

Add an optional `target` field to `RouteInfo`:

```ts
export interface RouteInfo {
  hostname: string;      // matching hostname (Host header)
  port: number;          // backend port
  target?: string;       // backend host — defaults to "127.0.0.1"
}
```

This is backwards-compatible: existing routes without `target` keep working.

---

## Step 2: Update the proxy to forward to the route's target host

**File: `src/proxy.ts`**

In `handleRequest` (line 85) and `handleUpgrade` (line 144), replace the hardcoded `"127.0.0.1"` with `route.target || "127.0.0.1"`:

```ts
const proxyReq = http.request({
  hostname: route.target || "127.0.0.1",
  port: route.port,
  ...
});
```

This is the core change — two lines total.

---

## Step 3: Support non-`.localhost` hostnames (MagicDNS names)

**File: `src/utils.ts`**

Currently `parseHostname()` forces all names to end with `.localhost`. We need a separate path for Tailscale/arbitrary hostnames. Options:

- Add a new function `parseTarget(input)` that validates Tailscale IPs (100.x.y.z / fd7a:115c:a1e0::/48) and MagicDNS names (`*.ts.net`) without appending `.localhost`.
- Or, make `parseHostname()` accept a flag/mode to skip the `.localhost` suffix when the input looks like a Tailscale address or IP.

Recommended approach — add a `parseTailscaleTarget(input: string): string` function that:
1. Validates IPv4 addresses (especially the Tailscale CGNAT range `100.64.0.0/10`)
2. Validates IPv6 addresses (Tailscale `fd7a:115c:a1e0::/48`)
3. Validates MagicDNS names (`*.ts.net`)
4. Returns the normalized hostname/IP

---

## Step 4: Add `--target` flag to the CLI

**File: `src/cli.ts`**

When running an app, allow specifying where the backend lives:

```
portless myapp --target 100.100.1.5 next dev
portless myapp --target devbox.tailnet.ts.net next dev
```

In `runApp()`, parse `--target` from `commandArgs`, validate it, and pass it through to `store.addRoute()`.

When `--target` is provided:
- The assigned port still comes from `findFreePort()` (the PORT env var for the child process)
- But the proxy forwards to `<target>:<port>` instead of `127.0.0.1:<port>`

Alternatively, for proxying to an *existing* remote service (not spawning a child), we could add a `portless add` command:

```
portless add myapp --target 100.100.1.5 --port 3000
```

This registers a route without spawning a process, useful for services already running on another Tailscale node.

---

## Step 5: Update `RouteMapping` and `RouteStore`

**File: `src/routes.ts`**

- Add `target?: string` to `RouteMapping` (extends `RouteInfo`, so it inherits automatically)
- Update `isValidRoute()` to accept the optional `target` field
- Update `addRoute()` signature: `addRoute(hostname, port, pid, target?)`
- Stale-route cleanup: for remote targets, the PID check (`process.kill(pid, 0)`) won't work since the process is on another machine. Skip PID liveness check when `target` is not `127.0.0.1` / not local.

---

## Step 6: Support accessing the proxy from other Tailscale devices (frontend)

**File: `src/proxy.ts`**

Currently the proxy matches `Host` header against `*.localhost` names. When accessed from another Tailscale device, the Host header will be something like `100.100.1.5:1355` or `machine.tailnet.ts.net:1355`.

Options:
1. **Wildcard/catch-all route**: If only one app is registered, route all requests to it regardless of Host header.
2. **Tailscale hostname aliases**: Allow a route to match multiple hostnames (e.g., both `myapp.localhost` and `myapp.machine.tailnet.ts.net`).
3. **Configurable base domain**: Instead of hardcoding `.localhost`, let users set a base domain like `.machine.tailnet.ts.net` so apps become `http://myapp.machine.tailnet.ts.net:1355`.

Recommended approach — option 3 with a `--domain` flag or `PORTLESS_DOMAIN` env var:

```
portless proxy start --domain mybox.tailnet.ts.net
```

Then `portless myapp next dev` registers as `myapp.mybox.tailnet.ts.net` in addition to (or instead of) `myapp.localhost`. This requires:
- Tailscale to be configured to resolve `*.mybox.tailnet.ts.net` (this may require Tailscale split DNS or a local DNS setup)
- Or just matching on the subdomain prefix regardless of the base domain

A simpler alternative: match routes by **subdomain prefix only** (strip the base domain), so `myapp.localhost`, `myapp.100.100.1.5`, and `myapp.machine.ts.net` all match the `myapp` route.

---

## Step 7: Update `formatUrl()` and display

**File: `src/utils.ts`**

Update `formatUrl()` to handle non-`.localhost` hostnames. When a Tailscale domain is configured, show URLs like `http://myapp.machine.tailnet.ts.net:1355` in CLI output and the 404 page.

---

## Step 8: Tests

**Files: `src/*.test.ts`**

- **proxy.test.ts**: Test proxying to non-localhost targets, test Host header matching with Tailscale IPs/MagicDNS names
- **utils.test.ts**: Test `parseTailscaleTarget()` with valid/invalid Tailscale IPs, MagicDNS names
- **routes.test.ts**: Test route storage with `target` field, test stale cleanup skips remote targets
- **cli.test.ts**: Test `--target` flag parsing

---

## Suggested Implementation Order

| Phase | What | Scope |
|-------|------|-------|
| **Phase 1** | Steps 1-2: Proxy to Tailscale targets | Minimal — types + 2 lines in proxy.ts |
| **Phase 2** | Steps 3-5: CLI + route storage for targets | `--target` flag, validation, route store |
| **Phase 3** | Step 6: Frontend access from Tailscale | Subdomain-prefix matching or `--domain` |
| **Phase 4** | Steps 7-8: Polish + tests | URL formatting, comprehensive tests |

Phase 1 alone is useful: users can manually edit `routes.json` to add a target. Phase 2 makes it ergonomic. Phase 3 enables the full Tailscale experience (accessing from other devices).

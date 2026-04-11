---
name: portless
description: Set up and use portless for named local dev server URLs (e.g. https://myapp.localhost instead of http://localhost:3000). Use when integrating portless into a project, configuring dev server names, setting up the local proxy, working with .localhost domains, or troubleshooting port/proxy issues.
---

# Portless

Replace port numbers with stable, named .localhost URLs. For humans and agents.

## Why portless

- **Port conflicts**: `EADDRINUSE` when two projects default to the same port
- **Memorizing ports**: which app is on 3001 vs 8080?
- **Refreshing shows the wrong app**: stop one server, start another on the same port, stale tab shows wrong content
- **Monorepo multiplier**: every problem scales with each service in the repo
- **Agents test the wrong port**: AI agents guess or hardcode the wrong port
- **Cookie/storage clashes**: cookies on `localhost` bleed across apps; localStorage lost when ports shift
- **Hardcoded ports in config**: CORS allowlists, OAuth redirects, `.env` files break when ports change
- **Sharing URLs with teammates**: "what port is that on?" becomes a Slack question
- **Browser history is useless**: `localhost:3000` history is a mix of unrelated projects

## Installation

Install globally (recommended) or as a project dev dependency. Do NOT use `npx` or `pnpm dlx` for one-off execution.

```bash
# Global (available everywhere)
npm install -g portless

# Or per-project dev dependency
npm install -D portless
```

When installed per-project, invoke via package.json scripts or `npx portless` (since the package is local, npx will not download anything).

## Quick Start

```bash
# Install globally (or add -D to a project)
npm install -g portless

# Run your app (auto-starts the HTTPS proxy on port 443)
portless run next dev
# -> https://<project>.localhost

# Or with an explicit name
portless myapp next dev
# -> https://myapp.localhost
```

The proxy auto-starts when you run an app. You can also start it explicitly with `portless proxy start`.

## Integration Patterns

### package.json scripts

```json
{
  "scripts": {
    "dev": "portless run next dev"
  }
}
```

The proxy auto-starts when you run an app. Or start it explicitly: `portless proxy start`.

### Multi-app setups with subdomains

```bash
portless myapp next dev          # https://myapp.localhost
portless api.myapp pnpm start    # https://api.myapp.localhost
portless docs.myapp next dev     # https://docs.myapp.localhost
```

By default, only explicitly registered subdomains are routed (strict mode). Start the proxy with `--wildcard` to allow any subdomain of a registered route to fall back to that app (e.g. `tenant1.myapp.localhost` routes to the `myapp` app). Exact matches always take priority over wildcards.

### Git worktrees

`portless run` automatically detects git worktrees. In a linked worktree, the branch name is prepended as a subdomain prefix so each worktree gets a unique URL:

```bash
# Main worktree (no prefix)
portless run next dev   # -> https://myapp.localhost

# Linked worktree on branch "fix-ui"
portless run next dev   # -> https://fix-ui.myapp.localhost
```

No config changes needed. Put `portless run` in `package.json` once and it works in all worktrees.

### Bypassing portless

Set `PORTLESS=0` to run the command directly without the proxy:

```bash
PORTLESS=0 pnpm dev   # Bypasses proxy, uses default port
```

## How It Works

1. `portless proxy start` starts an HTTPS reverse proxy on port 443 as a background daemon. Auto-elevates with sudo on macOS/Linux; falls back to port 1355 if sudo is unavailable. Use `--no-tls` for plain HTTP on port 80. Configurable with `-p` / `--port` or the `PORTLESS_PORT` env var. The proxy also auto-starts when you run an app.
2. `portless <name> <cmd>` assigns a random free port (4000-4999) via the `PORT` env var and registers the app with the proxy
3. The browser hits `https://<name>.localhost`; the proxy forwards to the app's assigned port

`.localhost` domains resolve to `127.0.0.1` natively in Chrome, Firefox, and Edge. Safari relies on the system DNS resolver, which may not handle `.localhost` subdomains on all configurations. Run `portless hosts sync` to add entries to `/etc/hosts` if needed.

Most frameworks (Next.js, Express, Nuxt, etc.) respect the `PORT` env var automatically. For frameworks that ignore `PORT` (Vite, VitePlus, Astro, React Router, Angular, Expo, React Native), portless auto-injects the correct `--port` flag and, when needed, a matching `--host` CLI flag.

### State directory

Portless stores its state (routes, PID file, port file) in a directory that depends on the proxy port:

- **Port < 1024** (sudo required): `/tmp/portless` (macOS/Linux only)
- **Port >= 1024** (no sudo): `~/.portless`
- **Windows**: Always `~/.portless` (no privileged port concept)

Override with the `PORTLESS_STATE_DIR` environment variable.

### Environment variables

| Variable              | Description                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `PORTLESS_PORT`       | Override the default proxy port (default: 443 with HTTPS, 80 without) |
| `PORTLESS_APP_PORT`   | Use a fixed port for the app (skip auto-assignment)                   |
| `PORTLESS_HTTPS`      | HTTPS on by default; set to `0` to disable (same as `--no-tls`)       |
| `PORTLESS_LAN`        | Set to `1` to always enable LAN mode (auto-detects LAN IP)            |
| `PORTLESS_TLD`        | Use a custom TLD instead of localhost (e.g. test)                     |
| `PORTLESS_WILDCARD`   | Set to `1` to allow unregistered subdomains to fall back to parent    |
| `PORTLESS_SYNC_HOSTS` | Set to `0` to disable auto-sync of /etc/hosts (on by default)         |
| `PORTLESS_STATE_DIR`  | Override the state directory                                          |
| `PORTLESS=0`          | Bypass the proxy, run the command directly                            |

### HTTP/2 + HTTPS

HTTPS with HTTP/2 is enabled by default (faster page loads for dev servers with many files). First run generates a local CA and adds it to the system trust store. After that, no prompts and no browser warnings.

```bash
portless proxy start --cert ./c.pem --key ./k.pem  # Use custom certs
portless proxy start --no-tls                       # Disable HTTPS (plain HTTP)
portless trust                                      # Add CA to trust store later
```

On Linux, `portless trust` supports Debian/Ubuntu, Arch, Fedora/RHEL/CentOS, and openSUSE (via `update-ca-certificates` or `update-ca-trust`). On Windows, it uses `certutil` to add the CA to the system trust store.

### LAN mode

```bash
portless proxy start --lan
portless proxy start --lan --https
portless proxy start --lan --ip 192.168.1.42
```

`--lan` advertises `<name>.local` hostnames over mDNS so any device on the same Wi-Fi can reach your apps. Portless auto-detects your LAN IP and follows network changes automatically, but you can pin a specific address with `--ip <address>` or the `PORTLESS_LAN_IP` environment variable. Set `PORTLESS_LAN=1` to default to LAN mode every time the proxy starts.

Portless remembers LAN mode via `proxy.lan`, so if you stop a LAN proxy and start again, it stays in LAN mode. Other proxy settings still follow the current flags and env vars. Use `PORTLESS_LAN=0` for one start to switch back to `.localhost` mode. If a proxy is already running with different explicit LAN/TLS/TLD settings, portless warns and asks you to stop it first.

LAN mode depends on the system mDNS helpers that portless launches: macOS includes `dns-sd`, while Linux uses `avahi-publish-address` from `avahi-utils` (install via `sudo apt install avahi-utils` or your distro’s tooling).

- **Next.js**: add your `.local` hostnames to `allowedDevOrigins`:

  ```js
  // next.config.js
  module.exports = {
    allowedDevOrigins: ["myapp.local", "*.myapp.local"],
  };
  ```

- **Expo / React Native**: portless always injects `--port`. React Native also gets `--host 127.0.0.1`. Expo gets `--host localhost` outside LAN mode, but in LAN mode portless leaves Metro on its default LAN host behavior instead of forcing `--host` or `HOST`.

## CLI Reference

| Command                                | Description                                                    |
| -------------------------------------- | -------------------------------------------------------------- |
| `portless run <cmd> [args...]`         | Infer name from project, run through proxy (auto-starts)       |
| `portless run --name <name> <cmd>`     | Override inferred base name (worktree prefix still applies)    |
| `portless <name> <cmd> [args...]`      | Run app at `https://<name>.localhost` (auto-starts proxy)      |
| `portless get <name>`                  | Print URL for a service (for cross-service wiring)             |
| `portless get <name> --no-worktree`    | Print URL without worktree prefix                              |
| `portless list`                        | Show active routes                                             |
| `portless trust`                       | Add local CA to system trust store (for HTTPS)                 |
| `portless clean`                       | Remove state, CA trust entry, and /etc/hosts block             |
| `portless proxy start`                 | Start HTTPS proxy as a daemon (port 443, auto-elevates)        |
| `portless proxy start --no-tls`        | Start without HTTPS (plain HTTP on port 80)                    |
| `portless proxy start --lan`           | Start in LAN mode (mDNS `.local`, auto-follows LAN IP changes) |
| `portless proxy start -p <number>`     | Start the proxy on a custom port                               |
| `portless proxy start --tld test`      | Use .test instead of .localhost                                |
| `portless proxy start --foreground`    | Start the proxy in foreground (for debugging)                  |
| `portless proxy start --wildcard`      | Allow unregistered subdomains to fall back to parent route     |
| `portless proxy stop`                  | Stop the proxy                                                 |
| `portless alias <name> <port>`         | Register a static route (e.g. for Docker containers)           |
| `portless alias <name> <port> --force` | Overwrite an existing route                                    |
| `portless alias --remove <name>`       | Remove a static route                                          |
| `portless hosts sync`                  | Add routes to /etc/hosts (fixes Safari)                        |
| `portless hosts clean`                 | Remove portless entries from /etc/hosts                        |
| `portless <name> --app-port <n> <cmd>` | Use a fixed port for the app instead of auto-assignment        |
| `portless <name> --force <cmd>`        | Kill the existing process and take over its route              |
| `portless --name <name> <cmd>`         | Force `<name>` as app name (bypasses subcommand dispatch)      |
| `portless <name> -- <cmd> [args...]`   | Stop flag parsing; everything after `--` is passed to child    |
| `portless --help` / `-h`               | Show help                                                      |
| `portless run --help`                  | Show help for a subcommand (also: alias, hosts, clean)         |
| `portless --version` / `-v`            | Show version                                                   |

**Reserved names:** `run`, `get`, `alias`, `hosts`, `list`, `trust`, `clean`, and `proxy` are subcommands and cannot be used as app names directly. Use `portless run <cmd>` to infer the name, or `portless --name <name> <cmd>` to force any name including reserved ones.

## Troubleshooting

### Proxy not running

The proxy auto-starts when you run an app with `portless <name> <cmd>`. If it doesn't start (e.g. port conflict), start it manually:

```bash
portless proxy start
```

### Port already in use

Another process is bound to the proxy port. Either stop it first, or use a different port:

```bash
portless proxy start -p 8080
```

### Framework not respecting PORT

Portless auto-injects the right `--port` flag and, when needed, a matching `--host` flag for frameworks that ignore the `PORT` env var: **Vite**, **VitePlus** (`vp`), **Astro**, **React Router**, **Angular**, **Expo**, and **React Native**. SvelteKit uses Vite internally and is handled automatically.

For other frameworks that don't read `PORT`, pass the port manually:

- **Webpack Dev Server**: use `--port $PORT`
- **Custom servers**: read `process.env.PORT` and listen on it

### Permission errors

The default ports (80 for HTTP, 443 for HTTPS) require `sudo` on macOS and Linux. Portless auto-elevates with sudo when needed. If sudo is unavailable, it falls back to port 1355 (no sudo needed). On Windows, no elevation is required.

```bash
portless proxy start --https           # Auto-elevates with sudo for port 443
portless proxy start -p 1355 --https   # No sudo needed (URLs include :1355)
portless proxy stop                    # Stop (use sudo if started with sudo)
```

### Safari can't find .localhost URLs

Safari relies on the system DNS resolver for `.localhost` subdomains, which may not resolve them on all macOS configurations. Chrome, Firefox, and Edge have built-in handling.

Fix:

```bash
portless hosts sync    # Adds current routes to /etc/hosts
portless hosts clean   # Remove entries later
```

Auto-syncs `/etc/hosts` for route hostnames by default. Set `PORTLESS_SYNC_HOSTS=0` to disable.

### Browser shows certificate warning with --https

The local CA may not be trusted yet. Run:

```bash
portless trust
```

This adds the portless local CA to your system trust store. After that, restart the browser.

### Remove portless from the machine

```bash
portless clean
```

Stops the proxy if needed, removes the portless CA from the trust store (when portless added it), deletes known files under state directories, and removes the portless `/etc/hosts` block. May require `sudo` on macOS/Linux.

### Proxy loop (508 Loop Detected)

If your dev server proxies requests to another portless app (e.g. Vite proxying `/api` to `api.myapp.localhost`), the proxy must rewrite the `Host` header. Without this, portless routes the request back to the original app, creating an infinite loop.

Fix: set `changeOrigin: true` in the proxy config (Vite, webpack-dev-server, etc.):

```ts
// vite.config.ts
proxy: {
  "/api": {
    target: "https://api.myapp.localhost",
    changeOrigin: true,
    ws: true,
  },
}
```

Portless automatically sets `NODE_EXTRA_CA_CERTS` in child processes so Node.js trusts the portless CA. If you run a separate Node.js process outside portless, point it at the CA manually: `NODE_EXTRA_CA_CERTS=/tmp/portless/ca.pem` (or `~/.portless/ca.pem` when the proxy runs on a non-privileged port like 1355). Alternatively, use `--no-tls` for plain HTTP.

### Requirements

- Node.js 20+
- macOS, Linux, or Windows
- `openssl` (for `--https` cert generation; ships with macOS and most Linux distributions; on Windows, install via `winget install -e --id ShiningLight.OpenSSL.Dev` or use the copy bundled with Git for Windows)

---
name: portless
description: Set up and use portless for named local dev server URLs (e.g. http://myapp.localhost instead of http://localhost:3000). Use when integrating portless into a project, configuring dev server names, setting up the local proxy, working with .localhost domains, or troubleshooting port/proxy issues.
---

# Portless

Replace port numbers with stable, named .localhost URLs. For humans and agents.

## Why portless

- **Port conflicts** -- `EADDRINUSE` when two projects default to the same port
- **Memorizing ports** -- which app is on 3001 vs 8080?
- **Refreshing shows the wrong app** -- stop one server, start another on the same port, stale tab shows wrong content
- **Monorepo multiplier** -- every problem scales with each service in the repo
- **Agents test the wrong port** -- AI agents guess or hardcode the wrong port
- **Cookie/storage clashes** -- cookies on `localhost` bleed across apps; localStorage lost when ports shift
- **Hardcoded ports in config** -- CORS allowlists, OAuth redirects, `.env` files break when ports change
- **Sharing URLs with teammates** -- "what port is that on?" becomes a Slack question
- **Browser history is useless** -- `localhost:3000` history is a mix of unrelated projects

## Installation

portless is a global CLI tool. Do NOT add it as a project dependency (no `npm install portless` or `pnpm add portless` in a project). Do NOT use `npx` or `pnpm dlx`.

Install globally:

```bash
npm install -g portless
```

## Quick Start

```bash
# Install globally
npm install -g portless

# Start the proxy (once, no sudo needed)
portless proxy start

# Run your app (auto-starts the proxy if needed)
portless run next dev
# -> http://<project>.localhost:1355

# Or with an explicit name
portless myapp next dev
# -> http://myapp.localhost:1355
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
portless myapp next dev          # http://myapp.localhost:1355
portless api.myapp pnpm start    # http://api.myapp.localhost:1355
portless docs.myapp next dev     # http://docs.myapp.localhost:1355
```

Wildcard subdomain routing: any subdomain of a registered route routes to that app automatically (e.g. `tenant1.myapp.localhost:1355` routes to the `myapp` app without extra registration). Exact matches take priority over wildcards.

### Git worktrees

`portless run` automatically detects git worktrees. In a linked worktree, the branch name is prepended as a subdomain prefix so each worktree gets a unique URL:

```bash
# Main worktree -- no prefix
portless run next dev   # -> http://myapp.localhost:1355

# Linked worktree on branch "fix-ui"
portless run next dev   # -> http://fix-ui.myapp.localhost:1355
```

No config changes needed. Put `portless run` in `package.json` once and it works in all worktrees.

### Bypassing portless

Set `PORTLESS=0` to run the command directly without the proxy:

```bash
PORTLESS=0 pnpm dev   # Bypasses proxy, uses default port
```

## How It Works

1. `portless proxy start` starts an HTTP reverse proxy on port 1355 as a background daemon (configurable with `-p` / `--port` or the `PORTLESS_PORT` env var). The proxy also auto-starts when you run an app.
2. `portless <name> <cmd>` assigns a random free port (4000-4999) via the `PORT` env var and registers the app with the proxy
3. The browser hits `http://<name>.localhost:1355` on the proxy port; the proxy forwards to the app's assigned port

`.localhost` domains resolve to `127.0.0.1` natively in Chrome, Firefox, and Edge. Safari relies on the system DNS resolver, which may not handle `.localhost` subdomains on all configurations. Run `sudo portless hosts sync` to add entries to `/etc/hosts` if needed.

Most frameworks (Next.js, Express, Nuxt, etc.) respect the `PORT` env var automatically. For frameworks that ignore `PORT` (Vite, Astro, React Router, Angular, Expo, React Native), portless auto-injects the correct `--port` and `--host` CLI flags.

### State directory

Portless stores its state (routes, PID file, port file) in a directory that depends on the proxy port:

- **Port < 1024** (sudo required): `/tmp/portless`
- **Port >= 1024** (no sudo): `~/.portless`

Override with the `PORTLESS_STATE_DIR` environment variable.

### Environment variables

| Variable              | Description                                                       |
| --------------------- | ----------------------------------------------------------------- |
| `PORTLESS_PORT`       | Override the default proxy port (default: 1355)                   |
| `PORTLESS_APP_PORT`   | Use a fixed port for the app (skip auto-assignment)               |
| `PORTLESS_HTTPS`      | Set to `1` to always enable HTTPS/HTTP/2                          |
| `PORTLESS_TLD`        | Use a custom TLD instead of localhost (e.g. test)                 |
| `PORTLESS_SYNC_HOSTS` | Set to `1` to auto-sync /etc/hosts (auto-enabled for custom TLDs) |
| `PORTLESS_STATE_DIR`  | Override the state directory                                      |
| `PORTLESS=0`          | Bypass the proxy, run the command directly                        |

### HTTP/2 + HTTPS

Use `--https` for HTTP/2 multiplexing (faster page loads for dev servers with many files):

```bash
portless proxy start --https                  # Auto-generate certs and trust CA
portless proxy start --cert ./c.pem --key ./k.pem  # Use custom certs
sudo portless trust                           # Add CA to trust store later
```

First run generates a local CA and prompts for sudo to add it to the system trust store. After that, no prompts and no browser warnings. Set `PORTLESS_HTTPS=1` in `.bashrc`/`.zshrc` to make it permanent.

On Linux, `portless trust` supports Debian/Ubuntu, Arch, Fedora/RHEL/CentOS, and openSUSE (via `update-ca-certificates` or `update-ca-trust`).

## CLI Reference

| Command                                | Description                                                   |
| -------------------------------------- | ------------------------------------------------------------- |
| `portless run <cmd> [args...]`         | Infer name from project, run through proxy (auto-starts)      |
| `portless run --name <name> <cmd>`     | Override inferred base name (worktree prefix still applies)   |
| `portless <name> <cmd> [args...]`      | Run app at `http://<name>.localhost:1355` (auto-starts proxy) |
| `portless list`                        | Show active routes                                            |
| `portless trust`                       | Add local CA to system trust store (for HTTPS)                |
| `portless proxy start`                 | Start the proxy as a daemon (port 1355, no sudo)              |
| `portless proxy start --https`         | Start with HTTP/2 + TLS (auto-generates certs)                |
| `portless proxy start -p <number>`     | Start the proxy on a custom port                              |
| `portless proxy start --tld test`      | Use .test instead of .localhost (requires /etc/hosts sync)    |
| `portless proxy start --foreground`    | Start the proxy in foreground (for debugging)                 |
| `portless proxy stop`                  | Stop the proxy                                                |
| `portless alias <name> <port>`         | Register a static route (e.g. for Docker containers)          |
| `portless alias <name> <port> --force` | Overwrite an existing route                                   |
| `portless alias --remove <name>`       | Remove a static route                                         |
| `portless hosts sync`                  | Add routes to /etc/hosts (fixes Safari)                       |
| `portless hosts clean`                 | Remove portless entries from /etc/hosts                       |
| `portless <name> --app-port <n> <cmd>` | Use a fixed port for the app instead of auto-assignment       |
| `portless <name> --force <cmd>`        | Override an existing route registered by another process      |
| `portless --name <name> <cmd>`         | Force `<name>` as app name (bypasses subcommand dispatch)     |
| `portless <name> -- <cmd> [args...]`   | Stop flag parsing; everything after `--` is passed to child   |
| `portless --help` / `-h`               | Show help                                                     |
| `portless run --help`                  | Show help for a subcommand (also: alias, hosts)               |
| `portless --version` / `-v`            | Show version                                                  |

**Reserved names:** `run`, `alias`, `hosts`, `list`, `trust`, and `proxy` are subcommands and cannot be used as app names directly. Use `portless run <cmd>` to infer the name, or `portless --name <name> <cmd>` to force any name including reserved ones.

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

Portless auto-injects `--port` and `--host` flags for frameworks that ignore the `PORT` env var: **Vite**, **Astro**, **React Router**, **Angular**, **Expo**, and **React Native**. SvelteKit uses Vite internally and is handled automatically.

For other frameworks that don't read `PORT`, pass the port manually:

- **Webpack Dev Server**: use `--port $PORT`
- **Custom servers**: read `process.env.PORT` and listen on it

### Permission errors

Ports below 1024 require `sudo`. The default port (1355) does not need sudo. If you want to use port 80:

```bash
sudo portless proxy start -p 80       # Port 80, requires sudo
portless proxy start                   # Port 1355, no sudo needed
portless proxy stop                    # Stop (use sudo if started with sudo)
```

### Safari can't find .localhost URLs

Safari relies on the system DNS resolver for `.localhost` subdomains, which may not resolve them on all macOS configurations. Chrome, Firefox, and Edge have built-in handling.

Fix:

```bash
sudo portless hosts sync    # Adds current routes to /etc/hosts
sudo portless hosts clean   # Remove entries later
```

Auto-syncs `/etc/hosts` for custom TLDs (e.g. `--tld test`). For `.localhost`, set `PORTLESS_SYNC_HOSTS=1` to enable.

### Browser shows certificate warning with --https

The local CA may not be trusted yet. Run:

```bash
sudo portless trust
```

This adds the portless local CA to your system trust store. After that, restart the browser.

### Proxy loop (508 Loop Detected)

If your dev server proxies requests to another portless app (e.g. Vite proxying `/api` to `api.myapp.localhost:1355`), the proxy must rewrite the `Host` header. Without this, portless routes the request back to the original app, creating an infinite loop.

Fix: set `changeOrigin: true` in the proxy config (Vite, webpack-dev-server, etc.):

```ts
// vite.config.ts
proxy: {
  "/api": {
    target: "http://api.myapp.localhost:1355",
    changeOrigin: true,
    ws: true,
  },
}
```

### Requirements

- Node.js 20+
- macOS or Linux
- `openssl` (for `--https` cert generation; ships with macOS and most Linux distributions)

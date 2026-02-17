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

portless is a global CLI tool. Do NOT add it as a project dependency (no `npm install portless` or `pnpm add portless` in a project). Do NOT use `npx`.

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
portless myapp next dev
# -> http://myapp.localhost:1355
```

The proxy auto-starts when you run an app. You can also start it explicitly with `portless proxy start`.

## Integration Patterns

### package.json scripts

```json
{
  "scripts": {
    "dev": "portless myapp next dev"
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

### Bypassing portless

Set `PORTLESS=0` or `PORTLESS=skip` to run the command directly without the proxy:

```bash
PORTLESS=0 pnpm dev   # Bypasses proxy, uses default port
```

## How It Works

1. `portless proxy start` starts an HTTP reverse proxy on port 1355 as a background daemon (configurable with `-p` / `--port` or the `PORTLESS_PORT` env var). The proxy also auto-starts when you run an app.
2. `portless <name> <cmd>` assigns a random free port (4000-4999) via the `PORT` env var and registers the app with the proxy
3. The browser hits `http://<name>.localhost:1355` on the proxy port; the proxy forwards to the app's assigned port

`.localhost` domains resolve to `127.0.0.1` natively on macOS and Linux -- no `/etc/hosts` editing needed.

Most frameworks (Next.js, Vite, Express, etc.) respect the `PORT` env var automatically.

### State directory

Portless stores its state (routes, PID file, port file) in a directory that depends on the proxy port:

- **Port < 1024** (sudo required): `/tmp/portless`
- **Port >= 1024** (no sudo): `~/.portless`

Override with the `PORTLESS_STATE_DIR` environment variable.

### Environment variables

| Variable             | Description                                     |
| -------------------- | ----------------------------------------------- |
| `PORTLESS_PORT`      | Override the default proxy port (default: 1355) |
| `PORTLESS_HTTPS`     | Set to `1` to always enable HTTPS/HTTP/2        |
| `PORTLESS_STATE_DIR` | Override the state directory                    |
| `PORTLESS=0\|skip`   | Bypass the proxy, run the command directly      |

### HTTP/2 + HTTPS

Use `--https` for HTTP/2 multiplexing (faster page loads for dev servers with many files):

```bash
portless proxy start --https                  # Auto-generate certs and trust CA
portless proxy start --cert ./c.pem --key ./k.pem  # Use custom certs
sudo portless trust                           # Add CA to trust store later
```

First run generates a local CA and prompts for sudo to add it to the system trust store. After that, no prompts and no browser warnings. Set `PORTLESS_HTTPS=1` in `.bashrc`/`.zshrc` to make it permanent.

## CLI Reference

| Command                             | Description                                                   |
| ----------------------------------- | ------------------------------------------------------------- |
| `portless <name> <cmd> [args...]`   | Run app at `http://<name>.localhost:1355` (auto-starts proxy) |
| `portless list`                     | Show active routes                                            |
| `portless trust`                    | Add local CA to system trust store (for HTTPS)                |
| `portless proxy start`              | Start the proxy as a daemon (port 1355, no sudo)              |
| `portless proxy start --https`      | Start with HTTP/2 + TLS (auto-generates certs)                |
| `portless proxy start -p <number>`  | Start the proxy on a custom port                              |
| `portless proxy start --foreground` | Start the proxy in foreground (for debugging)                 |
| `portless proxy stop`               | Stop the proxy                                                |
| `portless --help` / `-h`            | Show help                                                     |
| `portless --version` / `-v`         | Show version                                                  |

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

Some frameworks need explicit configuration to use the `PORT` env var. Examples:

- **Webpack Dev Server**: use `--port $PORT`
- **Custom servers**: read `process.env.PORT` and listen on it

### Permission errors

Ports below 1024 require `sudo`. The default port (1355) does not need sudo. If you want to use port 80:

```bash
sudo portless proxy start -p 80       # Port 80, requires sudo
portless proxy start                   # Port 1355, no sudo needed
portless proxy stop                    # Stop (use sudo if started with sudo)
```

### Browser shows certificate warning with --https

The local CA may not be trusted yet. Run:

```bash
sudo portless trust
```

This adds the portless local CA to your system trust store. After that, restart the browser.

### Requirements

- Node.js 20+
- macOS or Linux
- `openssl` (for `--https` cert generation; ships with macOS and most Linux distributions)

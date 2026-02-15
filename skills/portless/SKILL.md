---
name: portless
description: Set up and use portless for named local dev server URLs (e.g. http://myapp.localhost instead of http://localhost:3000). Use when integrating portless into a project, configuring dev server names, setting up the local proxy, working with .localhost domains, or troubleshooting port/proxy issues.
---

# Portless

Replace port numbers with stable, named .localhost URLs. For humans and agents.

## Why portless

- **Port conflicts** — `EADDRINUSE` when two projects default to the same port
- **Memorizing ports** — which app is on 3001 vs 8080?
- **Refreshing shows the wrong app** — stop one server, start another on the same port, stale tab shows wrong content
- **Monorepo multiplier** — every problem scales with each service in the repo
- **Agents test the wrong port** — AI agents guess or hardcode the wrong port
- **Cookie/storage clashes** — cookies on `localhost` bleed across apps; localStorage lost when ports shift
- **Hardcoded ports in config** — CORS allowlists, OAuth redirects, `.env` files break when ports change
- **Sharing URLs with teammates** — "what port is that on?" becomes a Slack question
- **Browser history is useless** — `localhost:3000` history is a mix of unrelated projects

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

# Start the proxy (once, requires sudo for port 80)
sudo portless proxy

# Run your app
portless myapp next dev
# -> http://myapp.localhost
```

When run directly in a terminal (TTY), portless can auto-start the proxy (prompts for sudo once). Via package scripts, start the proxy manually first.

## Integration Patterns

### package.json scripts

```json
{
  "scripts": {
    "dev": "portless myapp next dev"
  }
}
```

Start the proxy once (`sudo portless proxy`), then run `pnpm dev` / `npm run dev` as usual.

### Multi-app setups with subdomains

```bash
portless myapp next dev          # http://myapp.localhost
portless api.myapp pnpm start    # http://api.myapp.localhost
portless docs.myapp next dev     # http://docs.myapp.localhost
```

### Bypassing portless

Set `PORTLESS=0` or `PORTLESS=skip` to run the command directly without the proxy:

```bash
PORTLESS=0 pnpm dev   # Bypasses proxy, uses default port
```

## How It Works

1. `sudo portless proxy` starts an HTTP reverse proxy on port 80 (configurable with `--port`)
2. `portless <name> <cmd>` assigns a random free port (4000-4999) via the `PORT` env var and registers the app with the proxy
3. The browser hits `http://<name>.localhost` on the proxy port; the proxy forwards to the app's assigned port

`.localhost` domains resolve to `127.0.0.1` natively on macOS and Linux -- no `/etc/hosts` editing needed.

Most frameworks (Next.js, Vite, Express, etc.) respect the `PORT` env var automatically.

## CLI Reference

| Command                               | Description                          |
| ------------------------------------- | ------------------------------------ |
| `portless <name> <cmd> [args...]`     | Run app at `http://<name>.localhost` |
| `portless list`                       | Show active routes                   |
| `sudo portless proxy`                 | Start the proxy daemon on port 80    |
| `sudo portless proxy --port <number>` | Start the proxy on a custom port     |
| `sudo portless proxy stop`            | Stop the proxy daemon                |
| `portless --help` / `-h`              | Show help                            |
| `portless --version` / `-v`           | Show version                         |

## Troubleshooting

### Proxy not running

If `portless <name> <cmd>` reports the proxy is not running:

```bash
sudo portless proxy
```

In a TTY, portless offers to start it automatically. In non-interactive contexts (CI, package scripts), start it manually first.

### Port 80 already in use

Another process (e.g. Apache, nginx) is bound to port 80. Either stop it first, or use a different port:

```bash
portless proxy --port 8080   # No sudo needed for ports >= 1024
```

### Framework not respecting PORT

Some frameworks need explicit configuration to use the `PORT` env var. Examples:

- **Webpack Dev Server**: use `--port $PORT`
- **Custom servers**: read `process.env.PORT` and listen on it

### Permission errors

The proxy requires `sudo` because port 80 is a privileged port (< 1024). Either run with `sudo` or use an unprivileged port:

```bash
sudo portless proxy              # Port 80, requires sudo
portless proxy --port 8080       # Port 8080, no sudo needed
sudo portless proxy stop         # Stop requires sudo if started with sudo
```

### Requirements

- Node.js 20+
- macOS or Linux

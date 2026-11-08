# portless

Replace port numbers with stable, named .localhost URLs for local development. For humans and agents.

<p>
  <a href="https://vercel.com/labs#labs-products"><img alt="Vercel Labs Product" src="https://img.shields.io/badge/LABS-PRODUCT-0a0a0a.svg?style=for-the-badge&amp;logo=Vercel&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/portless"><img alt="npm version: portless" src="https://img.shields.io/npm/v/portless.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://github.com/vercel-labs/portless/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/github/license/vercel-labs/portless.svg?style=for-the-badge&amp;labelColor=000000" height="28"></a>
  <a href="https://www.npmjs.com/package/portless"><img alt="npm downloads per month: portless" src="https://img.shields.io/npm/dm/portless.svg?style=for-the-badge&amp;labelColor=000000&amp;label=npm%20downloads" height="28"></a>
  <a href="https://skills.sh/vercel-labs/portless"><img alt="skills.sh" src="https://skills.sh/b/vercel-labs/portless?style=for-the-badge" height="28"></a>
</p>

```diff
- "dev": "next dev"                  # http://localhost:3000
+ "dev": "portless run next dev"     # https://myapp.localhost
```

portless runs a local reverse proxy and gives each dev server a name. Your app listens on a free port that portless assigns, and you open `https://<name>.localhost` instead of remembering which port it took. The URL stays the same across restarts, so bookmarks, cookies, OAuth redirects, and an agent's test script keep pointing at the right app.

## Install

```bash
npm install -g portless
```

To pin the version per project, install it as a dev dependency with `npm install -D portless`. portless is pre-1.0, so contributors may run different versions, and a change to the state directory format between releases can require running `portless trust` again.

## Quick start

From a project with a `"dev"` script in `package.json`:

```bash
portless
# -> runs "dev", https://<project>.localhost
```

The name comes from `package.json`, the git root, or the directory. Pass a name and a command to choose both:

```bash
portless myapp next dev
# -> https://myapp.localhost
```

- The proxy starts on the first run. It serves HTTPS with HTTP/2 on port 443, so the first run creates a local certificate authority, adds it to the system trust store, and may ask for `sudo`. Use `--no-tls` for plain HTTP, or `--unprivileged` to skip `sudo` ([Unprivileged mode](https://portless.sh/commands#unprivileged-mode)).
- `portless run <cmd>` infers the name and detects git worktrees. In a linked worktree, the last `/` segment of the branch becomes a subdomain, so `fix-ui.myapp.localhost` and `myapp.localhost` run side by side. Use `--prefix` or `PORTLESS_PREFIX` to set the label, or [configure the label style and hostname template](https://portless.sh/configuration#worktree-hostnames).
- A name with dots is a subdomain: `portless api.myapp pnpm start` serves `https://api.myapp.localhost`.
- `PORTLESS=0 pnpm dev` runs the command directly, without the proxy. Commands such as `portless get` and `portless list` still run normally.

The full walkthrough is in [Getting started](https://portless.sh).

## How it works

Each app gets a random port from 4000 to 4999 through the `PORT` environment variable, and registers a route from its hostname to that port. The proxy forwards `https://<name>.localhost` to the route. Most frameworks read `PORT`. For those that don't, such as Vite, Astro, Angular, Expo, and Wrangler, portless adds the matching port and host flags to the command ([Port assignment](https://portless.sh/configuration#port-assignment)).

Outside LAN mode, the proxy listens only on `127.0.0.1` and `::1`. It keeps `/etc/hosts` in sync for route hostnames, which custom TLDs such as `.test` need. If a route hostname will not resolve, the command that registered it warns and points you to `portless hosts sync`.

To reach an app from another device or share it, use [LAN mode](https://portless.sh/commands#lan-mode) for phones on the same network, or [Tailscale](https://portless.sh/commands#share-on-tailscale), [ngrok](https://portless.sh/commands#share-with-ngrok), or a [Cloudflare quick tunnel](https://portless.sh/commands#share-with-cloudflare) with `--tailscale`, `--ngrok`, or `--cloudflare`.

portless writes its own status lines to stderr, so stdout carries only your app's output. A non-empty `NO_COLOR` disables color, while `FORCE_COLOR=0` disables it and `FORCE_COLOR=1` forces it.

### Upstream aliases

Use `--upstream` to route an alias to an HTTP or HTTPS service listening on loopback:

```bash
portless alias api 8080 --upstream https
portless alias api 8080 --upstream https://api.internal
portless alias api 8080 --upstream http://api.internal
```

The positional port always dials loopback. `https` enables TLS and preserves the incoming
Host header. An `https://` authority enables TLS and overrides Host with the full
authority, including its optional port. SNI uses a DNS hostname without the port;
IP addresses are not sent as SNI. An
`http://` authority overrides Host without TLS. This setting does not
change client-facing proxy TLS. Authorities accept only a hostname or IP address with an
optional port, without credentials, paths, queries, fragments, or whitespace.

`portless list --json` includes each route's `upstream` object when one is set, with the
same `tls` and `host` values.

Upstream TLS connects only to an HTTP/1.1 backend on loopback. Portless disables
certificate verification, so TLS does not authenticate backend identity, even through
an SSH tunnel. Restart the proxy daemon after upgrading portless.

## Configuration

An optional `portless.json` sets the name and script. In a monorepo, one file at the root covers every workspace package, and `portless` from the root starts all of them:

```json
{
  "apps": {
    "apps/web": { "name": "myapp" },
    "apps/api": { "name": "api.myapp" }
  }
}
```

A `"portless"` key in `package.json` works too. Fields, precedence, Turborepo setup, and environment variables are in [Configuration](https://portless.sh/configuration).

## For AI agents

Install the portless skill into an agent harness from [skills.sh](https://skills.sh/vercel-labs/portless):

```bash
npx skills add vercel-labs/portless
```

For MCP clients, `portless mcp` starts an MCP server over stdio. The default `core` profile lists routes, looks up URLs, and manages static aliases. `--tools all` adds proxy control and diagnostics:

```json
{ "mcpServers": { "portless": { "command": "portless", "args": ["mcp"] } } }
```

The server does not start dev servers. Agents run `portless run <cmd>` in a shell. See [MCP server](https://portless.sh/commands#mcp-server).

## Commands

Run `portless --help` for the full list, or `portless <command> --help` for one command. `--help` and `-h` print help and never run the command. After `run <cmd>`, `compose <subcommand>`, or `--`, they belong to the wrapped command, so `portless run next dev --help` passes `--help` to Next.js. Usage errors, such as an unknown flag or a missing argument, exit with code `2`; other failures exit with `1`. Wrapped commands (`run`, named apps, and `compose`) keep their own exit code. Value flags for `run`, named apps, and `service install` accept either `--flag value` or `--flag=value`. Use `portless list --json` or `portless get <name> --json` for JSON output.

| Group                | Commands                                                                              | Docs                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run apps             | `portless`, `run`, `<name> <cmd>`, `get`                                              | [Run an app](https://portless.sh/commands#run-an-app), [Get a service URL](https://portless.sh/commands#get-a-service-url)                                    |
| Static routes        | `alias`, `compose up`, `compose down`                                                 | [Alias](https://portless.sh/commands#alias-static-routes), [Docker Compose](https://portless.sh/commands#docker-compose)                                      |
| Proxy                | `proxy start`, `proxy stop`, `service install`, `service status`, `service uninstall` | [Proxy control](https://portless.sh/commands#proxy-control), [OS startup service](https://portless.sh/commands#os-startup-service)                            |
| HTTPS and DNS        | `trust`, `hosts sync`, `hosts clean`                                                  | [HTTPS](https://portless.sh/https), [Hosts](https://portless.sh/commands#hosts)                                                                               |
| Inspect and clean up | `list`, `doctor`, `prune`, `clean`                                                    | [Doctor](https://portless.sh/commands#doctor), [Prune orphans](https://portless.sh/commands#prune-orphans), [Clean up](https://portless.sh/commands#clean-up) |
| Agents               | `mcp`                                                                                 | [MCP server](https://portless.sh/commands#mcp-server)                                                                                                         |

`portless prune` removes stale routes and shares without killing unrelated port holders. A recorded process group that still has a live member keeps its route and shares even after it closes its port; prune records the member that survived and stops it on a retry with `portless prune --force`. A group prune cannot verify is kept and reported, never signaled. A port holder that cannot be proven part of the recorded group is kept and reported, never killed. Prune and clean stop recorded ngrok and cloudflared tunnels only when their executable names match, including on Windows.

Run `portless doctor` first when a URL does not load. It checks the proxy, routes, DNS, and CA trust without changing anything, and prints suggested fixes. Use `portless doctor --json` to print the report as JSON.

`portless clean` previews its cleanup and asks for confirmation. Use `portless clean --yes` (or `-y`) in CI or without a terminal. On macOS and Linux, a failed CA, state-file, or hosts step is retried with sudo for the same allowlisted targets. If the proxy cannot be confirmed stopped, its PID, port, and runtime marker files are kept. Service, CA, state-file, and hosts cleanup failures produce a nonzero exit code.

## Platforms

portless runs on macOS, Linux, and Windows with Node.js 24 or later. `--tailscale` and `--funnel` need the Tailscale CLI, `--ngrok` needs the ngrok CLI, and `--cloudflare` needs `cloudflared`.

## Development

This repo is a pnpm workspace with [Turborepo](https://turbo.build). The published package is `packages/portless/`, and the docs site is `apps/docs/`. Use Node.js 24 or later and pnpm 11:

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm type-check
pnpm format
```

[AGENTS.md](AGENTS.md) lists the files to update with each change and the release process.

## Documentation

- [portless.sh](https://portless.sh): getting started, commands, HTTPS, and configuration
- [Why portless](https://portless.sh/why): the problems named URLs solve
- [Changelog](CHANGELOG.md)

## License

Apache-2.0

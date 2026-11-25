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

To pin the version per project, install it with `npm install -D portless`, or see [Install on portless.sh](https://portless.sh#install) for the pre-1.0 note.

## Quick start

From a project with a `"dev"` script in `package.json`:

```bash
portless
# -> runs "dev", https://<project>.localhost
```

Pass arguments to the script after `--`, so `portless -- --inspect` runs `dev` with `--inspect`. Forwarding arguments into a script with shell operators or a comment exits 2; run the command directly or make the script a single command. In Turbo mode only the root script is checked, and Turbo passes the arguments to each package script unchanged.

The name comes from `package.json`, the git root, or the directory. Pass a name and a command to choose both:

```bash
portless myapp next dev
# -> https://myapp.localhost
```

- The proxy starts on the first run. It serves HTTPS with HTTP/2 on port 443, so the first run creates a local certificate authority, adds it to the system trust store, and may ask for `sudo`. Use `--no-tls` for plain HTTP, or `--unprivileged` to skip `sudo` ([Unprivileged mode](https://portless.sh/commands#unprivileged-mode)). `portless trust` is safe to run again: it exits without prompting when the CA is already trusted, and on Linux it also updates existing Chrome/Chromium NSS databases when `certutil` is installed.
- `portless run <cmd>` infers the name and detects git worktrees. In a linked worktree, the last `/` segment of the branch becomes a subdomain, so `fix-ui.myapp.localhost` and `myapp.localhost` run side by side. Use `--prefix` or `PORTLESS_PREFIX` to set the label, `--no-worktree` to skip worktree naming, or [configure the hostname layout](https://portless.sh/configuration#worktree-hostnames). Named launches keep their supplied hostname.
- A name with dots is a subdomain: `portless api.myapp pnpm start` serves `https://api.myapp.localhost`.
- `PORTLESS=0 pnpm dev` runs the command directly, without the proxy. Commands such as `portless get` and `portless list` still run normally.

The full walkthrough is in [Getting started](https://portless.sh).

## How it works

Each app gets a random port from 4000 to 4999 through the `PORT` environment variable, and registers a route from its hostname to that port. The proxy forwards `https://<name>.localhost` to the route. Most frameworks read `PORT`. For those that don't, such as Vite, Astro, Angular, Expo, and Wrangler, portless adds the matching port and host flags to the command ([Port assignment](https://portless.sh/configuration#port-assignment)). At a workspace root that uses Turbo, Turbo starts each package script itself, so read `PORT` and `HOST` in the framework config or set `"turbo": false`.

Outside LAN mode, the proxy listens only on `127.0.0.1` and `::1`. It keeps `/etc/hosts` in sync for route hostnames, which custom TLDs such as `.test` need. If a route hostname will not resolve, the command that registered it warns and points you to `portless hosts sync`.

To reach an app from another device or share it, use [LAN mode](https://portless.sh/commands#lan-mode) for phones on the same network, or [Tailscale](https://portless.sh/commands#share-on-tailscale), [ngrok](https://portless.sh/commands#share-with-ngrok), [NetBird](https://portless.sh/commands#share-with-netbird), or a [Cloudflare quick tunnel](https://portless.sh/commands#share-with-cloudflare) with `--tailscale`, `--ngrok`, `--netbird`, or `--cloudflare`. For HTTPS in LAN mode, `portless trust --device` lets a phone install the local CA from a QR code.

For Tailscale, `--tailscale-port <port>` or `PORTLESS_TAILSCALE_PORT` pins the share port and implies `--tailscale`. Serve accepts ports 1 to 65535; Funnel accepts 443, 8443, and 10000. `--tailscale-service[=<name>]` exposes `https://<service>.<tailnet>`, using the app's base name when no name is given. `PORTLESS_TAILSCALE_SERVICE=1` infers the name, a service name selects it directly, and `0` disables it. Services require MagicDNS, HTTPS, and a tag-based device identity (`--advertise-tags`), and cannot be combined with `--funnel` or `--tailscale-port`. If MagicDNS is disabled, `--tailscale` automatically serves HTTP over TCP on the node's Tailscale IP; Funnel and Services require MagicDNS.

Use `--ngrok-url <url>` or `PORTLESS_NGROK_URL` to pin a custom or static ngrok URL. Either implies `--ngrok` and passes `--url` to `ngrok http`; `PORTLESS_NGROK` remains a `0`/`1` switch.

NetBird sharing runs `netbird expose` and requires the NetBird CLI installed and connected with `netbird up`. It binds the child server to `0.0.0.0` and sets `PORTLESS_NETBIRD_URL` on the child. Use `PORTLESS_NETBIRD=1` to enable it or `0` to disable it. `--netbird-password <pw>`, `--netbird-pin <code>`, and `--netbird-groups <csv>` each imply `--netbird`; their environment equivalents are `PORTLESS_NETBIRD_PASSWORD`, `PORTLESS_NETBIRD_PIN`, and `PORTLESS_NETBIRD_GROUPS`. Portless records the tunnel PID for cleanup on exit and by `portless prune`.

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

In each project directory, portless reads `portless.json`, then `.config/portless.json`, then the `package.json` `"portless"` key, using the first available config. `apps` paths remain relative to the project directory even when the config is in `.config`. Fields, precedence, Turborepo setup, and environment variables are in [Configuration](https://portless.sh/configuration).

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

Run `portless --help` for the command list and common app options. Use `portless proxy --help` for proxy options, or `portless <command> --help` for command details. `--help` and `-h` print help and never run the command. After `run <cmd>`, `compose <subcommand>`, or `--`, they belong to the wrapped command, so `portless run next dev --help` passes `--help` to Next.js. Usage errors, such as an unknown flag, a missing argument, or a command that needs `--yes` without a terminal, exit with code `2`; other failures exit with `1`. Wrapped commands (`run`, named apps, and `compose`) keep their own exit code. Value flags for `run`, named apps, and `service install` accept either `--flag value` or `--flag=value`. Use `portless list --json` or `portless get <name> --json` for JSON output.

| Group                | Commands                                                                              | Docs                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run apps             | `portless`, `run`, `<name> <cmd>`, `get`                                              | [Run an app](https://portless.sh/commands#run-an-app), [Get a service URL](https://portless.sh/commands#get-a-service-url)                                    |
| Static routes        | `alias`, `compose up`, `compose down`                                                 | [Alias](https://portless.sh/commands#alias-static-routes), [Docker Compose](https://portless.sh/commands#docker-compose)                                      |
| Proxy                | `proxy start`, `proxy stop`, `service install`, `service status`, `service uninstall` | [Proxy control](https://portless.sh/commands#proxy-control), [OS startup service](https://portless.sh/commands#os-startup-service)                            |
| HTTPS and DNS        | `trust`, `hosts sync`, `hosts clean`                                                  | [HTTPS](https://portless.sh/https), [Hosts](https://portless.sh/commands#hosts)                                                                               |
| Inspect and clean up | `list`, `doctor`, `prune`, `clean`                                                    | [Doctor](https://portless.sh/commands#doctor), [Prune orphans](https://portless.sh/commands#prune-orphans), [Clean up](https://portless.sh/commands#clean-up) |
| Agents               | `mcp`                                                                                 | [MCP server](https://portless.sh/commands#mcp-server)                                                                                                         |

On Linux with Node under your home directory (nvm, fnm, volta, or mise), `portless service install` creates a systemd user service at `~/.config/systemd/user/portless.service` (or under `$XDG_CONFIG_HOME`) that runs as you and resolves `node` from your `PATH`. System Node, macOS LaunchDaemons, and Windows tasks keep the root or SYSTEM service and the install-time Node path, so re-run `portless service install` if that path changes.

`portless prune` removes stale routes and shares without killing unrelated port holders. A recorded process group that still has a live member keeps its route and shares even after it closes its port; prune records the member that survived and stops it on a retry with `portless prune --force`. A group prune cannot verify is kept and reported, never signaled. A port holder that cannot be proven part of the recorded group is kept and reported, never killed. Prune and clean stop recorded ngrok, cloudflared, and NetBird tunnels only when their executable names match, including on Windows.

App ports referenced by stale Tailscale Serve or Funnel records stay reserved, even after the dev server stops. Automatic assignment skips them, and fixed-port registration refuses them even with `--force`. Run `portless prune` to clean up stale shares before reusing their ports. If removing a Tailscale share fails on exit or during prune, portless keeps the stale route so prune can retry. If Tailscale share removal fails during `portless clean`, it keeps `routes.json` so `portless prune` or a later `portless clean` can retry.

Run `portless doctor` first when a URL does not load. It checks the proxy, routes, DNS, and CA trust without changing anything, and prints suggested fixes. Use `portless doctor --json` to print the report as JSON.

The proxy returns `503` when a request waits more than 30 seconds in the per-backend queue or the queue is full at 512 waiting requests. It returns `504` when the backend takes more than 120 seconds to send response headers after the request upload finishes. To distinguish these from app responses, look for `Vary: Accept` and a JSON body with `upstream` and an `error` of `service_unavailable` or `gateway_timeout`, or a portless HTML error page; app responses pass through unchanged.

`portless clean` previews its cleanup and asks for confirmation. Use `portless clean --yes` (or `-y`) in CI or without a terminal. On macOS and Linux, a failed CA, state-file, or hosts step is retried with sudo for the same allowlisted targets. If the proxy cannot be confirmed stopped, its PID, port, runtime marker files, and CA files are kept and the CA stays trusted. Service, CA, state-file, and hosts cleanup failures produce a nonzero exit code.

On macOS and Linux, `portless trust`, `portless proxy stop`, `portless prune`, `portless hosts sync`, `portless service install`, and `portless clean` act on a state directory only when no other user can change it. The directory and each of its parent directories must be owned by you or root and must not be writable by group or others. A parent with the sticky bit set, such as `/tmp`, is allowed. A symlink on the path counts only when you or root own it and it sits in a directory that passes the same check. `portless trust`, `portless proxy stop`, `portless prune`, `portless hosts sync`, and `portless service install` exit with the reason when the directory fails this check. Nothing is signaled and the hosts file is not changed. The proxy does not start from such a directory, and commands that register a route, such as `portless run` and `portless alias`, exit with the same reason. A proxy that is already running keeps the routes it has loaded and stops reloading them. portless never changes the permissions or owner of a state directory that fails it. Run `chmod go-w <dir>` on the directory it names, or point `PORTLESS_STATE_DIR` at a directory only you can write to. `portless clean` leaves such a directory alone, prints the reason, and exits nonzero. It skips a `/tmp/portless` directory that fails the check without an error. `portless proxy stop` and `portless clean` signal the recorded proxy PID only when nothing shows it is a different process from the one answering on the proxy port.

## Platforms

portless runs on macOS, Linux, and Windows with Node.js 24 or later. On Linux, `portless trust` supports Debian/Ubuntu, Arch, Fedora/RHEL/CentOS, and openSUSE; on declarative distros such as NixOS, add `ca.pem` through `security.pki.certificateFiles` or use `--no-tls`. LAN mode mDNS publishing is macOS and Linux only, so use `--tailscale`, `--ngrok`, `--cloudflare`, or `--netbird` on Windows. `--tailscale` and `--funnel` need the Tailscale CLI, `--ngrok` needs the ngrok CLI, `--cloudflare` needs `cloudflared`, and `--netbird` needs the NetBird CLI. Other UNIX platforms, such as BSD and Solaris, are unsupported for automatic CA trust and startup services.

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

## Community tools

These companion tools are maintained independently by their authors, not by Vercel.

- [portless-manager](https://github.com/SiyeolBaek/portless-manager): SwiftBar menu bar companion for macOS
- [portless-studio](https://github.com/keven-bardales/portless-studio): standalone local dashboard for active routes
- [PortlessBar](https://github.com/akshitkrnagpal/portlessbar): native macOS menu bar companion for active routes

## Documentation

- [portless.sh](https://portless.sh): getting started, commands, HTTPS, and configuration
- [Why portless](https://portless.sh/why): the problems named URLs solve
- [Changelog](CHANGELOG.md)

## License

Apache-2.0

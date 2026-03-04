# Changelog

## 0.5.2

### Documentation

- Add git worktree documentation to README, docs site, and agent skill. `portless run` automatically detects linked worktrees and prefixes the URL with the branch name (e.g. `fix-ui.myapp.localhost`).
- Document worktree support in 0.5.0 changelog entry.

## 0.5.1

### Bug Fixes

- **npm README**: Copy root `README.md` into the package at publish time so it appears on npmjs.com.
- **homepage**: Point npm homepage to https://port1355.dev.

## 0.5.0

### Features

- **`portless run` subcommand**: Automatically infer the project name from `package.json`, git root, or directory name instead of specifying it manually. In git worktrees, the branch name is prepended as a subdomain prefix (e.g. `fix-ui.myapp.localhost`) so each worktree gets a unique URL with no config changes. (#55, #68)
- **`portless alias` command**: Register routes for services not spawned by portless (e.g. Docker containers with published ports). Aliases persist across stale-route cleanup. (#73)
- **`PORTLESS_URL` env var**: Child processes now receive `PORTLESS_URL` containing the public `.localhost` URL (e.g. `http://myapp.localhost:1355`) so apps can self-reference their own URL. (#56)
- **`--app-port` flag**: Specify a fixed port for the app instead of automatic assignment. Also configurable via `PORTLESS_APP_PORT` env var. Useful when integrating with tools that provide their own port. (#72)
- **wildcard subdomain routing**: Subdomains now match registered hostnames (e.g. `tenant.myapp.localhost` matches `myapp.localhost`). Exact matches take priority over wildcard matches. (#71)
- **`/etc/hosts` sync**: Automatically sync `.localhost` hostnames to `/etc/hosts` for environments where `.localhost` does not resolve to `127.0.0.1` by default. (#74)
- **multi-distro Linux CA trust**: `portless trust` now supports Arch, Fedora/RHEL/CentOS, and openSUSE in addition to Debian/Ubuntu. Falls back to command probing when `/etc/os-release` detection fails. (#45)
- **Expo and React Native support**: Auto-inject `--port` and `--host` flags for `expo start` and `react-native start`. (#42)
- **branded error and status pages**: The proxy now renders styled HTML pages for 404, 502, 508, and other status codes instead of plain text. (#70)

### Bug Fixes

- **stream errors**: Handle proxy stream errors gracefully to prevent unhandled exceptions from crashing the proxy. (#57)

## 0.4.2

### Bug Fixes

- **spawn ENOENT**: Use `/bin/sh -c` for command execution so shell scripts and version-manager shims (nvm, fnm, mise) are resolved correctly. Prepend `node_modules/.bin` to `PATH` so local project binaries (e.g. `next`, `vite`) are found without a global install. (#21, #29)
- **sudo state directory permissions**: System state directory (`/tmp/portless`) now uses world-writable + sticky-bit permissions (`1777`) so non-root processes can register routes after a sudo proxy start. Route and state files created under sudo are chowned back to the real user. (#16)
- **duplicate route names**: `addRoute` now checks for an existing live route and throws `RouteConflictError` if the hostname is already registered by a running process. Use `--force` to override. (#38)
- **TLS SHA-1 rejection**: Force SHA-256 for all CA and server certificate generation. Detect and regenerate existing SHA-1 certificates automatically. Uses the `openssl` CLI for signature algorithm checks to maintain compatibility with Node.js < 24.9. (#36)
- **per-hostname certs for `.localhost` subdomains**: Issue a per-hostname certificate with an exact SAN for every `.localhost` subdomain (including single-level like `myapp.localhost`). `*.localhost` wildcard certs are invalid because `.localhost` is a reserved TLD per RFC 2606 section 2. (#18)
- **terminal left in raw mode**: Reset `stdin.setRawMode(false)` on process exit so the terminal is not left in raw mode after SIGINT. (#51)

### Features

- **proxy loop detection**: Detect forwarding loops (e.g. a Vite dev server proxying back through portless without `changeOrigin: true`) using the `X-Portless-Hops` header. Respond with `508 Loop Detected` and a message explaining the fix. Also detects loops on WebSocket upgrades. (#48, #52)
- **`--force` flag**: Override a route registered by another process with `portless <name> --force <cmd>`.

## 0.4.1

### Bug Fixes

- Fix Vite support and add e2e tests for 11 frameworks. (#32)

## 0.4.0

### Features

- HTTP/2 + HTTPS support with auto-generated local CA and per-hostname TLS certificates. (#10)

## 0.3.0

### Bug Fixes

- Fix proxy routing issues. (#4)

## 0.2.2

### Improvements

- Block `npx` / `pnpm dlx` usage and improve agent skill. (#1, #2)

## 0.2.1

### Bug Fixes

- Fix proxy routing issue.

## 0.2.0

### Features

- Add `--port` / `-p` flag to the proxy command.

## 0.1.0

Initial release.

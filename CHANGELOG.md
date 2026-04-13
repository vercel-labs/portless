# Changelog

## 0.10.2

<!-- release:start -->

### New Features

- **Auto-inject `NODE_EXTRA_CA_CERTS`**: Child processes spawned by `portless run` now automatically receive `NODE_EXTRA_CA_CERTS` pointing to the portless CA certificate, so Node.js subprocesses trust the local CA without manual configuration (#220)

### Bug Fixes

- **Proxy startup on slow macOS `security` command**: Fix the proxy failing to start when the macOS `security` command takes longer than expected to verify CA trust (#229)
- **Lock contention with parallel commands**: Fix lock contention that could cause failures when multiple `portless` commands run simultaneously (#230)
- **`ERR_HTTP2_PROTOCOL_ERROR` during HMR**: Fix HTTP/2 stream reset flood during hot module replacement causing protocol errors (#231)
- **Proxy auto-start in non-interactive terminals**: Fix auto-start failing in non-interactive terminals (e.g. IDE task runners) and when previous proxy config exists (#232)

### Contributors

- @ctate
<!-- release:end -->

## 0.10.1

### New Features

- **`portless clean`**: New command stops the proxy if it is running, removes the local CA from the OS trust store when it was installed by portless, deletes allowlisted files under known state directories, and removes the portless-managed block from the hosts file. Custom `--cert` and `--key` paths are never removed. (#213)

### Improvements

- **Hosts file sync by default**: The proxy now keeps the hosts file in sync with active routes automatically (improves Safari and other setups where `.localhost` subdomains do not resolve to loopback). Set `PORTLESS_SYNC_HOSTS=0` to opt out. The managed block is removed from the hosts file when the proxy exits. (#213)

### Contributors

- @ctate

## 0.10.0

### New Features

- **LAN mode**: New `--lan` flag exposes portless services to phones and other devices on the same network via mDNS `.local` hostnames. Auto-detects the active LAN IP, follows network changes, and supports `--ip` / `PORTLESS_LAN_IP` overrides for VPN or multi-interface setups. Publishes mDNS records with platform-native tools (`dns-sd` on macOS, `avahi-publish-address` on Linux). Adds `*.local` to generated certificate SANs so HTTPS works for LAN hostnames. (#168)
- **VitePlus support**: Auto-inject `--port` for VitePlus (`vp`) dev server (#147)

### Contributors

- @gabimoncha
- @carderne

## 0.9.6

### Bug Fixes

- **WebSocket proxy memory leak**: Add socket close/end handlers to prevent memory leaks in the WebSocket proxy (#208)

### Contributors

- @ctate

## 0.9.5

### Bug Fixes

- **`--force` kills existing process**: `--force` now terminates the process that owns the conflicting route before registering a new one, instead of only removing the stale route entry (#204)
- **CA certificate included in TLS chain**: The proxy now sends the CA certificate as part of the TLS chain, fixing `UNABLE_TO_VERIFY_LEAF_SIGNATURE` errors in clients that do not have the portless CA in their trust store (#203)

### Contributors

- @ctate

## 0.9.4

### Bug Fixes

- **README missing from npm package**: The published npm package now includes its README. Previously `.gitignore` excluded the copied README during packing; an `.npmignore` override fixes this. (#197)

### Contributors

- @ctate

## 0.9.3

### Breaking Changes

- **Origin/Referer header rewriting removed**: The proxy no longer rewrites `Origin` and `Referer` headers. The feature introduced in 0.9.2 caused issues with certain backend frameworks and has been removed. (#195)

### Contributors

- @ctate

## 0.9.2

### New Features

- **Origin/Referer header rewriting**: The proxy now rewrites `Origin` and `Referer` headers for portless-managed hostnames so backend CSRF protections accept proxied requests (#189)

### Bug Fixes

- **Browser-blocked ports excluded from auto-selection**: Ports that browsers refuse to connect to (e.g. 6666, 6667) are now excluded from automatic port assignment (#192)
- **State directory preserved during sudo elevation**: Fix `portless trust` losing the state directory when elevating to sudo (#187)
- **Windows OpenSSL config detection**: Auto-detect `openssl.cnf` location on Windows when `OPENSSLDIR` points to a non-existent path (#183)

### Contributors

- @ctate

## 0.9.1

### New Features

- **Project dev dependency install**: portless can now be installed as a project dev dependency (`npm install -D portless`) in addition to the global install. The `npx`/`dlx` guard now only blocks one-off downloads, not locally installed packages. (#179)

### Bug Fixes

- **`portless trust` on fresh install**: Fix `portless trust` failing on a fresh install when no CA certificate exists yet. The command now generates the CA and server certificates automatically before trusting. (#177)

### Contributors

- @ctate

## 0.9.0

### Breaking Changes

- **HTTPS on port 443 is now the default**: The proxy defaults to HTTPS on port 443 instead of HTTP on port 1355. Auto-elevates with sudo on macOS/Linux to bind privileged ports. Use `--no-tls` for plain HTTP on port 80, or `-p 1355` for the previous unprivileged port. (#172)
- **`PORTLESS_HTTPS` env var inverted**: HTTPS is on by default; set `PORTLESS_HTTPS=0` to disable (replaces the old `PORTLESS_HTTPS=1` opt-in). (#172)

### New Features

- **HTTP-to-HTTPS redirect**: When the HTTPS proxy runs on port 443, a companion HTTP server on port 80 automatically redirects all requests to HTTPS. (#172)
- **Auto-sudo for proxy lifecycle**: `portless proxy start` auto-elevates with sudo when binding privileged ports. `portless proxy stop` does the same when the running proxy is owned by root. (#172)
- **Clean URLs**: URLs are now `https://myapp.localhost` instead of `http://myapp.localhost:1355`. No port numbers to remember. (#172)

### Contributors

- @ctate

## 0.8.0

### Breaking Changes

- **Strict subdomain routing is now the default**: Subdomains no longer automatically match parent hostnames (e.g. `api.myapp.localhost` no longer routes to `myapp.localhost`). Use the `--wildcard` flag or `PORTLESS_WILDCARD=1` env var to restore the previous behavior. (#158)

### New Features

- **`--wildcard` flag**: Opt in to wildcard subdomain routing where subdomains match registered parent hostnames. Configurable via `PORTLESS_WILDCARD` env var. (#158)

### Bug Fixes

- **Cert generation with dots in `$HOME`**: Fix TLS certificate generation failing when the home directory path contains dots (#157)
- **DNS label limit for `--name` flag**: Fix regression where long `--name` values could exceed the 63-character DNS label limit (#144)
- **Windows `DEP0190` deprecation warning**: Silence Node.js deprecation warning on Windows by replacing `shell: true` with explicit `cmd.exe /d /s /c` spawning (#160)
- **Windows duplicate `PATH` entries**: Deduplicate `PATH` environment variables in child process spawn on Windows (#155)

### Improvements

- **Removed chalk dependency**: Replaced chalk with lightweight ANSI color utilities to reduce install size (#170)
- **Automated release process**: Added CI workflow for automated npm publishing and GitHub releases (#169)

### Contributors

- @ctate
- @mynameistito

## 0.7.2

### Bug Fixes

- **`--port` injection for package runners**: Fixed `--port` injection for commands run via package runners like `npx`, `pnpm dlx`, etc. (#150)
- **TLS cert generation**: Fixed TLS cert generation for long hostnames and proxy startup races (#149)
- **Proxy crash on ECONNRESET**: Handle `ECONNRESET` errors on TLS wrapper sockets to prevent proxy crash (#127)
- **Windows `node not recognized`**: Resolved `node not recognized` error on Windows when running `portless run` (#126)

### Documentation

- Added Windows to docs requirements section (#122)

### Improvements

- Added GitHub Action for automated npm publishing (#130)

## 0.7.1

### Documentation

- Updated docs site header (#118)

## 0.7.0

### Features

- **Windows support**: Full cross-platform support for Windows. Uses `os.tmpdir()` for state directory, `netstat -ano` for port detection, `shell: true` for command spawning, `certutil` for CA trust, and `windowsHide` for daemon spawn. Includes Windows CI job in GitHub Actions. (#6)

### Bug Fixes

- **`--name` sanitization in `portless run`**: Stop replacing dots with hyphens in `--name` values. Dots are valid and intentional in hostnames like `local.metaview`. The direct form and `portless get` already preserved dots; now `run --name` is consistent. (#108)
- **worktree prefix only for linked worktrees**: Only prepend the branch name for linked worktrees, not the root worktree. Previously any non-main branch got a prefix when multiple worktrees existed, even in the primary clone. (#108)
- **Windows hosts file paths**: Use platform-aware hosts file path (`C:\Windows\System32\drivers\etc\hosts` on Windows, `/etc/hosts` on Unix) and platform-appropriate error messages (Administrator vs sudo). (#113)

## 0.6.0

### Features

- **custom TLD**: Use `--tld` to set a custom TLD (e.g. `.test`) instead of `.localhost`. Configurable via `PORTLESS_TLD` env var. The proxy auto-syncs `/etc/hosts` for custom TLDs when started with sudo. Warns about risky TLDs like `.local` (mDNS/Bonjour conflicts) and `.dev` (Google-owned, HSTS). Recommended: `.test` (IANA-reserved, no collision risk). (#93)
- **`portless get` command**: Print the URL for a service, useful for wiring services together (e.g. `BACKEND_URL=$(portless get backend)`). Applies worktree prefix detection by default; use `--no-worktree` to skip it. (#88)
- **`--name` flag for `portless run`**: Override the inferred base name while preserving the worktree prefix (e.g. `portless run --name myapp next dev` in a worktree produces `fix-ui.myapp.localhost`). (#89)

### Bug Fixes

- **HTTPS proxy trust and stop on macOS with sudo**: Fix CA trust check and `proxy stop` when the proxy was started with sudo on macOS. (#98)
- **DNS label length for worktree hostnames**: Truncate worktree-prefixed hostnames to respect the 63-character DNS label limit. (#87)

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

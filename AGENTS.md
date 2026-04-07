# Agent Rules

## Package Manager

Use `pnpm` for all package management commands (not npm or yarn).

Exception: End-user install instructions should use `npm install -g` (global) or `npm install -D` (project dev dependency) since npm is universal.

## Dependencies

Always check for the latest npm version when adding dependencies. Use `pnpm add <package>` (without version) to get the latest, or verify with `npm view <package> version` first.

## No Emojis

Do not use emojis anywhere in this repository (code, comments, output, docs).

## Dashes

Never use `--` as a dash in prose, comments, or user-facing output. Use an em dash (\u2014) when a dash is needed, but prefer rephrasing to avoid dashes entirely. The only exception is CLI flags (e.g. `--port`).

## Boolean Environment Variables

Document boolean env vars using only `0` and `1` in CLI help, SKILL.md, docs pages, and README. Code accepts `true`/`false` as well (and `skip` for `PORTLESS`), but these alternatives are not documented.

## Docs Updates

When a change affects how humans or agents use portless (new/changed/removed commands, flags, behavior, or config), update all of these:

1. `README.md` (user-facing documentation)
2. `skills/portless/SKILL.md` (agent skill for using portless)
3. `packages/portless/src/cli.ts` (`--help` output)

## Releasing

Releases are manual, single-PR affairs. The maintainer controls the changelog voice and format.

To prepare a release:

1. Create a branch (e.g. `prepare-v1.2.0`)
2. Bump the version in `packages/portless/package.json`
3. Write the changelog entry in `CHANGELOG.md`, wrapped in `<!-- release:start -->` and `<!-- release:end -->` markers
4. Remove the `<!-- release:start -->` and `<!-- release:end -->` markers from the previous release entry (only the latest release should have markers)
5. Add a matching entry to `apps/docs/src/app/changelog/page.mdx`
6. Open a PR and merge to `main`

CI compares the version in `packages/portless/package.json` to what's on npm. If it differs, it builds, publishes, and creates the GitHub release automatically. The release body is extracted from the content between the markers.

## Windows Debugging

A remote Windows Server 2022 EC2 instance is available for debugging Windows-specific issues. It uses AWS Systems Manager (SSM) with no SSH or open ports. Commands run via `aws ssm send-command` and return stdout/stderr.

All scripts require `AWS_PROFILE=portless-debug` (or the profile must be set as default). Prefix every command with it or export it for the session:

```bash
export AWS_PROFILE=portless-debug
```

### Prerequisites

The instance must be provisioned first (one-time, by a human):

```bash
./scripts/windows-debug/provision.sh
```

Requires: AWS CLI v2 configured with `ec2:*`, `iam:CreateRole`, `iam:AttachRolePolicy`, `ssm:SendCommand`, `ssm:GetCommandInvocation` permissions and a default VPC.

### Usage

Start the instance (if stopped):

```bash
./scripts/windows-debug/start.sh
```

Run a command on Windows:

```bash
./scripts/windows-debug/run.sh "<powershell-command>"
```

Sync the current git branch and rebuild:

```bash
./scripts/windows-debug/sync.sh
```

Stop the instance when done (avoids cost):

```bash
./scripts/windows-debug/stop.sh
```

### Important notes

**SSM agent takes a long time to come online.** After starting or restarting the instance, the SSM agent can take 5 to 10 minutes before it accepts commands. If `run.sh` returns `InvalidInstanceId`, wait and retry. Do not assume the instance is broken; poll with increasing intervals.

**PowerShell uses `;` not `&&`.** The `run.sh` wrapper executes PowerShell, which does not support `&&` as a command separator. Use `;` instead:

```bash
./scripts/windows-debug/run.sh "cd C:\portless; pnpm test"
```

**OpenSSL may not be at the expected path.** The bootstrap installs OpenSSL to `C:\Program Files\OpenSSL-Win64\bin`, but this can fail silently. Git bundles its own OpenSSL at `C:\Program Files\Git\mingw64\bin`. If `openssl` is not found, add Git's path:

```bash
./scripts/windows-debug/run.sh '$env:PATH = "C:\Program Files\Git\mingw64\bin;$env:PATH"; openssl version'
```

**SSM runs as SYSTEM.** Commands execute as the SYSTEM account, not a normal user. This affects user-specific operations (e.g., `certutil -addstore -user Root` targets SYSTEM's trust store, not a real user's). Keep this in mind when testing user-facing features.

### Common Workflows

Run unit tests on Windows:

```bash
./scripts/windows-debug/run.sh "cd C:\portless; pnpm test"
```

Run e2e tests on Windows:

```bash
./scripts/windows-debug/run.sh "cd C:\portless; pnpm test:e2e"
```

Check bootstrap progress (first boot only):

```bash
./scripts/windows-debug/run.sh "Get-Content C:\bootstrap.log"
```

The repo lives at `C:\portless` on the instance. Node.js 20, pnpm, Git, and OpenSSL are pre-installed. The `run.sh` wrapper automatically adds these tools to PATH.

<!-- opensrc:start -->

## Source Code Reference

Source code for dependencies is available in `opensrc/` for deeper understanding of implementation details.

See `opensrc/sources.json` for the list of available packages and their versions.

Use this source code when you need to understand how a package works internally, not just its types/interface.

### Fetching Additional Source Code

To fetch source code for a package or repository you need to understand, run:

```bash
npx opensrc <package>           # npm package (e.g., npx opensrc zod)
npx opensrc pypi:<package>      # Python package (e.g., npx opensrc pypi:requests)
npx opensrc crates:<package>    # Rust crate (e.g., npx opensrc crates:serde)
npx opensrc <owner>/<repo>      # GitHub repo (e.g., npx opensrc vercel/ai)
```

<!-- opensrc:end -->

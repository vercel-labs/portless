# Agent Rules

## Package Manager

Use `pnpm` for all package management commands (not npm or yarn).

Exception: Global install instructions for end users should use `npm install -g` since it's universal.

## Dependencies

Always check for the latest npm version when adding dependencies. Use `pnpm add <package>` (without version) to get the latest, or verify with `npm view <package> version` first.

## No Emojis

Do not use emojis anywhere in this repository (code, comments, output, docs).

## Boolean Environment Variables

Document boolean env vars using only `0` and `1` in CLI help, SKILL.md, docs pages, and README. Code accepts `true`/`false` as well (and `skip` for `PORTLESS`), but these alternatives are not documented.

## Docs Updates

When a change affects how humans or agents use portless (new/changed/removed commands, flags, behavior, or config), update all of these:

1. `README.md` -- user-facing documentation
2. `skills/portless/SKILL.md` -- agent skill for using portless
3. `packages/portless/src/cli.ts` -- `--help` output

## Releasing

Releases are manual, single-PR affairs. The maintainer controls the changelog voice and format.

To prepare a release:

1. Create a branch (e.g. `prepare-v1.2.0`)
2. Bump the version in `packages/portless/package.json`
3. Write the changelog entry in `CHANGELOG.md`, wrapped in `<!-- release:start -->` and `<!-- release:end -->` markers
4. Add a matching entry to `apps/docs/src/app/changelog/page.mdx`
5. Open a PR and merge to `main`

CI compares the version in `packages/portless/package.json` to what's on npm. If it differs, it builds, publishes, and creates the GitHub release automatically. The release body is extracted from the content between the markers.

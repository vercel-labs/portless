# Agent Rules

## Package Manager

Use `pnpm` for all package management commands (not npm or yarn).

Exception: Global install instructions for end users should use `npm install -g` since it's universal.

## Dependencies

Always check for the latest npm version when adding dependencies. Use `pnpm add <package>` (without version) to get the latest, or verify with `npm view <package> version` first.

## No Emojis

Do not use emojis anywhere in this repository (code, comments, output, docs).

## Docs Updates

When a change affects how humans or agents use portless (new/changed/removed commands, flags, behavior, or config), update all of these:

1. `README.md` -- user-facing documentation
2. `skills/portless/SKILL.md` -- agent skill for using portless
3. `packages/portless/src/cli.ts` -- `--help` output

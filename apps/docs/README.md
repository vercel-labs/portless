# Portless documentation

Author the six public pages in `content/docs`. The shared content feeds Geistdocs, native search, WebMCP, Markdown, and the existing docs chat backend.

## Dependency policy

The migration checked published versions on September 17, 2026. Geistdocs 2.3.1 was the latest release, published at 14:23 UTC that day. The repository's `minimumReleaseAge: 2880` requires releases to be at least 48 hours old. pnpm selected Geistdocs 2.2.0, published September 15 at 14:53 UTC, without adding an exception or using an unreleased package.

Next.js is pinned to 16.3.4. `patches/next@16.3.4.patch` at the repository root contains only two substitutions, changing `setHeader` to `appendHeader` for Vary in the CommonJS and ESM app-page runtime templates. This preserves the documentation negotiation headers alongside Next's RSC headers without modifying global Node response prototypes. Recheck both runtime templates and production HTTP headers when upgrading Next.

## Response handling

RSC and prefetch requests bypass Markdown negotiation but retain the unprefixed language rewrite. Documentation responses use private, no-store caching, including explicit Markdown routes, with Vary covering representation-detection headers. The `/en` prefix redirects permanently to the unprefixed URL without setting a locale cookie.

## Verification

Use `pnpm --filter @portless/docs build`, `pnpm --filter @portless/docs type-check`, `pnpm --filter @portless/docs test` and `pnpm --filter @portless/docs test:routes` from the repository root. For a normal production build, leave `VERCEL_ENV` unset or set it to `production`. Preview builds retain noindex while all page and Markdown canonicals use `https://portless.sh`.

See [the regression guide](tests/README.md) for production/preview commands, frozen content baselines and server cleanup. [Verification](tests/VERIFICATION.md) records results and deployment limits. The route suite runs in Linux CI after the build.

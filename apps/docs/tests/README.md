# Docs regression verification

From the repository root:

```sh
pnpm --filter @portless/docs test
pnpm --filter @portless/docs test:routes
```

The unit suite runs separately from the Node built-in HTTP suite. No test dependencies are added. The HTTP runner requires an existing production build, starts its own `next start` process on an ephemeral `127.0.0.1` port, and terminates it after success, failure, SIGINT or SIGTERM. Requests do not follow redirects implicitly.

To build and verify production indexing explicitly:

```sh
VERCEL_ENV=production pnpm --filter @portless/docs build
VERCEL_ENV=production DOCS_EXPECT_NOINDEX=0 pnpm --filter @portless/docs test:routes
```

To verify preview indexing, build and run with matching environment values:

```sh
VERCEL_ENV=preview pnpm --filter @portless/docs build
VERCEL_ENV=preview DOCS_EXPECT_NOINDEX=1 pnpm --filter @portless/docs test:routes
```

A preview build replaces the local production build. Restore it with the production build command before running the default production assertions. `DOCS_EXPECT_NOINDEX` only changes test expectations; it does not configure Next.js or rebuild the app.

## Frozen migration baseline

`fixtures/docs-baseline.json` records commit `05d8a9a791052ae9322c24ebeafc27f596ceb4d8`. It contains the six original routes, exact metadata expectations, original MDX SHA-256 hashes, cleaned Markdown body hashes, SSR samples and heading tuples `[level, text, id]`. Tests read this fixture without invoking git or regenerating expectations from the implementation.

At this commit, `src/mdx-components.tsx` renders headings without assigning IDs, and `next.config.mjs` has no slug plugin. There is no old slugify algorithm or generated heading-ID contract to reproduce. Heading text and levels come from the original MDX, excluding fenced code blocks. The fixture freezes the migration's GitHub-style anchors, including punctuation removal and duplicate suffixes, for all 144 section headings. The six H1 titles are checked separately. Footer headings are not part of this contract.

When intentionally changing documentation, review the source and update only the affected fixture values. Do not refresh hashes just to make an unexpected content difference pass. The original MDX hash covers the file reconstructed by replacing migration frontmatter with its original H1; the Markdown hash covers the original cleaned body with its final newline. These six original pages have no import/export statements or decorative JSX divs to strip.

## HTTP details

HTML assertions inspect attributes independently of order, parse JSON-LD, and examine SSR text rather than React serialization or error stacks. Next Flight requests include `?_rsc`, avoiding Next's cache-key normalization redirect. The browser-navigation case uses `node:http` because Node fetch overwrites `Sec-Fetch-Mode`. Font discovery accepts HTML preload tags or HTTP Link preloads.

The suite covers representation negotiation, full Vary inputs, private/no-store including HEAD, canonical redirects, invalid paths, agent indexes, environment-specific indexing, body search, and asset bypass. Known contract failures remain failing assertions rather than skips or implementation workarounds.

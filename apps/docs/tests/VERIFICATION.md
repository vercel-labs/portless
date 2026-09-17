# Migration verification

Verified locally on September 17, 2026, on `feat/portless-geistdocs`, based on `05d8a9a791052ae9322c24ebeafc27f596ceb4d8`. This records pre-publication validation; no production deployment was performed.

## Final checks

All commands ran from the repository root and exited 0:

```sh
VERCEL_ENV=preview pnpm --filter @portless/docs build
VERCEL_ENV=preview DOCS_EXPECT_NOINDEX=1 pnpm --filter @portless/docs test:routes
VERCEL_ENV=production pnpm --filter @portless/docs build
VERCEL_ENV=production DOCS_EXPECT_NOINDEX=0 pnpm --filter @portless/docs test:routes
pnpm --filter @portless/docs test
pnpm --filter @portless/docs type-check
git diff --check
```

Both route runs passed 89/89 with no skips. The unit suite passed 18/18 across three files. The local build was left in production mode. The route runner closes its owned server, including when assertions fail. The Linux CI job now runs the route suite after the repository build and unit tests.

Scoped Biome formatting passed for changed TypeScript, TSX, JavaScript modules and JSON. The repository-wide CI jobs and Windows checks were not executed locally.

## Protected contract

The six existing public paths, complete MDX bodies and cleaned Markdown bodies match the frozen pre-migration baseline. HTML checks cover exact titles and descriptions, self-canonical URLs, Markdown alternates, OG/Twitter images, WebSite JSON-LD, one H1 and server-rendered content. All 144 section headings are addressable. The original renderer did not generate IDs: the fixture distinguishes historical heading text from newly frozen anchor expectations.

Negotiation tests cover HTML and Markdown Vary/cache headers, HEAD, quality preferences, social previews, Googlebot, browser navigation, RSC and prefetch. Redirect tests preserve queries without locale cookies. Sitemap, robots, agent indexes, full-body/table search, images, fonts and favicon are covered. Invalid routes return actual 404s.

## Failures found and resolved

The first route run passed 80 tests and failed nine. Malformed percent encodings (`/%` and `/%E0%A4%A`) caused 500 responses across four representations. The proxy now validates encoding before framework decoding. Native search also missed `PORTLESS_SYNC_HOSTS` in the configuration table; the supported Fumadocs structure scan now includes table cells, inline code and code blocks. All nine assertions now pass unchanged.

The old missing-Markdown unit assertion expected HTTP 200. It now requires 404, retaining canonical attribution and the readable not-found body.

A browser check found that Escape did not dismiss mobile chat when another dialog layer had prevented the default event. The chat keyboard handler now closes when Escape originates in its own mobile dialog, without closing it for a different dialog's input.

## Browser checks

`agent-browser` against the local production server confirmed native search navigation to `/configuration#environment-variables`, WebMCP table search and page reading after navigation, desktop chat open/Escape, mobile chat dismissal after the fix, and no horizontal overflow at 390px. The visible theme label switches to `dark-theme` and persists after reload. After animation frames, the launcher clears the footer theme controls by 24px. No browser errors were reported. These are manual CLI smoke checks, not an automated visual comparison or live LLM test.

## Rollout limits

Local tests do not establish unchanged rankings, deployed CDN behavior or field Core Web Vitals. Before and after deployment, run the HTTP suite against the deployment where accessible, verify HTML/Markdown in both cache-warming orders, and monitor Search Console indexing, crawl errors, impressions and clicks. Keep preview noindex enabled and confirm it is absent on production.

The existing chat backend and rate limiter are unchanged. Live model responses were not tested. GitHub CI and production deployment verification remain pending.

---
"portless": minor
---

Add `--path` flag for path-based routing. Multiple apps can share one hostname and route by URL path prefix using longest-prefix matching. Useful for local API gateways, microfrontends, monorepos, or any multi-service setup under one domain. Also available via `PORTLESS_PATH` env var.

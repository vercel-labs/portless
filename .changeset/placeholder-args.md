---
"portless": minor
---

Add `{PORT}`, `{HOST}`, and `{PORTLESS_URL}` placeholders for command args. Tools that ignore the `PORT` env var can now receive the assigned port directly via CLI flags: `portless run my-server --port {PORT}`. When placeholders are present, automatic `--port`/`--host` injection is skipped.

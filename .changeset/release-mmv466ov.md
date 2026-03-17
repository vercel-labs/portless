---
"portless-monorepo": patch
---

### Bug Fixes

- Fixed **'node not recognized'** error on Windows when running `portless run` (#126)
- Fixed **proxy crash** caused by unhandled `ECONNRESET` errors on TLS wrapper sockets (#127)

### Documentation

- Added **Windows** as a supported platform in the requirements section (#122)

### Improvements

- Added **GitHub Action** to automatically publish packages to npm on release (#130)
- Added **Changesets** configuration to support automated versioning and release workflows (#129)

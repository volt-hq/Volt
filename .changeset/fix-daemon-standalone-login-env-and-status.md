---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed a standalone binary's daemon never reading the login-shell environment, and `volt daemon status` failing for a healthy daemon whose build has no phone transport.

A daemon started from a standalone binary, including by the login service, now resolves PATH and the rest of the environment from the user's login shell like an npm install does. `volt daemon status` exits 0 when phone transport is unavailable only because the build lacks it (`native_binding_missing`: a standalone binary, an `--omit=optional` install, or Darwin x64); `volt remote status` still exits nonzero.

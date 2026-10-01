---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): `volt update` now points an installed login service at the updated installation when the daemon is not running, so the service still starts after an update moves volt. ([#556](https://github.com/volt-hq/Volt/issues/556))

The service is rewritten without starting the daemon. Previously, a pnpm global update or a renamed package left the service pointing at a removed path, and the daemon failed to start at the next login. On macOS the service is unloaded until the next login; run `volt daemon install-service` to start it sooner.

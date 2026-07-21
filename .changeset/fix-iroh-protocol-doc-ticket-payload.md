---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): The Iroh remote protocol doc now documents the actual pairing-ticket payload: `relayMode` values are `disabled`, `development`, or `production` (not `default`), tickets carry `relayUrls` and the secret-like `relayAuthToken`, and sanitized saved-host reconnect tickets strip `secret` and `relayAuthToken`. ([#51](https://github.com/volt-hq/Volt/issues/51))

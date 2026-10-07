---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

fix(remote): A pairing request that names no workspace is now refused instead of registering Volt's agent directory as a shared workspace named "voltd".

The daemon control protocol's `pair_request` now requires `workspaceName`. `volt remote pair` and `/remote` already send it.

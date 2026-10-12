---
"@hansjm10/volt-protocol": patch
"@hansjm10/volt-coding-agent": patch
---

improvement(rpc): The RPC contract declares the retry start time, prompt-cache times, worktree creation times, finding-outcome creation time, and daemon status times (paired, last seen, revoked, re-pair approved, and daemon start) as safe non-negative integer epoch milliseconds (`RpcEpochMilliseconds`) instead of unrestricted numbers. ([#842](https://github.com/volt-hq/Volt/issues/842))

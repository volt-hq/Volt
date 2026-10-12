---
"@hansjm10/volt-protocol": patch
---

improvement(rpc): The RPC contract declares review run `startedAt`, `endedAt`, `usageUpdatedAt`, and `acknowledgedAt` and the live phase's run and compaction `startedAt` as safe non-negative integer epoch milliseconds (`RpcEpochMilliseconds`) instead of unrestricted numbers. ([#316](https://github.com/volt-hq/Volt/issues/316))

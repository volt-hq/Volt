---
"@hansjm10/volt-coding-agent": patch
---

fix(subagents): A `runTimeoutMs` expiry now aborts children whose start was still in flight when the timeout fired, instead of letting them run to completion on a shared delegation scope.

---
"@hansjm10/volt-coding-agent": patch
---

fix(subagents): Bounded subagent tool detail payloads so large parallel outputs and error messages stay under remote RPC frame limits instead of disconnecting the session.

Details snapshots retain at most 100 task entries with one shared output-text budget and clamp per-task error messages; omitted entries are counted in the summary and full output stays reachable through child sessions and the registry. The parallel aggregate is also built incrementally under its byte limit instead of materializing one unbounded string.

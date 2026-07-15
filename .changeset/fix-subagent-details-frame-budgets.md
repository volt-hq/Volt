---
"@hansjm10/volt-coding-agent": patch
---

fix(subagents): Bounded subagent tool detail payloads so very large parallel runs can no longer exceed remote RPC frame limits and disconnect the session.

Details snapshots retain at most 100 task entries (non-completed prioritized) and share one fixed output-text budget; omitted entries are counted in the summary and full output stays reachable through child sessions and the registry. The parallel aggregate is also built incrementally under its byte limit instead of materializing an unbounded string.

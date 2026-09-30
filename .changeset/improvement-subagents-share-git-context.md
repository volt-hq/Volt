---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Subagents working in their parent's directory now share one Git status tracker instead of each running its own git status scans. ([#47](https://github.com/volt-hq/Volt/issues/47))

The parent session's Git status now also updates when its subagents change files. SDK hosts can share trackers the same way by passing a `GitContextProviderPool` to `createAgentSessionServices`.

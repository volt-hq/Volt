---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Fixed severe TUI slowdown with many subagents: rendered subagent rosters are cached between repaints, large rosters collapse past 16 visible rows, nested tree rendering is bounded, and progress snapshots are built only when the update throttle actually emits.

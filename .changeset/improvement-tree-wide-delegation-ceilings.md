---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Every delegation tree now shares hard root-scope ceilings in addition to per-call and per-definition limits: by default depth 5, 100 total starts, 16 concurrently active descendants, 1,000 turns, 50 million tokens, and $100 cost, with no wall-clock deadline.

SDK hosts can override each ceiling through `SubagentManagerOptions.delegationLimits`, with `Infinity` as an explicit unlimited opt-in; exhausted reservation ceilings fail new starts, and crossing a consumption ceiling cancels the whole tree.

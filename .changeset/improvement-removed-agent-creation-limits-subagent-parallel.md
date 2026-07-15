---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Removed per-call agent-creation caps: subagent parallel tasks and chain steps are no longer capped per call, and built-in subagents no longer carry depth or child-count budgets.

Delegation is instead governed by shared tree-wide ceilings on the root delegation scope: by default depth 5, 100 total starts, 16 concurrently active descendants, 1,000 turns, 50 million tokens, and $100 cost, with no wall-clock deadline. SDK hosts can override each ceiling through `SubagentManagerOptions.delegationLimits`, with `Infinity` as an explicit unlimited opt-in; crossing a consumption ceiling cancels the whole tree.

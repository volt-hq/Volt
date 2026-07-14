---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Subagent spawn requests now show the live session registry and require an exact one-time confirmation before starting new agents.

Concurrent identical requests share one tree-wide reservation, and exact duplicate agent/task pairs in a parallel request are rejected before any child starts.

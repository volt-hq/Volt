---
"@hansjm10/volt-coding-agent": patch
---

feature(subagents): Subagents can now discover every delegated run in the session and reuse results: the subagent tool gained list mode to see all runs across the tree and follow mode to return an existing run's result instead of starting a duplicate.

Delegating subagents also start with a bounded snapshot of already-recorded runs in their context, so they can reuse prior results without being told to check. Follow waits on running runs are deadlock-checked and rejected when they could never resolve.

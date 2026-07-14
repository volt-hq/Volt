---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Cut in-process subagent streaming overhead about 4-7x: parent-child RPC frames now pass as structured objects instead of being JSON-serialized and re-parsed inside the same process, removing the quadratic cost on long streaming outputs.

---
"@hansjm10/volt-coding-agent": patch
---

feature(subagents): Subagents can now discover every delegated run in the session and reuse results through bounded, paginated registry list mode and follow mode instead of starting a duplicate.

Child runtimes expose registry access through `subagent_registry`, while root sessions retain list/follow compatibility on `subagent`. Children with registry access also start with a bounded snapshot of already-recorded runs in their context. Follow waits on running runs are deadlock-checked and rejected when they could never resolve.

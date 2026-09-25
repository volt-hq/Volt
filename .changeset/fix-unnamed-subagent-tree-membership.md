---
"@hansjm10/volt-coding-agent": patch
---

fix(subagents): Definition-less SDK `start()` children now join the session tree — sharing the session-wide registry, delegation ceilings, and depth accounting — instead of acting as fresh roots, and are fail-closed for nested delegation.

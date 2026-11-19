---
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-coding-agent": patch
---

fix(agent): Reset automatic retries after successful requests so sporadic provider failures do not prematurely stop long-running goals or tool workflows.

Consecutive failures still exhaust the configured retry limit, and terminal failures still block goals until explicitly resumed.

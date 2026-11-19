---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-agent-core": patch
---

feature(extensions): Added outcome-aware continuation proposals so extensions can continue successful work without restarting after cancellation, failed recovery, or a policy stop.

The new `agent_settled` hook supports uncapped automation while prioritizing newer input and discarding proposals after extension retirement or session changes.

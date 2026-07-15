---
"@hansjm10/volt-coding-agent": patch
---

fix(subagents): Fixed completed subagent usage stats shrinking after compaction; final message, tool-call, token, and cost totals are now computed from lifetime session history instead of retained context. ([#24](https://github.com/volt-hq/Volt/issues/24))

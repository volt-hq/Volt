---
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-coding-agent": patch
---

fix(compaction): Split-turn compaction now works with providers that permit only one active request, and compacting a split turn with no new history keeps the previous summary instead of replacing it with "No prior history." ([#239](https://github.com/volt-hq/Volt/issues/239))

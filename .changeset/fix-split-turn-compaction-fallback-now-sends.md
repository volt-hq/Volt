---
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-coding-agent": patch
---

fix(compaction): Split-turn compaction fallback now sends its history and turn-prefix summary requests one at a time, so it works with providers that permit only one active request. ([#239](https://github.com/volt-hq/Volt/issues/239))

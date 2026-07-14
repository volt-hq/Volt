---
"@hansjm10/volt-coding-agent": patch
---

fix(compaction): Fixed threshold compaction repeatedly re-triggering when a conversation ended in a long run of tool results; the compaction cutoff now advances past trailing tool results, and the reported estimate matches the context actually retained for the retry. ([#25](https://github.com/hansjm10/Volt/issues/25))

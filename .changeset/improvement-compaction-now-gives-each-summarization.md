---
"@hansjm10/volt-coding-agent": patch
---

improvement(compaction): Compaction now gives each summarization request its own 10-minute deadline under a 30-minute overall limit, records per-request timing, and writes a debug record when compaction fails.

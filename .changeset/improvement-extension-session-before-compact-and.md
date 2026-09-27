---
"@hansjm10/volt-coding-agent": patch
---

improvement(extensions): Extension `session_before_compact` and `session_compact` events now include `reason` and `willRetry`, so extensions can tell manual, threshold, and overflow compaction apart. ([#239](https://github.com/volt-hq/Volt/issues/239))

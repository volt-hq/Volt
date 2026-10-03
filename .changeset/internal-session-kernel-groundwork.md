---
"@hansjm10/volt-coding-agent": patch
---

internal(sessions): Session stores accept the client input entries the conversation kernel writes (withdrawn inputs and messages the host queues), and existing stores upgrade to schema v4 on open. Compaction, retry, and turn-policy decisions move into pure session modules with no change in behavior. ([#585](https://github.com/volt-hq/Volt/issues/585))

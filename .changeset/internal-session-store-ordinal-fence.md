---
"@hansjm10/volt-coding-agent": patch
---

internal(sessions): Session store writes and deletes are fenced on the log's last entry ordinal instead of a per-transaction revision, and existing stores upgrade to schema v3 on open. ([#585](https://github.com/volt-hq/Volt/issues/585))

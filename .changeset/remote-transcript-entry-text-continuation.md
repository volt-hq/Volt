---
"@hansjm10/volt-coding-agent": patch
---

feature(remote): Long transcript entries are now fully fetchable by remote clients through the new get_transcript_entry_text continuation RPC, which pages a truncated entry's sanitized canonical text in 12,000-scalar chunks. ([#86](https://github.com/volt-hq/Volt/issues/86))

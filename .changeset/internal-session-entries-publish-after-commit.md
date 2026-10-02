---
"@hansjm10/volt-coding-agent": patch
---

internal(sessions): Session entry listeners and remote transcript commits now observe an entry only after its store transaction commits, and the session store reads committed entries incrementally by ordinal. ([#585](https://github.com/volt-hq/Volt/issues/585))

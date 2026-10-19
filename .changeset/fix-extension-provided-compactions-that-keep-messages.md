---
"@hansjm10/volt-coding-agent": patch
---

fix(compaction): Extension-provided compactions that keep messages from an invalid boundary, such as one before what the previous compaction kept or one that would keep a tool result without its call, now fail without committing instead of rebuilding a broken context.

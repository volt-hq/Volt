---
"@hansjm10/volt-coding-agent": patch
---

fix(compaction): Fixed auto-compaction failing with "Compaction summary exceeded the character limit" in long sessions: compaction now starts earlier, keeps each summary within a length budget, regenerates an oversized summary shorter, and keeps your earlier messages verbatim across repeated compactions.

A compaction whose result would not fit the context window, or would immediately trigger another automatic compaction, now fails before anything is committed and says what to change. Checkpoints list modified files before read files and shorten long file lists with a count; the complete lists stay in the compaction details.

---
"@hansjm10/volt-coding-agent": patch
---

fix(review): Review searches across a whole repository no longer fail on pages holding many large binary files; binaries are read at most once per review, skipped files no longer use up a search page, pages cover 1,000 files instead of 200, and binary skips are reported as a count.

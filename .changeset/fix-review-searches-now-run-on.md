---
"@hansjm10/volt-coding-agent": patch
---

fix(review): Review searches now run on git grep: searches across a whole repository no longer fail on trees with many large binary files, files over 8 MiB are searched, and results are paged by matches without listing skipped files.

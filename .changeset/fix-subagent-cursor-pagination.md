---
"@hansjm10/volt-coding-agent": patch
---

fix(subagents): Registry list mode now paginates newest first with an immutable registration-sequence `cursor` instead of a numeric offset, so pages never duplicate or skip runs while other runs start or finish.

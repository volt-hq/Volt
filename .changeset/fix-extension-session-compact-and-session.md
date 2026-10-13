---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Extension session_compact and session_tree handlers each get their own copy of the event, so a handler that changes compactionEntry or summaryEntry no longer changes the session's saved entry or what later handlers see. ([#853](https://github.com/volt-hq/Volt/issues/853))

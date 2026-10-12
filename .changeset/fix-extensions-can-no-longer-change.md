---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Extensions can no longer change the content, details, or display of the host's custom messages (review, work_notice, plan, and subagent recovery messages) through a message_end replacement; passing one through unchanged still works. ([#867](https://github.com/volt-hq/Volt/issues/867))

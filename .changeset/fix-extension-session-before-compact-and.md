---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Extension session_before_compact and session_before_tree handlers each get their own copy of the preparation, so a handler that returns no result no longer changes what Volt's default summary or later handlers receive. ([#849](https://github.com/volt-hq/Volt/issues/849))

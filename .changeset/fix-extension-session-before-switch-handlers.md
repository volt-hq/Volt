---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Extension session_before_switch handlers each get their own copy of the event, so a handler that changes targetSessionRef no longer changes which session Volt opens or what later handlers see. ([#852](https://github.com/volt-hq/Volt/issues/852))

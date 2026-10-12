---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Extension handlers of agent loop events such as turn_end and message_update each get their own copy of the event, so one handler's change no longer reaches later handlers, session listeners, or clients. ([#773](https://github.com/volt-hq/Volt/issues/773))

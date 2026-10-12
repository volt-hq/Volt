---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

fix(sessions): Fixed a message the host lost while sending it blocking every later message in the session: `/discard-stuck` and the `discard_client_input` intent now discard it without sending it again. ([#492](https://github.com/volt-hq/Volt/issues/492))

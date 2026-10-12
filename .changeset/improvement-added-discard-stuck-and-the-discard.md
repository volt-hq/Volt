---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(sessions): Added `/discard-stuck` and the `discard_client_input` intent to discard a message the host lost while sending it, which previously blocked every later message in the session. ([#492](https://github.com/volt-hq/Volt/issues/492))

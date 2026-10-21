---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): A phone opening a conversation in use by another client now gets a conversation_in_use rejection naming its workspace and session instead of a handshake protocol error. ([#962](https://github.com/volt-hq/Volt/issues/962))

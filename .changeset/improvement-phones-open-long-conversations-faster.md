---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(remote): Phones open long conversations faster and with about half the bytes: the host sends the newest 100 entries (older ones still load with "Load earlier"), prepares the snapshot from only those, reuses that work when the conversation is reopened or opened on another phone, and redacts workspace paths several times faster ([#935](https://github.com/volt-hq/Volt/issues/935)).

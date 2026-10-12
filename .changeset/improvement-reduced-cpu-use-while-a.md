---
"@hansjm10/volt-protocol": patch
"@hansjm10/volt-coding-agent": patch
---

improvement(daemon): Reduced CPU use while a large tool call streams: the live state no longer re-parses the call's whole argument text on every delta. ([#775](https://github.com/volt-hq/Volt/issues/775))

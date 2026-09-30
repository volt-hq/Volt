---
"@hansjm10/volt-coding-agent": patch
---

internal(extensions): Extensions loaded from a source checkout share the host's Volt package modules instead of re-evaluating them per extension, cutting load time for extensions that import @hansjm10/volt-coding-agent from ~850 ms to ~15 ms. ([#560](https://github.com/volt-hq/Volt/issues/560))

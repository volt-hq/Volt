---
"@hansjm10/volt-coding-agent": patch
---

fix(review): Review discussion intents now reject a stale branch as `stale` and a reused reset request id as `conflict`, and report other failures with their own message instead of as an unavailable review source. ([#818](https://github.com/volt-hq/Volt/issues/818))

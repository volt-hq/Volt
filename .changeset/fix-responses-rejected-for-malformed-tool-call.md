---
"@hansjm10/volt-ai": patch
"@hansjm10/volt-coding-agent": patch
---

fix(tools): Responses rejected for malformed tool-call JSON, such as literal tabs inside strings, now retry immediately with feedback explaining the rejection instead of ending the turn. ([#452](https://github.com/volt-hq/Volt/issues/452))

---
"@hansjm10/volt-ai": patch
"@hansjm10/volt-coding-agent": patch
---

fix(tools): Rejected tool calls now name unescaped control characters such as tabs, and the next request tells the model why its call was not executed without replaying the malformed arguments. ([#452](https://github.com/volt-hq/Volt/issues/452))

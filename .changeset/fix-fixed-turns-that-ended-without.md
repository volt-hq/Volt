---
"@hansjm10/volt-coding-agent": patch
---

fix: Fixed turns that ended without a reply when a model returned an empty response after a tool result; Volt now retries the request and reports an error if it stays empty. ([#1060](https://github.com/volt-hq/Volt/issues/1060))

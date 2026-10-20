---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): A phone's conversation open that the same phone's newer connection replaced, or whose conversation host exited or did not take it up in time, is now rejected as retryable, so the app retries it instead of clearing the selected agent. ([#947](https://github.com/volt-hq/Volt/issues/947))

---
"@hansjm10/volt-ai": patch
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-coding-agent": patch
---

fix(anthropic): Thinking changes, including on/off, wait for the next explicit prompt instead of taking effect during tool continuations or injected reminders; empty input no longer leaves dangling effort controls. ([#1068](https://github.com/volt-hq/Volt/issues/1068))

---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Fixed a `before_agent_start` handler that mutated `event.images` changing the images committed with the prompt and seen by later handlers. ([#609](https://github.com/volt-hq/Volt/issues/609))

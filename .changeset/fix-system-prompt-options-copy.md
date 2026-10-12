---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Fixed `before_agent_start` handlers and extension commands that mutated `systemPromptOptions` changing the skills and context files the session had loaded; each now receives a copy. ([#782](https://github.com/volt-hq/Volt/issues/782))

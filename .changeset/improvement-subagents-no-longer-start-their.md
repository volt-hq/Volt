---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Subagents no longer start their own copy of every eager and keep-alive MCP server; they connect to a server the first time they use it. ([#498](https://github.com/volt-hq/Volt/issues/498))

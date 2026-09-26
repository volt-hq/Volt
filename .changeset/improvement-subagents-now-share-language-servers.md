---
"@hansjm10/volt-coding-agent": patch
---

improvement(lsp): Subagents now share language servers with their parent session instead of starting their own. ([#47](https://github.com/volt-hq/Volt/issues/47))

`/reload` now keeps healthy language servers running when their server settings are unchanged, and `/lsp restart` also restarts the servers shared with subagents. A session that can show prompts still gets one install offer after subagents open a server's failed-start breaker.

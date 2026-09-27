---
"@hansjm10/volt-coding-agent": patch
---

improvement(lsp): Subagents now share language servers with their parent session instead of starting their own. ([#47](https://github.com/volt-hq/Volt/issues/47))

`/reload` now keeps healthy language servers running when their server settings are unchanged, and `/lsp restart` also restarts the servers shared with subagents. If subagents fail to start a missing language server, the interactive session still offers once to install it.

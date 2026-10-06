---
"@hansjm10/volt-coding-agent": patch
---

improvement(tui): The TUI draws its transcript as a client of its host, from the conversation's log, its live lane, and the presentations the host computes. ([#585](https://github.com/volt-hq/Volt/issues/585))

A tool call shows its tool's name while its arguments still stream, and how its tool presents it once it runs. Switching sessions shows the new session once it loaded, and a session that loses its log ends the TUI as before. Extension errors show as error notices without a stack trace. An extension command's `ctx.fork()` and `ctx.navigateTree()` no longer put text in the editor.

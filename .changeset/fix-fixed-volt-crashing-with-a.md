---
"@hansjm10/volt-coding-agent": patch
---

fix(sessions): Fixed Volt crashing with a bus error or reading a malformed session when another Volt process opened the same project's session store.

This affected running several Volt sessions, the daemon, or `volt lsp audit` against one project at the same time.

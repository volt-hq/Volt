---
"@hansjm10/volt-coding-agent": patch
---

improvement(extensions): Saved Jev Ahead of Model Work inputs, results, evidence selection, and admission observations in session audits accessible after reopening.

Use `/ahead history` and `/ahead audit [entry-id]` with the example extension. Audits include exported content, seal when the request ends, and mark unfinished work as interrupted. Persistent sessions use the existing SQLite store; in-memory SDK sessions remain temporary.

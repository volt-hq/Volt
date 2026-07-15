---
"@hansjm10/volt-coding-agent": patch
---

fix(tui): Discarded tool rows no longer leak subagent repaint timers; pending tool renderers are disposed at every discard site (drain-overlay truncation and finish, session re-renders, turn boundaries, and inline child-session views).

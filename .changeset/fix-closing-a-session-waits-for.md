---
"@hansjm10/volt-coding-agent": patch
---

fix(sessions): Closing a session waits for the Git status scan it stopped to exit, so Volt can remove the session's worktree right after it closes on Windows.

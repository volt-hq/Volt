---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed worktree-bound conversations failing to resume after a daemon restart with "stored session working directory is outside the authorized workspace". ([#83](https://github.com/volt-hq/Volt/issues/83))

Session rekeys (fork/new), missing-session replacements, and TUI-side rekeys now keep the durable worktree binding covering the current session id, and resume/relay resolution heals stranded bindings (including subagent sessions) from the session's stored working directory. Attach failures additionally audit the target session id.

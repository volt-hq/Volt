---
"@hansjm10/volt-coding-agent": patch
---

feature(tools): Run Bash commands and subagent tasks in the background while Volt continues independent work.

Use `background: true` on native Bash or confirmed subagent spawning calls, then use `jobs` to list, read, wait for, or cancel the work. Jobs retain bounded output and respect session cancellation, tool grants, and branch ownership. Running jobs do not survive runtime shutdown or restart.

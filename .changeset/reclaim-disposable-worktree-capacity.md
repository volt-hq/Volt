---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Reclaim safe inactive worktree checkouts before capacity is exhausted while retaining session history and exact resume placement ([#426](https://github.com/volt-hq/Volt/issues/426)).

Retention defaults to one hour and reconciles after restart. Protected work remains untouched, and PR preparation reports worktree capacity failures distinctly from GitHub or checkout failures.

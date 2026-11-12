---
"@hansjm10/volt-coding-agent": patch
---

fix(worktrees): Fixed package, config, store, and MCP commands run in a pull request review checkout reading the pull request's project settings and MCP servers instead of the workspace's. ([#1041](https://github.com/volt-hq/Volt/issues/1041))

In any daemon-managed worktree, these commands now take project trust from the workspace repository and never save a trust decision for a worktree path. An unreadable unrelated record in the daemon's state file no longer makes managed worktrees run untrusted.

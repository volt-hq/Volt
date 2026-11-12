---
"@hansjm10/volt-coding-agent": patch
---

fix(worktrees): Fixed a terminal, print, JSON, or RPC conversation in a pull request review checkout loading the pull request's project settings, extensions, and MCP servers instead of the workspace's. ([#1041](https://github.com/volt-hq/Volt/issues/1041))

Project trust for a daemon-managed worktree now follows the daemon's record of it, which also fixes workspaces that are themselves Git worktrees, submodules, or separate-git-dir clones. A managed checkout the daemon has no record of is trusted only while nothing in it needs trust, and `--approve` does not apply to it.

---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Made managed worktrees visible and removable across primary and linked checkouts of the same Git repository within a workspace.

Worktree creation keeps the selected source checkout's default branch or commit, even when the primary checkout is outside the workspace.

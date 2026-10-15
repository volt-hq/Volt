---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

fix(extensions): Subagents an extension starts now close their conversation when the run ends in daemon-hosted conversations too, and ctx.worktrees can remove a worktree and create one on an existing branch, so an extension can free checkouts it is done with.

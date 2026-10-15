---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Prevented worktree operations from targeting the enclosing repository when a conversation runs in a nested repository inside a managed checkout.

The worktree example now checks checkout availability and explains how to handle archived worktrees without reusing a missing checkout or its reserved id.

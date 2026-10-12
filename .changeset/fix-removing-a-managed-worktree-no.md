---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Removing a managed worktree no longer fails once 32 removed checkouts fill the recovery folder: the oldest ones that were clean are deleted to make room.

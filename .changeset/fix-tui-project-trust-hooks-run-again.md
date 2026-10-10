---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(tui): Keys you are typing when the project trust prompt or an extension's confirmation appears no longer answer it.

The trust prompt lists its "Do not trust" answers first, a hook's confirmation lists "No" first, and letters do not move the selection. A decision for this session only applies to the same terminal's later conversations of that project, never to another terminal's. Dismissing the prompt leaves that conversation untrusted and saves nothing; quitting before you answer opens nothing. A managed worktree whose own checkout holds project resources is asked about even when its parent checkout holds none.

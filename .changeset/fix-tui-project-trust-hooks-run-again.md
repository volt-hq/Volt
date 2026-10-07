---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

fix(tui): `project_trust` extension hooks run again for interactive sessions.

The conversation's worker decides its project trust as Volt did before conversations moved into the daemon: user/global and `-e` extensions' `project_trust` hooks first, then the saved decision, then `defaultProjectTrust`, then the trust prompt, which shows in the TUI along with any hook's dialog. The TUI reads its display settings with the trust the worker decided. A decision for this session only applies to the same TUI's later conversations of that project, never to another terminal's. Dismissing the prompt leaves that conversation untrusted and saves nothing; quitting before you answer opens nothing. Because these questions can appear while you type, keys typed as one appears do not answer it: the trust prompt lists its "Do not trust" answers first, a hook's confirmation lists "No" first, and letters do not move the selection. A managed worktree whose own checkout holds project resources is asked about even when its parent checkout holds none. `--approve` and `--no-approve` still decide the startup project without asking.

---
"@hansjm10/volt-coding-agent": minor
---

breaking(sessions): Stored the sessions of every working directory in one default session store.

Every working directory's sessions are now in one store, `~/.volt/agent/sessions/sessions.sqlite` (under `VOLT_CODING_AGENT_DIR` when set). Custom session directories (`--session-dir`, `VOLT_CODING_AGENT_SESSION_DIR`, the `sessionDir` setting) keep their own store.

Migration: sessions in the per-directory stores of earlier versions, `~/.volt/agent/sessions/--<directory>--/sessions.sqlite`, are not moved, read, or deleted. Open one with `volt -r --session-dir ~/.volt/agent/sessions/--<directory>--`; opening it upgrades that store to the new schema.

The current folder in `volt -c`, `volt -r`, `/resume`, and `SessionManager.list`, `search`, and `findContinuation` is exactly the directory Volt runs in, by its real path: a subdirectory's or a worktree checkout's sessions are listed under All. `--session-id` with the ID of another directory's session is refused instead of opening it.

SDK: `getDefaultSessionDir(agentDir?)` and `getDefaultSessionDirPath(agentDir?)` no longer take a cwd and return `<agentDir>/sessions`; `listAll()` and `searchAll()` read that one store.

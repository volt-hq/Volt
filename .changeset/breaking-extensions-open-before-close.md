---
"@hansjm10/volt-coding-agent": minor
---

breaking(extensions): `/new`, `/resume`, `/fork`, `/clone`, `/import`, and the matching extension and RPC actions now open the next session before the current one closes, so a session that fails to open (locked by another process, missing cwd) leaves you in the current session instead of exiting the TUI. ([#585](https://github.com/volt-hq/Volt/issues/585))

The new session's extension instance receives `session_start` before the old instance receives `session_shutdown`, and the old instance's `session_shutdown` handlers no longer reach the client's UI. A session that fails to open receives no `session_shutdown`. `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` reject inside a subagent's conversation.

Migration: keep extension state per instance, not in module-level variables shared between the old and new instance; the two briefly coexist. Do not rely on `session_shutdown` running before the next `session_start`, or on showing UI from a `session_shutdown` that moves to another session. SDK hosts drop `runWithStableSession()`, `runSessionInterruption()`, `trackClientInputAdmission()`, `waitForSessionOperations()`, and `isSessionOperationInProgress` from `AgentSessionRuntime` calls: commands act on `runtime.session` directly, `runtime.whileOpen(operation)` keeps the current session open until an operation that disposal must wait for settles, and a session change refuses to leave a session that is running a turn, a bash command, a session mutation, or a detached review.

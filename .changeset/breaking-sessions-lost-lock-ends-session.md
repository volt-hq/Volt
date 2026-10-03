---
"@hansjm10/volt-coding-agent": minor
---

breaking(sessions): A session whose saved state can no longer be confirmed now always ends with an error instead of being reconciled and reloaded, and `volt --mode rpc` reports that error and exits with code 1 without a stack trace.

Volt finds out that a session lost its write lock when a commit cannot be confirmed: another writer appended, the session was deleted, or the commit's outcome could not be resolved. To continue, reopen the session with `/resume` (or `--session`); it resumes from what was saved. Extensions observe the end through the aborted `ctx.signal` of their commands and then receive `session_shutdown` as usual; session writes after the loss throw. SDK code replaces `SessionManager.getConversationAuthorityStatus()`, `subscribeConversationAuthorityChanges()`, `assertConversationAuthorityAvailable()`, and `retireConversationAuthority()` with the `lost` promise on `SessionManager`, `AgentSession`, and `AgentSessionRuntime`, and replaces `drainPersistence()` with `closePersistence()`, which no longer rejects for a lost log. `SessionConversationStateUnavailableError` and `SessionAtomicAppendError.authority` are removed.

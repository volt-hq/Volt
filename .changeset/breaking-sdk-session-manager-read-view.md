---
"@hansjm10/volt-coding-agent": minor
---

breaking(sdk): `SessionManager` is now the session catalog and a read view of one session, and sessions are written through a `SessionWriter`.

The write methods moved off `SessionManager`. Before a session opens, write through `sessionManager.logWriter` (`appendMessage`, `appendCustomEntry`, `appendCustomMessageEntry`, `appendModelChange`, `appendThinkingLevelChange`, `appendFastModeChange`, `appendPlanningState`, `appendSessionInfo`, `appendLabelChange`, `appendSubagentSpawn`, `recordStartingGitContext`, `recordPrReviewBinding`, `appendCompaction`, `branch`, `resetLeaf`, `branchWithSummary`). While an `AgentSession` is open, write through `session.sessionWriter`; the log writer refuses writes while a session holds the log. Code that runs in either phase takes the `SessionWriter` interface, whose `sessionManager` is the view it writes. The model, thinking level, Fast mode, plan, name, and label writes resolve to `void`; read the entry they appended from `getLeafId()`. `recordStartingGitContext(gitContext)` no longer takes a session id.

Extension `ctx.newSession({ setup })` now passes `setup` an async `SessionWriter` for the new session instead of its `SessionManager`; read the new session through `writer.sessionManager`.

A `SessionManager` holds one session for its whole life: `newSession()` and `createBranchedSession()` are removed. Create a session with `SessionManager.create(cwd, sessionDir, options)` or `SessionManager.inMemory(cwd, options)` (which now takes `id`, `parentSession`, and `origin`), and copy one branch of a session into a new one with `SessionManager.createBranched(source, leafId)`.

`buildSessionContext` (the function and the method) and `SessionContext` are removed in favor of the conversation fold. `sessionManager.getConversationState()` returns the fold of the session's log: its `context` holds `messages`, `model`, `thinkingLevel`, and `fastMode` (now a boolean), and its `planning` is `null` until the branch commits a plan state. For log entries outside a session, use `fold` and `buildContext` from `@hansjm10/volt-agent-core`. `prepareCompaction(pathEntries, messages, settings, context)` now takes the branch's context messages, and a subagent spawn record carries the `writer` its durable edge commits through.

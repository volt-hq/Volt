---
"@hansjm10/volt-coding-agent": minor
---

breaking(sdk): `AgentSession` drops the members only the TUI used, and `ExtensionRunner` and `ModelCycleResult` are no longer exported. ([#585](https://github.com/volt-hq/Volt/issues/585))

To migrate: `executeBash(command, onChunk, options)` becomes `runUserBash(command, { excludeFromContext, operations })` (extensions see `user_bash` first; output shows as the live `bash` value), and `recordBashResult` has no replacement beyond `runUserBash` with the operations that produce the result. `getSteeringMessages()`, `getFollowUpMessages()`, and `getQueuedWorkNotices()` are replaced by the `queue_update` event or `clientInputRecovery(sessionManager.getConversationState())`. `cycleModel()` and `cycleThinkingLevel()` are replaced by the `models` query's `cycleScope` and `setModel(model, { source: "cycle" })` or `setThinkingLevel(level)`; `toggleAgentMode()` by `setAgentMode(mode)`. `getUserMessagesForForking()` and `getLastAssistantText()` are replaced by reading `sessionManager.getEntries()` and `messages`. `InteractiveMode`'s `options.settingsScope` says where the TUI reads its display settings before its client connects.

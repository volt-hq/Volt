---
"@hansjm10/volt-agent-core": minor
---

breaking(agent): Removed agent-core's built-in compaction, JSONL and in-memory session storage, skill and prompt-template loading, `NodeExecutionEnv` and the `./node` entry point, `AgentState`, and the unused `AgentHarness` prompt, queue, resource, and tree APIs. ([#585](https://github.com/volt-hq/Volt/issues/585))

Drive runs with `harness.runReserved(harness.reserveRun(), message)` instead of `run()`, `runPrompt()`, `prompt()`, `skill()`, or `promptFromTemplate()`. Queue input with `queueSteer()` and `queueFollowUp()` and revoke it with `revokeAllQueues()`. Supply a `Session` backed by your own `SessionStorage`, set tools with `setTools(tools, activeToolNames)`, resolve credentials in your `streamFn` instead of `getApiKeyAndHeaders`, change request options with `setStreamOptions()` instead of a `before_provider_request` hook, and run summarization through `runCompactionOperation()`, `requestCompaction()`, or `requestTreeOperation()`. The `systemPrompt` option is now a string or a function of the operation's `AbortSignal`. Coding Agent provides its own compaction, storage, skills, and prompt templates.

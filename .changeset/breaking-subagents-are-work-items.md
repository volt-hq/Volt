---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
"@hansjm10/volt-agent-core": minor
---

breaking(subagents): Subagents are now work items kept in the conversation that started them: a subagent running when Volt stops is suspended instead of lost, and resumes only when asked. ([#585](https://github.com/volt-hq/Volt/issues/585))

Each child is recorded as `subagent` work before its first prompt, and its final report stays readable after a restart. A suspended subagent costs nothing until it is resumed with the subagent tool's `{ resume: "<id>" }` mode or `resume_work`, which reopens its conversation and lets it finish its task; the first turn after a restart lists suspended subagents to the model. Stopping a turn no longer stops a subagent started outside a tool call; `cancel_work` does. Subagent statuses use work terms: `aborted` is now `cancelled`, and a list shows `suspended` and `interrupted` runs.

Protocol clients start a subagent with `start_subagent{agent, prompt}` (answering `{workId, conversation}`) instead of `subagent_start`, stop it with `cancel_work{workId}` instead of `subagent_abort`, and follow it through the live `work/<workId>` value instead of `subagent/<id>`; `subagent_dispose` is gone, since a subagent's conversation closes with its work. A subagent outlives the connection that started it, not its conversation. A client may read only the child conversations its conversation links by subagent work (`work_started.child.conversation`); paired devices may neither start, cancel, nor resume subagents. Logs no longer hold `subagent_spawn` entries, and `@hansjm10/volt-protocol` no longer exports `SubagentSpawnEntryPayloadSchema` or `LiveSubagentValueSchema`.

SDK callers: a `SubagentManager` passed as `subagentToolManager` belongs to that one session. `SessionWriter.appendSubagentSpawn`, `SessionManager.getSubagentSpawnEntries`, and the `spawnRecord` start option are removed (pass `toolCallId` instead); `SubagentActivityStatus`, `SubagentRegistryStatus`, `SubagentToolStatus`, and `SubagentToolOverallStatus` are replaced by `SubagentRunStatus`, and `resumeDelegation` takes no `allowedTools` (a resumed child gets the session's tool policy).

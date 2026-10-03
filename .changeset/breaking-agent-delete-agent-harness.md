---
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(agent): Removed `AgentHarness` and its `Session` storage; the `Conversation` kernel is agent-core's only stateful runtime. ([#585](https://github.com/volt-hq/Volt/issues/585))

Open a conversation over a log with `await Conversation.open({ log, stream, resolveModel, tools, systemPrompt, policy })` instead of constructing `AgentHarness` with a `Session`. Use `InMemoryConversationLog` or implement `ConversationLog`; the log replaces `SessionStorage`, and its ordinals replace projection cursors, guards, and mutation receipts. Submit input with `prompt`, `steer`, and `followUp` and await the admission's `completion` instead of `reserveRun()`/`runReserved()`; delivery owners are gone because the conversation commits each delivery itself. Harness event handlers become `ConversationPolicy` hooks (`transformContext`, `beforeProviderPayload`, `afterProviderResponse`, `beforeToolCall`, `afterToolCall`, `messageEnd`, `prepareDelivery`, `nextAction`, `requestBoundary`, `retry`, `compaction`), and `subscribe` delivers `ConversationEvent`s.

Removed exports: `AgentHarness`, `AgentHarnessError`, `AgentHarnessOptions`, `AgentHarnessEvent`, `AgentHarnessStreamOptions` (use `ConversationStreamOptions`), `AgentHarnessNextActionPolicy` (use `ConversationPolicy["nextAction"]`), the other `AgentHarness*` types, the harness event types (`QueueUpdateEvent`, `ToolCallEvent`, `ToolResultEvent`, and the rest), `Session`, `SessionStorage` and its snapshot, cursor, mutation, and receipt types, `SessionError`, the `SessionTreeEntry` entry types, `buildSessionContext` and `SessionContext` (use `fold` and `buildContext`), the delivery-owner types (`AgentDeliveryOwner`, `AgentDelivery`, and their contexts and outcomes), `AgentRunResult`, `AgentRunSnapshot`, and `toError`. `AgentHarnessAdmissionGate` is now `AdmissionGate`, and suspended admission throws `ConversationError` with code `busy`.

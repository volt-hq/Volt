---
"@hansjm10/volt-ai": minor
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(ai): The AI library no longer reads `VOLT_*` environment variables, no longer carries `clientMessageId` on user messages, and no longer applies the conversation replay policy inside providers; callers apply the new `applyReplayPolicy(messages)` before each request.

Volt itself reads `VOLT_CODEX_REQUEST_DIAGNOSTICS` and `VOLT_OAUTH_CALLBACK_HOST` from the process environment as before, and takes prompt cache retention from the `promptCache.retention` setting. Direct users of `@hansjm10/volt-ai` pass `cacheRetention: "long"` (default `"short"`), `requestDiagnostics: true` for OpenAI Codex request fingerprints, and `callbackHost` in OAuth login options instead. `resolvePromptCacheRetention(model, cacheRetention, options)` no longer takes an `env` argument.

`UserMessage` and `UserMessageSchema` no longer have `clientMessageId`. Volt stores a client input identity on the session entry beside the message (`{"type":"message","message":{...},"clientMessageId":"..."}`) instead of inside it; existing session files are not migrated. Transcript projections are unchanged.

Providers now send the messages they are given. Apply `applyReplayPolicy(messages)` (drops errored and aborted turns with their tool results, explains rejected tool calls, synthesizes missing tool results) to the history before calling `stream`, `complete`, `streamSimple`, `completeSimple`, or `refreshPromptCache`; `agentLoop` and `AgentHarness` in `@hansjm10/volt-agent-core` apply it for you. `onPayload` no longer receives `ProviderPayloadMetadata`, and `toolResultMessageIndices` is removed: Volt marks background-job results collected when they are in the replayed context of a request whose payload hook left the payload unchanged and whose response completed successfully.

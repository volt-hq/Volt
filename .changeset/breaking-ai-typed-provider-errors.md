---
"@hansjm10/volt-ai": minor
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(ai): Failed assistant messages now carry a typed `error` (`{ kind, retryable, providerCode?, message }`) instead of `errorMessage`, and Volt decides automatic retries and context-overflow compaction from that error rather than by matching error text.

`kind` is one of `rate_limit`, `overloaded`, `server`, `network`, `timeout` (retryable), or `quota`, `auth`, `invalid_request`, `context_overflow`, `refusal`, `invalid_tool_call`, `stream_limit`, `aborted`, `unknown`. Providers set it from HTTP status codes and provider error types, so quota and billing limits are never retried and a provider's own wording no longer changes the decision.

To migrate, read `message.error?.message` where you read `message.errorMessage`, and check `message.error?.retryable` or `message.error?.kind` instead of matching its text. Custom providers report failures through the stream runner (`createProviderStream`): throw `ProviderStreamError(kind, message)` or supply `mapError`; error fragments pushed into `AssistantStreamNormalizer` take `error: ProviderError` instead of `errorMessage`, and `fauxAssistantMessage` takes `error` instead of `errorMessage`. Session files and the RPC contract store the assistant message's `error` object (`RpcProviderError`) in place of `errorMessage`; the agent proxy protocol's `error` event carries `error` as well. An extension that rewrote `errorMessage` in `message_end` to trigger compaction should set `error.kind` to `"context_overflow"` instead.

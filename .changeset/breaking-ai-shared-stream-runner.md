---
"@hansjm10/volt-ai": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(ai): Every built-in provider now streams through one shared runner with one retry policy: `maxRetries` (default 0) retries only rate-limit, overload, server, network, and timeout failures, and only before a response starts streaming.

Each retry waits the server-requested delay, or 1s doubling per attempt, capped at `maxRetryDelayMs`; a server-requested delay above the cap fails immediately. Provider SDKs no longer retry on their own, so Amazon Bedrock no longer makes its two built-in SDK retries: set `maxRetries` (in Volt, `retry.provider.maxRetries`) to retry at the provider level. OpenAI Codex no longer retries quota, authentication, or other rejected requests. An aborted request now always reports "Request was aborted", and a stream emits its `start` event once the provider accepts the request.

Custom providers can implement only request building and fragment parsing: pass a `StreamProvider` definition to `createProviderStream`, which owns the event stream, abort mapping, retries, and the terminal event.

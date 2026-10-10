---
"@hansjm10/volt-coding-agent": minor
---

breaking(sdk): The steering and follow-up queue is read from the session log's client inputs, so every queued entry names the client input it delivers.

`queue_update` session events list `{ clientMessageId, text }`: `queueEntryId` is removed, and input sent without a `clientMessageId` carries the `local-` identity the session gave it instead of a `local-queue:` identity. The queue limit counts every queued input, extension messages included.

`SessionManager.getClientInputRecoveryPlan()` and `getRecoverableQueuedClientInputs()` are removed. Use `clientInputRecovery(sessionManager.getConversationState())` from `@hansjm10/volt-agent-core`; its `records` are the recoverable queued inputs.

A `client_input_outcome` session event reports the outcome of identified input that was queued, including input queued before a restart.

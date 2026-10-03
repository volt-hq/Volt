---
"@hansjm10/volt-coding-agent": minor
---

breaking(sdk): The steering and follow-up queue is read from the session log's client inputs, so every queued entry names the client input it delivers.

`getSteeringMessages()`, `getFollowUpMessages()`, and `queue_update` events list `{ clientMessageId, text }`: `queueEntryId` is removed, and input sent without a `clientMessageId` carries the `local-` identity the session gave it, which RPC clients now also receive in `queue_update`, `steeringQueue`, and `followUpQueue` instead of a `local-queue:` identity. The queue limit counts every queued input, extension messages included.

`SessionManager.getClientInputRecoveryPlan()` and `getRecoverableQueuedClientInputs()` are removed. Use `clientInputRecovery(sessionManager.getConversationState())` from `@hansjm10/volt-agent-core`; its `records` are the recoverable queued inputs.

A client learns through `client_input_outcome` the outcome of identified input it was told was queued, including input queued before a restart. An input whose prompt was interrupted before it was queued no longer reports one when a finding discussion fails it on restart; resubmitting it reports the failure.

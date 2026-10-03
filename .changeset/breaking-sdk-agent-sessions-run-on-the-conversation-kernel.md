---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-agent-core": minor
---

breaking(sdk): Agent sessions now run on the conversation kernel over their session log, so `AgentSession.create` is async, the model, thinking level, and Fast mode come from the log, and queued input survives restarts.

Create sessions with `await AgentSession.create(config)`; the constructor is private. A configured model or thinking level the branch does not name is committed as a `model_change` or `thinking_level_change` entry when the session opens, and `setModel`, `setThinkingLevel`, and `setFastModeEnabled` commit entries; read the current values from the session instead of keeping your own copy. A resumed session whose model has no credentials commits its fallback model.

Every prompt, steer, follow-up, and extension message is a durable client input. Queued input is recovered after a restart, `clearQueue()` settles it as `withdrawn` (clients still receive `client_input_outcome` with reason `queue_cleared`), and input sent without a `clientMessageId` gets a local identity. A steer or follow-up sent while the session is idle starts a turn instead of waiting for the next prompt. A prompt whose delivery transaction rolls back now fails instead of staying queued, and a turn policy that stops a turn before its first request withdraws the prompt that turn would have delivered.

While a session is open, its `SessionManager` writes go through the session and are refused after `dispose()`. `appendCompaction`, `branch`, `resetLeaf`, and `branchWithSummary` are refused on a live session; use `session.compact()` and `session.navigateTree()`. The client-input and delivery writers `reserveClientInput`, `markClientInputQueued`, `transitionClientInput`, `rollbackClientInput`, `commitCanonicalCommand`, `issueCanonicalProjection`, `commitDelivery`, `retainDelivery`, `terminalizeDelivery`, `attestDeliveryNoEffect`, and `verifyDeliveryReceipt` are removed; the session records client inputs itself. In agent-core, a next-action policy now sees `pause` as the default action when a turn would compact between requests and may request instead, a turn that a tool batch stopped still compacts past the threshold, and a retry whose loop fails ends with `success: false`.

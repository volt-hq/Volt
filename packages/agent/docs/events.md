# Conversation events

A `Conversation` publishes one ordered stream of `ConversationEvent`s. Listeners observe it; they cannot change the conversation.

```ts
const unsubscribe = conversation.subscribe(async (event) => {
  if (event.type === "committed") await projection.apply(event.entries);
});
```

## Delivery

- Events reach listeners in publication order. Each event is delivered to every listener, one listener at a time, and the next event waits until the previous one's listeners settle; async listeners are awaited.
- A listener that throws or rejects is ignored for that event.
- Commit, then publish. `committed` is published only after its batch is durable in the log and folded, so a message's `committed` event always precedes its `message_end`.
- The turn waits for each loop event to reach every listener before it continues. Slow listeners slow the turn.
- Loop events are copied for each listener. Other events share their payloads: committed entries are frozen, and `queue_changed` carries a copy taken at publication.

`conversation.state` advances when a batch is folded, before its `committed` event is delivered. A projection that must stay consistent with the event stream should advance from `committed` events, not read `state` from a listener.

## Events

| Event | Fields | Published when |
|---|---|---|
| `committed` | `entries`, `ordinal` | A batch reached the log and the fold; `ordinal` is its newest entry. Host entries are included. |
| Loop events | an `AgentEvent` plus `basedOn` | The agent loop emitted it. `basedOn` is the ordinal of the log position it builds on. |
| `phase_changed` | `phase` | The operation or activity counts changed. |
| `queue_changed` | `queue` | Pending deliveries changed: input queued, delivered, returned, withdrawn, or settled. |
| `next_action_resolved` | `action`, `requestAuthority`, `stopReason?` | A dispatch decision resolved, after `nextAction`. |
| `retry_start` | `attempt`, `delayMs`, `error` | A failed request will be retried after `delayMs`. |
| `retry_end` | `attempt`, `success`, `error?` | A sequence of retries ended: the retried request succeeded, failed without another retry, or was cancelled. |
| `compaction_start` | `cause` | The summarizer starts compacting (`manual`, `overflow`, or `threshold`). |
| `compaction_end` | `cause`, `status`, `error?` | Compaction ended: `compacted`, `skipped`, `aborted`, or `failed`. |
| `ended` | `reason`, `error` | The conversation was closed or its log was lost. |

### Loop events

These are the low-level loop's `AgentEvent`s:

- `agent_start`, `agent_end`: one loop invocation. A turn operation can run more than one loop (after a retry or a compaction).
- `turn_start`, `turn_end`: one assistant response and its tool results.
- `delivery_start`: a delivery committed and enters the context.
- `message_start`, `message_update`, `message_end`: `message_update` streams assistant output; `message_end` carries the committed message, after `messageEnd` policy.
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`.

### next_action_resolved

Published for each dispatch decision with the final `action` and `requestAuthority`. A `stop` carries `stopReason`: `policy` when `nextAction` returned it, `tool` when a tool result's disposition stopped the turn, otherwise `completion`. A pause the kernel takes itself, to compact or because the operation was aborted, publishes no event.

### ended

`reason` is the `ConversationLogLossReason`: `closed` after `close()`, or `fence_conflict`, `uncertain_commit`, or `storage` when the log was lost. When it is published, pending input completions have rejected with `ConversationError("ended")`, and every later intent throws it.

## Typical prompt

For `prompt({ message })` on an idle conversation, listeners see roughly:

1. `phase_changed` (operation `turn`), then `committed` (the client input entry) and `queue_changed`.
2. `agent_start`, `next_action_resolved` (a `request`).
3. `committed` (the input's `started` state and its user message), `queue_changed`, `delivery_start`, `message_start`, `message_end`.
4. `turn_start`, `message_start`, `message_update`..., `committed` (the assistant message), `message_end`, then tool events and tool-result messages, `turn_end`.
5. `next_action_resolved` (a `stop`), `agent_end`, `phase_changed` (no operation).

The admission's `completion` resolves `completed` once that turn operation finishes.

## State and lifecycle accessors

- `state`: the fold of every committed entry (`ConversationState`).
- `phase`: `{ operation, activities, busy }`. `operation` is `turn`, `compaction`, `navigation`, `host`, or `null`; `activities` counts `bash`, `extension_command`, and `background` work started with `beginActivity`.
- `busy`: an exclusive operation is reserved or running, or an activity is counted.
- `operation`: a frozen snapshot of the active operation: `id`, `kind`, `stage`, `requestAccepted`, `signal`, and `abortSource` once an abort was accepted.
- `queue`: pending deliveries in admission order, as `prompt`, `steer`, and `followUp` message lists.
- `model`: the model the active branch names, resolved; `undefined` when unset or unknown.
- `waitForIdle()`: resolves when no exclusive operation runs and the events published before it were delivered.
- `waitForNotBusy()`: the same, counting activities too.
- `ended`: resolves once with `{ reason, error }`.

An accepted `abort(source)` records `source` on the operation and adds a `runtime_abort` diagnostic naming it to the aborted assistant message.

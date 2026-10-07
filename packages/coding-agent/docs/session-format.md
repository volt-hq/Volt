# Session Format

A Volt session is one conversation log: an ordered, append-only list of entries. Messages, model and thinking changes, plan state, labels, branch moves, queued input, lineage, and long-running work are all entries. Persisted sessions live in one SQLite store per session directory; JSONL is only an interchange snapshot format that Volt imports once and never reopens as live storage.

This reference describes the entries, how they form a tree, how the store keeps them, and the snapshot format. For using sessions, see [Sessions](sessions.md). For what protocol clients receive, see [RPC mode](rpc.md#subscriptions).

## The Conversation Log

Everything that happens in a conversation is recorded as an entry. The session's own identity (its ID, generation, cwd, creation time, parent, and origin) lives beside the log, in its [session row](#store-layout) and [snapshot header](#snapshot-header). An entry has an envelope and a type-specific payload:

| Field | Meaning |
|-------|---------|
| `ordinal` | Position in the log: an integer, contiguous per session, starting at 1. Assigned when the entry commits. |
| `id` | Entry identity, unique within the session: an opaque, NUL-free string of 1 to 512 characters. |
| `parentId` | The entry's parent in the tree, or `null` for a root. |
| `type` | The entry type (see [Entry Types](#entry-types)). |
| `timestamp` | When the entry was written: canonical ISO-8601 UTC, exactly as `Date.prototype.toISOString()` writes it. |
| `visibility` | `public` or `host`, fixed per entry type. |
| `payload` | The type-specific fields. |

### Log Form and Stored Form

An entry has two equivalent JSON forms:

- **Log form**: the envelope above, with the type's fields in `payload`. The conversation kernel (`@hansjm10/volt-agent-core`) reads and writes this form. `@hansjm10/volt-protocol/entries` defines it and the core entry types, and the protocol contract artifact ([`protocol-schema.json`](../../protocol/contract/protocol-schema.json)) publishes their schemas as `LogEntry.<type>` and `LogEntryPayload.<type>`.
- **Stored form**: the envelope fields beside the payload fields, without `visibility`, which follows from `type`. The SQLite store, `SessionManager`, the extension APIs, and JSONL snapshots use this form, and so does the rest of this reference.

The same `model_change` entry in both forms:

```json
{"ordinal":4,"id":"d4e5f6a7","parentId":"c3d4e5f6","type":"model_change","timestamp":"2026-10-06T12:00:04.000Z","visibility":"public","payload":{"provider":"openai","modelId":"gpt-5"}}
{"type":"model_change","id":"d4e5f6a7","parentId":"c3d4e5f6","timestamp":"2026-10-06T12:00:04.000Z","ordinal":4,"provider":"openai","modelId":"gpt-5"}
```

A `message` entry's `clientMessageId` is an envelope field in both forms: it sits beside `payload` in the log form and beside `message` in the stored form.

### Ordinals and Commits

- **The ordinal is the only position.** There is no separate revision, cursor, or epoch. Readers page the log by ordinal, and protocol clients resume by it.
- **Atomic, fenced batches.** A writer appends one batch at a time and names the ordinal it expects the log to be at (`expectedOrdinal`). The batch commits whole or not at all. Each batch carries a commit ID: retrying a commit ID with the same entries returns the original result instead of appending again.
- **Lost logs.** When the log is not at `expectedOrdinal` (another writer appended), the session no longer exists, or a commit's outcome cannot be resolved, the writer's log is lost and its session stops; see [Sessions](sessions.md#when-a-session-stops).
- **Commit, then publish.** An entry reaches readers, listeners, and clients only after its batch commits. A batch that rolls back leaves the log unchanged.
- **One writer.** A host takes the session's exclusive lock before it opens the log for writing (see [Locking](#locking)).
- **Admission.** A write validates and clones each complete entry, against its type's schema and the entries before it, before the batch commits. A rejected entry leaves the log, the store, and the active branch unchanged.

### Visibility

`public` entries are conversation nodes. Each becomes the active leaf when it is appended, and together they form the tree that branch navigation, model context, the transcript, forks, and snapshots read. A public entry's parent is always a public entry, or `null`.

`host` entries are host records. They never become the leaf (a `leaf` entry moves it), never enter model context or the transcript, and are never copied into forks, clones, imports, or snapshots (a snapshot ends with a `leaf` entry of its own). A host entry's `parentId` is the leaf it was written under, or `null` before the first conversation entry.

Protocol subscriptions project the core host types (client input, `leaf`, `forked_from`, and work entries), redacted by profile, so a client can fold the queue, the branch, lineage, and work ([RPC](rpc.md#entries-and-positions)). The coding-agent product types are never projected.

### Canonical JSON Data

Every admitted entry must round-trip through JSON without type or value loss. Accepted data is `null`, booleans, strings, finite numbers other than negative zero, dense arrays, and ordinary plain objects whose own properties are enumerable string-keyed data properties. Optional properties are omitted when absent.

Volt rejects explicit `undefined`, non-finite numbers, negative zero, bigint, symbols, functions, cycles, sparse arrays, accessors, symbol-keyed or non-enumerable properties, custom or null prototypes, and rich objects such as `Map`, `Set`, `Date`, `Error`, `RegExp`, `Buffer`, typed arrays, `ArrayBuffer`, and `SharedArrayBuffer`. Encode rich values as plain JSON, for example dates as ISO strings and maps as arrays of entries.

## Entry Types

Core types are defined by `@hansjm10/volt-protocol` and folded by the conversation kernel. Product types are defined by coding-agent ([`session-entry-types.ts`](../src/core/session-entry-types.ts)); the kernel indexes them in the tree by their envelope and carries them through without reading them. Type strings are part of the format, and a product type never reuses a core type string.

| Type | Visibility | Defined by | Purpose |
|------|------------|------------|---------|
| `message` | public | core | A conversation message |
| `model_change` | public | core | Model selection |
| `thinking_level_change` | public | core | Thinking level |
| `fast_mode_change` | public | core | Fast mode |
| `planning_state_change` | public | core | Plan mode snapshot |
| `compaction` | public | core | Summary of earlier context |
| `branch_summary` | public | core | Summary of a branch left behind |
| `custom` | public | core | Extension or host state outside model context |
| `custom_message` | public | core | Extension or host message inside model context |
| `label` | public | core | Bookmark on an entry |
| `session_info` | public | core | Display name |
| `leaf` | host | core | Active-leaf move |
| `forked_from` | host | core | [Lineage](#lineage) of a forked, cloned, or imported session |
| `client_input_receipt`, `client_input_queued`, `client_input_state` | host | core | [Client input](#client-input) and the delivery queue |
| `work_started`, `work_checkpoint`, `work_finished` | host | core | [Long-running work](#work-entries-host-only) |
| `session_start_git_context` | host | coding-agent | [First Git observation](#starting-git-context) |
| `pr_review_binding` | host | coding-agent | [PR checkout](#pr-review-binding) a review session is bound to |
| `review_general`, `review_alias`, `review_discussion`, `review_discussion_reset`, `review_discussion_link` | host | coding-agent | [Review state](#review-state-entries-host-only) across sessions |

Every entry type is closed: a property the type does not define is rejected. The examples below use short IDs, abbreviated content, and illustrative ordinals; each block stands alone unless it says otherwise.

## Conversation Entries

### message

| Field | Type | Notes |
|-------|------|-------|
| `message` | message | A `user`, `assistant`, `toolResult`, `bashExecution`, or `custom` message (see [Message Types](#message-types)). |
| `clientMessageId` | string, optional | Envelope field. Only on a `user` message a client submitted; the entry completes that [client input](#client-input). Snapshots omit it. |

```json
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-10-06T12:00:01.000Z","ordinal":1,"message":{"role":"user","content":"Hello","timestamp":1791288001000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2026-10-06T12:00:02.000Z","ordinal":2,"message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":12,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"input":0.000036,"output":0.000045,"cacheRead":0,"cacheWrite":0,"total":0.000081}},"stopReason":"stop","timestamp":1791288002000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2026-10-06T12:00:03.000Z","ordinal":3,"message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1791288003000}}
```

The conversation kernel commits the custom messages it delivers as `custom_message` entries; a `message` entry holding a `custom` message is also valid and enters context the same way. `branchSummary` and `compactionSummary` messages are never stored: the fold derives them from `branch_summary` and `compaction` entries.

### model_change

| Field | Type | Notes |
|-------|------|-------|
| `provider` | non-empty string | |
| `modelId` | non-empty string | |

The model of a branch is its latest `model_change` or assistant message. Before a session's conversation opens, the host commits the configured model and thinking level when the branch names different ones.

### thinking_level_change

| Field | Type | Notes |
|-------|------|-------|
| `thinkingLevel` | string | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. A branch without one is `off`. |

### fast_mode_change

| Field | Type | Notes |
|-------|------|-------|
| `enabled` | boolean | Branch-local inference-speed policy, independent of the thinking level. Eligible OpenAI requests run with Priority processing while it is on. A branch without one is off. |

### planning_state_change

| Field | Type | Notes |
|-------|------|-------|
| `planning` | object | A complete Plan mode snapshot `{mode, plan}`: `mode` is `build` or `plan`, and `plan` is the plan state or `null`. Stored in canonical form. |

The latest snapshot on the branch is the session's plan state. A session with a plan state is listed even before its first message.

```json
{"type":"planning_state_change","id":"e5f6a7b8","parentId":"c3d4e5f6","timestamp":"2026-10-06T12:00:05.000Z","ordinal":5,"planning":{"mode":"plan","plan":null}}
```

### compaction

| Field | Type | Notes |
|-------|------|-------|
| `summary` | string | Summary of the context before `firstKeptEntryId`. |
| `firstKeptEntryId` | entry ID | An ancestor of the compaction entry: the oldest entry still sent as-is. |
| `tokensBefore` | number, at least 0 | Context size before compaction. |
| `details` | JSON, optional | Producer data. Built-in compaction stores `{readFiles, modifiedFiles, requests?}`; see [Compaction](compaction.md#compactionentry-structure). |
| `fromHook` | boolean, optional | `true` when an extension produced the summary. |

```json
{"type":"compaction","id":"f6a7b8c9","parentId":"e5f6a7b8","timestamp":"2026-10-06T12:10:00.000Z","ordinal":9,"summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

### branch_summary

| Field | Type | Notes |
|-------|------|-------|
| `fromId` | entry ID | Equals the entry's `parentId`, or `"root"` for a summary at the top of the tree. |
| `summary` | string | Summary of the branch left behind. An empty summary contributes nothing to context. |
| `details` | JSON, optional | Producer data. Built-in summarization stores `{readFiles, modifiedFiles}`. |
| `fromHook` | boolean, optional | `true` when an extension produced the summary. |

`/tree` writes one when it leaves a branch with a summary: the leaf moves to the target and the summary is appended as the target's child in the same commit.

```json
{"type":"branch_summary","id":"a7b8c9d0","parentId":"a1b2c3d4","timestamp":"2026-10-06T12:15:00.000Z","ordinal":11,"fromId":"a1b2c3d4","summary":"Branch explored approach A..."}
```

### label

| Field | Type | Notes |
|-------|------|-------|
| `targetId` | entry ID | A public entry. |
| `label` | string, optional | The target's label. Absent or empty clears it. |

The latest label entry for a target sets its label. A label entry is a public entry like any other, so it becomes the leaf.

```json
{"type":"label","id":"b8c9d0e1","parentId":"c3d4e5f6","timestamp":"2026-10-06T12:30:00.000Z","ordinal":14,"targetId":"a1b2c3d4","label":"checkpoint-1"}
```

### session_info

| Field | Type | Notes |
|-------|------|-------|
| `name` | string, optional | The display name, trimmed. Absent or blank clears it. |

Set with `/name`, `--name` / `-n`, or `volt.setSessionName()` in extensions. The session selector shows the name instead of the first message.

```json
{"type":"session_info","id":"c9d0e1f2","parentId":"b8c9d0e1","timestamp":"2026-10-06T12:35:00.000Z","ordinal":15,"name":"Refactor auth module"}
```

`custom` and `custom_message` are described under [Extension Entries](#extension-entries).

## Branching and the Tree

Public entries form a tree through `parentId`:

- A root has `parentId: null`.
- The active leaf is the current position. Each public entry becomes the leaf when it is appended. A child of the leaf extends the branch; a public entry appended under another entry starts a new branch there.
- A `leaf` entry moves the leaf without adding a node. Resetting the leaf to `null` makes the next public entry a new root, so a session can have more than one root.
- Nothing is changed or removed: every branch stays in the log.

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

### leaf

A host entry that moves the active leaf.

| Field | Type | Notes |
|-------|------|-------|
| `targetId` | entry ID or `null` | The new leaf: a public entry, or `null` for an empty conversation. |

Its `parentId` is the leaf it replaces. Navigation with `/tree`, branching, resetting the leaf, and branch summaries write one; moving to the current leaf writes nothing. A snapshot ends with exactly one leaf entry.

```json
{"type":"leaf","id":"d0e1f2a3","parentId":"c9d0e1f2","timestamp":"2026-10-06T12:40:00.000Z","ordinal":16,"targetId":"b2c3d4e5"}
```

### Context Building

The conversation kernel folds the log into the session's state: `fold(entries)` in `@hansjm10/volt-agent-core` returns a `ConversationState` with the tree, the leaf, the active branch, its model context, the plan state, labels, the name, client inputs, and work. `SessionManager.getConversationState()` returns the fold of a session's committed entries. The fold also checks the invariants it relies on: contiguous ordinals, unique IDs, existing parents (public under public), leaf and label targets, compaction and branch-summary references, and the client-input and work lifecycles.

The model context of the active branch is built from the root to the leaf:

1. The model is the latest `model_change` or assistant message on the branch; the thinking level, Fast mode, and plan state are the latest `thinking_level_change`, `fast_mode_change`, and `planning_state_change` (defaults: `off`, off, none).
2. If a `compaction` entry is on the branch, the latest one applies: its summary comes first, as a `compactionSummary` message, then the messages from `firstKeptEntryId` up to the compaction, then the messages after it.
3. `message` entries contribute their message; a client user message carries its `clientMessageId`, which conversion to provider messages drops.
4. `custom_message` entries become `custom` messages, and `branch_summary` entries become `branchSummary` messages.
5. Every other entry contributes nothing: `custom`, `label`, `session_info`, host entries, and product entries.

`buildContext(state, { convertToLlm, transformContext? })` turns that context into provider messages: it applies `transformContext`, converts the messages with `convertToLlm` (coding-agent's converts bash executions, custom messages, and summaries to user messages and drops bash executions excluded from context), and applies the replay policy of `@hansjm10/volt-ai`.

## Lineage

A session created by fork, clone, or import starts with a `forked_from` host entry, at ordinal 1 with `parentId: null`. A log holds at most one, and only there.

| Field | Type | Notes |
|-------|------|-------|
| `sessionId` | session ID | The source session: for an import, the snapshot's session ID. |
| `entryId` | entry ID or `null` | The source entry the copied branch ends at, or `null` when it is empty (a fork before the first message, or a snapshot with no active leaf). |

The copied branch follows in the same commit: the source's public entries from the root to `entryId`, keeping their IDs and timestamps, each relinked to the copied entry before it (the first to `null`), with ordinals assigned again and client input identities dropped. Label entries are not copied as such; a new `label` entry follows the branch for each copied entry that has a label. Other branches and every host entry stay in the source, so a copy carries no work items and no review state.

```json
{"type":"forked_from","id":"f0e1d2c3","parentId":null,"timestamp":"2026-10-06T13:00:00.000Z","ordinal":1,"sessionId":"019a5c3e-7f10-7c4e-9a2b-3d4e5f6a7b8c","entryId":"b2c3d4e5"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-10-06T12:00:01.000Z","ordinal":2,"message":{"role":"user","content":"Hello","timestamp":1791288001000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2026-10-06T12:00:02.000Z","ordinal":3,"message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":12,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"input":0.000036,"output":0.000045,"cacheRead":0,"cacheWrite":0,"total":0.000081}},"stopReason":"stop","timestamp":1791288002000}}
{"type":"label","id":"e1f2a3b4","parentId":"b2c3d4e5","timestamp":"2026-10-06T12:30:00.000Z","ordinal":4,"targetId":"a1b2c3d4","label":"checkpoint-1"}
```

The session never reads its source, so it stays readable after the source is deleted. A fork or clone of a persisted session also records the source as the session's parent (`SessionInfo.parentSessionRef`), so a parent can be found across stores; an import records no parent. A review finding discussion cannot be forked or cloned. `SessionManager.getForkedFrom()` returns `{ sessionId, entryId }`. For which entry each command copies to, see [Fork Lineage](sessions.md#fork-lineage).

## Client Input

Every prompt, steer, follow-up, and queued host message a session delivers is a durable client input. Three host entry types record its lifecycle, and the session's delivery queue is a fold of them.

`client_input_receipt` reserves the input when it is admitted:

| Field | Type | Notes |
|-------|------|-------|
| `clientMessageId` | string | The input's identity: `[A-Za-z0-9][A-Za-z0-9._:-]{0,255}`, not starting with `local-queue:`. One receipt per identity. |
| `command` | string | `prompt`, `steer`, or `follow_up`. |
| `semanticDigest` | string | Hex SHA-256 of the JSON of `{command, message, images, streamingBehavior?}`, each image as `{type, mimeType, data}`. A resubmission with the same identity and digest is idempotent; different input under the same identity is refused. |
| `input` | object | The exact retryable input in canonical form: `{message, images, streamingBehavior?}`, with `images` always present (at most 8) and `streamingBehavior` (`steer` or `followUp`) only on a `prompt`. |
| `origin` | `"host"`, optional | Present on input the host submitted itself (extension messages, work notices, plan checkpoints). |

`client_input_queued` records the queued delivery of an input before the queue acknowledges it. It is written while the input is `accepted` or `started`, at most once, and returns it to `accepted`:

| Field | Type | Notes |
|-------|------|-------|
| `receiptId` | entry ID | The receipt. |
| `clientMessageId` | string | The receipt's identity. |
| `queuedInput` | object | `{delivery, message, images, messages?, wake?}`. `delivery` is `steer` or `follow_up` and must match the command (a `prompt` queues by its `streamingBehavior`). Only a host input sets `messages`, the messages it delivers (its `message` and `images` are then empty), and `wake: false`, which makes it ride the next turn instead of starting one. |

`client_input_state` records a state change:

| Field | Type | Notes |
|-------|------|-------|
| `receiptId` | entry ID | The receipt. |
| `clientMessageId` | string | The receipt's identity. |
| `state` | string | See below. |
| `error` | string, optional | Present only on `failed`; at most 2,000 Unicode scalars. |

| State | Meaning |
|-------|---------|
| `accepted` | Admitted, not yet dispatched. |
| `started` | Dispatch started. |
| `completed` | The input was delivered. A `message` entry with the input's `clientMessageId` implies it; a host input that delivers its queued messages records it explicitly. |
| `failed` | The input will not be delivered; `error` explains why. |
| `withdrawn` | A queued input was taken back before dispatch (clearing the queue, restoring it to the editor, or a withdrawn work notice). |

`accepted` moves to `started`, `completed`, `failed`, or `withdrawn`; `started` moves to `accepted`, `completed`, or `failed`. `completed`, `failed`, and `withdrawn` are terminal. A `message` entry with a `clientMessageId` requires a `started` input.

A follow-up submitted while a turn runs, then delivered (one block, in order):

```json
{"type":"client_input_receipt","id":"r1","parentId":"b2c3d4e5","timestamp":"2026-10-06T12:00:04.000Z","ordinal":3,"clientMessageId":"client-1","command":"follow_up","semanticDigest":"8e39063f3a4d8134849d18969925d366b2aade4c07975665d3c7de0ec8d98199","input":{"message":"Continue","images":[]}}
{"type":"client_input_queued","id":"q1","parentId":"b2c3d4e5","timestamp":"2026-10-06T12:00:04.000Z","ordinal":4,"receiptId":"r1","clientMessageId":"client-1","queuedInput":{"delivery":"follow_up","message":"Continue","images":[]}}
{"type":"client_input_state","id":"s1","parentId":"b2c3d4e5","timestamp":"2026-10-06T12:00:09.000Z","ordinal":5,"receiptId":"r1","clientMessageId":"client-1","state":"started"}
{"type":"message","id":"d4e5f6a7","parentId":"b2c3d4e5","timestamp":"2026-10-06T12:00:09.000Z","ordinal":6,"message":{"role":"user","content":[{"type":"text","text":"Continue"}],"timestamp":1791288009000},"clientMessageId":"client-1"}
```

When a session opens, accepted inputs with a queued delivery are replayed in admission order (the ordinal of the queued entry, or of the receipt). A `started` input with no completing message or terminal state is ambiguous: it may or may not have reached the model, so it is never replayed, and later input waits behind it until it is settled (`client_input_outcome_ambiguous`).

## Work Entries (host-only)

Long-running work of a conversation is a work item recorded by three core host entry types. Only the host writes them, through the kernel's work API: `Conversation.append` refuses them, extensions cannot write them, and they are never copied into forks, clones, imports, or snapshots. Each is a child of the current leaf and never moves it.

| Kind | Work | Delivery | Resumable | What `input` keeps |
|------|------|----------|-----------|--------------------|
| `job` | A detached bash or subagent tool call | `wake` | no | `{tool}` |
| `subagent` | A child conversation | `none` | yes | `{agent, task?}`, the task bounded |
| `review` | A review run (see [Review Runs](#review-runs)) | `none` | no | `{action, target}` |
| `host_action` | An action that waits for the user's approval, such as a language server install | `none` | no | `{action, title, commandPreview?, metadata?}` |
| `ext:<extension>/<kind>` | An extension's work (see [`volt.registerWorkKind()`](extensions.md#voltregisterworkkindname-kind)) | as registered | as registered | as registered |

`work_started` starts an item:

| Field | Type | Notes |
|-------|------|-------|
| `workId` | entry ID | Unique in the log; never named as a parent before it starts. |
| `kind` | string | A kind above. |
| `title` | string | One line, at most 200 characters, without terminal control sequences. |
| `parentWorkId` | entry ID, optional | The work that started this one: an earlier item of the same log, or, for a subagent, its parent run in the parent conversation's log. |
| `input` | JSON | The kind's input, at most 16 KiB serialized. |
| `cancellable` | boolean | Whether a client may cancel it. |
| `delivery` | string | `none`, `message`, or `wake`, copied from the kind. |
| `resume` | boolean | Whether the kind resumes after a restart, copied from the kind. |
| `state` | string | `running`, or `awaiting_approval` for work that needs approval. |
| `toolCallId` | entry ID, optional | The tool call that started the work. |
| `child` | object, optional | `{conversation, ref?}`: the conversation the work runs in; `ref`, a session reference whose `sessionId` is `conversation`, locates its persisted log. |
| `requires` | array, optional | Remote capabilities a client needs, beyond an intent's or query's own, to act on the work or read its output. |
| `remote` | object, optional | `{cancel, resume}`: whether a paired remote device may cancel or resume the work at all; it may when absent. |
| `opens` | boolean, optional | `true` when the kind opens its work's conversation (`open_work`). |

The kind's delivery, resumability, remote policy, and `opens` are copied in, so reconciliation, delivery, and what a client may do are functions of the log alone, even when the kind is no longer registered.

`work_checkpoint` records a coarse change. The payload is at most 8 KiB serialized:

| Field | Type | Notes |
|-------|------|-------|
| `workId` | entry ID | Open work. |
| `state` | string, optional | `running` (after an approval or a resume) or `cancelling` (once a cancel was requested). |
| `progress` | object, optional | `{text?, value?, max?, steps?}`: text, a determinate `value` of `max`, or steps of `{key, label, status}`. |
| `detail` | `UiNode`, optional | Kind-specific detail, such as a review's accounting. |
| `child` | object, optional | The conversation the work runs in from now on, such as a review's next pass. |

The host writes state changes and `child` moves at once, kind phases at most once every 10 seconds, and at most 256 checkpoints per item over its lifetime; later phases and fine-grained progress reach clients only through the live `work/<workId>` value.

`work_finished` ends an item:

| Field | Type | Notes |
|-------|------|-------|
| `workId` | entry ID | Open work. |
| `outcome` | string | `completed`, `failed`, `cancelled`, or `interrupted` (its executor was lost: the runtime ended, or the conversation closed while it ran). |
| `result` | object, optional | `{summary?, output?, child?, data?}`: a summary of at most 2,000 characters, the output's newest 50 KiB as `{text, truncated}`, a conversation the work seeded as `{conversation}`, and kind data of at most 64 KiB serialized. |
| `error` | string, optional | At most 2,000 characters. |

```json
{"type":"work_started","id":"w1a2b3c4","parentId":"c3d4e5f6","timestamp":"2026-10-06T12:01:00.000Z","ordinal":20,"workId":"7f3c1a2e-0000-4000-8000-000000000001","kind":"job","title":"npm test","input":{"tool":"bash"},"cancellable":true,"delivery":"wake","resume":false,"state":"running","toolCallId":"call_1"}
{"type":"work_checkpoint","id":"w5d6e7f8","parentId":"c3d4e5f6","timestamp":"2026-10-06T12:01:10.000Z","ordinal":24,"workId":"7f3c1a2e-0000-4000-8000-000000000001","progress":{"text":"Running tests"}}
```

**Lifecycle.** The fold checks it: a work ID starts once; a checkpoint or finish names open work; `awaiting_approval` moves to `running` or `cancelling`, `running` to `cancelling`, and nothing moves back (a checkpoint may repeat the current state); a finished item never changes.

**Reconciliation.** When a host opens a conversation, before `session_start` and before recovered input runs, the open work the previous runtime left ends `interrupted` in one batch, except open work of a resumable kind (`resume: true`, subagents), which stays open and suspended until a client resumes it (`resume_work`) or cancels it (`cancel_work`). A resumable item whose in-log parent is finished or interrupted ends with it.

**Delivery.** A completed or failed item of a `message` or `wake` kind commits, in the same batch as its `work_finished`, a host client input (`client_input_receipt` with `origin: "host"` and command `steer`, then `client_input_queued`) that delivers a `work_notice` custom message. Its details are `{workId, kind, title, outcome, summary?, error?, child?, output?: {truncated}}`; its text is the line naming the work, followed by the summary and error or by the executor's own text. A `wake` notice starts a turn when the conversation is idle; a `message` notice (`queuedInput.wake: false`) rides the next turn. No notice is queued when the executor already handed the result to its reader, when the turn that started the work was stopped (its notices still queued are withdrawn), or while 16 host inputs are already queued. Cancelled and interrupted work delivers nothing.

```json
{"type":"work_finished","id":"w9x8y7z6","parentId":"c3d4e5f6","timestamp":"2026-10-06T12:01:30.000Z","ordinal":31,"workId":"7f3c1a2e-0000-4000-8000-000000000001","outcome":"completed","result":{"output":{"text":"PASS 40 tests\n","truncated":false}}}
{"type":"client_input_receipt","id":"n1r2c3p4","parentId":"c3d4e5f6","timestamp":"2026-10-06T12:01:30.000Z","ordinal":32,"clientMessageId":"0b6f2a1e-5d3c-4e7a-9f1b-2c3d4e5f6a7b","command":"steer","semanticDigest":"39318cb6eebba3bbea506081833da8c830ce0048617258ddb7219fce62c22c7b","input":{"message":"","images":[]},"origin":"host"}
{"type":"client_input_queued","id":"n5q6u7e8","parentId":"c3d4e5f6","timestamp":"2026-10-06T12:01:30.000Z","ordinal":33,"receiptId":"n1r2c3p4","clientMessageId":"0b6f2a1e-5d3c-4e7a-9f1b-2c3d4e5f6a7b","queuedInput":{"delivery":"steer","message":"","images":[],"messages":[{"role":"custom","customType":"work_notice","content":"npm test (job 7f3c1a2e-0000-4000-8000-000000000001) completed.","display":true,"details":{"workId":"7f3c1a2e-0000-4000-8000-000000000001","kind":"job","title":"npm test","outcome":"completed","output":{"truncated":false}},"timestamp":1791288090000}]}}
```

## Extension Entries

Extensions and the host keep their own data in two core entry types, identified by `customType`.

`custom` stores state that never enters model context. Extensions write it with [`volt.appendEntry()`](extensions.md#voltappendentrycustomtype-data) and read it back on reload by scanning entries for their `customType`.

| Field | Type | Notes |
|-------|------|-------|
| `customType` | non-empty string | The producer's identifier. |
| `data` | JSON, optional | The producer's data. |

```json
{"type":"custom","id":"f2a3b4c5","parentId":"c9d0e1f2","timestamp":"2026-10-06T12:20:00.000Z","ordinal":12,"customType":"my-extension","data":{"count":42}}
```

`custom_message` stores a message that enters model context as user content. Extensions write it with [`volt.sendMessage()`](extensions.md#voltsendmessagemessage-options).

| Field | Type | Notes |
|-------|------|-------|
| `customType` | non-empty string | The producer's identifier. |
| `content` | string or array | A string, or text and image blocks, as in a user message. |
| `display` | boolean | `true` shows it in the transcript, `false` hides it. |
| `details` | JSON, optional | Producer metadata, never sent to the model. |

```json
{"type":"custom_message","id":"a3b4c5d6","parentId":"f2a3b4c5","timestamp":"2026-10-06T12:25:00.000Z","ordinal":13,"customType":"my-extension","content":"Injected context...","display":true}
```

Both are public entries, so forks, clones, and snapshots copy them. The custom message types the host presents as its own are reserved: extensions cannot send `work_notice`, `review`, `subagent_recovery`, `volt-plan-checkpoint`, or `volt-plan-execution` messages. Volt itself writes `custom` entries of these types: `volt.review.run`, `volt.review.acknowledgment`, `volt.review.finding-transition`, and `volt.review.publication` (see [Review Runs](#review-runs)), and `prompt_cache_refresh`. The `volt.review.` entry types are reserved too: `volt.appendEntry()` and the writer a `ctx.newSession({ setup })` callback gets reject them, since later reviews, publishing, and the findings handoff trust those records. Forks, clones, and imports still copy them.

## Product Entries

coding-agent defines these host entry types. Only the host writes them, they are never projected to clients, and they are never copied into forks, clones, imports, or snapshots.

### Starting Git Context

`session_start_git_context` records a new session's first definitive path-free Git observation. Only the manager that created the session records it, at most once. Transient Git failures record nothing, so a later successful observation may still do so.

| Field | Type | Notes |
|-------|------|-------|
| `gitContext` | object or `null` | The bounded Git context RPC uses (repository name, head, upstream and base comparisons, status counts, operation), or `null` when the cwd was definitively not a Git worktree. |

```json
{"type":"session_start_git_context","id":"l2m3n4o5","parentId":null,"timestamp":"2026-10-06T12:00:00.000Z","ordinal":1,"gitContext":{"repository":"Volt","head":{"kind":"branch","name":"feature/work","oid":"0123456789abcdef0123456789abcdef01234567"},"upstream":null,"base":null,"status":{"staged":{"added":0,"modified":0,"deleted":0,"renamed":0},"unstaged":{"added":0,"modified":0,"deleted":0,"renamed":0},"untracked":0,"conflicted":0,"total":0,"clean":true},"operation":null,"revision":1,"observedAt":"2026-10-06T12:00:00.000Z","stale":false}}
```

Session listings and state responses expose the value as optional `startingGitContext`.

### PR Review Binding

`pr_review_binding` records the immutable PR checkout a review session is bound to. Its one field, `placement`, names the workspace and its generation, the worktree, the session `cwd` (which must be the session's), the source checkout and repository directory, the GitHub pull request (URL, number, title, repository, head ref and commit), and the canonical repository identities and remote. A log holds at most one: recording the same placement again is a no-op, and a different one is refused.

### Review Runs

A review is `review` work; its `workId` is its run ID. It runs detached from the conversation's turns, at most three at once, and an abort of the conversation's run does not cancel it. While it runs, its accounting so far is its work item's `detail`, checkpointed once per pass, and each pass's conversation is the item's `child`.

When a run ends, the source appends a `volt.review.run` custom entry (schema version 1, at most 512 KiB): the run's ID, action, status (`completed`, `incomplete`, `failed`, or `cancelled`), start and end times, target and file identities, options, parsed findings or error, and finalized accounting. The accounting keeps, per pass, phase, and attempt, the provider and model, requested and effective service tiers, request and turn counts, token components, and model-priced USD estimates; observations still pending or incomplete stay partial or unavailable. A run that was running when its runtime stopped ends `interrupted` as work and records no run entry.

Other custom entries record what happens to a run afterwards: `volt.review.acknowledgment`, `volt.review.finding-transition` (a finding's status: `open`, `accepted`, `fixed`, `dismissed`, or `uncertain`), and `volt.review.publication` (a review published to the pull request). Volt reads review runs from the active branch. Because these are public `custom` entries, a fork, clone, or import copies those on the copied branch, and the copy is a local report: it is linked to neither the source review's General nor its finding discussions.

### Review State Entries (host-only)

A review run belongs to the session that ran it, its source: the `work_started` of its `review` work anchors the run there. The rest of a run's cross-session state is these product entries. Each names sessions by exact identity (`{sessionId, sessionGeneration}`):

| Type | Written in | Fields | Meaning |
|------|------------|--------|---------|
| `review_alias` | A handoff target (a new session that carries the run, such as a review fix or a plan execution) | `runId`, `source` | This session carries run `runId` of `source`. |
| `review_general` | The source | `runId`, `general` | The run's General discussion moved to `general`. The latest one is current; until the first, the source is the General. |
| `review_discussion` | The source | `discussionId`, `runId`, `findingId`, `contextSnapshot`, `child`, `requestId`, `kickoffClientMessageId` | A finding's discussion and its first child session. `contextSnapshot` is the finding's immutable context, at most 64 KiB of JSON. |
| `review_discussion_reset` | The source | `discussionId`, `child`, `requestId`, `kickoffClientMessageId` | The discussion was reset to a new child, which becomes its current child. |
| `review_discussion_link` | A discussion child, as its first entry (ordinal 1, `parentId: null`) | `discussionId`, `runId`, `findingId`, `source`, `contextSnapshot` | This session is that finding's discussion. A child stays linked after a reset or after its source is deleted. |

```json
{"type":"review_discussion","id":"r1s2t3u4","parentId":"c3d4e5f6","timestamp":"2026-10-06T14:00:00.000Z","ordinal":42,"discussionId":"d-uuid","runId":"run-uuid","findingId":"f1","contextSnapshot":{"finding":{"id":"f1","title":"Unchecked input"}},"child":{"sessionId":"child-uuid","sessionGeneration":"generation-uuid"},"requestId":"request-1","kickoffClientMessageId":"kickoff-uuid"}
```

When it commits these entries, the store maintains two derived indexes: `review_run_index` (each run's source and current General) and `review_discussion_index` (each discussion child its source records). It refuses an entry that does not fit the other logs: a second session anchoring a run, a General or discussion recorded outside the run's source, a General outside the source's cwd or that is a discussion child, an alias or link naming a session that does not anchor the run or naming its own session, a second discussion of a finding, a reset by a session other than the source, a repeated reset request, or a child already used. The indexes answer cross-session lookups and grant nothing by themselves; the host builds each write of review entries from that log's committed review state (`recordReviewState`). An index row leaves with the session it derives from.

## Storage

### Store Location

Default storage is organized by workspace:

```text
~/.volt/agent/sessions/--<encoded-workspace>--/sessions.sqlite
```

The workspace directory name is the resolved cwd without its leading separator, with `/`, `\`, and `:` replaced by `-`. `VOLT_CODING_AGENT_DIR` moves `~/.volt/agent`. A directory passed through `--session-dir`, `VOLT_CODING_AGENT_SESSION_DIR`, or the SDK instead contains its own `sessions.sqlite`.

A session directory holds:

| Path | Contents |
|------|----------|
| `sessions.sqlite` | The store. SQLite may keep active `sessions.sqlite-wal` and `sessions.sqlite-shm` sidecars beside it; treat all three files as one live store. |
| `locks/` | Per-session writer locks (see [Locking](#locking)). |
| `deleted-session-snapshots/` | Recovery snapshots of deleted sessions that no `trash` command took. |

The directory is owner-only (`0700`), and the database and its sidecars are owner-readable and -writable only (`0600`); symlinked and hard-linked store files are refused. The store runs in WAL mode with full synchronous commits and foreign keys on; Volt reaches it through a worker thread, and every session of the directory shares it.

Listing, exact-ID resolution, continuation candidate selection, and RPC session discovery use materialized summaries rather than scanning entries or JSONL. Listing the default directory of a workspace includes every session in it, worktree-bound sessions with another cwd among them; a custom directory's cwd filter compares canonical filesystem identities, so symlink and junction aliases match the same workspace. A session is listed once it has a message or a plan state; a hidden session with pending input can still be continued. Tree loading opens and verifies one selected session. Deep search scans extracted searchable text (user and assistant text, and displayed custom messages) one session at a time; it is not a full-text index.

### Store Layout

The layout is informational, not an interface: read sessions through `SessionManager` or an exported snapshot, never by querying `sessions.sqlite`.

| Table | Contents |
|-------|----------|
| `store_metadata` | The schema ID, schema digest, schema version, store ID, and creation time. |
| `sessions` | One row per session: ID, immutable generation, entry format version (5), cwd, creation and update times, parent locator, origin, starting Git context, name, visibility, leaf, message count, and first message. |
| `entries` | Every entry of every session: session ID, entry ID, ordinal (unique per session), parent ID, type, timestamp, host-only flag, and the complete stored entry as canonical JSON. |
| `client_inputs` | One row per client input with its current lifecycle state. |
| `search_chunks` | The searchable text of each entry that has any. |
| `transaction_commits` | Each committed batch's commit ID, payload digest, and ordinal range, which make commits idempotent. |
| `review_run_index`, `review_discussion_index` | The [review indexes](#review-state-entries-host-only). |

`entries` is the log. Each commit writes the `sessions` row, `client_inputs`, and `search_chunks` projections in the same transaction, and every load replays the entries and refuses a session whose projections do not match.

A `SessionReference` names a session as `{sessionDirectory, storeId, sessionId, sessionGeneration}`. The store ID keeps a session ID from being opened against the wrong database, and the generation keeps a reference from reaching a different session that later reused the ID.

### Locking

A host takes an exclusive OS lock on `<session dir>/locks/<sha256(session id)>.lock` before it opens a session's log for writing, and holds it until it closes the log; the operating system releases it if the process exits. Taking the lock never waits, a second acquisition is refused even within the holding process, and lock files are never unlinked. A session that is already open elsewhere fails with `ConversationLockedError` (`code: "conversation_locked"`). Where the native lock addon is unavailable, no persisted log can be opened for writing.

Listing, searching, read-only opens, exports, and forks from a stored session take no lock. Deleting a session takes its lock briefly. The lock gives no loss signal: a writer that is no longer the only one is detected at commit time by the ordinal fence.

### Store Version and Upgrade

The SQLite schema is v5 (`PRAGMA user_version`); entries are format version 5. New stores initialize at v5 directly. Before opening an existing store with this version, stop older Volt CLI and daemon processes that use it; do not run old and new versions against the same live store.

The first open upgrades only an exact v1, v2, v3, or v4 schema, in one serialized transaction. It preserves the store ID, session IDs and generations, entries, parent references, and client inputs. Upgrading from v1 or v2 removes the per-session store revision and its revision-keyed commit records; the log ordinal replaces them. Upgrading from v2, v3, or v4 drops the earlier review tables without carrying their rows anywhere: a review run from before v5 stays readable as an unanchored report, and the v5 review indexes start empty. Concurrent opens converge on the same upgrade, and a failed upgrade rolls back.

Unknown versions, altered schema objects, invalid metadata, and failed integrity checks are rejected without repair or deletion. Older binaries cannot reopen a v5 store; downgrading the executable does not downgrade storage.

### Deleting Sessions

Delete sessions through `/resume` or `volt -r`, the `delete_session` intent, or `SessionManager.delete(ref)`. All but `SessionManager.delete` first export a JSONL recovery snapshot into `deleted-session-snapshots/` under the session directory, move it to the system trash when a `trash` command takes it, and then delete the session only if it has not moved past the snapshot's last ordinal. Deleting a session removes its entries, projections, commit records, and the review index rows it anchors.

## JSONL Snapshots

JSONL snapshots are explicit interchange:

- `SessionManager.exportJsonlSnapshot(ref, outputPath)` writes a snapshot and resolves with `{ lastOrdinal }`, the ordinal it exported through. The file is written atomically and owner-only.
- `SessionManager.importFromJsonl(path, targetCwd?, sessionDir?, options?)` imports a snapshot into SQLite as a new session. CLI path arguments to `--session` and `--fork`, and `/import`, do the same; an in-memory host imports into memory.

### Snapshot Contents

A snapshot is the header line, then every public entry of the session (all branches) with ordinals assigned again from 1, then exactly one final `leaf` entry that records the active leaf. Entries keep their IDs, parents, and timestamps. Host entries are never interchange data: client input, work, lineage, the starting Git context, PR review bindings, and review state stay with the session, and so does each message's `clientMessageId`.

```json
{"type":"session","version":5,"snapshotVersion":1,"id":"019a5c3e-7f10-7c4e-9a2b-3d4e5f6a7b8c","timestamp":"2026-10-06T12:00:00.000Z","cwd":"/path/to/project"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2026-10-06T12:00:01.000Z","ordinal":1,"message":{"role":"user","content":"Hello","timestamp":1791288001000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2026-10-06T12:00:02.000Z","ordinal":2,"message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":12,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"input":0.000036,"output":0.000045,"cacheRead":0,"cacheWrite":0,"total":0.000081}},"stopReason":"stop","timestamp":1791288002000}}
{"type":"leaf","id":"5e6f7a8b","parentId":"b2c3d4e5","timestamp":"2026-10-06T13:00:00.000Z","ordinal":3,"targetId":"b2c3d4e5"}
```

### Snapshot Header

The first line is metadata, not part of the tree: it has no `parentId` or `ordinal`.

| Field | Type | Notes |
|-------|------|-------|
| `type` | `"session"` | |
| `version` | `5` | The entry format version. |
| `snapshotVersion` | `1` | The interchange version. |
| `id` | session ID | The exported session's ID. |
| `timestamp` | string | When the session was created. |
| `cwd` | string | The session's working directory. |
| `parentSessionDirectory`, `parentStoreId`, `parentSessionId`, `parentSessionGeneration` | strings, optional | All four or none: the host-local store locator of the session's persisted parent. |
| `origin` | `"subagent"`, optional | Present on a session created for a subagent. |

`SessionManager.getHeader()` exposes the live form as `SessionHeader`, whose optional `parentSession` is a `SessionReference`; export converts it to the locator fields. Every header includes the session's `cwd`, and a parent locator can include another host path, so treat snapshots as sensitive local artifacts. Locators never cross the remote RPC surface.

### Import

Import requires the exact current header versions and rejects unmarked or older JSONL, a second header, malformed or blank lines, and a truncated final line. It reads the file as a private regular file: it tightens the file to owner-only and refuses symlinks and hard-linked files. The entries must be a valid snapshot: contiguous ordinals, valid parents and references, no host entries but the final `leaf`, and no `clientMessageId`.

The imported session gets a new ID unless `options.id` (`--session-id` with `--fork <path>`) names one. Its cwd is the snapshot's unless the caller names another (`--fork <path>` imports into the current directory). It keeps the header's `origin`; the parent locator is validated but not carried over. Its log is a [lineage](#lineage) copy of the snapshot at its active leaf: a `forked_from` entry naming the snapshot's session ID and leaf, then the snapshot's active branch, then the labels on it. Other branches of the snapshot are not imported.

### Parsing an Exported Snapshot

Parse JSONL only when consuming an explicitly exported snapshot. Do not read `sessions.sqlite` directly or treat arbitrary JSONL as session state.

```typescript
import { readFileSync } from "node:fs";

const lines = readFileSync("session-snapshot.jsonl", "utf8").trim().split("\n");

for (const line of lines) {
  const entry = JSON.parse(line);

  switch (entry.type) {
    case "session":
      console.log(`Session v${entry.version}, snapshot v${entry.snapshotVersion}: ${entry.id}`);
      break;
    case "message":
      console.log(`[${entry.ordinal}] ${entry.message.role}: ${JSON.stringify(entry.message.content)}`);
      break;
    case "compaction":
      console.log(`[${entry.ordinal}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "branch_summary":
      console.log(`[${entry.ordinal}] Branch from ${entry.fromId}`);
      break;
    case "custom":
      console.log(`[${entry.ordinal}] Custom (${entry.customType}): ${JSON.stringify(entry.data)}`);
      break;
    case "custom_message":
      console.log(`[${entry.ordinal}] Custom message (${entry.customType}): ${JSON.stringify(entry.content)}`);
      break;
    case "label":
      console.log(`[${entry.ordinal}] Label ${entry.label ? `"${entry.label}"` : "cleared"} on ${entry.targetId}`);
      break;
    case "model_change":
      console.log(`[${entry.ordinal}] Model: ${entry.provider}/${entry.modelId}`);
      break;
    case "thinking_level_change":
      console.log(`[${entry.ordinal}] Thinking: ${entry.thinkingLevel}`);
      break;
    case "leaf":
      console.log(`Active leaf: ${entry.targetId}`);
      break;
  }
}
```

## Message Types

A `message` entry contains an `AgentMessage`. These types matter for parsing sessions and writing extensions.

### Content Blocks

Messages contain arrays of typed content blocks:

```typescript
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

interface ImageContent {
  type: "image";
  data: string;      // base64 encoded
  mimeType: string;  // e.g., "image/jpeg", "image/png"
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
  thoughtSignature?: string;
}
```

### Base Message Types (from volt-ai)

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;  // Unix ms
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  error?: ProviderError; // set when stopReason is "error" or "aborted"
  timestamp: number;
}

interface ProviderError {
  kind:
    | "rate_limit" | "overloaded" | "server" | "network" | "timeout" // transient
    | "quota" | "auth" | "invalid_request" | "context_overflow" | "refusal"
    | "invalid_tool_call" | "stream_limit" | "aborted" | "unknown";
  retryable: boolean;     // repeating the identical request may succeed
  providerCode?: string;  // provider error code or type, or the HTTP status
  message: string;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: JsonValue; // Tool-specific JSON metadata
  isError: boolean;
  timestamp: number;
}

interface Usage {
  availability?: "complete" | "partial" | "unavailable";
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    priceVersion?: string;
  };
  serviceTier?: {
    requested?: "auto" | "default" | "flex" | "scale" | "priority";
    effective?: "auto" | "default" | "flex" | "scale" | "priority";
  };
}
```

### Extended Message Types

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;  // true for !! prefix commands
  timestamp: number;
}

interface CustomMessage {
  role: "custom";
  customType: string;            // Producer identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in the transcript
  details?: JsonValue;           // Producer-specific JSON metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // The branch_summary entry's fromId
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

A `message` entry stores a `user`, `assistant`, `toolResult`, `bashExecution`, or `custom` message. `BranchSummaryMessage` and `CompactionSummaryMessage` exist only in the folded context.

### AgentMessage Union

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

## SessionManager API

A `SessionManager` is the session catalog (its static methods) and the read view of one session's log. It does not write: before a session opens, `sessionManager.logWriter` writes its log; while an `AgentSession` is open, `session.sessionWriter` does, and the log writer refuses writes. Both implement `SessionWriter`. See [SDK](sdk.md) for writing sessions.

```typescript
interface SessionReference {
  readonly sessionDirectory: string;
  readonly storeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: string; // immutable incarnation; prevents stale writes after ID reuse
}
```

Use references returned by `getSessionRef()`, `SessionInfo.ref`, or another `SessionManager` API; do not construct references from IDs alone.

### Opening and Creating

Persisted factories and store queries are asynchronous. `inMemory()` remains synchronous.

- `await SessionManager.create(cwd, sessionDir?, options?)` - Create and durably reserve a persisted session. `options` takes `id`, `parentSession` (a `SessionReference`), and `origin`.
- `await SessionManager.open(ref, cwdOverride?)` - Open a session for writing. Takes the session's lock; throws `ConversationLockedError` (`code: "conversation_locked"`) while another host has it open.
- `await SessionManager.openReadOnly(ref, cwdOverride?)` - Open a session to read it. Takes no lock, so it works while the session is open elsewhere; every write throws.
- `await SessionManager.continueRecent(cwd, sessionDir?)` - Open the most recent visible or pending-input session, or create one.
- `await SessionManager.findContinuation(cwd, sessionDir?)` - Find that session's reference without opening it.
- `SessionManager.inMemory(cwd?, options?)` - Create a session without persistence.
- `await SessionManager.openInMemory(log, cwd?)` - Open an in-memory session over an existing `ConversationLog`.
- `await SessionManager.createBranched(source, leafId)` - Create a session holding the branch from the root to `leafId` of `source` (`null` for an empty branch) after its [lineage](#lineage); persisted beside a persisted source, which becomes its parent.
- `await SessionManager.forkFrom(sourceRef, targetCwd, sessionDir?, options?)` - Copy a stored session's active branch into a new persisted session after its lineage. `options` takes `id` and `origin`.
- `await SessionManager.importFromJsonl(inputPath, targetCwd?, sessionDir?, options?)` - Import one JSONL snapshot as a new session; `options.id` names it, otherwise it gets a new ID.
- `await SessionManager.exportJsonlSnapshot(ref, outputPath)` - Export one JSONL snapshot; resolves with `{ lastOrdinal }`.
- `await SessionManager.delete(ref, expectedOrdinal?)` - Delete a persisted session. Takes its lock, and refuses when the session has moved past `expectedOrdinal`.

A manager holds one session for its whole life. `await closePersistence()` waits for every write already called, then closes a persisted session's log and releases its lock.

### Summary Discovery and Deep Search

- `await SessionManager.list(cwd, sessionDir?, onProgress?, options?)` - List materialized session summaries for a workspace or custom store.
- `await SessionManager.search(cwd, query, sessionDir?, options?)` - Scan extracted searchable text for a workspace or custom store.
- `await SessionManager.listAll(...)` - List summaries across known workspace stores, or within one custom store.
- `await SessionManager.searchAll(query, sessionDir?)` - Scan extracted searchable text across known workspace stores, or within one custom store.
- `await SessionManager.findForResume(sessionDir, sessionId)` - Resolve an exact ID to a checked reference.

`options.includeMessageFreeDurable` also lists sessions that are not yet visible. `SessionInfo` includes `ref`, `id`, `cwd`, timestamps, message count, first message, optional name, optional `parentSessionRef`, optional `origin`, and optional `startingGitContext`.

### Reading the Log

Reads return committed state only. The view advances when an entry commits, before the entry reaches any listener.

- `getConversationState()` - The fold of the committed entries (see [Context Building](#context-building)).
- `getOrdinal()` - Ordinal of the newest committed entry.
- `await readEntries(afterOrdinal, limit)` - Up to `limit` (at most 1,000) committed entries after `afterOrdinal`, host entries included, with the log's `lastOrdinal`.
- `subscribeEntries(listener)` - Observe public entries in ordinal order after they commit.
- `subscribeBranchChanges(listener)` - Observe active-leaf moves after their leaf entry commits.
- `subscribeOrdinal(listener)` - Observe the log position after every committed batch, host entries included.
- `getClientInput(clientMessageId)` - One client input's record.
- `lost` - Resolves when the session's log is lost (see [Sessions](sessions.md#when-a-session-stops)).

### Tree Navigation

- `getLeafId()`, `getLeafEntry()`, `getEntry(id)`
- `getBranch(fromId?)`, `getBranchWindow(options)`, `getTree()`, `getChildren(parentId)`
- `getLabel(id)`

Tree reads return public entries only.

### Identity and Metadata

- `getEntries()` - The public entries in ordinal order.
- `getHeader()`, `getSessionName()`
- `getCwd()`, `getSessionDir()`, `getSessionId()`
- `getSessionRef()` - Current persisted reference, or `undefined` in memory.
- `isPersisted()` - Whether the session uses SQLite persistence.
- `getForkedFrom()` - The source session and entry of a forked, cloned, or imported session, or `undefined`.
- `getStartingGitContext()`, `getPrReviewBinding()`, `getSessionEntrySummary()`
- `getReviewState()` - The session's review state: the runs it anchors or carries as an alias, their General, the discussions it is the source of, and its discussion link.
- `getReviewDiscussion()` - The session's discussion link when it is a review finding discussion, or `null`.

### Writing

`SessionWriter` methods resolve after their entry commits, when the writer's `sessionManager` already holds it:

- `appendMessage(message)`, `appendCustomEntry(customType, data?)`, `appendCustomMessageEntry(customType, content, display, details?)` - Resolve with the entry ID.
- `appendModelChange(provider, modelId)`, `appendThinkingLevelChange(level)`, `appendFastModeChange(enabled)`, `appendPlanningState(planning)`
- `appendSessionInfo(name)`, `appendLabelChange(targetId, label)` - An empty or missing label clears it.
- `recordStartingGitContext(gitContext)`, `recordPrReviewBinding(placement)`
- `recordReviewState(build)` - Append the review entries `build` returns from the committed review state; no other review entry of the session commits in between.

`LogWriter` also moves the leaf, compacts, and queues host messages before a session opens: `appendCompaction(...)`, `branch(entryId)`, `resetLeaf()`, `branchWithSummary(entryId, summary, details?, fromHook?)`, and `queueHostMessages(delivery, messages)`. A live session does these through `session.compact()`, `session.navigateTree()`, and its message APIs.

## Source Files

- [`packages/protocol/src/entries.ts`](../../protocol/src/entries.ts) - Log envelope and core entry schemas
- [`packages/protocol/src/work.ts`](../../protocol/src/work.ts) - Work kinds, states, outcomes, and bounds
- [`packages/coding-agent/src/core/session-entry-types.ts`](../src/core/session-entry-types.ts) - Entry types a session log stores, including coding-agent's product types
- [`packages/coding-agent/src/core/session-entry-codec.ts`](../src/core/session-entry-codec.ts) - Stored-form validation and snapshot rules
- [`packages/coding-agent/src/core/session-manager.ts`](../src/core/session-manager.ts) - Stored entry types and `SessionManager`
- [`packages/coding-agent/src/core/session-writer.ts`](../src/core/session-writer.ts) - `SessionWriter` and `LogWriter`
- [`packages/coding-agent/src/core/conversation-log/`](../src/core/conversation-log/) - The SQLite conversation log, its entry codec, and the writer lock
- [`packages/coding-agent/src/core/session-store/`](../src/core/session-store/) - The SQLite store, its schema, and its upgrades
- [`packages/coding-agent/src/core/messages.ts`](../src/core/messages.ts) - Extended message types (BashExecutionMessage, CustomMessage, etc.)
- [`packages/agent/src/conversation/fold.ts`](../../agent/src/conversation/fold.ts) - The fold that builds session state and model context from the log
- [`packages/agent/src/conversation/work.ts`](../../agent/src/conversation/work.ts) - The work lifecycle and reconciliation
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - Base message types (UserMessage, AssistantMessage, ToolResultMessage)
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - AgentMessage union type

For TypeScript definitions in your project, inspect `node_modules/@hansjm10/volt-coding-agent/dist/` and `node_modules/@hansjm10/volt-ai/dist/`.

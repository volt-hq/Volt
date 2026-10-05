# Session Storage and Log Format

Persisted sessions live in SQLite. Each workspace session directory, or custom session directory, contains one authoritative `sessions.sqlite` store. Sessions are addressed by stable IDs and `SessionReference` values, not by live session file paths.

Each session is one conversation log: an ordered, append-only list of entries. Entries form a tree through `id`/`parentId`. Messages, model and thinking changes, labels, branch moves, and queued input are all entries.

JSONL (JSON Lines) is an interchange snapshot format. Volt imports a snapshot into SQLite once; it never reopens the JSONL file as live storage.

## The Conversation Log

An entry has an envelope and a type-specific payload:

| Field | Meaning |
|-------|---------|
| `ordinal` | Position in the log: contiguous per session, starting at 1. |
| `id` | Entry identity, unique within the session. An opaque string of 1 to 512 characters. |
| `parentId` | The parent entry in the tree, or `null` for a root. |
| `type` | The entry type, such as `message` or `leaf`. |
| `timestamp` | Canonical ISO-8601 UTC time, as `Date.prototype.toISOString()` writes it. |
| `visibility` | `public` or `host`. Fixed per entry type. |
| `payload` | The type-specific fields. |

The protocol package (`@hansjm10/volt-protocol/entries`) defines this envelope and the core entry types. Volt stores and exports entries in a flat form: the envelope fields beside the payload fields, with `visibility` implied by `type`. A `message` entry also carries an optional `clientMessageId` beside its payload.

- **The ordinal is the only position.** There is no separate session revision. Every write appends one batch atomically and names the ordinal it expects the log to be at (`expectedOrdinal`). A mismatch means another writer appended, so the log is lost and the session stops; see [Sessions](sessions.md#when-a-session-stops).
- **Commit, then publish.** An entry reaches readers, listeners, and clients only after its batch commits. A batch that rolls back leaves the log unchanged.
- **One writer.** A host takes an exclusive lock on a session before it opens the session for writing.
- **Visibility.** `public` entries form the conversation tree that clients, snapshots, and forks see. `host` entries are host metadata: they never enter model context, the transcript, snapshots, or forks.

## Canonical JSON Data

Every admitted entry must round-trip through JSON without type or value loss. Accepted data is `null`, booleans, strings, finite numbers other than negative zero, dense arrays, and ordinary plain objects whose own properties are enumerable string-keyed data properties. Optional properties are omitted when absent.

Volt rejects explicit `undefined`, non-finite numbers, negative zero, bigint, symbols, functions, cycles, sparse arrays, accessors, symbol-keyed or non-enumerable properties, custom or null prototypes, and rich objects such as `Map`, `Set`, `Date`, `Error`, `RegExp`, `Buffer`, typed arrays, `ArrayBuffer`, and `SharedArrayBuffer`. Encode rich values as plain JSON, for example dates as ISO strings and maps as arrays of entries.

A write validates and clones each complete entry before the log assigns its ordinal. A rejected entry leaves the log, the store, and the branch unchanged.

## Store Location

Default storage is organized by workspace:

```text
~/.volt/agent/sessions/--<encoded-workspace>--/sessions.sqlite
```

A directory passed through `--session-dir`, `VOLT_CODING_AGENT_SESSION_DIR`, or the SDK instead contains its own `sessions.sqlite`. SQLite may keep active `sessions.sqlite-wal` and `sessions.sqlite-shm` sidecars beside it. The directory is owner-only (`0700`), and the database and sidecars are owner-readable/writable only (`0600`). Treat all three SQLite files as one live store. Per-session writer locks live in the `locks/` subdirectory.

Listing, exact-ID resolution, continuation candidate selection, and RPC session discovery use materialized SQLite summaries rather than scanning entries or JSONL. Custom-session-directory cwd filters compare canonical filesystem identities after reading summaries so symlink and junction aliases match the same workspace. Tree loading opens and verifies one selected session. Deep search scans extracted searchable chunks one session at a time; those chunks are not a full-text index.

## Session Store Upgrade

The current SQLite schema is v5. Before opening an existing store with this
version, stop older Volt CLI and daemon processes that own that store. Do not run
old and new host versions against the same live store.

The first open upgrades only the exact supported v1, v2, v3, or v4 schema, in
one serialized transaction. It preserves the store ID, session IDs and
generations, entries, parent references, and client inputs. Upgrading from v1
or v2 removes the per-session store revision and its revision-keyed commit
records; the log ordinal replaces them. New stores initialize at v5 directly.
Concurrent new-version opens converge on the same upgrade; an upgrade failure
rolls back rather than partially changing the store.

v5 keeps review state in the logs (see [Review State Entries](#review-state-entries-host-only)).
Upgrading from v2, v3, or v4 drops the review anchor, alias, discussion, and
discussion-child tables without carrying their rows anywhere: a review run from
before v5 stays readable in each session that holds it as an unanchored report,
with no handoff alias, General, or discussion linkage. v5 adds two indexes the
store derives from the review entries it commits, `review_run_index` and
`review_discussion_index`; they start empty.

Unknown versions, altered schema objects, invalid metadata and failed integrity
checks are rejected without repair or deletion. Older binaries cannot reopen a
v5 store; downgrading the executable does not downgrade storage.

## JSONL Snapshots

For explicit interchange:

- `SessionManager.importFromJsonl(path, ...)` imports a snapshot into SQLite as a new session (see [ForkedFromEntry](#forkedfromentry-host-only)).
- CLI path arguments to `--session` and `--fork`, and `/import`, perform the same one-time import.
- `SessionManager.exportJsonlSnapshot(ref, outputPath)` writes a portable snapshot and resolves with the ordinal it exported through.

Delete sessions through `/resume` or `SessionManager.delete(ref)`. When the `trash` CLI is available, `/resume` exports a JSONL snapshot to trash before deleting the SQLite record.

## Snapshot Version

The current header has `version: 5` for session entries and `snapshotVersion: 1` for the interchange envelope. Import requires both exact values and rejects unmarked or older JSONL.

A snapshot contains the header, then the session's public entries with contiguous ordinals starting at 1, then exactly one final `leaf` entry that records the active leaf. Malformed or truncated final lines are rejected. Client-input records, starting Git context, PR review bindings, subagent links, work and review records, fork lineage, and transport-owned `clientMessageId` values are never accepted as interchange data.

Import creates a session with a new ID, unless `options.id` (`--session-id` with `--fork`) names one. Its log is a fork of the snapshot at its active leaf: a `forked_from` entry naming the snapshot's session ID and leaf, then the snapshot's active branch with ordinals assigned again, then its labels. Other branches of the snapshot are not imported.

## Source Files

- [`packages/protocol/src/entries.ts`](../../protocol/src/entries.ts) - Log envelope and core entry schemas
- [`packages/coding-agent/src/core/session-entry-types.ts`](../src/core/session-entry-types.ts) - Entry types a session log stores, including coding-agent's product types
- [`packages/coding-agent/src/core/session-manager.ts`](../src/core/session-manager.ts) - Stored entry types and `SessionManager`
- [`packages/coding-agent/src/core/session-writer.ts`](../src/core/session-writer.ts) - `SessionWriter` and `LogWriter`
- [`packages/coding-agent/src/core/messages.ts`](../src/core/messages.ts) - Extended message types (BashExecutionMessage, CustomMessage, etc.)
- [`packages/agent/src/conversation/fold.ts`](../../agent/src/conversation/fold.ts) - The fold that builds session state and model context from the log
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - Base message types (UserMessage, AssistantMessage, ToolResultMessage)
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - AgentMessage union type

For TypeScript definitions in your project, inspect `node_modules/@hansjm10/volt-coding-agent/dist/` and `node_modules/@hansjm10/volt-ai/dist/`.

## Message Types

Message entries contain `AgentMessage` objects. Understanding these types is essential for parsing sessions and writing extensions.

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

### Extended Message Types (from volt-coding-agent)

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
  customType: string;            // Extension identifier
  content: string | (TextContent | ImageContent)[];
  display: boolean;              // Show in TUI
  details?: JsonValue;           // Extension-specific JSON metadata
  timestamp: number;
}

interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;                // Entry we branched from
  timestamp: number;
}

interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

A `message` entry stores a `user`, `assistant`, `toolResult`, `bashExecution`, or `custom` message. `BranchSummaryMessage` and `CompactionSummaryMessage` are never stored as messages: the context builder derives them from `branch_summary` and `compaction` entries.

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

## Entry Base

Every stored or exported entry (except the snapshot header) has these envelope fields:

```typescript
interface SessionEntryBase {
  type: string;
  id: string;               // Opaque, unique within the session
  parentId: string | null;  // Parent entry ID (null for a root)
  timestamp: string;        // Canonical ISO-8601 UTC timestamp
  ordinal: number;          // Log position, assigned at commit
}
```

A public entry's parent is always a public entry. A host entry's `parentId` is the leaf it was written under; host entries never become the leaf.

## Entry Types

| Type | Visibility | Purpose |
|------|------------|---------|
| `message` | public | A conversation message |
| `model_change` | public | Model selection |
| `thinking_level_change` | public | Thinking level |
| `fast_mode_change` | public | Fast mode |
| `planning_state_change` | public | Plan mode snapshot |
| `compaction` | public | Summary of earlier context |
| `branch_summary` | public | Summary of an abandoned branch |
| `custom` | public | Extension state outside model context |
| `custom_message` | public | Extension message inside model context |
| `label` | public | Bookmark on an entry |
| `session_info` | public | Display name |
| `leaf` | host | Active-leaf move |
| `client_input_receipt` | host | Client input reservation |
| `client_input_queued` | host | Queued delivery of a client input |
| `client_input_state` | host | Client input state change |
| `work_started`, `work_checkpoint`, `work_finished` | host | Long-running work: a background job, subagent, review, host action, or extension work (see [Work Entries](#work-entries-host-only)) |
| `forked_from` | host | Lineage of a forked, cloned, or imported session; always the first entry |
| `session_start_git_context` | host | First Git observation (coding-agent product type) |
| `pr_review_binding` | host | PR checkout a review session is bound to (coding-agent product type) |
| `review_general` | host | A review run's General moved; in the run's source (coding-agent product type) |
| `review_alias` | host | A handoff target carries a review run of its source (coding-agent product type) |
| `review_discussion` | host | A finding discussion and its first child; in the run's source (coding-agent product type) |
| `review_discussion_reset` | host | A discussion reset to a new child; in the run's source (coding-agent product type) |
| `review_discussion_link` | host | A discussion child's link; always its first entry (coding-agent product type) |

The examples below use short IDs, abbreviated messages, and illustrative ordinals; each block stands alone.

### Snapshot Header

The first line of an exported snapshot is metadata only and is not part of the tree (no `parentId` or `ordinal`). `SessionManager.getHeader()` exposes the live form as `SessionHeader`, whose optional `parentSession` is a `SessionReference`; export converts that reference to the host-local locator fields shown below.

```json
{"type":"session","version":5,"snapshotVersion":1,"id":"uuid","timestamp":"2026-08-31T14:00:00.000Z","cwd":"/path/to/project"}
```

A snapshot exported from a session with a persisted parent carries the complete host-local store locator of that parent. `parentSessionDirectory` can identify the parent session's active SQLite store directory:

```json
{"type":"session","version":5,"snapshotVersion":1,"id":"uuid","timestamp":"2026-08-31T14:00:00.000Z","cwd":"/path/to/project","parentSessionDirectory":"/path/to/parent/store","parentStoreId":"store-uuid","parentSessionId":"parent-uuid","parentSessionGeneration":"parent-generation-uuid"}
```

A subagent session's header also carries `"origin":"subagent"`. Every snapshot header includes the session `cwd`, and a parent locator can include another host path. Treat snapshots as sensitive local interchange artifacts. Import validates a parent locator but does not carry it into the imported session, whose lineage names the snapshot instead; locators never cross the remote RPC surface.

### SessionMessageEntry

A message in the conversation. The `message` field contains an `AgentMessage`.

```json
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2024-12-03T14:00:01.000Z","ordinal":1,"message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","ordinal":2,"message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop","timestamp":1733234402000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","ordinal":3,"message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1733234403000}}
```

A user message that a client submitted with a `clientMessageId` keeps that identity beside the message, never inside it. The entry completes that client input (see [Client Input](#client-input)). Snapshots omit it.

```json
{"type":"message","id":"d4e5f6a7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:00:04.000Z","ordinal":7,"message":{"role":"user","content":[{"type":"text","text":"Continue"}],"timestamp":1733234404000},"clientMessageId":"client-1"}
```

### ModelChangeEntry

Records a model selection: the user switching models, or the model a session opened with when the branch named none.

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","ordinal":4,"provider":"openai","modelId":"gpt-4o"}
```

### ThinkingLevelChangeEntry

Records a change of the thinking/reasoning level.

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","ordinal":5,"thinkingLevel":"high"}
```

### FastModeChangeEntry

Records a change of the branch-local inference-speed policy. This is independent of thinking level. Eligible OpenAI requests map enabled Fast mode to Priority processing.

```json
{"type":"fast_mode_change","id":"f5g6h7i8","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:07:00.000Z","ordinal":6,"enabled":true}
```

### PlanningStateChangeEntry

A complete branch-local Plan mode snapshot. The latest one on the branch is the session's plan state.

```json
{"type":"planning_state_change","id":"g6h7i8j9","parentId":"f5g6h7i8","timestamp":"2024-12-03T14:08:00.000Z","ordinal":8,"planning":{"mode":"plan","plan":null}}
```

### CompactionEntry

Created when context is compacted. Stores a summary of earlier messages.

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","ordinal":9,"summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000}
```

`firstKeptEntryId` must be an ancestor of the compaction entry.

Optional fields:
- `details`: JSON data (e.g., `{ readFiles: string[], modifiedFiles: string[] }` for default, or custom data for extensions)
- `fromHook`: `true` if generated by an extension; omitted otherwise

### BranchSummaryEntry

Created when switching branches via `/tree` with an LLM generated summary of the left branch up to the common ancestor. Captures context from the abandoned path. `fromId` equals the entry's `parentId`, or `"root"` for a summary at the top of the tree.

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","ordinal":11,"fromId":"a1b2c3d4","summary":"Branch explored approach A..."}
```

Optional fields:
- `details`: JSON file-tracking data (`{ readFiles: string[], modifiedFiles: string[] }`) for default, or custom JSON data for extensions
- `fromHook`: `true` if generated by an extension; omitted otherwise

### CustomEntry

Extension state persistence. Does NOT participate in LLM context.

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","ordinal":12,"customType":"my-extension","data":{"count":42}}
```

Use `customType` to identify your extension's entries on reload.

### Review run records

A review is `review` work (see [Work Entries](#work-entries-host-only)); its `workId` is its run ID. When a run ends, a `volt.review.run` custom entry records its identity, outcome, findings, and finalized accounting. While it runs, its accounting so far is its work item's detail, checkpointed once per pass. A run that was still running when its runtime stopped ends `interrupted` as work and records no run entry. Run entries with status `unfinished` and `volt.review.usage` entries that earlier versions wrote are ignored.

Accounting retains per-pass/repair provider/model, available service tier, host request attempts, assistant turns, token components, and model-priced USD estimates. Pending or incomplete observations remain partial/unavailable after reopen. Missing historical accounting is unavailable and is never backfilled. Accounting does not retain inference transcripts, enter model context, or contribute to subsequent discussion totals. Host-created aliases resolve the canonical source; copied entries do not create new spend or authority. Ordinary session retention limits still apply; in-memory sessions are not restart-durable.

### CustomMessageEntry

Extension-injected messages that DO participate in LLM context.

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","ordinal":13,"customType":"my-extension","content":"Injected context...","display":true}
```

Fields:
- `content`: String or `(TextContent | ImageContent)[]` (same as UserMessage)
- `display`: `true` = show in TUI with distinct styling, `false` = hidden
- `details`: Optional extension-specific metadata (not sent to LLM)

### LabelEntry

User-defined bookmark/marker on a public entry.

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","ordinal":14,"targetId":"a1b2c3d4","label":"checkpoint-1"}
```

A label entry without `label` clears the target's label.

### SessionInfoEntry

Session metadata (e.g., user-defined display name). Set via `/name`, `--name` / `-n`, or `volt.setSessionName()` in extensions.

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","ordinal":15,"name":"Refactor auth module"}
```

The session name is displayed in the session selector (`/resume`) instead of the first message when set.

### LeafEntry (host-only)

Moves the active leaf. Navigation with `/tree`, branching, and resetting the leaf write one; its `parentId` is the leaf it replaces and `targetId` is the new leaf (`null` for an empty conversation). A snapshot ends with exactly one leaf entry.

```json
{"type":"leaf","id":"m3n4o5p6","parentId":"k1l2m3n4","timestamp":"2024-12-03T14:40:00.000Z","ordinal":16,"targetId":"b2c3d4e5"}
```

### Client Input

Every prompt, steer, follow-up, and extension message a session delivers is a durable client input. Its lifecycle is recorded in three host-only entry types; the session's delivery queue is a fold of them.

`client_input_receipt` reserves the input when it is admitted. `semanticDigest` is the hex SHA-256 of the canonical JSON of `{command, message, images, streamingBehavior?}`, so a client that resubmits the same `clientMessageId` with the same input is idempotent, and one that sends different input under it is refused. `origin: "host"` marks input the host submitted itself (extension messages, background notices, plan checkpoints).

```json
{"type":"client_input_receipt","id":"r1","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:00:04.000Z","ordinal":4,"clientMessageId":"client-1","command":"follow_up","semanticDigest":"<64 hex chars>","input":{"message":"Continue","images":[]}}
```

`client_input_queued` records the queued delivery (`steer` or `follow_up`) of an input submitted while a turn runs, before the queue acknowledges it. A host input may queue the messages it delivers in `messages`; its `message` and `images` are then empty.

```json
{"type":"client_input_queued","id":"q1","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:00:04.000Z","ordinal":5,"receiptId":"r1","clientMessageId":"client-1","queuedInput":{"delivery":"follow_up","message":"Continue","images":[]}}
```

`client_input_state` records a state change. `error` is present only on `failed` and holds at most 2,000 Unicode scalars.

```json
{"type":"client_input_state","id":"s1","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:00:04.000Z","ordinal":6,"receiptId":"r1","clientMessageId":"client-1","state":"started"}
```

States:

| State | Meaning |
|-------|---------|
| `accepted` | Admitted, not yet dispatched. |
| `started` | Dispatch started. |
| `completed` | The input's user message committed. A `message` entry with the input's `clientMessageId` implies it. |
| `failed` | The input will not be delivered; `error` explains why. |
| `withdrawn` | A queued input was taken back before dispatch (clearing the queue, restoring it to the editor). |

`accepted` moves to `started`, `completed`, `failed`, or `withdrawn`; `started` moves to `accepted`, `completed`, or `failed`. `completed`, `failed`, and `withdrawn` are terminal.

When a session opens, accepted inputs with a queued delivery are replayed in admission order. A `started` input with no completing message or terminal state is ambiguous: it may or may not have reached the model, so it is never replayed and later input waits behind it until it is settled (`client_input_outcome_ambiguous`).

### Work Entries (host-only)

Long-running work of a conversation is a work item recorded by three core host entry types. A work item is one of these kinds: `job` (a background bash or subagent tool call), `subagent` (a child conversation), `review`, `host_action` (an action that waits for the user's approval, such as a language server install), or `ext:<extension>/<kind>` (an extension's work). Only the host writes work entries: `Conversation.append` refuses them, extensions cannot write them, and they never copy into forks, clones, imports, or snapshots.

`work_started {workId, kind, title, parentWorkId?, input, cancellable, delivery, resume, state, toolCallId?, child?}` starts an item. `title` is one line of at most 200 characters. `input` is the kind's JSON input, at most 16 KiB serialized; kinds keep only what they need (a job keeps its tool, a subagent its agent and bounded task). `delivery` (`none`, `message`, or `wake`) and `resume` are copied from the kind, so reconciliation and delivery are functions of the log alone. `state` is `running`, or `awaiting_approval` for a host action. `parentWorkId` names the work that started this one: an earlier item of the same log, or, for a subagent, its parent run in the parent conversation's log. `toolCallId` names the tool call that started the work. `child {conversation, ref?}` names the conversation a subagent runs in; `ref` locates its persisted log.

```json
{"type":"work_started","id":"w1a2b3c4","parentId":"c3d4e5f6","timestamp":"2026-10-05T12:00:00.000Z","ordinal":20,"workId":"7f3c1a2e-0000-4000-8000-000000000001","kind":"job","title":"npm test","input":{"tool":"bash"},"cancellable":true,"delivery":"wake","resume":false,"state":"running","toolCallId":"call_1"}
```

`work_checkpoint {workId, state?, progress?, detail?}` records a state change (`running`, after an approval or a resume; `cancelling`, once a cancel was requested) or a coarse phase: `progress {text?, value?, max?, steps?}` and `detail`, kind-specific `UiNode` data such as a review's accounting. A checkpoint is at most 8 KiB serialized. Phases are written at most once every 10 seconds and at most 256 checkpoints per item over its lifetime; fine-grained progress reaches clients only through the live `work/<workId>` value.

`work_finished {workId, outcome, result?, error?}` ends an item: `completed`, `failed`, `cancelled`, or `interrupted` (its executor was lost: the runtime ended, or the conversation closed while it ran). `result {summary?, output?, child?, data?}` keeps a summary and an error of at most 2,000 characters each, the output's newest 50 KiB (`{text, truncated}`), and kind data of at most 64 KiB serialized.

```json
{"type":"work_finished","id":"w9x8y7z6","parentId":"w1a2b3c4","timestamp":"2026-10-05T12:01:30.000Z","ordinal":31,"workId":"7f3c1a2e-0000-4000-8000-000000000001","outcome":"completed","result":{"output":{"text":"PASS 40 tests\n","truncated":false}}}
```

Lifecycle, checked by the fold: a work id starts once; a checkpoint or finish names open work; `awaiting_approval` moves to `running` or `cancelling`, `running` to `cancelling`, and nothing moves back; a finished item never changes. Every entry is a child of the current leaf but never moves it.

Reconciliation: when a host opens a conversation, before `session_start`, open work no executor of the new runtime runs ends `interrupted` in one batch, except work of a resumable kind (`resume: true`, subagents), which stays open and suspended until a client resumes it (`resume_work`) or cancels it (`cancel_work`). Resumable children of an in-log parent that ends interrupted end with it.

Delivery: a completed or failed item of a `message` or `wake` kind commits, with its `work_finished` in the same batch, a host client input (`client_input_receipt` with `origin: "host"`, then `client_input_queued`) that delivers a `work_notice` custom message. Its details are `{workId, kind, title, outcome, summary?, error?, child?, output?: {truncated}}`; its text is the line naming the work, then the summary and error, or the kind's own text. A `wake` notice starts a turn when the conversation is idle; a `message` notice (`queuedInput.wake: false`) rides the next turn. Cancelled and interrupted work delivers nothing.

### ForkedFromEntry (host-only)

The first entry of a session created by fork, clone, or import, at ordinal 1 with `parentId: null`. `sessionId` is the source session, and `entryId` is the source entry the copied branch ends at, or `null` when the copied branch is empty (a fork before the first message, or an import of a snapshot with no active leaf).

```json
{"type":"forked_from","id":"f0e1d2c3","parentId":null,"timestamp":"2026-10-03T12:00:00.000Z","ordinal":1,"sessionId":"source-uuid","entryId":"b2c3d4e5"}
```

The copied branch follows it in the same commit: the public entries from the root to `entryId`, keeping their IDs, each with its `parentId` relinked to the copied entry before it (the first to `null`), ordinals assigned again, and client input identities dropped. Label entries are not copied as such. A `label` entry follows for each copied entry with a label. The session never reads its source, so it stays readable after the source is deleted. A log holds at most one lineage entry, and only at ordinal 1. `SessionManager.getForkedFrom()` returns `{ sessionId, entryId }`. The listing's `parentSessionRef` still records a persisted fork's or clone's source, so a parent can be found across stores; an import has none.

### SessionStartGitContextEntry (host-only)

A newly created current-format session records its first **definitive** path-free
Git observation. `gitContext` is either the same bounded object used by RPC
`gitContext`, or `null` when the cwd was definitively not a Git worktree.
Transient Git command failures do not create this entry; a later successful
observation may still do so. Only the manager that created the session records
it, at most once.

```json
{"type":"session_start_git_context","id":"l2m3n4o5","parentId":null,"timestamp":"2026-08-29T16:00:00.000Z","ordinal":1,"gitContext":{"repository":"Volt","head":{"kind":"branch","name":"feature/work","oid":"0123456789abcdef0123456789abcdef01234567"},"upstream":null,"base":null,"status":{"staged":{"added":0,"modified":0,"deleted":0,"renamed":0},"unstaged":{"added":0,"modified":0,"deleted":0,"renamed":0},"untracked":0,"conflicted":0,"total":0,"clean":true},"operation":null,"revision":1,"observedAt":"2026-08-29T16:00:00.000Z","stale":false}}
```

Current-format readers validate this entry strictly and reject duplicates. It
is host metadata only: it never advances the active leaf, enters model context,
appears as a transcript item, copies into forks or explicit snapshots, or reaches
extension message projection. Session listings and state responses may expose the validated
path-free value as optional `startingGitContext`.

### PrReviewBindingEntry (host-only)

The immutable PR checkout identity of a review session (`placement`). Recording the same placement again is a no-op and a different one is refused. It is never imported, exported, or sent to the model.

### Review State Entries (host-only)

A review run belongs to the session that ran it, its source: the `work_started` entry of its `review` work (`workId` is the run ID) anchors the run there. The rest of a run's cross-session state is coding-agent product entries, which only the host writes. Each names sessions by exact identity (`sessionId` and `sessionGeneration`):

- `review_alias {runId, source}`: in a handoff target (a new session that carries the run, such as a review fix or a plan execution), the run's source.
- `review_general {runId, general}`: in the source, the session the run's General discussion moved to. The latest one is current; until the first, the source is the General.
- `review_discussion {discussionId, runId, findingId, contextSnapshot, child, requestId, kickoffClientMessageId}`: in the source, a finding's discussion and its first child session. `contextSnapshot` is the finding's immutable context, at most 64 KiB of JSON.
- `review_discussion_reset {discussionId, child, requestId, kickoffClientMessageId}`: in the source, a reset to a new child, which becomes the discussion's current child.
- `review_discussion_link {discussionId, runId, findingId, source, contextSnapshot}`: the first entry of a discussion child, which makes the child a finding discussion. A child stays linked after a reset or after its source is deleted.

```json
{"type":"review_discussion","id":"r1s2t3u4","parentId":"m5n6o7p8","timestamp":"2026-10-05T12:00:00.000Z","ordinal":42,"discussionId":"d-uuid","runId":"run-uuid","findingId":"f1","contextSnapshot":{"finding":{"id":"f1","title":"Unchecked input"}},"child":{"sessionId":"child-uuid","sessionGeneration":"generation-uuid"},"requestId":"request-1","kickoffClientMessageId":"kickoff-uuid"}
```

When it commits these entries, the store maintains two derived indexes: `review_run_index` (each run's source and current General) and `review_discussion_index` (each discussion child its source records). It refuses an entry that does not fit the other logs: a second session anchoring a run, a General or discussion recorded outside the run's source, an alias or link naming a session that does not anchor the run, a second discussion of a finding, a reset by another session, or a child already used. The indexes answer cross-session lookups and grant nothing by themselves; a write to a source's log first re-reads that log. A row leaves with the session it derives from.

These entries never move the active leaf, enter model context, reach a client, or copy into forks, clones, imports, or snapshots, so a copied review stays a local report.

## Tree Structure

Public entries form a tree:
- A root has `parentId: null`
- Each other public entry points to its parent via `parentId`
- Branching creates new children from an earlier entry
- The "leaf" is the current position in the tree. Each public entry becomes the leaf when it is appended; a `leaf` entry moves it elsewhere.

```
[user msg] ─── [assistant] ─── [user msg] ─── [assistant] ─┬─ [user msg] ← current leaf
                                                            │
                                                            └─ [branch_summary] ─── [user msg] ← alternate branch
```

## Context Building

The conversation kernel in `@hansjm10/volt-agent-core` folds the log into the session's state: `fold(entries)` returns a `ConversationState` with the leaf, the active branch, its model context, the plan state, labels, the name, and client inputs. `SessionManager.getConversationState()` returns the fold of a session's committed entries. The model context of the active branch is built from the root to the leaf:

1. The model is the latest `model_change` or assistant message on the branch; the thinking level, Fast mode, and plan state are the latest `thinking_level_change`, `fast_mode_change`, and `planning_state_change` (defaults: `off`, disabled, none).
2. If a `compaction` entry is on the branch, the latest one applies:
   - its summary comes first, as a `compactionSummary` message;
   - then the messages from `firstKeptEntryId` up to the compaction;
   - then the messages after the compaction.
3. `message` entries contribute their message; a client user message carries its `clientMessageId`, which conversion to provider messages drops.
4. `custom_message` entries become `custom` messages, and `branch_summary` entries become `branchSummary` messages (an empty summary contributes nothing).
5. Every other entry contributes no message: `custom`, `label`, `session_info`, host-only entries, and product entries.

`buildContext(state, { convertToLlm, transformContext? })` turns that context into provider messages: it applies `transformContext`, converts the messages with `convertToLlm` (coding-agent's converts bash executions, custom messages, and summaries to user messages), and applies the replay policy from `@hansjm10/volt-ai`.

## Parsing an Exported Snapshot

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
      console.log(`[${entry.ordinal}] Extension message (${entry.customType}): ${JSON.stringify(entry.content)}`);
      break;
    case "label":
      console.log(`[${entry.ordinal}] Label "${entry.label}" on ${entry.targetId}`);
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

Use references returned by `getSessionRef()`, `SessionInfo.ref`, or another `SessionManager` API. The `storeId` prevents a session ID from being opened against the wrong database; do not construct references from IDs alone.

### Opening and Creating

Persisted factories and store queries are asynchronous. `inMemory()` remains synchronous.

- `await SessionManager.create(cwd, sessionDir?, options?)` - Create and durably reserve a persisted session. `options` takes `id`, `parentSession` (a `SessionReference`), and `origin`.
- `await SessionManager.open(ref, cwdOverride?)` - Open a session for writing. Takes the session's lock; throws `ConversationLockedError` (`code: "conversation_locked"`) while another host has it open.
- `await SessionManager.openReadOnly(ref, cwdOverride?)` - Open a session to read it. Takes no lock, so it works while the session is open elsewhere; every write throws.
- `await SessionManager.continueRecent(cwd, sessionDir?)` - Open the most recent visible or pending-input session, or create one.
- `await SessionManager.findContinuation(cwd, sessionDir?)` - Find that session's reference without opening it.
- `SessionManager.inMemory(cwd?, options?)` - Create a session without persistence.
- `await SessionManager.openInMemory(log, cwd?)` - Open an in-memory session over an existing `ConversationLog`.
- `await SessionManager.createBranched(source, leafId)` - Create a session holding the branch from the root to `leafId` of `source` (`null` for an empty branch) after its [lineage](#forkedfromentry-host-only); persisted beside a persisted source, which becomes its parent.
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

`SessionInfo` includes `ref`, `id`, `cwd`, timestamps, message count, first message, optional name, optional `parentSessionRef`, optional `origin`, and optional `startingGitContext`.

### Reading the Log

Reads return committed state only. The view advances when an entry commits, before the entry reaches any listener.

- `getConversationState()` - The fold of the committed entries (see [Context Building](#context-building)).
- `getOrdinal()` - Ordinal of the newest committed entry.
- `await readEntries(afterOrdinal, limit)` - Committed entries after `afterOrdinal`, host-only records included, with the log's `lastOrdinal`.
- `subscribeEntries(listener)` - Observe public entries in ordinal order after they commit.
- `subscribeBranchChanges(listener)` - Observe active-leaf moves after their leaf entry commits.
- `getClientInput(clientMessageId)` - One client input's record.
- `lost` - Resolves when the session's log is lost (see [Sessions](sessions.md#when-a-session-stops)).

### Tree Navigation

- `getLeafId()`, `getLeafEntry()`, `getEntry(id)`
- `getBranch(fromId?)`, `getBranchWindow(options)`, `getTree()`, `getChildren(parentId)`
- `getLabel(id)`

Tree reads return public entries only.

### Identity and Metadata

- `getEntries()`, `getHeader()`, `getSessionName()`
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

`LogWriter` also moves the leaf and compacts before a session opens: `appendCompaction(...)`, `branch(entryId)`, `resetLeaf()`, and `branchWithSummary(entryId, summary, details?, fromHook?)`. A live session does these through `session.compact()` and `session.navigateTree()`.

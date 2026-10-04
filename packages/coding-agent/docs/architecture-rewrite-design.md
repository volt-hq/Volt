# RFC: Volt Architecture Rewrite

- Status: Draft (proposed). Open questions resolved 2026-10-02 (§14). §6.1 amended 2026-10-04 (live-lane scoping, history query, long resume gaps). §7.1 and §7.3 amended 2026-10-04 (explicit resume, retention on running work).
- Date: 2026-10-02
- Scope: all four packages (`packages/ai`, `packages/agent`, `packages/tui`, `packages/coding-agent`) plus a new `packages/protocol`. `volt-hq/volt-app` adapts through filed issues.
- Release: ships in the next release (0.3.0), together with the removal of Pi extension compatibility (#573). There is no intermediate release.
- Landing: incremental. Every PR leaves `main` green and releasable. Old and new paths may coexist inside a phase; each phase ends by deleting the old path.
- Absorbs: [Daemon-hosted conversations](daemon-hosted-conversations-design.md) as the host model (§5.3, Phase 7).
- Supersedes:
  - [Remote-friendly extensions](extension-remote-ux-design.md). That design keeps terminal components as an optional TUI enhancement; this one removes them (§8).
  - The cursor model of [Atomic conversation bootstrap](conversation-bootstrap-design.md). Clients resume by log position instead of re-bootstrapping on every gap (§6.1).
- Breaking changes: intentional and everywhere. Volt has no users; no compatibility paths are added.

Paths are relative to `packages/coding-agent/` unless they start with `packages/`. Line references are as of `58a7a64e4`.

---

## 1. Decisions

1. **The conversation log is the core primitive.** Every durable fact about a conversation is an entry in one ordered, append-only log. Its ordinal is the only revision, cursor, and fence.
2. **One runtime.** A product-agnostic `Conversation` kernel in `packages/agent` owns the agent loop, the delivery queue, operation state, and the fold over the log. It is bound to one log for its whole life. `AgentHarness`, `AgentSession`, and `AgentSessionRuntime` collapse into the kernel plus coding-agent services.
3. **One protocol.** Clients subscribe to a projected log by ordinal, send schema-validated intents, and query catalogs. The same frames run over stdio, loopback, the daemon socket, and Iroh.
4. **One work primitive.** Background jobs, subagents, review workflows, host actions, and extension-started work are work items: one record, one state machine, durable in the log, rendered generically.
5. **Data-only extensions.** Extensions declare a manifest, typed settings, permissions, and UI as data. Every client renders the same declarations. Extensions can be enabled and disabled at runtime. The store becomes a curated hub with review records.

Package consequences:

- `packages/ai` becomes a pure LLM library that owns its message schemas, errors, and registries (§9).
- A new `packages/protocol` owns the log entry schemas, protocol frames, the shared `UiNode` UI schema, and the contract artifact (§5.1, §6.2).
- `packages/tui` gains a generic declarative layer and the missing generic components. It stays free of Volt dependencies (§10).
- The coding-agent TUI becomes a client of a conversation it does not own (§10).

## 2. Motivation

### 2.1 Four answers to "what is the conversation"

The per-session `entries` table is already an ordered, append-only log. It is insert-only (no `UPDATE entries` in `src/core/session-store/worker.ts`), with contiguous ordinals and idempotent commits. Branch navigation is itself an entry (`leaf`), and most runtime state is already a fold (`replaySessionEntries`). The rest of the system does not treat it as the source of truth:

- **Four revision counters.** These are:
  - the store `revision`, one per transaction (`worker.ts:1286-1288`);
  - `canonicalRevision`, one per public entry (`src/core/session-store/projection.ts:518`);
  - the harness adapter's `revision` plus an `authorityGeneration` UUID (`src/core/harness-session-adapter.ts:141-142`);
  - the projection feed's `branchEpoch`, plus a per-subscription in-memory cursor.
- **Two context builders.** These are `buildSessionContext` in `packages/agent/src/harness/session/session.ts:22` and in `src/core/session-manager.ts:913`. Both are live, joined by a 558-line adapter, so the model's view and the UI's view of the transcript can disagree.
- **Publish before commit.** `_appendAcceptedEntry` enqueues an async persist and notifies listeners immediately (`session-manager.ts:1686-1698`). Subscribers can observe entries that later fail to persist.
- **Live state outside the log.** This covers:
  - background jobs, which are an in-memory `Map` (`src/core/background-jobs.ts:98`; "Jobs do not survive runtime restart", `:467`);
  - the review workflow registry;
  - delivery inbox ordering;
  - the streaming assistant;
  - `buildRpcSessionState`.
- **A concurrent writer is fail-stop.** A revision conflict sets a sticky `reconciliation_required` (`session-manager.ts:132`) and forces runtime replacement. The authority-loss bugs #525, #535, #547, and #548 came from this path.

### 2.2 Layers that reimplement each other

- **`AgentHarness`** (`packages/agent/src/harness/agent-harness.ts`, 3,827 lines, 67 public members) is used by coding-agent as a lease, queue, and loop kernel.
  - `AgentSession` never calls its `prompt`, `steer`, `followUp`, `compact`, `navigateTree`, or `setActiveTools`.
  - Harness compaction (1,090 lines) and its JSONL and in-memory storage (849 lines) are unused by coding-agent.
  - Coding-agent imports only four values from the package: `AgentHarness`, `AgentHarnessAdmissionGate`, `createSessionId`, and `uuidv7`.
- **`AgentSession`** (9,297 lines, about 121 public members) reimplements prompting, queues, compaction, and tree navigation on top of the harness.
- **Busy state** is stacked in three places:
  - harness operation leases;
  - `AgentSession.isBusy`, which combines five sources;
  - runtime structural-operation counters (`src/core/agent-session-runtime.ts:331-333`).
- **`AgentSessionRuntime`** (2,152 lines) replaces sessions in place.
  - `replaceCurrentSession` (`:816`) is a seven-step transaction with rollback.
  - Hosts plug into it through single-slot hooks: `setRebindSession`, `setPrepareSessionReplacement`, and `setBeforeSessionInvalidate` (`:509-556`).
  - RPC mode saves and restores the TUI's rebind handler when a phone relays through it (`src/modes/rpc/rpc-mode.ts:988-1013`).
  - Rekey is a host concept implemented twice, by the TUI lease and by the daemon registry.

### 2.3 Protocol sprawl

- **Commands and events.** There are 100 RPC commands (`src/core/rpc/schema/commands.ts:81-415`). Events comprise 22 declared event schemas (25 wire types) plus 20 undeclared passthrough event types, because the union is deliberately open.
- **Daemon control protocol.** It has 63 message types guarded by hand-written type guards (`src/daemon/control-protocol.ts`). Four remote-only command types sit outside the schema.
- **Three sequencing mechanisms.** These are plain stdio with no ids, the ordered feed with per-subscription cursors, and the daemon viewer feed with its own `seq`. Cursors live in memory, so any gap, overflow, or rebind triggers a fresh bootstrap.
- **Two transcript projections with different shapes.** The local one is `src/core/rpc/transcript.ts`; the remote one is `src/daemon/conversation-commands.ts:607-753`. The contract declares only the local shape.
- **Two intent namespaces.** Typed commands and UI action ids overlap on about a dozen operations, such as `set_agent_mode` and `agent.mode`, or `abort` and `run.cancel`.
- **Silent state changes.** Some changes emit no client event. `setModel` notifies extensions only (`src/core/agent-session.ts:6409-6437`), so clients learn the new model from the next snapshot.

### 2.4 Seven kinds of long-running work

| Primitive | Status values | Durable | Survives restart | Wire surface |
|---|---|---|---|---|
| Background jobs | 5 | No | No | `background_jobs_changed`, 3 commands, a `get_state` field |
| Subagents | 3 separate enums of 4 | Spawn edge and child log | Yes (hydration, resume) | 3 events and 6 commands, local RPC only |
| Review workflows | 3 separate enums | `volt.review.run` entries | No; `unfinished` records are never reconciled | `workflow_*`, 14 commands, push kind |
| Host actions | 4 | No | No | `host_action_*`, 1 command |
| MCP calls | – | No | No | `mcp_call_*` |
| swarm-review (extension) | 5 | No | No | Terminal widget only |
| Extension tasks (`ctx.work.tasks`) | 5 | No | No; request-scoped | None |

Each primitive has its own id scheme, cancellation path, observer bus, retention cap, result delivery, and TUI renderer. Daemon retention ORs four separate activity checks (`src/daemon/integrated-runtimes.ts:2034-2038`). The open `RpcWorkflowKindSchema` (`src/core/rpc/schema/projections.ts:14`) has only one producer, review.

### 2.5 A terminal-shaped extension API

- **`ctx.ui`.** Of its 28 members, 10 cross RPC, 4 work only on the host, and 14 are no-ops outside the TUI. `renderCall`, `renderResult`, and `registerMessageRenderer` return TUI `Component`s.
- **Usage.** 23 of 67 example extensions, 3 of 4 repo extensions, and our own `prompt-url-widget` use terminal-only APIs.
- **No settings schema.** The only declared configuration is `registerFlag`. Store packages invent their own config files and environment variables.
- **No stable identity.** An extension is identified by its file path.
- **No runtime enable or disable.** Disabling means editing settings patterns, then a full `/reload` that is refused while streaming.
- **Untyped hooks.** `on()` accepts any string (`src/core/extensions/loader.ts:217`). `.volt/extensions/prompt-url-widget.ts:230` subscribes to `session_switch`, which does not exist, so that handler can never run.
- **No isolation.** Extensions run in-process "with your full system permissions" (`docs/extensions.md:110`).
- **Thin curation.** The store's curation is a single maintainer-set `verified` boolean.

### 2.6 ai and tui

**packages/ai**
- **Schemas.** ai ships no runtime schemas, so coding-agent mirrors its types as TypeBox (`src/core/rpc/schema/external.ts`) with drift assertions.
- **Errors.** Errors are free text classified by regex in coding-agent (`src/core/provider-errors.ts`).
- **Mutation.** `calculateCost` mutates usage in place.
- **Global state.** The provider, model, and OAuth registries are all process-global maps.
- **Product leaks.** Volt concepts appear in ai: `VOLT_*` environment variables, `clientMessageId`, and `toolResultMessageIndices`.
- **Duplication.** `ThinkingLevel` is defined twice. Environment-key fallback exists in both ai and `AuthStorage`. The provider stream skeleton is duplicated 8 to 10 times, and retry behavior differs per provider.

**packages/tui and the TUI**
- **Components.** Leaf components already render plain data.
- **The ownership problem.** It sits in `InteractiveMode` (10,130 lines; 262 `this.session.*` and 40 `this.runtimeHost.*` call sites). Beyond that:
  - `FooterComponent` holds an `AgentSession`;
  - tool cards call `createAllToolDefinitions(cwd)`;
  - the jobs inspector takes the live job manager.
- **Missing generic components.** There is no typed form, table, determinate progress, card, action bar, multi-select, tabs, or tree.
- **Keybindings.** Keybinding definitions are fixed at construction.

## 3. Goals and Non-Goals

| # | Goal |
|---|---|
| G1 | Every fact about a conversation that outlives a process is a log entry. One position, the ordinal, serves as revision, cursor, and fence. |
| G2 | One kernel class owns the loop, queue, operation state, and fold, and is bound to one log for its life. |
| G3 | Every frame on every transport has a schema in one contract artifact, published from `packages/protocol`. |
| G4 | One work record and state machine, durable in the log, rendered without kind-specific client code. |
| G5 | No extension API takes or returns terminal components. Every extension feature behaves the same in the TUI and on the phone. |
| G6 | Clients hold no authority. They render a fold of the projected log plus a live lane. |
| G7 | Net deletion. The inventory is in §11, and each phase reports its measured net line change. |

Non-goals:
- **Rewriting LLM providers.** Only the shared skeleton, schemas, errors, auth path, and registries change.
- **Sandboxing extensions** (Q2). Permissions are declared and advisory.
- **Replacing SQLite** or the session store's storage engine.
- **Multiple writers per log.** There is one writer per conversation, enforced by a lock.
- **Replacing the TUI renderers.** Main-screen and alt-screen both stay.

## 4. The Conversation Log

### 4.1 Model

- **Entries.** A conversation is one log. Each entry carries an ordinal (contiguous per log), an entry id, a parent entry id (the tree), a type, a payload, and a visibility (`public` or `host`). The `sessions` row stays as a projection of the log.
- **The ordinal is the only position.** Store revision, `canonicalRevision`, adapter revision and authority generation, `branchEpoch`, and per-subscription cursors are removed. Fences compare ordinals (`expectedOrdinal`).
- **Commit, then publish.** An entry reaches any listener only after its transaction commits. The write-behind path is removed.
- **Incremental reads.** The store adds `read_entries(sessionId, afterOrdinal, limit)`. Today the worker exposes only a full `load_session`.
- **Single writer.** Every host, in-process modes included, takes an exclusive OS lock per log before opening it (daemon-hosted conversations RFC §5.2). A lost lock ends that runtime. `reconciliation_required` and the authority-loss reload paths are deleted.

### 4.2 What becomes an entry

| State | Today | After |
|---|---|---|
| Model, thinking, fast mode, plan | Entries, but some changes emit no client event | Entries; clients learn every change from the log |
| Background jobs | In-memory map | Work entries (§7) |
| Review workflow lifecycle | In-memory registry plus `unfinished` run records | Work entries. Findings stay review entries. |
| Delivery queue | In-memory FIFO plus `client_input_*` entries | `client_input_*` entries; the queue is a fold |
| Streaming assistant, active tool state | In memory | Live lane, keyed to the ordinal it builds on (§6.1) |
| Extension status, panels, pending dialogs | In memory, per UI binding | Live lane, replayed on attach (Q3) |
| Global and project settings | `settings.json` | Unchanged. Only per-conversation overrides are entries. |
| Review anchors, general review state, discussions | Separate tables with their own CAS counters | Entries in the owning conversation's log (Q7). The tables survive only as derived indexes, if cross-session lookups need them. |

### 4.3 Folds and projections

- **One fold.** Runtime state is `fold(log)`, owned by the kernel: leaf, model context, delivery queue, open work, plan state, and client-input recovery. It replaces both context builders.
- **Replay policy moves into the fold.** ai's `transformMessages` drops errored turns, synthesizes missing tool results, and injects rejection feedback. That logic is exported as a pure function the fold calls, so the log stays the source of truth.
- **Pure projections.** Projections are pure functions of `(log, profile)`: the transcript (one implementation, replacing both), session tree, search chunks, and HTML and JSONL export.
- **Snapshots are caches.** A snapshot is a fold result tagged with its ordinal.

### 4.4 Branches, forks, imports

- **Branches.** The tree stays `parentId` plus `leaf` entries.
- **Fork, clone, and import.** Each creates a new log whose first entry records lineage (`forked_from{sessionId, entryId}`), followed by a copy of the branch path, so logs stay self-contained (Q1). Today lineage is lost at the log level.

## 5. One Runtime

### 5.1 Layers

| Package | Owns | No longer owns |
|---|---|---|
| `packages/ai` | LLM types and message schemas, providers, streaming, typed errors | Replay policy (moves to the fold, §4.3); product hooks |
| `packages/protocol` (new) | Log envelope and core entry schemas, protocol frames, `UiNode`, the contract artifact. Depends on `packages/ai` for message schemas. | – |
| `packages/agent` | `Conversation`: log writer, fold, agent loop, operation coordinator (the single busy/phase state), delivery queue, work registry, compaction mechanism with an injected summarizer. Uses `packages/protocol` for the log envelope and core entry types. | Its own unused compaction and storage stacks; a parallel prompt and tree API |
| `packages/tui` | Terminal rendering, generic components, a generic spec-to-component reconciler | Nothing Volt-specific; it gains no dependency on `packages/protocol` |
| `packages/coding-agent` | Tools, system prompt, resources, settings, models and auth, extension host, LSP, MCP, review, subagents; `ConversationHost`; modes; the `UiNode` mapping for the TUI client | `AgentSession` as a 9k-line class; in-place session replacement |

The dependency order is `ai` → `protocol` → `agent` → `coding-agent`, with `tui` → `coding-agent`. Product entry payloads (review state, extension entries) are namespaced entry types whose schemas coding-agent registers. The kernel folds core entries and carries the rest through.

Deleted outright:
- `harness-session-adapter.ts`;
- the unused harness surface, compaction, and JSONL/memory storage (test-only pieces move under `packages/agent/test`);
- `AgentState`;
- the three-layer busy state.

### 5.2 Conversation identity is fixed

- **No in-place replacement.** A `Conversation` serves one log for its whole life. New, resume, switch, fork, clone, and import open another conversation, and the client's stream moves to it.
- **Deleted with it:**
  - `replaceCurrentSession`;
  - rekey;
  - `setRebindSession`, `setPrepareSessionReplacement`, `setBeforeSessionInvalidate`;
  - the RPC handler save-and-restore;
  - the daemon's post-hoc `rekeyEntry`.
- **`/reload` stays in place.** Resources and extensions rebind; the log is untouched.
- **Extension session control becomes intents.** `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` return the new conversation id, and the host moves the invoking client. Each conversation's extensions get their own `session_start` and `session_shutdown`.

### 5.3 Hosts

- **One library.** Every mode uses one `ConversationHost`: the interactive TUI (a daemon worker, per the daemon-hosted conversations RFC), print and JSON, stdio RPC, the SDK, subagents, and review passes. Modes differ only by process placement, transport, and subscriber profile.
- **Subagents** are child conversations in the same host, reached through the host API instead of an in-process RPC client.
- **Review passes** become ordinary conversations. Today they are bare `createAgentSession` calls that never bind extensions or emit `session_start` (`src/core/review.ts:1318`).

## 6. One Protocol

### 6.1 Frames

- **Subscribe.** `subscribe{conversation, after, profile}` streams projected entries as `entry{ordinal, ...}`.
  - **Resume.** A reconnecting client sends `after` = the last ordinal it applied.
  - **Snapshot.** `after: "snapshot"` returns a fold snapshot at ordinal N, then entries after N.
  - **Long gaps (amended).** A profile with bounded replay (the remote profile) may answer a resume whose gap exceeds its replay limit with a snapshot at the current ordinal instead of every entry. The semantics are those of `after: "snapshot"`; there are no reason codes.
  - **Removed:** `report_stream_discontinuity` and the bootstrap reasons `resync`, `overflow`, and `session_rebind`.
- **Live lane.** `live{basedOn, seq, ...}` frames carry ephemeral state: assistant deltas, tool progress, fine-grained work progress, extension UI declarations, and pending dialogs. On attach, the host replays its current live state.
  - **Scoping (amended).** `basedOn` scopes only streaming items (assistant deltas and tool progress): a client discards those when `basedOn` changes or when it applies the entry that commits them. Keyed state (extension UI declarations, pending dialogs, phase) persists until the host clears or replaces it, so a commit never drops a pending dialog.
- **Intents.** One namespace: `{type, intentId, expectedOrdinal?, ...}`. A result is either `accepted{ordinals}` or `rejected{reason}`.
  - Typed commands and UI action ids merge.
  - Intent descriptors carry the input schema, availability, and remote safety, replacing UI action descriptors.
  - `cycle_*` commands become explicit `set_*` intents.
- **Queries** cover only what is not in a conversation log:
  - the catalogs (models, intents, sessions, MCP, extensions, settings schemas and values);
  - content fetch by id (images, entry text, work output).
  - **History (amended).** A bounded read of the projected log (`history{before, limit, branch}`), a pure function of (log, profile), lets a client with a bounded snapshot page older entries.
- **Host requests.** Dialogs, forms, and approvals live in the live lane until answered. `get_pending_host_actions` is removed.

### 6.2 One contract

- **Everything is schema-first.** Every frame has a TypeBox schema in one contract artifact, including the daemon control protocol and the remote-only commands. The artifact is published from `packages/protocol` and replaces `packages/coding-agent/contract/rpc-schema.json`. Passthrough events are removed.
- **A transport is framing plus admission.** A profile is a projection filter, redaction rules, and an intent allowlist. The Iroh command allowlist, capability grants, and outbound sanitizer collapse into profile definitions.

### 6.3 Mapping

| Today | After |
|---|---|
| `prompt`, `steer`, `follow_up`, `abort`, `compact`, `bash`, plan, model and mode setters, `invoke_ui_action` | Intents |
| `get_state`, `get_transcript`, `get_session_tree`, `get_messages`, `get_fork_messages`, `get_last_assistant_text`, `get_session_stats`, `get_pending_host_actions` | Derived from the subscription; removed as commands |
| `list_jobs`, `read_job`, `cancel_job`, `subagent_*`, `cancel_workflow`, `list_review_workflows` | Work intents and work-output queries |
| `new_session`, `switch_session*`, `fork`, `clone` | Intents that return a conversation id, followed by a new subscription |
| `conversation_bootstrap` resync and overflow, `report_stream_discontinuity` | Removed: resume by ordinal |
| Daemon `viewer_*`, TUI lease states, `relay_rpc` | Removed (daemon-hosted conversations RFC) |

## 7. One Work Primitive

### 7.1 Record

- **Durable entries.** These are:
  - `work_started{workId, kind, title, parentWorkId?, input, cancellable}`;
  - `work_checkpoint{workId, progress}`, which is coarse;
  - `work_finished{workId, outcome, result}`.
- **Live progress.** Fine-grained progress uses the live lane.
- **One state machine.** `running → cancelling → completed | failed | cancelled`. On open, the fold finds work with no live executor and the kernel appends `interrupted`, unless the kind declares resume (subagents do).
  - **Resume (amended).** A resumable item that is open without an executor is suspended until a client resumes or cancels it; opening a conversation never resumes work on its own. Resumable children of an in-log parent that is closed or being interrupted are interrupted with it.
- **Delivery policy per kind.** `none`, `message` (a result entry the model sees), or `wake` (the result entry plus an idle turn).

### 7.2 Kinds

| Kind | Notes |
|---|---|
| `job` | Detached bash or subagent tool calls. Delivery `wake`. Output fetched by id. |
| `subagent` | Links a child conversation. Supports resume. Its delegation tree is `parentWorkId`. |
| `review` | Results seed a new conversation. Findings stay review entries. |
| `host_action` | Adds an `awaiting_approval` state before `running`. |
| `ext:<id>/<kind>` | Extension-started work, such as swarm-review. It gains remote visibility, cancellation, and durability. |

Not work items:
- **Planning** is state.
- **MCP calls** stay tool calls.
- **Extension-services tasks** (`ctx.work.tasks`) are request-scoped context collection with deadlines. They stay a separate, ephemeral mechanism, and the namespace becomes `ctx.services` to free the word "work".
- **The daemon's branch and PR binding store** (`work-state.json`) is renamed `changes`.

### 7.3 Rendering and deletions

- **Generic rendering.** Clients render title, status, progress (text, determinate, or steps), result summary, and actions (cancel, open the child conversation). Kind-specific detail is declared UI data (§8.3), not client code.
- **One retention check.** Daemon retention becomes a single check: is any work running (open with a live executor), a turn busy, or an operation holding the conversation open. Suspended work does not keep a conversation alive (amended).
- **Deleted:**
  - `background_jobs_changed` and the `backgroundJobs` state field;
  - the job commands;
  - the `subagent_*` events and local-only commands, and the three subagent status enums;
  - review-specific workflow registry code;
  - `host_action_update`;
  - the separate TUI job and subagent inspectors, in favor of one work inspector.

## 8. Data-Only Extensions

### 8.1 Manifest

The `volt` field in `package.json`, or `export const manifest` for single-file extensions, declares:
- `id`;
- `displayName`;
- `description`;
- `entry`;
- `settings`, a TypeBox schema;
- `permissions`, from `exec`, `network`, `fs-write`, `secrets`, and `providers`.

The version comes from the package. The manifest id replaces path-derived identity.

### 8.2 Lifecycle

- **Contributions are owned.** The host records every contribution by extension id: tools, intents and commands, hooks, providers, UI declarations, and work kinds.
- **Runtime toggling.** Disabling sends `deactivate`, removes the contributions, and cancels or waits for the extension's open work. Enabling loads the extension and sends `activate`. Neither requires `/reload`.
- **Typed hooks.** `on()` rejects unknown event names at load.
- **Settings** live under `extensions.<id>` in global or project settings and are validated against the schema. Changes arrive as `settings_changed`. Every client renders the editor generically from the schema, and so does `volt config`.
- **Permissions** are shown at install and enable time. They are advisory, because in-process extensions are not sandboxed (Q2).
- **Instances.** There is one extension instance per conversation, as today (Q10).

### 8.3 UI as data

- **A shared `UiNode` schema** in `packages/protocol`, used by the TUI client, the contract, and the phone. It provides:
  - `text`, `markdown`, `list`, `table`, and `keyValue`;
  - `progress` (determinate or steps);
  - `form` (string, boolean, enum, and integer fields with validation);
  - `actions` (bound to intents);
  - `card` (title, sections, badges, actions);
  - `diff`, `terminal` (bounded output lines), `code`, `image`, and `tree`.

  Styling uses semantic tokens only. The host converts ANSI to tokens or strips it; ANSI is never sent as data.
- **Keyed updates.** Live-lane presentation updates are keyed patches against the previous tree, so streaming output appends lines instead of resending a whole card.
- **Contributions.** An extension can contribute:
  - status items;
  - named panels with placement hints;
  - notifications;
  - dialogs and forms;
  - tool-call presentation;
  - custom-message presentation;
  - work detail.
- **Presentation runs on the host.** Tool-call and custom-message presentation are `present()` functions that return `UiNode` data, so clients never run extension code.
- **Declarations live on the host.** The host holds current declarations per conversation in the live lane.
- **Removed:**
  - `custom()`, `setFooter`, `setHeader`, `setEditorComponent`, `getEditorComponent`;
  - `onTerminalInput`;
  - `addAutocompleteProvider`, replaced by a declarative completion provider that returns items;
  - `renderCall`, `renderResult`, `disposeRenderState`, and `registerMessageRenderer`, replaced by `present()`;
  - the synchronous `getEditorText`, replaced by an async query;
  - the TUI components exported for subclassing (`src/index.ts:1010-1043`).
- **Kept:**
  - dialogs;
  - `notify`, status, title, and editor-text operations;
  - `registerShortcut`, as data mapping a key to an intent.
- **Built-in tools render the same way** (Q9). Bash, edit, read, subagent, and every other built-in tool define `present()`, and clients contain no tool-specific rendering code. The 16 built-in `renderCall`/`renderResult` implementations become `present()` functions, and the phone renders `UiNode` only.

### 8.4 Hub

- **Catalog v2.** Each entry adds the manifest id, version, permissions, and a review record (reviewed commit, reviewer, date, notes).
- **Pinning.** Entries pin to the reviewed commit. Install and enable show the declared permissions.
- **Submission.** New entries arrive as pull requests to the catalog. CI validates the manifest and settings schema.

### 8.5 Porting

- **Examples.** Port or delete the 23 terminal-dependent examples. Examples that only demonstrate terminal APIs are deleted.
- **Repo extensions.** `prompt-url-widget`, `swarm-review`, `tps`, and `redraws` are ported or deleted.
- **Store packages.** The five store packages move their configuration into manifest settings. The azure-devops package also has to drop its optional peer dependencies on `@earendil-works/volt-*`, which the host never serves.

## 9. packages/ai

- **Owned schemas.** ai owns versioned TypeBox schemas for messages, content blocks, usage, errors, and model metadata. Coding-agent's mirrors (`src/core/rpc/schema/external.ts` and its drift assertions) are deleted.
- **Immutability.** Messages are immutable. Cost is derived from raw token counts and a versioned price table, never written in place.
- **Typed errors.** Every provider returns errors as `{kind, retryable, providerCode, message}`. Regex classification is deleted.
- **Instance registries.** `createAiClient({providers, models, credentials})` replaces the global maps and `resetApiProviders`.
- **No product leaks.** `VOLT_*` environment variables move to coding-agent configuration. `clientMessageId` moves to the log entry envelope. `toolResultMessageIndices` is removed.
- **One stream runner.** A single runner owns the normalizer lifecycle, abort mapping, retry policy, and the stop-reason and usage mapping hooks. Each provider supplies only request building and fragment parsing.
- **One credential path.** ai defines a `CredentialSource` interface. Storage and resolution order live only in coding-agent. The ai CLI's own `auth.json` and the environment fallback inside `stream()` are removed.
- **Unchanged.** Streaming events stay a transient channel, not a log format. `models.generated.ts` stays generated.

## 10. packages/tui and the TUI Client

- **A generic declarative layer in packages/tui.**
  - A spec-to-component reconciler maps keyed node trees to retained components through a node-type registry. It knows nothing about `UiNode`; the coding-agent client registers the `UiNode` mapping.
  - Theme-resolved semantic tokens replace ANSI in data.
  - Focus groups handle Tab traversal.
  - It adds the missing components: form, table, determinate progress, card, action bar, multi-select, tabs, tree, diff and terminal-output views, and a notification stack.
  - The keybinding and action table can be updated at runtime.
  - Both screen modes render the layer; flex layout remains alt-screen only.
- **The coding-agent TUI becomes a client.** Its store is a fold of the projected log plus the live lane. Components read the store, and input leaves as intents.
  - `InteractiveMode` splits into stream client, store, views, and input.
  - `FooterComponent` stops holding `AgentSession`.
  - The jobs inspector becomes the work inspector.
  - Tool cards render each tool's `present()` output instead of calling `createAllToolDefinitions(cwd)`.
- **Relation to the daemon RFC.** This is the daemon-hosted conversations RFC Phase 1, rebased on the new protocol. Because extension UI is data-only by then, it needs none of that RFC's degraded extension behavior (its §6.5).

## 11. Deletion Inventory

| Area | Deleted |
|---|---|
| packages/agent | Harness compaction (1,090 lines), JSONL and in-memory storage (849), the unused `AgentHarness` surface, `AgentState` |
| Kernel seams | `harness-session-adapter.ts` (558), the second context builder, the write-behind append, `reconciliation_required` and authority-loss reloads, three-layer busy state |
| Replacement | `replaceCurrentSession` and its host hooks, rekey (TUI lease and daemon registry), RPC rebind save-and-restore |
| Protocol | 20 passthrough events, `report_stream_discontinuity`, bootstrap resync/overflow, the second transcript projection, overlapping UI-action/command pairs, state-query commands derivable from the log |
| Work | Job, subagent, and workflow-specific events and commands; three subagent status enums; separate inspectors; four-way retention check |
| Extensions and tools | 14 terminal-only `ctx.ui` members, render hooks, message renderers, exported subclassable TUI components, the 16 built-in `renderCall`/`renderResult` implementations |
| Review | Side-table CAS counters (`general_revision`, `current_ordinal`) and table-owned review state |
| ai | Schema mirrors in coding-agent, regex error classification, global registries, duplicated provider skeletons, the second auth path |
| Daemon (absorbed RFC) | TUI lease states, viewer feed, drain viewer, `LeaseBroker.tla` and `RelayViewer.tla` |

## 12. Delivery Plan

Every PR keeps `main` green and adds a changeset fragment. Breaking changes use kind `breaking`. Each phase ends by deleting the path it replaced and reporting its net line change.

| Phase | Content | Depends on |
|---|---|---|
| 0a Store | Commit-then-publish everywhere; `read_entries(after)`; the ordinal exposed as the position | – |
| 0b ai | Owned schemas, typed errors, immutable usage, instance registries, product leaks out, single credential path, shared stream runner | – |
| 0c agent | Delete unused harness compaction, storage, surface, and `AgentState` | – |
| 0d tui | Generic spec-to-component reconciler and the missing generic components | – |
| 0e protocol | Create `packages/protocol` with the log envelope and core entry schemas, frames, `UiNode`, and the contract artifact moved from coding-agent. Teach release tooling, shrinkwrap generation, and release checks about the fifth package. File a volt-app issue for the artifact path. | 0b |
| 1 Kernel | `Conversation` in packages/agent with one fold, one context builder, and one operation coordinator. `AgentSession` becomes coding-agent services over it. Adapter and extra revisions deleted. Per-log lock in all hosts. `reconciliation_required` removed. | 0a, 0c, 0e |
| 2 Identity | Hosts open conversations instead of replacing them. Replacement machinery and rekey deleted. Extension session control becomes intents. Until Phase 7, the TUI lease releases and reacquires instead of rekeying. | 1 |
| 3 Protocol | Subscribe by ordinal, live lane, unified intents, queries, one contract including daemon control, profiles, one transcript projection. File a volt-app issue. | 2 |
| 4 Work | Work entries, kernel reconciliation, generic rendering. Migrate jobs, subagents, reviews, and host actions. Rename `work-state` and `ctx.work`. Review anchors, general state, and discussions become entries; the side tables become derived indexes or are dropped. File a volt-app issue. | 3 |
| 5 Extensions | Manifest, settings, permissions, runtime toggling, UI as data, `present()`. Built-in tools move to `present()`. Port or delete examples, repo extensions, and store packages. Catalog v2. File a volt-app issue: the phone renders `UiNode` only. | 0d, 0e, 3, 4 |
| 6 TUI client | `InteractiveMode` as a client of an in-process `ConversationHost` over loopback | 4, 5 |
| 7 Workers | Daemon-hosted conversations Phases 2–4, minus what Phases 2 and 3 already deleted | 6 |

**Release.** 0.3.0 is cut after Phase 7 (Q8).

**Testing.**
- Suite tests keep using `test/suite/harness.ts` with the faux provider.
- Property tests (fast-check) cover the log contract:
  - `fold` is deterministic;
  - projections are pure;
  - `snapshot(N)` plus the entries after N equals `fold(all)`;
  - resume-after-ordinal equals an uninterrupted stream.
- The contract check covers every frame.
- A worker-registry TLA+ model replaces `LeaseBroker.tla` and `RelayViewer.tla` in Phase 7.

## 13. Effects Outside the Packages

- **volt-app.** The contract artifact moves in Phase 0e. The protocol changes in Phases 3 to 5. In Phase 5 the phone drops its hand-built tool cards for `UiNode` rendering. One issue is filed per phase; there are no compatibility paths.
- **Release process.** Phase 0e updates `docs/github-release-automation.md`, the release workflows, and the AGENTS.md release checklist (which verifies four npm packages) for the fifth package.
- **Docs.** `docs/rpc.md`, `docs/extensions.md`, `docs/packages.md`, `docs/sdk.md`, `docs/daemon.md`, `docs/sessions.md`, and `docs/session-format.md` are rewritten in the phase that changes them.
- **Design docs.** Superseded design docs get a banner pointing here.

## 14. Resolved Questions

Resolved by the maintainer on 2026-10-02.

| # | Question | Decision | Rejected alternative |
|---|---|---|---|
| Q1 | Fork lineage | Copy the branch path into the new log and record a `forked_from` entry | Read-through to the parent log |
| Q2 | Extension isolation | In-process with advisory permissions; revisit per-extension worker processes after Phase 7 | Per-extension worker processes now |
| Q3 | Durability of extension UI declarations | Ephemeral live-lane state, replayed on attach; an extension re-declares after a runtime restart | Durable log entries |
| Q4 | Work progress durability | Coarse `work_checkpoint` entries; fine progress in the live lane | All progress durable; only start and finish durable |
| Q5 | Where shared schemas live | A new `packages/protocol` owns the log envelope and core entries, frames, `UiNode`, and the contract artifact (§5.1) | `UiNode` TypeBox schema owned by packages/tui; plain tui types mirrored in coding-agent |
| Q6 | Role of packages/agent | Product-agnostic kernel | Merging it into coding-agent |
| Q7 | Review anchors, general state, discussions | Become log entries in Phase 4; side tables survive only as derived indexes | Keep side tables with their own CAS counters |
| Q8 | Release cut | 0.3.0 after Phase 7 | After Phase 6 or Phase 3, with later phases as further minor releases |
| Q9 | Built-in tool rendering | Every tool, built-in included, renders through `present()`; clients contain no tool-specific code | First-party client renderers with `present()` as fallback |
| Q10 | Extension instance scope | One instance per conversation, as today | One instance per host process |

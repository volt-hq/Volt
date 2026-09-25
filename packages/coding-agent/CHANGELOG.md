# Changelog

## [0.2.0] - 2026-09-25

### Highlights

- Added a Simplified Technical English personality for user-facing responses without changing code or repository artifacts.
- Agents can now use [`web_fetch`](https://volt-cli.dev/docs/usage/#tool-options) to retrieve approved public URLs as bounded readable text after `web_search` or a user-provided link.
  Only links supplied by the user or returned by approved tools are eligible. Non-public destinations are rejected before and after redirects, and response size, parsing work, metadata, and DNS cancellation remain bounded.

  Readable HTML extraction removes navigation and footer chrome while preserving code formatting.
- Added bounded first-request preparation waits, structured LSP discovery, and exact loaded-skill reads for managed extensions. ([#435](https://github.com/volt-hq/Volt/issues/435))
- Added GPT-6 Astra support for OpenAI API, Azure OpenAI, and ChatGPT OAuth.
- Added managed extension tasks, policy-aware repository reads, and ready-only context contributions. ([#431](https://github.com/volt-hq/Volt/issues/431))
- Added subscription-backed managed relay access that moves securely between paired computers. ([#309](https://github.com/volt-hq/Volt/issues/309))
- Added native read-only [Plan mode](https://volt-cli.dev/docs/quickstart/#switch-models) with structured checklists and an explicit, context-clearing handoff into execution.
- After a response sits idle for a minute, the transcript records how long the work took and when it finished.
- Answer focused agent questions with keyboard choices, free-form input, notes, and a review step without leaving the conversation.
- Configure host auto-compaction and exact-model token thresholds from a paired phone with scope-aware, stale-target-safe controls.
- Added session-scoped [Fast mode](https://volt-cli.dev/docs/usage/#slash-commands) with `/fast` controls, a TUI status indicator, and OpenAI Priority processing for eligible OpenAI and OpenAI Codex models. ([#110](https://github.com/volt-hq/Volt/issues/110), [#111](https://github.com/volt-hq/Volt/issues/111), [#112](https://github.com/volt-hq/Volt/issues/112))
  Fast mode persists per branch independently from thinking, synchronizes across attached clients, carries into review inference and findings sessions, and is advertised only for models that support it.
- Added [GPT Image 2 generation and editing](https://volt-cli.dev/docs/usage/#tool-options) for local, attached, and conversation images when using an OpenAI Codex model.
- Added an optional [fullscreen interactive mode](https://volt-cli.dev/docs/usage/#other-options) with fixed input controls and application-owned transcript scrolling.
  Start it with `--tui-mode fullscreen` or select it in `/settings`; regular terminal-owned native scrollback remains the default.
- Review runs retain their current General destination across context replacements and host restarts.
- [Remote clients can now run detached reviews](https://volt-cli.dev/docs/rpc/#detached-review-workflows) of uncommitted changes, branches, commits, and pull requests while the conversation remains available. ([#66](https://github.com/volt-hq/Volt/issues/66), [#80](https://github.com/volt-hq/Volt/issues/80))
  Accepted invocations return a workflow ID immediately and stream sanitized progress events. Clients can fetch findings, list or cancel workflows, and open completed findings in a fresh session on demand.
- Run Bash commands and subagent tasks in the background while Volt continues independent work.
  Use `background: true` on native Bash or confirmed subagent spawning calls, then use `jobs` to list, read, wait for, or cancel the work. Jobs retain bounded output and respect session cancellation, tool grants, and branch ownership. Running jobs do not survive runtime shutdown or restart.
- [Subagents can now discover, follow, and resume runs across the session tree](https://volt-cli.dev/docs/usage/#subagents-mvp), with bounded pagination and confirmation before duplicate work starts. ([#129](https://github.com/volt-hq/Volt/issues/129), [#136](https://github.com/volt-hq/Volt/issues/136), [#146](https://github.com/volt-hq/Volt/issues/146))
  Spawn preflights show the live registry and require exact one-time confirmation before new work starts, helping agents reuse equivalent runs instead of duplicating them.

  Interrupted children can resume from their transcripts after restarts or disconnects. Registry listing and follow remain available when spawning is disabled, and followed output remains explicitly marked as untrusted data.
- The footer now counts down to prompt-cache expiry and warns when the next message will resend the conversation uncached, and RPC clients receive the same status through get_state and prompt_cache_changed.
- Volt keeps supported prompt caches warm while work runs and for 15 minutes after it finishes, so long tool calls and short breaks no longer resend the whole conversation uncached.
  Keepalive replays the previous request without output about a minute before the cache expires (Claude models on the Anthropic Messages API today, with adaptive thinking or thinking off; requests with a Claude 4.5 thinking budget are not refreshed or shown as warm). Extension commands count as work, including while they wait for your input. The footer shows `cache warm 12m` while the idle window runs, refresh costs count toward session totals, and `promptCache.keepAlive` / `promptCache.keepAliveIdleMinutes` or `/settings` control it. After each real request, refreshing stops once it would cost more than the cache miss it avoids (24 refreshes on Opus 5.5's 5-minute cache), and a late timer skips its refresh instead of risking a full-price cache write.
- Volt writes metadata-only prompt-cache audit logs to ~/.volt/agent/prompt-cache-audit/ so cache hit rates and keepalive costs can be compared over time.
  Records cover request token counts and gaps, refresh outcomes and costs, and keepalive stops, never prompt or response content. Set `VOLT_PROMPT_CACHE_AUDIT=0` to turn them off.
- Added an offline, read-only `volt lsp audit` command with content-free usage, outcome, freshness, and latency reports across saved sessions.
- Added per-model auto-compaction token thresholds, configurable with Compact at in /settings or settings.json.

### Breaking Changes

- **agent:** Changed low-level agent dispatch to use delivery-aware next actions and explicit event-stream failure propagation.
  Exhaustive `AgentEvent` consumers must handle `delivery_start`. Low-level loops now always use delivery-aware dispatch: migrate `prepareNextTurn` to `prepareRequest`, and replace `shouldStopAfterTurn`, `getSteeringMessages`, and `getFollowUpMessages` with `nextAction` plus explicit deliveries. Migrate queued-message hooks to an `AgentDeliveryOwner` installed before admission.
- **tui:** Changed custom components to return explicit render frames so terminal image placement survives composition.
  Migrate `render(width): string[]` to `render(width): RenderFrame` and wrap text-only output with `createRenderFrame(lines)`. Use the exported frame composition helpers instead of flattening `child.render(width).lines` when building another component.
- **tui:** Replaced the constructible `TUI` class with explicit main-screen and fullscreen renderers.
  Migrate `new TUI(terminal)` to `new TuiMainScreen(terminal)` and use `TUI` only as a renderer-neutral type. Use `TuiAltScreen` when the application needs an alternate-screen viewport and constrained `VStack`/`HStack`/`ScrollView` layout.
- **remote:** Changed paired-device defaults to track daemon tool grants and include `host.manage.v1`, `inspect`, and `lsp` capabilities. ([#153](https://github.com/volt-hq/Volt/issues/153), [#154](https://github.com/volt-hq/Volt/issues/154))
  Devices paired before this release retain their frozen pair-time tool grant and no longer receive extension-registered tools through the default grant. Re-pair the device or reset its access to the coding preset to adopt the tracking grant. Explicitly customized grants remain pinned.

  `host.manage.v1` enables capability advertisement, host-action responses, and keep-awake without a custom access grant. The `inspect` and `lsp` tools make Plan mode inspection available from paired devices; `lsp` is classified as unsafe alongside `bash`, `edit`, and `write` because its rename and fix actions can edit workspace files.
- **remote:** Removed ActivityKit Live Activity support from remote sessions.
  Clients must stop sending `register_live_activity` and `unregister_live_activity` RPC commands or ActivityKit token data in `register_push_target`. Use ordinary completion notifications through `register_push_target` instead.
- **agent-session:** Removed Agent injection and mutable runtime exposure from AgentSession.
  Construct `AgentSession` with model, stream, conversion, and queue configuration. Use the explicit session capabilities for abort, runtime events, transport, active tool projections, and scoped turn policy.
- **agent:** Removed the legacy Agent wrapper in favor of AgentHarness.
  Migrate stateful integrations to `AgentHarness` with a `Session` and execution environment, or use `agentLoop()` only when the host owns persistence and lifecycle orchestration.
- **subagents:** Replaced implicit delegation-tree consumption budgets with explicit structural safeguards and host-configured token, cost, and deadline limits.
  Hosts that rely on finite tree-wide token, cost, or deadline budgets must configure them explicitly. Hosts that need more than depth 5, 100 total starts, or 16 concurrently active descendants must raise the corresponding `SubagentManagerOptions.delegationLimits` values.

  Structural admission failures reject only new starts without aborting admitted descendants. Per-call, per-definition, and per-child turn safeguards continue to apply.
- **daemon:** UI action invocations now require a correlation ID that the daemon echoes in every response.
  Clients must add a unique, trimmed, non-empty `id` of at most 256 UTF-8 bytes to every `invoke_ui_action` command and correlate the result using the identical response `id`. Invocations without a usable id now receive an uncorrelated `command: "invalid"` failure instead of an id-less `invoke_ui_action` response.
- **review:** Upgraded review to immutable two-pass verification with durable structured findings and lifecycle actions. ([#228](https://github.com/volt-hq/Volt/issues/228))
  RPC clients must migrate review results from transient workflow IDs and legacy `file`/`line` and model-authored coverage fields to durable run IDs, structured change/evidence locations, verification metadata, and host-derived coverage. Clients must also handle complete and incomplete results, paginate durable run listings, and use the new finding lifecycle actions.

  The lifecycle now also:

  - Opens all findings when a blank finding selection starts a fix session.
  - Persists detached review records for empty sessions across restarts.
  - Reports incomplete reviews consistently through host actions, detached workflows, and notifications.
  - Inherits unchanged incremental coverage only from the requested compatible completed review.
  - Requires verification passes to independently inspect in-scope changed files before completion.
  - Keeps feedback export local-only so remote clients cannot write caller-selected host paths.
  - Allows paired remote clients to record outcomes, rerun reviews, and publish reviews.
  - Preserves changed-line locations when reviewed source begins with diff header markers.
  - Keeps reviews with unsupported in-scope changes incomplete.
- **remote:** Local development credential brokers now support separate approvals and repeated pairings on the same device using nonce-prefixed proofs.
  Development callers must replace bare shared-secret `signedAppTransaction` values with `<64-lowercase-hex nonce>.<shared secret>`. Generate the nonce with `openssl rand -hex 32` once per new proof instance and retain the exact composed proof, device ID, app node ID, and refresh-token hash for retries of the same claim. New pairings require a fresh nonce; keep the device ID stable. `VOLT_DEVELOPMENT_APP_STORE_PROOF` remains the shared secret. No database reset or migration is required, and Apple verification is unchanged.
- **rpc:** Added explicit epoch and sequence positions to assistant streaming frames. ([#72](https://github.com/volt-hq/Volt/issues/72))
  RPC clients must adopt assistant base, snapshot, and final frames unconditionally, apply only contiguous compact deltas within an epoch, and seed resumable tool arguments from snapshot `toolState`. TypeScript clients can use `StreamProjectionDecoder` for this reconstruction.
- **jobs:** Background-job waits now suspend until selected jobs finish or steering arrives, without repeated polling turns.
  Replace `jobs wait` arguments using `id` with `ids: [id]`. The default `mode` is `any`; use `all` to await every selected job. Waits no longer have a default deadline; supply `timeoutMs` (0–300000) when a bounded wait is required. Wait results use a `backgroundJobWait` envelope with terminal `results`, metadata-only `pending` jobs, and a `reason` rather than a single `backgroundJob` snapshot. `read` and `cancel` continue to use `id`.

  Source launchers enable private, metadata-only background-job performance logs. Set `VOLT_BACKGROUND_JOB_DIAGNOSTICS=0` to disable them. Logs stay outside conversations and can be analyzed with the repository performance-report script.
- **plan:** Activating Plan mode is now asynchronous so its read-only Git, GitHub, and explicitly trusted MCP inspection tools are ready before planning starts.
  SDK migration: `AgentSession.setAgentMode()` is now asynchronous. Callers must `await session.setAgentMode(...)` before reading planning state or active tools.
- **agent:** Replaced tool termination hints with bounded final-response dispositions and added typed local abort provenance. ([#199](https://github.com/volt-hq/Volt/issues/199))
  Migrate `AgentToolResult.terminate` and `AfterToolCallResult.terminate` to `disposition: "stop"`; use `disposition: "final_response"` when a successful tool should authorize one additional tool-free response.
- **sessions:** Enforced lossless JSON data for persisted session payloads and isolated event snapshots while containing subscriber failures. ([#213](https://github.com/volt-hq/Volt/issues/213))
  Custom messages, tool details and updates, diagnostics, compaction details, branch summaries, and extension replacements must now use plain JSON values. Replace `Map`, `Set`, `Date`, typed arrays, shared memory, cycles, and other rich objects with plain object, array, string, number, boolean, or null representations, and omit optional properties instead of assigning `undefined`.
- **remote:** Remote conversations now use an atomic resumable attachment and input-delivery protocol across reconnects and daemon restarts.
  Remote conversation clients must upgrade with the daemon because conversation attachment now uses the versioned atomic bootstrap-and-tail protocol instead of the legacy snapshot replay sequence.

  Prompt, steer, and follow-up commands now require a stable `clientMessageId`, which the host echoes on the canonical user transcript entry.

  The host now durably deduplicates prompt, steer, and follow-up retries by `clientMessageId`, including across daemon restarts. Input acknowledgements and queued delivery remain durable across branch changes, outstanding records are bounded, and audits identify the acting device.
  Private retry receipts never appear as blank conversations in local or remote session history.

  Conversation runtime, lease, direct-stream, and relay ownership now remain under one stable coordinator through handoff, rekey, reconnect, and retirement.
- **streaming:** Made assistant streaming events immutable and self-contained. ([#72](https://github.com/volt-hq/Volt/issues/72))
  Custom providers must emit fragments through `AssistantStreamNormalizer`. Event consumers must read the immutable `snapshot`, contiguous `seq`, and typed `toolState` fields instead of `partial` or provider-owned argument scratch fields.
- **sessions:** Made session listing, exact-ID resolution, continuation lookup, and remote history discovery independent of transcript payload size by moving live session storage to SQLite ([#328](https://github.com/volt-hq/Volt/issues/328)).
  Persisted `SessionManager.create`, `open`, `continueRecent`, and `forkFrom` calls are now asynchronous. Replace live session-file paths and `getSessionFile()` with `SessionReference` values and `getSessionRef()`. JSONL remains available only for explicit current-format snapshot import and export. Awaited `AgentSession` or `AgentSessionRuntime` disposal releases its manager; callers that directly own a persisted `SessionManager` must await `closePersistence()`. Deep fuzzy, phrase, and regex search still scans extracted searchable text, bounded to one session document in memory at a time.
- **caching:** Replaced legacy long-cache flags with model-specific prompt-cache metadata and provider overrides.
  Custom providers and `models.json` configurations must replace `compat.supportsLongCacheRetention` with model or provider `promptCache` metadata. Declare `retention.long` to enable the `long` preference, or set `promptCache` to `null` in an override to clear inherited cache behavior for an incompatible proxy.
- **boundaries:** Public input, reducer, session-state, and queue-publication boundaries now expose owned readonly projections.
  Migrate code that assigns through `AgentSession.state` to the corresponding session mutation APIs; every state property and its tool/message arrays, pending-tool set, and pending-tool map are now readonly. `AgentHarness.steer()` and `followUp()` now resolve only after passive queue publication completes, while `queueSteer()` and `queueFollowUp()` remain synchronous.
- **review:** Added durable parallel finding discussions with independent read-only conversations and upgraded session storage. ([#341](https://github.com/volt-hq/Volt/issues/341))
  Before opening existing session stores with this version, stop older Volt CLI and daemon processes that own those stores. The first open upgrades the exact supported v1 schema transactionally to v2 while preserving sessions and transcripts. Older binaries cannot reopen upgraded stores. Update the iOS companion together with the host; the discussion RPC contract has no older-host fallback.
- **review:** Review runs retain initial-review request, token, and model-priced cost accounting across completion and interruption ([#409](https://github.com/volt-hq/Volt/issues/409)).
  RPC clients must accept the `unfinished` review status and an absent `endedAt` until a terminal result is committed. Use `usage` summaries and `usageBreakdown` details instead of reconstructing cost from workflow events; absent historical accounting is explicitly unavailable. Costs are model-priced USD estimates, not invoices or subscription charges. Initial-review usage remains separate from discussion usage.

  Custom text providers should set `Usage.availability` to `complete`, `partial`, or `unavailable` according to reported counters; missing metadata is unknown, not reported zero.
- **policy:** Background jobs no longer resume runs explicitly stopped by host turn policies.
  SDK hosts must return `undefined` from next-action hooks and registered turn policies when leaving the suggested action unchanged, rather than returning `context.defaultAction`. Return `pause` for resumable interruptions such as compaction; an explicit `stop` revokes automatic continuation for existing jobs without cancelling workers or discarding their results. Natural completion still permits background wakes, and later explicit prompts remain available.
- **session:** Canonical continuations and structural operations now use store-issued cursors and guarded atomic batches. ([#211](https://github.com/volt-hq/Volt/issues/211))
  Custom `SessionStorage` implementations must provide atomic branch snapshots, exact/descendant guarded `commitBatch()` operations, opaque mutation receipts, and committed/rolled-back/uncertain classification. Harness continuation state now tracks a `ProjectionCursor` plus owned overlay messages; canonical appends reconcile, rewrites invalidate arbitrary overlays, compaction installs a replacement, and tree navigation clears it.

  Runs, compaction, and tree navigation share one Harness operation coordinator. Structural hooks remain abortable until the coordinator seals and submits their single noncancelable canonical commit.
- **delivery:** Replaced delivery participants with stable owners, attempt-bound store receipts, and fence-first closure. ([#205](https://github.com/volt-hq/Volt/issues/205), [#207](https://github.com/volt-hq/Volt/issues/207), [#214](https://github.com/volt-hq/Volt/issues/214))
  Replace `prepareDelivery` and transaction participants with an `AgentDeliveryOwner` installed before admission. Implement side-effect-free `prepareLogical()`, atomic `commitAttempt()`, and passive `finish()`; committed and retained outcomes require store-verifiable receipts bound to delivery ID, inbox epoch, attempt ID, and exact canonical projection delta.

  `AgentHarness.dispose()` is now a synchronous fence-only alias for `requestClose()`. Call `waitForClosed()` externally to join active operations, delivery settlement, notifications, and persistence. Owner callbacks may request abort or close but must not join closure from inside themselves.
- **rpc:** Changed `message_update` frames to carry only deltas instead of accumulated partial messages. ([#44](https://github.com/volt-hq/Volt/issues/44))
  Every `message_update` frame previously serialized the full accumulated assistant message twice (as `message` and as `assistantMessageEvent.partial`), making streaming bandwidth quadratic in message length on stdio RPC, Iroh remote, `--mode json`, and daemon viewer feeds. Frames now carry only the streaming delta; `message_start` seeds the accumulator, `message_end` carries the final message, and a client attaching mid-message receives one full `message` snapshot on its first update. Daemon viewer feeds still carry full messages but drop the duplicated partial.

  Migration: clients using the bundled RPC client (`RpcClientBase` and SDK clients built on it) are unaffected — full `message` and `partial` fields are reconstructed transparently. Clients reading raw JSONL frames must accumulate deltas per the reconstruction rules in `docs/rpc.md` (`text_delta`/`thinking_delta` append to the block at `contentIndex`; `toolcall_start` carries an id/name stub, `toolcall_delta` streams raw argument JSON, `toolcall_end` is authoritative), or read only `message_end` for final content.
- **extensions:** Omit prepared context when tool policy changes before provider admission, without retrying validation. ([#433](https://github.com/volt-hq/Volt/issues/433))
  Host turn policies now snapshot callbacks: replace mutation of a registered policy object with `registration.update(nextPolicy)`. After changing callback closure state, call `registration.invalidate()` synchronously. Extension `tool_call` and `tool_result` registrations return the same update/invalidate/removal handle; loaded handler lists are host-owned rather than mutable maps.

  Custom Harness request-boundary callbacks must return `{ messages, authorization: { isCurrent, settle } }` instead of a message array. Both authorization callbacks are synchronous; `settle` reports final provider-handoff inclusion or omission, not provider success. Do not change authority or invoke extension code from these callbacks.

### Improvements

- **agent:** Added collaborative and pragmatic personality options selectable from settings and the TUI.
- **agent:** Added ordered AgentHarness host-policy hooks, optional-model startup, and complete provider stream configuration.
- **agent:** Improved task continuity across side questions and compaction, clarified approval blockers, and reduced unnecessary repeated validation. ([#356](https://github.com/volt-hq/Volt/issues/356))
- **agent:** Kept coding tasks scoped to the requested outcome when reviews or validation reveal unrelated issues.
- **blog:** Made the Volt origin story easier to discover from the GitHub repository.
- **cli:** Reduced cold startup latency for npm installations by shipping a bundled CLI entrypoint. ([#285](https://github.com/volt-hq/Volt/issues/285))
- **compaction:** Compact context in one cache-preserving request when it fits, with a small summary budget, bounded retries and cancellation-safe fallback for oversized input.
  Built-in summary generation keeps the current reasoning setting for cache reuse, requests at most 4096 summary tokens, and has a five-minute deadline. Empty, truncated, tool-calling or overlong summaries leave the original context intact.
- **compaction:** Show and save cache-hit token usage for each compaction request, keeping native requests, retries, and chunked fallbacks separate.
- **compaction:** Added opt-in redacted Codex request diagnostics to compare compaction cache reuse with normal replies.
- **daemon:** Associated trusted sessions with exact pull requests in remote Work lists.
- **daemon:** Preserved each new session's starting Git context for remote work organization.
- **daemon:** Reduced background daemon memory usage by favoring memory-efficient Node.js optimizations.
- **daemon:** Preparing successive pull-request reviews is faster when checkouts for other pull requests are retained. ([#426](https://github.com/volt-hq/Volt/issues/426))
- **docs:** Updated the product philosophy to reflect native Plan mode and subagents.
- **extensions:** Added an opt-in deterministic context-preparation example with bounded skill and source excerpts. ([#437](https://github.com/volt-hq/Volt/issues/437))
- **lsp:** Automatic diagnostics now report bounded changes with freshness labels, independent check controls, and conservative Swift project-context evidence.
- **lsp:** Make language-server failures and diagnostic freshness explicit, validate native TypeScript compatibility, and support Swift/SourceKit without automatic project setup.
- **lsp:** Enabled navigation, diagnostics, and refactoring across workspace boundaries, including sibling repositories and symlinked dependencies.
- **lsp:** Inspect language-server readiness, capabilities, failures, and idle or disabled state without starting servers, while Plan mode blocks automatic repair installs.
- **lsp:** TypeScript projects now use TypeScript 7's native language server for diagnostics and navigation. ([#334](https://github.com/volt-hq/Volt/issues/334))
- **mcp:** Find tools with fewer discovery calls and retrieve selected fields or complete rows from cached results without loading entire catalogs or outputs into context. ([#469](https://github.com/volt-hq/Volt/issues/469))
- **models:** Added GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5 with updated pricing and supported reasoning levels, and refreshed the provider model catalog.
- **plan:** Plan details now wrap complete checklists, and planning updates show focused semantic checklists instead of JSON.
- **plan:** Plan execution now freezes approved scope and requires explicit reapproval before structural changes.
  Plan state now travels through append-only checkpoints and progress results so ordinary planning and execution turns remain provider-cacheable.
- **plan:** Plan mode now creates a working draft early and refines it as research changes its understanding.
- **plan:** Made submitted plans self-contained for current-context and fresh-session execution.
- **prompts:** Actionable questions now execute in the same turn unless safety, authority, or material ambiguity requires clarification.
- **providers:** Updated available models, pricing, and token limits from provider catalogs, including Vercel AI Gateway.
- **release:** Stable releases now publish through npm `latest` and GitHub's latest non-prerelease channel.
- **remote:** Remote clients can now inspect session branches without loading the full conversation tree. ([#240](https://github.com/volt-hq/Volt/issues/240))
- **remote:** [Configured remote agents](https://volt-cli.dev/docs/daemon/#configured-remote-agents) can now discover read-only workspace defaults and retry caller-named conversation creation safely.
  Clients can discover workspace model defaults without side effects, provision worktrees separately, and safely retry the normal configured attach flow with the same session identity.
- **remote:** [Managed relay enrollment](https://volt-cli.dev/docs/daemon/) now runs through the normal daemon pairing flow, so paired iOS clients connect without manually configured relay credentials.
  The credential service refreshes and explicitly revokes node-bound credentials, persists state across broker restarts and replicas, and keeps enrollment retryable through reconnects, pairing cancellation, daemon restarts, and stalled networking.

  Production and canary relay fleets are bound to their exact broker and relay origins. Expired, revoked, or cross-environment credentials are rejected, and established connections close when access expires.
- **remote:** Remote clients can now display [path-free Git context](https://volt-cli.dev/docs/rpc/#get_state), including branch, divergence, operation, and status, from session state and live updates.
- **remote:** Added authoritative start and end times to detached review lifecycle events.
- **remote:** Added host-authoritative agent run timestamps so connected clients can show accurate elapsed time.
- **remote:** Added plan-ready and target-aware review completion notifications with canonical workspace metadata. ([#151](https://github.com/volt-hq/Volt/issues/151))
- **remote:** Notification deep links now open on their source host. ([volt-app#118](https://github.com/volt-hq/volt-app/issues/118), [#289](https://github.com/volt-hq/Volt/issues/289))
- **remote:** Remote clients can request a correlated assistant-stream recovery snapshot after detecting frame loss, restoring live transcripts without waiting for the message boundary.
  Recovery validates the client's exact stream position and continues from a matching checkpoint.
- **remote:** Iroh handshake failures now distinguish permanently missing workspaces (`workspace_missing`) from transiently unavailable ones (`workspace_unavailable` with a `retryAfterMs` hint), so clients can stop or pace retries. ([#88](https://github.com/volt-hq/Volt/issues/88))
- **remote:** Made mobile Work discovery load only the pinned session context it needs.
- **remote:** Phone pairing QR codes render as sharp images in terminals with Kitty or Sixel graphics, so they fit standard 80x24 windows such as Windows Terminal.
- **remote:** Made /remote explain relay access problems and guide confirmed credential resets into fresh phone pairing.
- **remote:** Made reviews started in the TUI visible and cancellable from paired Volt apps.
- **remote:** Reduced remote session resume overhead for long histories.
- **remote:** Review discussions apply the selected chat model and thinking level before their first turn and retain them on reset.
- **remote:** Remote clients can now retrieve complete sanitized assistant transcript text for the latest turn and paginated older entries. ([#85](https://github.com/volt-hq/Volt/issues/85), [#86](https://github.com/volt-hq/Volt/issues/86))
  The branch-latest assistant message is served complete (up to the 256 KiB live assistant content budget) in conversation bootstraps, resync checkpoints, `get_transcript` head pages, and its transcript commit frame. Older or over-budget entries remain bounded in transcript pages and can be retrieved through the paginated `get_transcript_entry_text` RPC.
- **review:** Show concise review results with expandable evidence and clear static-validation limits. ([#359](https://github.com/volt-hq/Volt/issues/359))
- **review:** Added pull request discussions and linked issue context to both review passes.
- **review:** Exposed pull request headers and truthful changed-file summaries to paired apps. ([#331](https://github.com/volt-hq/Volt/issues/331))
- **review:** Reduced Git subprocess overhead when preparing and validating PR review checkouts.
- **review:** Finding discussions use their finding titles in session lists and chat headers. ([#341](https://github.com/volt-hq/Volt/issues/341))
- **review:** The footer now displays the active review context and cumulative review cost.
- **rpc:** RPC client authors can now validate integrations against the committed `packages/coding-agent/contract/rpc-schema.json` JSON Schema, which CI keeps aligned with the wire contract.
- **rpc:** RPC commands now reject unknown fields and validate every command type against the schema-derived contract.
- **rpc:** Local and remote clients can now complete workspace branch names for the `review.branch` action through `get_ui_action_completions`. ([#79](https://github.com/volt-hq/Volt/issues/79))
- **rpc:** RPC clients can list, inspect, and cancel background jobs, receive live status updates, and recover current job summaries after reconnecting.
- **rpc:** The host now emits a terminal `subagent_disposed` event whenever it releases a local RPC-managed subagent (abort, dispose, failed start, or a session switch disposing active subagents). ([#44](https://github.com/volt-hq/Volt/issues/44))
  Host-side disposals (for example a session switch while a subagent streams) previously produced no terminal frame, so the bundled RPC client retained that subagent's message-delta accumulator indefinitely. The bundled client now drops the accumulator on `subagent_disposed`; raw-frame consumers should treat it as the end of that subagent's event stream.
- **session:** Session saves no longer block active conversation work while preserving ordered, durable shutdown and handoff behavior. ([#46](https://github.com/volt-hq/Volt/issues/46))
- **sessions:** Bounded deep-search accumulation to one session document while preserving matching and ranking.
- **sessions:** Kept live session history listings responsive for long conversations.
- **sessions:** Kept long session saves responsive as conversation history grows.
- **sessions:** Made cold session browsing avoid full-store foreign-key scans during routine opens.
- **site:** Added blog social metadata, RSS discovery, and crawler guidance.
- **site:** Updated the public site to use Volt's app icon, purple TUI palette, and current product links.
- **sqlite:** Reduced session listing, recent-session lookup, and SQLite index write overhead for workspaces with long histories.
- **subagents:** Reduced in-process subagent streaming overhead by roughly 4–7× for long outputs.
  Parent-child RPC frames now pass as structured objects in-process, avoiding repeated serialization and quadratic work.
- **subagents:** Made subagent delegation local-first by default. ([#143](https://github.com/volt-hq/Volt/issues/143))
- **subagents:** Long-running subagents now receive a wrap-up warning at 80 turns and a tool-free final-report prompt at 120 turns.
  Host `turnLimits` overrides stay consistent: an unset warning threshold clamps to `min(80, maxTurns)`, an explicit `warnAtTurns` above a finite `maxTurns` is rejected, and an infinite `maxTurns` without an explicit warning disables both stages.
- **tools:** Bash commands that stop producing output are now killed as hung after five minutes, and timed-out commands no longer leave stray processes running. ([#125](https://github.com/volt-hq/Volt/issues/125))
  Silence, not elapsed time, is what separates a hung command from a slow one, so long-running commands no longer need an inflated `timeout` to stay safe. Pass `stallTimeout` to adjust the window for commands that are legitimately quiet for long stretches, or `0` to disable the check. Explicit `timeout` values are now capped at one hour.

  Teardown now enumerates the whole process tree before signalling, so a child that moved itself into its own process group — as test runners and daemons commonly do — is killed rather than orphaned. Commands also get a brief SIGTERM grace period to clean up before SIGKILL.
- **tui:** Background jobs now show live status, elapsed time, and recent output, with a `/jobs` inspector for scrolling output and cancelling individual jobs ([#378](https://github.com/volt-hq/Volt/issues/378)).
- **tui:** Background jobs use a single compact status line, and completed, failed, or cancelled notices disappear after the agent collects their results.
- **tui:** Reduced duplicate background-job details by keeping one main card, hiding redundant completion notices, and collapsing inspection snapshots to expandable single-line entries.
- **tui:** Simplified job tool cards by hiding collapsed IDs, redundant snapshot labels, duplicate hints, and model-only wait instructions while keeping status and output warnings visible.
- **tui:** Fullscreen mouse-wheel scrolling now moves three lines per event instead of one.
- **tui:** Improved the startup wordmark's V alignment.
- **tui:** Expanded OpenAI Codex GPT-5.6 Sol sessions to a 1M-token context window and added a configurable 350K-token context warning threshold.
- **tui:** Added a responsive plan inspector that keeps canonical plan lifecycle state visible beside the conversation in regular and fullscreen modes.
  Wide terminals keep at least 80 columns for the conversation and show a focusable, independently scrollable 48–72-column plan pane above the full-width footer. Compact terminals retain Plan Details, while responsive transitions preserve regular-mode scrollback and fullscreen paging, search, pointer routing, images, overlays, and custom UI focus.
- **tui:** Show background job completion notices with clear statuses and task names instead of internal instructions.
  Expand job details with the configured tool-output shortcut to see full job IDs and elapsed times. Model-facing notices remain unchanged.
- **tui:** Show live tool preparation and execution progress, with bounded private debug capture and never-started call diagnostics.
- **tui:** Reduced Plan mode noise with compact working drafts and grouped execution substeps that expand only when relevant ([#314](https://github.com/volt-hq/Volt/issues/314)).
- **tui:** Added negotiated [Sixel image rendering](https://volt-cli.dev/docs/terminal-setup/#windows-terminal) in Windows Terminal 1.22+, including fullscreen scrolling, cropping, and stale-image repainting.
  Sixel output uses deterministic adaptive quantization with up to 256 colors for improved fidelity without dithering.
- **usage:** Added normalized [subscription quota reporting](https://volt-cli.dev/docs/usage/#slash-commands) through `/usage` and local or paired-device RPC for Claude and ChatGPT OAuth logins. ([#260](https://github.com/volt-hq/Volt/issues/260))
- **web-search:** Structured OpenAI and OpenAI Codex search results now use roughly 14x less context and respect requested result limits.
- **website:** Added privacy and terms pages for Volt's managed services.
- In-app release notes and extension catalog links now point to the Volt repository under the `volt-hq` GitHub organization.

### Fixes

- **agent:** Prevented session message snapshots from mutating canonical conversation history.
- **agent:** Exported usable branch-summary options and allowed successful tools to return non-cloneable details when no result hooks are registered.
- **agent:** Fixed retries, compaction, and paused continuations losing current context or final-response authority.
- **agent:** Canceled prompt preflights and retained delivery retries now preserve the context they were admitted with.
- **agent:** Made automatic context compaction retry transient summary failures, stop safely when recovery cannot complete, and use supported reasoning levels.
- **agent:** Prevented long tool-heavy sessions from exhausting memory as session history grows.
- **agent:** Fixed structural requests bypassing provider policy and no-op continuation requiring model-backed state.
- **agent:** Prevented automatic session naming from breaking tool continuations.
- **agent:** Prevented new turns and pending operations from starting while session cancellation drains background work. ([#380](https://github.com/volt-hq/Volt/pull/380))
  Hosts can share an `AgentHarnessAdmissionGate` across foreground and detached work. Cancellation preserves queued context and job inspection, and admission resumes after cleanup unless the session was disposed.
- **ai:** Batched streaming tool previews and stopped overloaded event queues from growing without a bound. ([#354](https://github.com/volt-hq/Volt/issues/354))
- **ai:** Bound tool argument preparation with independent time and byte budgets, and stop safely when a limit is reached. ([#350](https://github.com/volt-hq/Volt/issues/350))
- **ai:** Fixed Claude Opus 5 and Claude Sonnet 5 requests failing with a 400 error when thinking or a temperature is set, and made their xhigh and max thinking levels available.
  Claude models now use adaptive thinking unless they are Claude 4.5 or earlier, and omit temperature from Claude 4.7 onward, so new Claude releases no longer need a code change to accept these requests. Claude Opus 4.7 and later expose the max thinking level on Anthropic, Amazon Bedrock, and gateway providers. GitHub Copilot now routes Claude 5 models through the Anthropic Messages API. Amazon Bedrock application inference profiles whose name mentions Claude without a version now use adaptive thinking.
- **ai:** Fixed malformed diagnostic getters interrupting otherwise valid streamed responses and compaction.
- **ai:** Fixed resumed conversations failing with orphaned tool results after interrupted tool generation. ([#355](https://github.com/volt-hq/Volt/issues/355))
- **ai:** Let long document and tool arguments keep streaming while bytes arrive, timing out after five minutes without progress by default.
  Use `toolArgumentLimits.maxIdleMs` to adjust the idle timeout. A total preparation deadline applies only when `toolArgumentLimits.maxDurationMs` is explicitly configured. Byte limits and complete-JSON validation still apply before execution.
- **anthropic:** Updated Claude subscription request headers to match the verified Claude Code 2.1.280 client identity.
- **atomic-append:** Fixed uncertain atomic session appends without exposing stale live conversation state. ([#217](https://github.com/volt-hq/Volt/issues/217))
  Reconciliation now classifies storage effect separately from generation authority, retires stale managers before they can overwrite newer session bytes, fences queued canonical projection responses, and permits a fresh runtime generation to reopen the authoritative session.
- **caching:** Codex models that opt out of prompt-cache retention no longer reuse WebSocket connections or continuation state.
- **compaction:** Fixed compaction failing on Claude adaptive-thinking models such as Opus 5.5, on Anthropic and Amazon Bedrock, because thinking used up the summary's output limit.
- **compaction:** Preserved other models' compaction thresholds when multiple sessions save global or profile settings.
- **compaction:** Compaction now reserves context for active tool definitions and keeps retained messages within the effective budget.
- **compaction:** Kept the full conversation in native compaction requests to improve cache reuse while preserving recent messages verbatim.
- **compaction:** Preserved earlier constraints and progress when fallback compaction splits an ongoing turn with no complete history turns.
- **compaction:** Recover from provider context overflows that return no summary output by using chunked compaction, while continuing to reject genuinely truncated summaries.
- **compaction:** Fixed threshold compaction repeatedly re-triggering when a conversation ended in a long run of tool results; the compaction cutoff now advances past trailing tool results, and the reported estimate matches the context actually retained for the retry. ([#25](https://github.com/volt-hq/Volt/issues/25))
- **daemon:** Prevented closed Iroh transcript streams from crashing voltd. ([#57](https://github.com/volt-hq/Volt/issues/57))
- **daemon:** Keep active managed checkouts protected from reclamation when the daemon disconnects or restarts. ([#442](https://github.com/volt-hq/Volt/pull/442))
- **daemon:** Concurrent daemon starts wait for the winning daemon to become ready instead of failing when the losing process exits.
- **daemon:** Made daemon restarts recover promptly from stalled network teardown without interrupting admitted work.
  Accepted remote streams, pairing tickets, control requests, and startup state now drain within a bounded shutdown window before durable state closes. If the operating system refuses termination, shutdown fails closed instead of risking overlapping daemon ownership.
- **daemon:** Allow slow daemon startup up to 60 seconds and distinguish a still-running child from an exited process when readiness cannot be confirmed. ([#395](https://github.com/volt-hq/Volt/issues/395))
- **daemon:** Prevented long lease-drain overlays from truncating assistant output. ([#63](https://github.com/volt-hq/Volt/issues/63))
- **daemon:** Allowed slower Windows daemon startups to become healthy before reporting failure. ([#188](https://github.com/volt-hq/Volt/issues/188))
- **daemon:** Kept Windows workspaces and worktrees available when opened through equivalent long-form or 8.3 paths.
- **daemon:** Contained failed background Work association refreshes and retried them with backoff.
- **daemon:** Custom push relays retain their configured authentication and never receive managed relay credentials.
- **daemon:** Fixed daemon workspace matching and remote path sanitization on Windows. ([#32](https://github.com/volt-hq/Volt/issues/32))
- **daemon:** Fixed interrupted prepared PR sessions resuming without their original PR and commit constraints.
- **daemon:** Fixed large Work histories repeatedly failing to persist near the storage limit.
- **daemon:** Fixed namespaced feature branches being treated as base branches across sessions.
- **daemon:** Fixed older registered workspaces missing PR-aware Work grouping.
- **daemon:** Fixed phone reconnects through pre-rekey TUI session aliases. ([#259](https://github.com/volt-hq/Volt/issues/259))
- **daemon:** Fixed prepared PR reviews blocking independent sessions with the same ID in another workspace.
- **daemon:** Fixed remote sessions failing to open after the daemon started SQLite session storage.
- **daemon:** Fixed source-checkout daemon startup failing when compiled workspace packages are stale.
- **daemon:** Fixed the daemon freezing when a remote client detached while a ! command, extension command, or reload was running; shutdown and TUI lease handoff now also wait for that work instead of cutting it off.
- **daemon:** Fixed warm TUI lease handoffs leaving a conversation permanently unreachable from paired phones with "conversation owner changed; retry" until the TUI released the session. ([#81](https://github.com/volt-hq/Volt/issues/81))
  After a warm daemon-to-TUI handoff the conversation authority kept its retired runtime lifecycle and rejected every subsequent phone relay attach. Relay attaches now succeed while the TUI owns the session, a daemon reservation racing relay closure reports the accurate transient reason, and rejected relay handshakes record the underlying error in the daemon audit log.
- **daemon:** Keep conversations recoverable when workspace session storage is unavailable.
- **daemon:** Kept review-created sessions grouped with their parent pull request in Work.
- **daemon:** Kept sticky Work associations refreshing after their branch head advances.
- **daemon:** Linked pull request status in Work now keeps refreshing after a session leaves the PR branch, its runtime ends, or the daemon restarts. ([#468](https://github.com/volt-hq/Volt/issues/468))
  Existing Work associations are reset once on upgrade; active sessions relink their pull request the next time their branch is observed.
- **daemon:** Preserved structured Iroh handshake failures until remote clients close the connection. ([#67](https://github.com/volt-hq/Volt/issues/67))
- **daemon:** Prevented delayed Work discovery from overwriting newer branch observations shared across sessions.
- **daemon:** Prevented hidden daemon subprocesses from flashing command windows on Windows.
- **daemon:** Prevented stale TUI Git observations from replacing newer remote Work state.
- **daemon:** Kept phone relay connections responsive while warm conversation switches finish.
  Relay offers now wait until the target session runtime is ready instead of reaching it mid-switch.
- **daemon:** Fixed worktree-bound conversations failing to resume after a daemon restart with "stored session working directory is outside the authorized workspace". ([#83](https://github.com/volt-hq/Volt/issues/83))
  Session rekeys (fork/new), missing-session replacements, and TUI-side rekeys now keep the durable worktree binding covering the current session id, and resume/relay resolution heals stranded bindings (including subagent sessions) from the session's stored working directory. Attach failures additionally audit the target session id.
- **daemon:** Fixed Windows worktree reclamation, leaked capacity after rejected restores, pending review source protection, and capacity errors when retrying archived reviews.
- **daemon:** Allow fresh local sessions in managed worktrees to start and retain checkout protection with default or custom session stores. ([#442](https://github.com/volt-hq/Volt/pull/442))
- **daemon:** Prevented PR review preparation from running Git filters enabled only in the destination worktree.
- **daemon:** Preserve source checkouts required by bound PR reviews during automatic worktree reclamation.
- **daemon:** Prevented concurrent worktree reclamation from removing a pull-request review's source while preparation is in progress. ([#442](https://github.com/volt-hq/Volt/pull/442))
- **daemon:** Local resume completes interrupted checkout restoration and protects managed worktrees from reclamation until session teardown, including print and JSON runs. ([#442](https://github.com/volt-hq/Volt/pull/442))
- **daemon:** Preserve prepared PR review checkouts until conversation attachment instead of removing them during retention cleanup.
- **daemon:** Reclaim safe inactive worktree checkouts before capacity is exhausted while retaining session history and exact resume placement ([#426](https://github.com/volt-hq/Volt/issues/426)).
  Retention defaults to one hour and reconciles after restart. Protected work remains untouched, and PR preparation reports worktree capacity failures distinctly from GitHub or checkout failures.
- **daemon:** Failed archived-session resumes no longer consume checkout capacity when the branch is already checked out elsewhere.
- **daemon:** Isolated fallback control sockets for distinct agent directories. ([#126](https://github.com/volt-hq/Volt/issues/126))
- **daemon:** Allow overlapping local sessions and subagents to acquire the same managed checkout without spurious restoration failures.
- **diagnostics:** Fixed private Windows review diagnostics failing to be retained when PowerShell startup takes longer than 10 seconds.
- **diagnostics:** Fixed Windows diagnostic captures hanging after the private writer process exits.
- **diagnostics:** Fixed Windows diagnostic captures waiting for input pipe closure after receiving a complete request.
- **diagnostics:** Windows private diagnostics no longer launch PowerShell for each write, avoiding startup delays during session shutdown.
- **extensions:** Context preparation now ignores incomplete source references at the input cutoff instead of reading a different file or range.
- **extensions:** Preserved context validation concurrency limits and cancellation ownership when preparation waits are enabled.
- **extensions:** Omit prepared repository context when tool policies change during source validation.
- **extensions:** Prevented the context preparation example from reading local path suffixes embedded in URLs or absolute paths.
- **extensions:** Fixed the context preparation example to recognize complete digit-leading and numeric-only skill names instead of omitting them or selecting an alphabetic suffix.
- **extensions:** Fixed contractions and possessives suppressing later explicit source paths in the context-preparation example.
- **extensions:** Fixed context preparation selecting potentially ambiguous skill guidance from truncated catalogs while preserving explicit-source excerpts.
- **extensions:** Prevented the context preparation example from reading unintended file suffixes from unterminated quoted paths.
- **extensions:** Exposed prompt cache metadata when extensions register model providers.
- **extensions:** Applied valid top-level provider registrations before selecting the initial session model while reporting invalid registrations without aborting startup.
- **github:** Stopped pull request reviews from retrying repeated GitHub pagination cursors indefinitely.
- **jobs:** Automatically resume idle conversations to collect completed or failed background work, without waking after cancellation. ([#392](https://github.com/volt-hq/Volt/issues/392))
- **jobs:** Preserve long-line Bash output tails alongside truncation footers and exit status in background job snapshots.
- **jobs:** Show truncation warnings in live background Bash reads and the inspector when earlier output has been dropped.
- **jobs:** Preserved automatic background outcome handling across resumable policy pauses without repeatedly retrying paused work.
- **lsp:** Built-in Go and Rust language servers now start when installed outside PATH, and a missing rust-analyzer component offers the reviewed install instead of failing to start ([#459](https://github.com/volt-hq/Volt/issues/459)).
- **lsp:** Fixed diagnostics collection reporting spurious failures when other files synchronize concurrently.
- **lsp:** Fixed existing cross-file errors being reported as newly introduced when baseline diagnostics are stale or unavailable.
- **lsp:** Fixed explicitly named Windows language-server executables being skipped when their extension was absent from PATHEXT.
- **lsp:** Fixed repeated diagnostic timeouts hiding new errors in other open files.
- **lsp:** Preserved symlinked workspace aliases and isolated automatic language-server install prompts between sessions.
- **lsp:** Fixed macOS path aliases causing absolute navigation output and rejected workspace edits.
- **lsp:** Preserved Windows executable ordering, caller-independent installs, and valid case-insensitive workspace paths.
- **lsp:** Made language-server startup deterministic and workspace-confined, limited automatic installs to missing unchanged built-ins, and preserved complete startup diagnostics.
- **lsp:** Prevented failed servers from hanging startup and stale documents from reading outside the project workspace.
- **lsp:** Prevented unsafe or stale language-server workspace edits from changing unintended files. ([#278](https://github.com/volt-hq/Volt/issues/278))
- **lsp:** Fixed offline audits missing session stores when the workspace path uses a symlink.
- **lsp:** Prevent cancelled installation prompts from restoring stale server failures after restart or reload.
- **lsp:** Report cancelled installations instead of leaving their status running when restart or reload races with installer completion.
- **lsp:** Verify language-server readiness after installation and explain launcher repair without restarting the conversation. ([#399](https://github.com/volt-hq/Volt/issues/399))
- **lsp:** Keep language-server startup failures handled and health evidence accurate after callers cancel.
- **lsp:** Preserve current diagnostics published during dependency refresh instead of returning a spurious timeout.
- **lsp:** Report one final readiness status for shared language-server installations without hiding failures in other project roots.
- **mcp:** Keep tool discovery and MCP results within the configured output budget, with compact tool summaries and cache retrieval for large results. ([#469](https://github.com/volt-hq/Volt/issues/469))
- **packaging:** Fixed local builds failing to resolve the optional Iroh native adapter.
- **plan:** Plan mode no longer becomes ready without preserving the feedback that produced the final plan. ([#212](https://github.com/volt-hq/Volt/issues/212))
- **plan:** Submitted plans now accept queued revision feedback without redundant research while requiring fresh evidence after tree navigation.
- **plan:** Completed approved plans now persist a final assistant summary while preserving Build tools for the next request, and known cancellations record their source. ([#199](https://github.com/volt-hq/Volt/issues/199))
- **planning:** Encourage approved checklist updates as work starts and verified outcomes finish, rather than deferring progress until the end. ([#417](https://github.com/volt-hq/Volt/issues/417))
- **relay:** Carried authorized workspace catalogs through TUI relays so initial remote host metadata matches daemon-owned conversations. ([#250](https://github.com/volt-hq/Volt/issues/250))
- **relay:** Fixed canary credential-broker deployment to preserve both App Store subscription product IDs.
- **relay:** Fixed pairing and entitlement reconciliation rejecting subscriptions in billing grace after a scheduled product change.
- **remote:** Limited repeated relay subscription checks to once per hour while preserving suspended pairing heartbeats and notification-based recovery.
- **remote:** Prevented connection cleanup from interrupting sibling Iroh handshake responses. ([#69](https://github.com/volt-hq/Volt/issues/69))
- **remote:** Pairing QR codes fit in terminals with four fewer rows, and size warnings show the required and available dimensions.
- **remote:** Allow choosing workspace folders with ordinary paired-device access while keeping workspace removal restricted.
- **remote:** Avoided forced App Store authentication during pairing by requiring a fresh installation-bound approval assertion.
- **remote:** Canceling a phone pairing now allows a replacement QR immediately.
- **remote:** Retained committed remote sessions when runtime setup fails.
- **remote:** Fixed host-authorized phone relay revocation being blocked by an inactive Volt Pro subscription.
- **remote:** Fixed managed push relay registration failing after successful App Check verification.
- **remote:** Fixed starting a fresh conversation from daemon-backed app sessions.
- **remote:** Hosts now reconnect to the relay within seconds of a Volt Pro renewal instead of up to an hour later, and the daemon logs a subscription suspension once instead of on every retry.
- **remote:** Include the configured relay in first-time pairing tickets before managed relay enrollment completes.
- **remote:** Remote-access and Iroh protocol documentation now use the actual relay modes, `production` default, pairing-ticket fields, secret handling, and workspace availability metadata. ([#51](https://github.com/volt-hq/Volt/issues/51), [#97](https://github.com/volt-hq/Volt/issues/97))
- **remote:** Phone requests that take longer than 15 seconds, such as a slow Runs refresh, no longer lose their host connection. ([#461](https://github.com/volt-hq/Volt/issues/461))
- **remote:** Preserved empty assistant content blocks so live conversation transcripts stay synchronized.
- **remote:** Prevented refreshed review discussions from leaving duplicate open Work entries.
- **remote:** Prevented remote phone sessions from disconnecting after submitting a prompt.
- **remote:** Prevented remote payloads from exposing host-local SQLite session locators.
- **remote:** Prevented silent phone transport outages and bounded mobile reconnect recovery.
- **remote:** Stopping a conversation from a remote client now sends its queued steering and follow-up messages instead of leaving them stuck in the queue.
- **remote:** Restored phone pairing retries after computer storage is freed.
- **remote:** Streamed message deltas can no longer bypass host path redaction on Iroh remote connections.
  Delta-only `message_update` frames are now derived from sanitized accumulated text, and the host replaces the client accumulator with a fully sanitized snapshot whenever redaction rewrites text that already streamed (including tool-call arguments), so remote clients can no longer reassemble a complete redacted host path from deltas split across frames. As before, an incomplete prefix of a path may still appear in individual frames until the completing snapshot rewrites it.
- **remote:** Prevented shared conversations from emitting blank compaction rows.
- **remote:** Preserved operation elapsed time across automatic compaction, retries, and reconnects. ([#421](https://github.com/volt-hq/Volt/issues/421))
- **remote:** Preserve notification retries when the Firebase push relay cannot retrieve valid signing keys.
- **remote:** Kept Git work associations updating after replacing a session.
- **remote:** Refresh cached push relay signing keys when a notification uses a newly published key, while keeping key-service failures retryable.
- **remote:** Fixed Register current directory in /remote silently using a registered parent instead of registering the child directory. ([#418](https://github.com/volt-hq/Volt/issues/418))
- **remote:** Rejected malformed assistant tool state before publishing it to remote clients.
- **remote:** Rejected incomplete Iroh frames, preserved successful workspace unregister responses, fenced stale attaches across workspace re-registration, and retired direct and relayed conversations after unregister. ([#49](https://github.com/volt-hq/Volt/issues/49))
- **retry:** Made active runs more resilient to short transient provider outages by increasing the default automatic retry budget. ([#124](https://github.com/volt-hq/Volt/issues/124))
- **review:** Prevented incremental reviews from retaining stale duplicate findings for re-reviewed files.
- **review:** Bound published GitHub reviews to the commit that was actually reviewed.
- **review:** Kept review snapshots and searches fast, bounded, and reliable across large trees, unusual Git paths, sparse checkouts, and Windows. ([#249](https://github.com/volt-hq/Volt/issues/249))
  Snapshot collection now returns safe incomplete results for binary or oversized content. Searches read immutable Git trees directly, return bounded pages without prefetching excess blobs, preserve ignored and sparse tracked files, and handle non-UTF-8 or oversized pathnames, configured Git pathspec modes, and Windows `NUL` artifacts.
- **review:** Keep the Current PR picker aligned with the tracked repository and reject capture if the selected repository changes.
- **review:** Recheck verifier concerns before completing a review and show unresolved code locations, explanations, and next steps instead of a generic incomplete result. ([#372](https://github.com/volt-hq/Volt/issues/372))
  Reviews perform at most one follow-up discovery and independent verification cycle on the captured snapshot. Unresolved concerns remain distinct from verified findings, private PR analysis stays private, and failed follow-up checks preserve the earlier verified result. Review failures identify the failed stage and a recovery action.
- **review:** Allow requested code fixes and current-context plan execution in finding discussions, including resumed conversations. ([#341](https://github.com/volt-hq/Volt/issues/341))
  Discussion linkage no longer claims read-only permissions. Normal tool grants and Plan-mode restrictions still apply; source-owned reset and canonical finding outcomes remain separate from code editing.
- **review:** Applied Git URL rewrites only once when fetching isolated review snapshots.
- **review:** Branch review reruns now recapture their resolved base after earlier snapshots are disposed.
- **review:** Branch reviews now refresh upstream bases without losing shallow-clone history boundaries, so already-merged changes are excluded safely.
- **review:** Cancelled reviews now dismiss pending confirmation and setup promptly.
- **review:** Fixed current-PR capture in fork checkouts with differently named tracking branches and kept capture reads pinned to the resolved pull request. ([#405](https://github.com/volt-hq/Volt/issues/405))
- **review:** Fixed new-session creation in a different session directory when no review runs are transferred.
- **review:** Fixed cancelled reviews leaving subprocesses and temporary directories behind on Windows.
- **review:** Fixed current-PR reviews failing when historical PRs have unavailable head repositories alongside a unique open match.
- **review:** Fixed numbered pull request reviews selecting the upstream repository instead of the workspace fork.
- **review:** Fixed PR reviews failing on GitHub CLI versions that do not expose baseRefOid, while retaining exact commit verification. ([#443](https://github.com/volt-hq/Volt/issues/443))
- **review:** Fixed prepared PR reviews being rejected when Git global configuration supplies ignore rules or repository trust.
- **review:** Fixed pull request review publishing to use the captured repository and GitHub host instead of GitHub CLI defaults.
- **review:** Fixed pull request snapshots fetching from a different remote than the selected repository.
- **review:** Fixed review reports misrepresenting verifier provenance or usage and pull request discussion captures including drafts or falsely reporting truncation.
- **review:** Fixed uncommitted reviews for repositories containing tracked paths that differ only by case.
- **review:** Kept incremental pull request reviews scoped after code revisions when GitHub discussion is unchanged.
- **review:** Keep finding conversation status consistent with queued requests, recovery, and the selected transcript branch.
- **review:** Keep the current General conversation selected when its replacement cannot be published.
- **review:** Kept pull request review conversations grouped with the pull request they review.
- **review:** Made review startup visible, cancellable, and faster for pull requests.
- **review:** Completed reviews no longer resurface after their findings are opened or dismissed over RPC. ([#78](https://github.com/volt-hq/Volt/issues/78), [#281](https://github.com/volt-hq/Volt/issues/281))
  A declined or failed open keeps the review available. After a successful open, `get_review_result` for that workflow ID fails and the findings live in the seeded session.
- **review:** Preserved conditional Git authentication and proxy settings for isolated review fetches.
- **review:** Preserved prepared PR checkout and pinned-head enforcement across review handoffs and subsequent reruns.
- **review:** Preserved pull request review identity when display metadata is unavailable and rejected missing file statistics instead of reporting zero changes.
- **review:** Preserved repository-local Git authentication and transport settings when fetching isolated review snapshots.
- **review:** Starting a fresh review discussion no longer loses the review record needed for rerun and publish actions.
- **review:** Preserved review findings when executing approved plans with cleared context.
- **review:** Prevented captured pull request discussion text from entering durable or remote review results.
- **review:** Prevented partial clones from causing missing-object failures during remote-backed reviews.
- **review:** Resolved relative local Git remote URLs for isolated review snapshots.
- **review:** Opening review findings no longer drops them when post-replacement input recovery fails. ([#92](https://github.com/volt-hq/Volt/issues/92))
- **review:** Short branch review bases now ignore colliding tags and refresh matching remote branches.
- **review:** Show final accounting in the transcript when an interactive review fails or is cancelled.
- **review:** Show interrupted finding requests in the review conversation list until a new request is answered.
- **review:** Skipped tag-only names when auto-detecting review base branches.
- **review:** Prevented pull request reviews from failing when the base branch advances during snapshot capture.
- **review:** Prevented PR checkout preparation and validation from executing filters configured only in submodules, including nested submodules.
- **review:** Prevented PR reruns from switching repositories and fixed Work PR discovery when local and tracked branch names differ. ([#406](https://github.com/volt-hq/Volt/issues/406))
- **review:** Protected private review diagnostics with Windows ACLs and added a local warning when diagnostic retention fails.
  Review verdicts remain unchanged, and private error details stay out of public results, sessions, and exports.
- **review:** Omitted recoverable tool-attempt warnings from review reports while keeping completion blockers and material coverage limits visible.
- **review:** Kept detached review terminal events consistent with durable run status when cancellation races finalization.
- **review:** Rejected findings anchored outside the effective explicit-path or incremental review scope.
- **review:** Restored recorded token and estimated-cost subtotals when reopening an interrupted review.
- **review:** Retained private verifier assessments and challenges for diagnosing incomplete reviews in source-development runs.
- **review:** Failed remote reviews no longer retain private provider diagnostics.
- **review:** Fixed pull request snapshots failing in shallow repositories.
- **reviews:** App-started PR reviews and their discussions now use a prepared PR-head worktree instead of an unrelated checkout ([#414](https://github.com/volt-hq/Volt/issues/414)).
- **rpc:** Mid-turn attaches that land exactly on `toolcall_start` now stream tool-call arguments instead of freezing them until `toolcall_end`.
- **sdk:** Retained committed sessions when SDK session setup fails.
- **security:** Updated bundled dependencies to resolve known HTTP, URI parsing, and brace expansion vulnerabilities.
  Also updated development-only YAML, CSS, and ID-generation dependencies and deduplicated Vite's esbuild onto the existing patched version.
- **session:** Captured starting Git context for sessions branched from an existing conversation.
- **session:** Rejected JSONL imports with compaction boundaries outside their active branch.
- **session:** Prevented persisted session replacement while accepted writes are still settling.
- **session:** Fixed Windows context discovery and deep session traversal performance. ([#236](https://github.com/volt-hq/Volt/issues/236))
- **session:** Session flush and shutdown now wait for atomic SQLite transactions to settle. ([#329](https://github.com/volt-hq/Volt/pull/329))
- **sessions:** Rejected malformed or contradictory session data before mutation and reported corrupt canonical SQLite rows with one stable bounded integrity error.
- **sessions:** Made first-time SQLite session storage reliable when multiple Volt processes start together.
- **sessions:** Imported persisted and in-memory JSONL snapshots through one canonical timestamp-preserving path while retaining committed imports after runtime setup failures.
- **sessions:** Fixed Volt crashing with a bus error or reading a malformed session when another Volt process opened the same project's session store.
  This affected running several Volt sessions, the daemon, or `volt lsp audit` against one project at the same time.
- **sessions:** Generated a fresh session ID when forking a JSONL snapshot by path unless --session-id is provided.
- **sessions:** Kept healthy project sessions available when another session store cannot be read.
- **sessions:** Kept session modified times stable when live runtimes attach or detach.
- **sessions:** Preserved fuzzy relevance ranking for full-history session searches.
- **sessions:** Preserved pending client input recovery when continuing a session.
- **sessions:** Rejected imported session snapshots with dangling entry or leaf references.
- **sessions:** Rejected out-of-range message timestamps before changing session state.
- **sessions:** Retained committed sessions when new-session preparation fails.
- **sessions:** Fixed session store lock timeouts, full disks, and I/O failures being reported as rejected writes or corrupt sessions instead of busy, full, or unavailable storage.
- **sessions:** Resolved relative custom session directories before publishing reusable session references.
- **sessions:** Finalized failed CLI and remote session resources exactly once, audited late daemon cleanup failures, preserved concurrent cleanup errors, and resolved exact session IDs through isolated indexed summaries without duplicate transcript opens.
- **sessions:** Enforced SQLite client-input bounds and canonical client-input and search projections at write time, then verified retained projections on open.
- **sessions:** Continued tool-free length-limited turns after compaction while preserving strict retained-history boundaries.
- **sessions:** Pooled equivalent physical SQLite stores across parent path aliases while rejecting session-directory symlink leaves.
- **sessions:** Kept imported and cross-store-forked labels available before reopening or branching. ([#329](https://github.com/volt-hq/Volt/pull/329))
- **sessions:** Rejected malformed thinking-level and Fast mode values before importing JSONL snapshots.
- **sessions:** Report corrupt session entry sequences with a stable integrity error.
- **site:** Displayed blog social cards on the index and article pages.
- **sqlite:** Fenced stale session managers when a reconciled commit is already behind authoritative state.
- **streaming:** Retry transient provider failures during tool-call responses without restarting the task or executing incomplete calls.
  Preserve the original provider error in retry and failure messages. Malformed completed arguments, cancellation, and local resource safeguards remain non-retryable.
- **subagents:** Subagents re-prompted after reaching their turn limit now return a tool-free reply instead of aborting.
- **subagents:** Explicitly aborted subagent retries now appear as aborted in activity, registry list, and follow results.
- **subagents:** Retained committed child sessions while consuming supplied managers at invocation, finalizing partial startup and resumed handles once, and reporting every cleanup error.
- **subagents:** Parent results now agree with aborted child status, and canceled prepared subagents no longer accept work. ([#184](https://github.com/volt-hq/Volt/issues/184))
- **subagents:** Prevented subagents rejected before prompt acceptance from appearing in the inspector or daemon. ([#56](https://github.com/volt-hq/Volt/issues/56))
  A first prompt rejected before the start is published (including a daemon registration commit failure after acceptance) now also disposes the SDK subagent handle, so later handle calls fail with a clear disposed-handle error instead of hitting a rolled-back runtime.
- **subagents:** Internal aborts (tree budget crossed, run timeout) that land while a child is being cleaned up no longer discard the child's already-computed result or a parallel run's per-task failure details.
- **subagents:** Bounded subagent tool detail payloads so large parallel outputs and error messages stay under remote RPC frame limits instead of disconnecting the session.
  Details snapshots retain at most 100 task entries with one shared output-text budget and clamp per-task error messages; omitted entries are counted in the summary and full output stays reachable through child sessions and the registry. The parallel aggregate is also built incrementally under its byte limit instead of materializing one unbounded string.
- **subagents:** A `runTimeoutMs` expiry now aborts children whose start was still in flight when the timeout fired, instead of letting them run to completion on a shared delegation scope.
- **subagents:** Definition-less SDK `start()` children now join the session tree — sharing the session-wide registry, delegation ceilings, and depth accounting — instead of acting as fresh roots, and are fail-closed for nested delegation.
- **subagents:** Restored responsive TUI rendering with large delegation trees by caching rosters, collapsing long lists, bounding nested rendering, and throttling progress snapshots.
- **subagents:** Kept untrusted delegation labels and task text out of child system prompts while preserving them in registry tool results.
- **subagents:** Fixed completed subagent usage stats shrinking after compaction; final message, tool-call, token, and cost totals are now computed from lifetime session history instead of retained context. ([#24](https://github.com/volt-hq/Volt/issues/24))
- **tools:** Prevented incomplete or malformed streamed tool arguments from executing or triggering automatic retries. ([#351](https://github.com/volt-hq/Volt/issues/351))
- **tools:** Bash full-output files are fully written before their path is reported, so opening the saved output no longer shows an empty file.
- **tools:** Responses rejected for malformed tool-call JSON, such as literal tabs inside strings, now retry immediately with feedback explaining the rejection instead of ending the turn. ([#452](https://github.com/volt-hq/Volt/issues/452))
- **tools:** Rejected tool calls now name unescaped control characters such as tabs, and the next request tells the model why its call was not executed without replaying the malformed arguments. ([#452](https://github.com/volt-hq/Volt/issues/452))
- **tui:** Background job notices remain visible when provider payload hooks change or fail to verify result delivery, or when the model response fails or is aborted.
- **tui:** Distinguish generating file content and tool arguments from queued calls and active execution, and keep tools with partial output labeled as running.
- **tui:** Kept fullscreen clipboard reads and selection copies responsive while system clipboard commands run.
- **tui:** Kept terminal images intact across renderer switches and constrained side-by-side layouts.
  Cropped images now survive differential sibling updates and scrolling without displacing adjacent text.
- **tui:** Prevented contained nested scroll views from forwarding edge wheel input to the primary viewport.
- **tui:** Displayed non-PNG tool images after delayed terminal image capability detection.
- **tui:** Prevented discarded subagent rows from increasing background repaint work in long-running TUI sessions.
- **tui:** Made independently configured prompt history keybindings navigate editor history.
- **tui:** Fixed backslash+Enter prematurely submitting custom answers and option notes in structured questions.
- **tui:** Fixed Escape aborts crashing the interactive TUI. ([#105](https://github.com/volt-hq/Volt/issues/105))
- **tui:** Fixed fullscreen pointer interactions remaining active after terminal focus loss.
- **tui:** Fixed opening daemon-owned phone conversations in the TUI with their latest transcript state instead of failing with `target_in_use`.
- **tui:** Fixed the fullscreen Plan split leaving blank rows beneath the conversation composer.
- **tui:** Routed Page Up and Page Down to focused fullscreen dedicated views.
- **tui:** Fullscreen mode now exits cleanly when transcript or terminal-restore output stalls.
- **tui:** Cleared stale Kitty placements and released removed image data during scrollback-preserving viewport redraws.
- **tui:** Made TUI-started reviews visible and cancellable to attached clients throughout preparation.
- **tui:** Made TUI-started reviews visible to attached clients during preparation and confirmation.
- **tui:** Kept fullscreen search scoped to the selected plan pane while the search overlay is open.
- **tui:** Preserved complete grow-region content when fullscreen sessions restore terminal scrollback.
- **tui:** Prevented hidden overlays from being discarded when switching TUI modes.
- **tui:** Printed the conversation transcript instead of temporary views when exiting fullscreen mode.
- **tui:** Preserved the first character when starting a custom question answer on terminals using modifyOtherKeys.
- **tui:** Restored terminal state after fullscreen render crashes and preserved editor text when regular mode stops.
- **tui:** Restored focus to the visible plan or conversation pane when fullscreen search spans a responsive layout transition.
- **tui:** Clearing or resuming a conversation no longer renders from a session that has already been replaced.
- **tui:** Preserved active deep-search results and ranking while session lists load or refresh.
- **tui:** Fullscreen content now uses the correct layout on first display and after terminal resizing.
- **tui:** Kept clipped Sixel images visible after stopping and restarting the renderer.
- **tui:** Distributed stack growth and shrinkage proportionally without sibling-order bias.
- **tui:** Prevented viewport-only redraws from splitting multi-row terminal image blocks.
- **tui:** Enabled DA1-confirmed Sixel images when Windows Terminal is the default host and omits `WT_SESSION`.
- **tui:** Running Volt on Windows no longer blocks branch switches while native helpers are loaded.
- **tui:** Preserved Windows clipboard text without adding a trailing newline during right-click paste.
- **tui:** Fixed Shift+Enter inserting a newline instead of submitting input on Windows terminals that send a raw carriage return.
- **tui:** Background job notices no longer disappear when provider conversion omits their results.
- **tui:** Protect active work from accidental quits and capture diagnostics with configurable F12 or /debug. ([#353](https://github.com/volt-hq/Volt/issues/353))
- **tui:** Fixed terminal scrollback being corrupted during live transcript updates; offscreen rows keep their last painted content until re-exposed, and the bottom anchor survives terminal height shrinks. ([#30](https://github.com/volt-hq/Volt/pull/30))
- **windows:** Resolve short-name and case aliases consistently so workspace files are not incorrectly rejected as escaping symlinks. ([#343](https://github.com/volt-hq/Volt/issues/343))
- **worktrees:** Restore reclaimed managed checkouts when resuming sessions through local /resume or CLI startup, without redirecting failed restorations to another directory.
- Sessions report busy while a prompt waits in auto-retry backoff, so quit confirmation, daemon shutdown drains, RPC idle waits, and extension isIdle() no longer treat a retrying prompt as idle.

## [0.1.0] - 2026-07-13

Volt's first release: a terminal coding agent with a companion daemon that can hand a running session to your phone and back. Volt is a fork of [Pi](https://github.com/badlogic/pi-mono); this release restarts the version line under the `@hansjm10/volt-coding-agent` package identity.

### Highlights

- **Remote sessions on your phone** — Pair the Volt iOS app with your machine over an end-to-end encrypted Iroh connection (QR-code pairing, no port forwarding or accounts), attach to live conversations, steer runs from anywhere, and get push notifications and Live Activities as turns complete. Every device pairs with an explicit access preset: `coding`, `review`, `chat`, or `full`.
- **`voltd` daemon and `/remote` control center** — A background daemon owns workspaces, runtimes, and conversation leases, so sessions survive TUI restarts and move cleanly between desktop and phone. The `/remote` command manages daemon health, workspace registration, pairing, paired devices, active leases, and runtime tool policy from inside the TUI. See [Daemon](docs/daemon.md).
- **Subagent delegation** — A built-in `subagent` tool discovers user- and project-defined child agents, ships reserved `general`, `researcher`, `design-doc`, and `security-reviewer` roles, enforces bounded recursive delegation budgets, and renders live nested delegation trees in the TUI and on remote clients.
- **Native MCP support** — Trusted config loading, a built-in `mcp` gateway tool, stdio/Streamable HTTP/SSE transports, and OAuth (browser PKCE and device-code) with host-side token storage. See [MCP](docs/mcp.md).
- **LSP-backed editing** — Language servers spawn lazily per project and append diagnostics to `edit`/`write` results by default, and the `lsp` tool adds navigation, references, call hierarchy, project-wide rename, and quick fixes. See [LSP Diagnostics](docs/lsp.md).
- **`/review`** — Review uncommitted changes, branch diffs, GitHub PRs, or single commits in an isolated session, then continue from the numbered findings with clean context.
- **Built-in web search** — A `web_search` tool enabled by default across SDK, CLI/RPC, and remote sessions, with OpenAI/Codex, custom-endpoint, and Brave Search backends.
- **Settings profiles** — Workflow-specific settings and resource overlays selectable with `--profile`, `VOLT_PROFILE`, or `defaultProfile`, plus `/profile` for switching interactively.

### Breaking Changes

- Volt now ships as `@hansjm10/volt-coding-agent` with the release line restarted at 0.1.0; npm beta installs use the `beta` dist-tag.
- Paired remote devices and pending pairing tickets require a versioned per-device access grant; pairings created before this release fail closed and must re-pair with `volt remote pair --access coding|review|chat|full`.

### Also in this release

- Standalone releases are Node.js Single Executable Applications for six OS/architecture targets, with checksum-verified installers, pinned license manifests, and a reviewed exact-commit release pipeline.
- Live model catalog updates, mid-turn reconnect state (`get_state` active tools), remote model/thinking-level switching, and remote-safe transcript projection for paired clients.
- Proactive mid-run compaction, an `agent_settled` idle-boundary event, and bounded summarization input for long conversations.
- Pi extension compatibility: `volt install` reads `pi` manifests when no `volt` manifest is present and aliases Pi core imports to Volt modules at load time.
- A redesigned interactive shell: responsive startup lockup, electric purple themes, Bash syntax highlighting, tool duration suffixes, focus-aware turn-done alerts, and `/clear` replacing `/new`.
- Extensive hardening across daemon lifecycle and Windows support, Iroh pairing and connection admission, push delivery, MCP and OAuth handling, local persistence, and release integrity. The full engineering log for this release (~180 entries) is preserved in this file's git history.

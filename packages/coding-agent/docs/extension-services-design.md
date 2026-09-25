# Extension services foundation

- Status: Design intent. Text/search, tasks, and ready-only context shipped in #432; [completion scope](extension-services-completion-design.md) adds bounded waiting, semantic discovery, and skill resources. See [extensions](extensions.md#managed-context-preparation) for the actual public API.
- Date: 2026-09-18
- Audience: Volt maintainers and extension API implementers.
- Scope: Read services, managed request-scoped tasks, and optional context contributions.
- Decision: Foundation first. Transparent tool-cache reuse and autonomous workflows are deferred.
- Delivery plan: [First implementation PR](extension-services-implementation-plan-design.md). It records the smaller text/search, task, and ready-only context slice; LSP, skill-file reads, and bounded waits are covered by the separate completion scope.

## 1. Objective

Let an optional extension prepare useful information before a model request or while the main agent works, using Volt's existing execution environment and lifecycle ownership. The same API must be useful without a classifier, an additional model, or a network connection.

Volt supplies observations, authorized operations, bounded execution, and context admission. Extensions supply strategy: candidate generation, skill selection, relevance decisions, diagnostic triage, and provider-specific inference. There is no built-in ahead-of-model pipeline and no mandatory auxiliary model.

The motivating research describes a decision model selecting among observed artifacts. Its vendor-specific latency, pricing, confidence, and accuracy claims are not requirements or independently verified evidence for this design. Evaluate that integration separately after a deterministic extension proves the foundation.

### Ownership

| Host responsibility | Extension responsibility |
| --- | --- |
| Current session, branch, runtime, and request identity | Which preparation is useful |
| Grants and trusted operation classification | Candidate extraction and expansion |
| Configured read/search/navigation execution | Classification, ranking, and abstention |
| Task admission, revocation, and bounded host resources | Auxiliary inference and its configuration |
| Source observations and freshness checks | Extension-local memoization |
| Optional context admission and attribution | Selection of evidence and explanation |

### Non-goals

- Transparent prefetch hits in normal tools or foreground/background single-flight.
- A persistent repository index, import graph, or test-association database.
- Speculative Bash, tests, builds, edits, subagents, MCP, or web operations.
- A generic execute-any-tool method or a second autonomous agent loop.
- An auxiliary-model adapter, model dependency, new provider registration, or inference billing system.
- A sandbox, secret detector, path-permission redesign, or protection from malicious installed extensions.
- Durable task recovery, new mobile UI, new RPC methods, or session-format changes.
- Removal of existing extension tools, commands, or mutation hooks.

These exclusions apply to the new managed services, not to all existing trusted extension code.

## 2. Current implementation and gaps

The [extension guide](extensions.md) and [SDK guide](sdk.md) describe the current public API. The following are current code facts, not proposed behavior:

| Existing component | Reuse or limitation |
| --- | --- |
| `extensions/types.ts`: `ExtensionContext`, `ExtensionAPI`, `ToolInfo` | Model/auth access and async hooks exist; tool enumeration provides metadata, not invocation or shared LSP access. |
| `extensions/runner.ts`: `emitInput`, `emitBeforeAgentStart`, `emitContext` | Hooks are awaited. Ordinary hook errors are reported and contained. There is no host-enforced hook deadline. |
| `agent-session.ts`: `_promptAdmitted`, `_prompt`, and `emitBeforeAgentStart` call site | Fresh prompts reach `before_agent_start`; queued steer/follow-up branches return earlier. Direct `steer`/`followUp` and several continuation paths bypass it. |
| `agent-session.ts`: `_installAgentToolHooks`, `_generateCompaction` | Conversational requests and compaction use `context`. An unqualified context hook is not a conversational-request-only boundary. |
| `extensions/loader.ts`: `exec`; tool factories | Direct process/tool execution does not traverse the live session's policy, tool hooks, or transcript flow. |
| `operation-authorization.ts`; `agent-session.ts`: `_getTrustedOperationResolver` | Argument-sensitive host classification exists. An extension override does not inherit native authority just by using a built-in name. |
| `agent-session.ts`: `_handleToolCallPolicy`, `registerTurnPolicy` | Active-tool checks, extension gates, mode authorization, and additional host policies all matter. Extracting only one check would not reproduce the full policy. |
| `tools/read.ts`, `grep.ts`, `find.ts`; `lsp/outcome.ts` | Much output is presentation text. Search hits and LSP locations are not yet a complete public structured artifact API. |
| `background-jobs.ts` | Jobs are Bash/subagent-specific, branch-scoped, and carry completion-wake authority. They are not a generic extension task manager. |
| `resource-loader.ts`: enabled resource filtering | Resource selection can omit a module before its factory runs. Reuse this loading boundary. |

Implementation must preserve the [delivery transaction contract](delivery-transaction-contract-design.md). In particular, optional extension work must not enter side-effect-free logical delivery preparation, determine whether a user message committed, replay ambiguous input, or publish from a retired conversation authority.

Source paths above are relative to `packages/coding-agent/src/core/`. Existing source, not other proposed RFCs, is authoritative for implementation dependencies.

## 3. Required invariants

1. **Optionality:** with no registered consumers, no new preparation tasks, repository reads, provider lookups, or context blocks are produced.
2. **No new authority:** calls through managed services cannot exceed current session grants or the new service's read-only operation set.
3. **No bypass:** overridden/unclassified execution is unavailable to the managed read API; it never falls back to a native local implementation.
4. **Request ownership:** work and contributions belong to one host-issued runtime/branch/request scope. IDs supplied by an extension are not authority.
5. **Revocation wins:** after invalidation, the managed facilities cannot start operations, publish context, or affect a replacement scope.
6. **No wake authority:** managed task completion cannot create a model request, enqueue a user message, or replay a finished request. This does not sandbox existing trusted APIs such as a captured `volt.sendUserMessage`.
7. **Bounded optional waits:** all providers share one wait allowance at a model boundary, not one allowance each. Ready-only is the default.
8. **Evidence is data:** classifier output and retrieved text cannot become system instructions, consent, trusted read classification, or successful verification.
9. **Attribution:** prepared, admitted-to-context, dispatched-to-provider, and actually useful are different observations. Do not claim the model used evidence merely because it was prepared.
10. **No exactly-once claim:** tasks are in-memory. Process failure, provider retries, and arbitrary external effects are not transactionally recoverable.

## 4. Proposed public surface

Names below are proposed TypeScript API names, not existing exports. Final declarations must preserve these semantics. Add three facilities rather than exposing `AgentSession`, `LspManager`, or mutable internal registries:

1. `ctx.work`: a scoped facade for a stable snapshot, managed tasks, and context contributions.
2. `task.repository`: bounded read-only operations available only within an admitted managed task.
3. `request_boundary` and diagnostic-only `extension_operation` events, with bounded wait requests at the first boundary.

Use existing `tool_execution_end` events to schedule passive triage after foreground tools. Existing `tool_result` reducers remain policy/transform hooks, not managed-operation scheduling hooks. No additional file-watcher or diff-inference subsystem is required. Out-of-band filesystem changes are addressed by source validation, not a claim that all changes emit events.

### 4.1 Snapshot and scope

`ctx.work` is present only for an active conversational request scope. It is absent during extension factory execution, idle commands, raw input interception, compaction, and tree summarization. Calls through a retained facade remain bound to its original scope, never whichever session happens to be current later.

The snapshot is an owned readonly value containing:

- Opaque `scopeId`, runtime generation, branch identity, and snapshot revision.
- Newly committed user inputs for this scope, in order, after normal input/template handling.
- Their delivery class (`prompt`, `steer`, or `followUp`) and origin category when known.
- Current cwd, agent mode, model identity, and effective managed read capabilities.
- Skill catalog entries with opaque resource IDs, names, descriptions, and scope/origin metadata.

Do not equate a request scope with an HTTP attempt, agent turn, RPC correlation ID, or durable client-message ID. Do not invent raw unexpanded text for paths that do not retain it. Image bytes, credentials, full system prompts, and the full transcript are not included automatically. Existing explicit session/model APIs remain available to trusted extensions.

Skill selection is advisory: a contribution may recommend none or name a host-observed skill. It cannot suppress an explicitly invoked skill or mandatory project instructions. Reading a selected skill uses a host-issued resource handle for the currently loaded catalog, not a classifier-invented path. This permits explicitly loaded global skills without granting arbitrary reads of adjacent credential files through the resource API. Apply read-shaped call/result policy hooks, but reject any hook-patched target or resolved identity that no longer matches the exact issued resource; catalog membership is not arbitrary path-read authority.

### 4.2 Request boundary observation

`request_boundary` is a synchronous, notification-only callback immediately before optional context collection for a conversational provider attempt. It receives:

- The scoped snapshot and an opaque attempt ID.
- Cause: new user input, tool continuation, explicit continuation, or retry.
- Whether this is the first boundary of the scope.
- The remaining shared optional wait allowance.

The callback can synchronously enqueue a managed task and call `work.context.requestWait(ms)`. The latter returns the effective allowance, clamped to host policy, and is valid only during the first boundary notification. Combine requests by maximum, never sum; one scope-wide deadline starts when collection begins. The host default allows zero wait. The callback cannot replace messages, approve a tool, or delay provider admission by returning a promise. Unexpected returned promises are observed for rejection but not awaited. CPU-bound extension code still runs in the trusted host process; this is not an event-loop isolation guarantee.

Emit from the common conversational request path after canonical delivery settlement, not by patching only `prompt()`. A small Harness request-boundary adapter may be needed to report the actual committed delivery set and request cause. Do not infer these from message text, timestamps, or array length.

### 4.3 Task API

Conceptual shape:

```ts
interface ExtensionTaskSpec {
  key: string;
  label: string;
  timeoutMs?: number;
}

// Bound to the creating extension and captured request scope.
work.tasks.start(spec, async (task) => {
  const result = await task.repository.readText({ path, offset: 1, limit: 80 });
  if (result.status !== "ok") return;
  task.context.put({
    key: "candidate-evidence",
    text: result.text,
    dependency: "sources",
    evidenceIds: [result.evidence.id],
  });
});
```

This is schematic, not copy-paste code. The task callback receives the captured snapshot, fixed cancellation signal, absolute deadline, repository facade, and contribution methods. It does not receive a more privileged `ExtensionContext`.

`start` returns immediately with a handle, or a typed admission failure. A handle provides identity, bounded status, `cancel()`, and `wait({ signal })`. Waiting from a request observer is not part of context collection; only the host's shared wait budget can delay provider admission. A task cannot await itself or start nested managed tasks. Extensions may coordinate parallel tasks within their granted ceiling.

`key` is unique among an extension's live tasks in one scope. Duplicate starts return `already_running` with the existing handle; completed keys may be restarted explicitly. This is task admission deduplication, not equivalent-operation caching or foreground tool single-flight.

Task state is `running -> draining -> completed | failed`, or `running | draining -> cancelling -> cancelled`. Callback return or throw immediately fences further task calls, cancels any unawaited host operations, and enters draining. Every terminal state requires both callback and owned host work to settle; fire-and-forget reads cannot escape capacity accounting. The manager observes all operation rejections, including operations abandoned by the callback. Retained evidence is data, not continued execution authority.

Deadline expiry and scope revocation synchronously enter cancelling, abort the task signal, and fence host access. Ordinary read failures are typed results; invalid API input and callback exceptions fail the task with contained diagnostics. A task that returned successfully but abandoned operations may retain its already-published valid evidence; incomplete observations are never published.

### 4.4 Read services

| Service | Input | Structured result |
| --- | --- | --- |
| `readText` | Path, optional line range, bounded limit | Observed text, resolved source identity, range, revision evidence, truncation |
| `findPaths` | Root and glob | Bounded discovered paths, coverage/truncation |
| `searchText` | Root, literal/regex query, optional glob | Bounded file/line/range hits, excerpts, coverage/truncation |
| `symbols` | Path, optional symbol query | Symbol names/kinds, locations/ranges, semantic coverage |
| `definition` / `references` | Path, symbol, optional line | Observed locations/ranges, semantic coverage |
| `readSkill` | Host-issued resource ID | Loaded skill text, resource revision and provenance |

Start with these methods. Other semantic actions can be added from demonstrated use cases; do not expose rename/fix through an action string that also accepts reads.

Every result is a JSON-owned discriminated union: `ok`, `denied`, `unavailable`, `unsupported`, `invalidated`, `cancelled`, `deadline_exceeded`, `limit_exceeded`, or `failed`. Successful empty searches have `status: "ok"` and zero hits. Missing text files are explicit failures, not empty evidence. Results carry truncation and partial coverage; limits never masquerade as exhaustive answers.

Text reads do not auto-convert images or return image attachments. Unrecognized/binary inputs are unsupported. Search and LSP locations are discovery hints; a successful semantic query does not prove the index is current or complete. Read located ranges before presenting their contents as source evidence.

The existing LSP outcome/freshness model remains authoritative. Structured locations must be retained where LSP replies are decoded, not reconstructed by parsing rendered prose. Similarly retain ripgrep's already-parsed matches and find results before presentation formatting. Share these bounded producers with existing native tools; preserve current tool-visible behavior.

## 5. Authorized execution path

Extension-initiated repository access is available only inside an admitted task. Host-owned collection-validation leases have the narrow exception defined in section 7. There is no unrestricted idle facade and no helper that changes active tools automatically.

For every operation:

1. Prove extension instance, request scope, conversation authority, admission gate, and remaining task budget are current.
2. Resolve the effective configured implementation. Capture its identity/revision; require the corresponding active tool (`read`, `find`, `grep`, or `lsp`). `readSkill` instead requires membership in the current already-loaded skill catalog.
3. Require a trusted host read resolver. Native name alone is insufficient. Any unsupported SDK/extension override returns unavailable without executing or consulting the hidden native implementation.
4. Validate arguments; run existing applicable extension tool-call gates and host before-tool policies with host-stamped extension origin.
5. Revalidate patched arguments, effective implementation, grants, mode, scope, and budgets after every awaited gate. Apply a dedicated preparation-read profile even in Build mode.
6. Execute the shared bounded producer through the session's configured environment/manager; keep its structured result private pending result policy.
7. Render the corresponding ordinary tool result and run all existing `tool_result` reducers with the task signal and host-stamped origin. Revalidate current policy/implementation after awaited reducers. In the managed path, any reducer error fails closed rather than using the ordinary runner's contained-error fallback.
8. Return structured observations and mint evidence handles only if reducers left the original content, details, and error status unchanged. Otherwise discard the raw structured result and return `unavailable` with reason `transformed_result` (or a failed outcome for an error result). Do not attempt to reverse-map arbitrary text transformations into source records.
9. Recheck authority and own the accepted result before publication.

Both `tool_call` and `tool_result` policy events receive host-stamped origin (`agent` or extension task/validation identity). V1 keeps existing foreground behavior; managed execution adds the origin and uses stricter result-error handling. Arbitrary conditional hooks cannot be classified as applicable before execution. No-op or other-tool hooks may coexist with managed reads; a redactor that changes this result prevents any raw structured data or evidence handle from escaping. Structured-transform interoperability is deferred.

Normal managed result observation uses diagnostic-only `extension_operation`, not synthetic assistant/tool transcript messages. Policy reducers execute for compatibility with installed gates, but no foreground `tool_execution_end` event is synthesized for them.

Extract the applicable gate chain; do not call `_handleToolCallPolicy` wholesale from a background task. It assumes canonical foreground production and updates Plan research bookkeeping. Managed reads alone do not satisfy the foreground research-before-submit gate, execute next-action policies, or create an agent tool call. Host `registerTurnPolicy().beforeToolCall` restrictions still apply; next-action policies do not authorize or schedule preparation.

No authorization path waits for the foreground event drain from inside one of its own handlers. Managed starts and repository calls are forbidden throughout tool-call gates, tool-result reducers, and operation-observer asynchronous lineage, including calls through previously captured facades after an await or timer. Carry an internal async-context prohibition rather than checking only the synchronous stack. The observer's context exposes no managed execution facade; captured facades must still enforce the prohibition. Reactive cross-extension operation chains are deferred.

Policy callbacks receive the task/validation signal, not an unrelated foreground signal. Tool or policy changes synchronously revoke affected in-flight operations; completion cannot validate against an obsolete implementation identity.

LSP uses the existing session manager and routing. Speculative calls never prompt for installation or start an installation. This requires per-operation installation policy rather than temporarily mutating a shared setting while foreground work runs. Already configured servers may start lazily. Server indexing can be incomplete; report that honestly.

## 6. Scope lifecycle

A request scope is created at the first conversational boundary after one or more new user deliveries commit. It groups all newly committed user deliveries participating in that boundary. It persists across tool turns, retries, and compaction recovery until replaced or revoked. Scope creation is not a new user-message commit.

| Situation | Contract |
| --- | --- |
| Fresh prompt | Normal preflight/hooks and canonical delivery finish; create scope; notify boundary; collect optional context. |
| Queued steer/follow-up | Queue admission starts no managed preparation. When the input actually commits for a request, replace the old scope and notify with the committed batch. |
| Direct SDK `steer()` / `followUp()` | Same committed-delivery path; no dependence on the `input` hook. |
| Several inputs drained together | One scope with ordered new inputs, not several competing current scopes. |
| Tool continuation | Same scope; ready evidence may be admitted at the next boundary. |
| Retry | Same scope, new attempt ID; no fresh scope-level wait allowance or automatic task replay. |
| Compaction/tree summary model calls | No preparation boundary or optional contribution collection. Existing general `context` hook behavior stays unchanged. |
| Automatic compaction recovery | Resume the scope, invalidate conversation-dependent snapshots/contributions, recheck source-backed evidence before the next conversational call. |
| Final response/host stop | No new preparation starts. Ready current evidence may be collected for an already-authorized final response; completion cannot grant further turns. |
| Foreground settlement | Revoke the scope and its tasks; there is no useful next boundary to wake. |
| Abort or accepted steering | Abort revokes immediately. Accepted steering revokes current preparation conservatively at queue admission, before its later committed scope is created. Follow-up waits until delivery and does not immediately cancel current preparation. |
| Tree navigation, reload, replacement, disable, authority loss | Revoke before the first teardown await; no inheritance into the new generation. |
| Transport disconnect | Follow the actual runtime ownership policy; disconnect alone is not a new task cancellation rule. |
| Restart | No task/contribution recovery. Reopened input may create new work only through ordinary proven delivery/request admission. |

A queued steer can revoke speculative work without changing delivery ownership or cancelling unrelated foreground tools. If that queued input is subsequently removed, old preparation is not automatically resurrected.

Provider-only continuations without a live user scope do not create one by reading the last transcript user message. Foreground tool observations carry their producing scope; an old native background job's completion cannot borrow whichever scope is now current. Extension-triggered turns require explicit future scope rules; V1 permits no implicit preparation for them.

### Closure and non-cooperative callbacks

Revocation is synchronous; cleanup is not. All outstanding host-owned operations remain tracked and must drain before their environment is destroyed. Optional context collection never joins arbitrary task callbacks.

After a one-second callback cancellation grace, mark a still-running callback unresponsive in diagnostics, keep its facade revoked, and retain its task against process-wide preparation capacity until both callback and host operations settle. Do not call it cancelled, release its quota, or allow repeated reload to create unbounded detached work. Host-owned resources must still drain; failure to drain them is a lifecycle error, not successful teardown. Arbitrary extension-created processes/sockets remain the extension's responsibility. Stronger termination requires process/OS isolation and is outside this proposal.

## 7. Context contribution contract

`task.context.put({ key, text, evidenceIds })` stores a bounded candidate, replacing only that extension's key within the captured scope. `remove(key)` retracts that candidate. These methods do not write the transcript, signal a user message, or request inference. Contributions live only in memory.

The host owns evidence handles; submitted IDs must resolve to observations obtained by that extension through the current scope. Another extension's handle, an invented ID, or a path string is not a valid substitute. A contribution may omit evidence IDs for an explicitly labeled extension suggestion, but it must not be displayed as verified source evidence. Referencing real evidence does not prove the extension's prose accurately describes it.

Each candidate depends on its captured request and conversation snapshot by default. After the conversation advances it must be refreshed. `put` accepts `dependency: "snapshot" | "sources"`, defaulting to snapshot. Sources-only is for direct observed source text or catalog information selected for the current user request; it relaxes conversation dependence, never request scope or source validation. Contradiction/ranking judgments based on old conversation text remain snapshot-dependent.

### Validation ownership

Source validation is a narrow host-owned collection lease, not revival of a completed task. The lease captures the owning extension, current scope/conversation authority, evidence and implementation identities, cancellation signal, and collection deadline. It can only revalidate existing observations, not discover additional candidates or run extension callbacks as tasks. It uses the same applicable current authorization and result-policy gates as the original read.

Reserve validation operation/byte capacity from the remaining scope budget before dispatch. Original production counts against task and scope budgets; later validation counts against the scope budget, not a finished task's deadline. Allow at most one unsettled collection lease per runtime and four process-wide, with at most two concurrent validation operations per lease. A later boundary with an outstanding lease omits new validation rather than queueing more work. These leases join the same host-resource drain and authority-revocation barriers as task operations.

Timeout or revocation aborts the lease and omits unfinished candidates immediately; resource ownership/capacity remain held until every dispatched operation settles. Already copied validation results can be admitted only if current when the collection snapshot closes. Late completions cannot admit evidence into that or another attempt. Validation is excluded from extension task counts but has these independent finite ceilings and the same scope byte/operation accounting.

### Collection order

1. Settle canonical delivery and invoke existing conversation-context transforms.
2. Capture current request/snapshot identity; emit the notification-only request boundary.
3. For the scope's first conversational attempt only, optionally await admitted tasks within the one shared wait allowance. Later attempts collect ready-only.
4. Snapshot ready candidates; obtain the host collection-validation lease and validate source handles/current grants within the separate collection deadline. No capacity or slow/unverifiable source checks means omitted candidates, not an unbounded main-request delay.
5. Select candidates deterministically within the remaining context allowance. Use stable extension registration order and per-extension key order, with a per-extension ceiling so one extension cannot consume the whole budget. Record exclusions.
6. Append one bounded, host-labeled untrusted evidence/suggestion suffix to the request-local message projection. Do not rewrite stable system instructions or break assistant-tool/result pairing.
7. Reconcile the canonical cursor and current scope before dispatch. If either changed, discard the candidate projection and let the normal provider admission path rebuild it.

Contribution admission is additive. No extension priority can evict required context or remove other extensions' contributions. Existing trusted payload/context rewrite hooks remain powerful; this new API is not a security fence against those hooks. An admission record describes what the managed API appended, not proof that later trusted payload rewrites preserved it or that the model acted on it.

Use both hard byte limits and the existing model-context estimator/reserve. If available headroom is unknown or insufficient, omit optional material. Never trigger compaction solely to fit preparation. An extension does not get another wait allowance by replacing a key, throwing, retrying, or starting another task.

### Freshness

- Text observations record the actual bytes read, resolved source identity, range, and host-created content revision evidence. A Git commit is not a working-tree revision.
- At admission, revalidate the relevant source through the same authorized environment. Changed/deleted/replaced/retargeted sources invalidate the candidate.
- Discovery lists and semantic relationships carry coverage and observation time, not a fabricated repository-wide revision. They are hints, not proof that no other matching files or references exist.
- If the backend cannot cheaply validate an observation, report unknown and omit it as current source evidence; an explicit historical observation can only appear as an extension suggestion labeled with its observation time.
- No global atomic filesystem snapshot is promised. Validation establishes a checked-at observation; a concurrent external writer can change a file after the check. Never label this as verified current build/test success.
- Reserve budget for validation when scheduling reads. Ready-only refers to not waiting for unfinished preparation; the total collection/validation deadline still bounds source checks.

## 8. Initial resource policy

These are proposed conservative defaults for the first implementation, not measured performance claims. A trusted host may tighten them; extensions may request less but cannot raise host ceilings.

| Limit | Initial ceiling |
| --- | --- |
| Unsettled preparation tasks (callback plus owned operations) | 2 per extension, 4 per runtime; 8 process-wide including revoked tasks |
| Pending admission queue | None; return a capacity result |
| Task wall-clock deadline | 10 seconds default, 30 seconds maximum, including auxiliary inference/retries |
| Managed repository calls | 16 per task, 64 per request scope |
| Returned source bytes | 256 KiB per task, 1 MiB per scope, including validation reads |
| Per-operation returned output | At most existing 50 KiB / 2,000-line bounds and the remaining budget |
| Retained completed task summaries | 32 per runtime; metadata only |
| Contributions | 8 keys and 8 KiB retained text per extension; 4 KiB each; 16 KiB aggregate request suffix including framing |
| Optional wait | Default 0; host may allow up to 1,000 ms total on first scope attempt (expanded from 100 ms in [#440](https://github.com/volt-hq/Volt/pull/440)) |
| Collection/source-validation deadline | 25 ms per attempt, separate from the optional wait; omit unfinished candidates |
| Unsettled collection-validation leases | 1 per runtime, 4 process-wide; at most 2 operations per lease |

For determinism, collection may await bounded source checks even in ready-only mode, but never unfinished preparation. Cheap identity checks and cached host change evidence may avoid I/O; this is not a reusable tool-result cache. Expensive sources can simply miss the boundary. Do not advertise zero added latency.

Byte limits bound returned/retained material, not necessarily filesystem scan I/O or language-server indexing. Deadline/cancellation bounds supported host operations; scan cost and server startup remain explicit limitations. The process-wide task ceiling prevents many sessions or reloads from bypassing callback admission limits.

Provider spending and arbitrary extension allocations/network calls are not automatically metered by these services. Task signals and deadlines must be propagated by the extension's inference client. No configuration promises enforced dollar/token limits on unmediated HTTP calls.

## 9. Optional loading, trust, and observation

Use current package/resource selection to disable an extension before evaluating its module/factory. An explicitly requested CLI extension remains an explicit load; `--no-extensions` is not an absolute prohibition on `-e` or SDK-injected factories. No new extension dependency is added to core.

Changing resource configuration takes effect through the existing reload/restart path. At reload, revoke and drain managed host work before swapping instances. A hot single-extension enable/disable UI is not required for V1. A future shipped preparation extension must avoid auxiliary model discovery or credentials checks until enabled and needed.

The [security model](security.md) remains trusted in-process extensions. Managed service permission checks do not prevent an extension from using Node filesystem access, `volt.exec`, its existing model registry, or its own HTTP client. Read authority is not export consent. An auxiliary-provider integration must explicitly document/configure its data export, use minimal selected state, and remain opt-in. This foundation does not silently upload any content.

`extension_operation` is diagnostic-only and non-blocking. It contains extension/task-or-validation/scope/operation identity, service kind, terminal status, elapsed time, byte counts, and coverage. Do not emit raw paths, source text, hook arguments, model prompts, credentials, or arbitrary exception messages/stacks in generic diagnostics; use fixed bounded reason codes. Full content is extension-local until explicitly contributed. Suppress the initiating extension's own operation notifications by default. Opting in does not grant reactive execution: the asynchronous-lineage prohibition in section 5 still applies.

Provide `volt.getWorkStatus()` as a bounded extension-local metadata snapshot for tasks, contributions, and exclusion reasons. It is usable from an idle command without retaining an obsolete execution facade and grants no execution authority. A deterministic example command can render it through current UI facilities. Use current extension error/status facilities for TUI, print/JSON, and RPC; no new native mobile inspector or protocol is part of this phase. Runtime diagnostics must remain observable without a terminal and must not influence task outcomes if an observer throws.

## 10. Implementation sequence

Each step is a separate reviewable change. Add changeset fragments for product source changes. Do not broaden into deferred facilities because a helper could eventually support them.

1. **Request identity and boundary contract.** Add the minimum common Harness boundary metadata and coding-agent scope owner. Cover direct/queued input, retries, compaction, abort, final-response, and replacement with faux-provider tests before exposing public callbacks. Existing delivery outcomes and persistence remain unchanged.
2. **Structured read producers and policy adapter.** Preserve structured read/search/LSP results behind existing tools; expose the finite managed read surface. Reuse full applicable policy gates, reject unclassified overrides, honor post-hook revocation, and disable speculative LSP installation per operation. Test resource-handle reads separately from workspace tool grants.
3. **Task ownership.** Add an extension task owner, distinct from model background jobs. Implement process/runtime/extension limits, deadlines, no-wake behavior, async-lineage recursion guards, scope revocation, and host-resource draining for every completion outcome. No task persistence or foreground result reuse.
4. **Contribution admission.** Add owned evidence handles, bounded replacement keys, separately owned collection-validation leases, stable ordering, one wait allowance, and ephemeral suffix assembly at the proven request boundary. Preserve canonical transcript and mandatory instructions.
5. **Test-only consumers and docs.** Prove scoped observations, bounded reads, and cited context with deterministic extension factories confined to tests. No actual extension or distributable example ships with the foundation; those come later. No classifier, network, paid tokens, or autonomous repair. Document only implemented services and their unavailable/enable/disable behavior in user-facing extension docs.

Likely write scopes:

- `packages/coding-agent/src/core/extensions/{types,runner,loader}.ts`: additive API binding, origin attribution, stale guards.
- New modules under `packages/coding-agent/src/core/extensions/`: scope/task owner, read facade, evidence/contribution store; avoid embedding all logic into `AgentSession`.
- `packages/coding-agent/src/core/agent-session.ts`: lifecycle wiring and extraction of the existing policy gate chain.
- `packages/coding-agent/src/core/{operation-authorization.ts,tools/,lsp/}`: bounded structured producers and per-operation restrictions.
- `packages/agent/src/harness/`: only the common request metadata/admission seam required by step 1; no extension strategy or classifier types.
- Focused tests and private extension factories: deterministic demonstration and behavioral coverage. A real extension under `examples/extensions/` or in a separate package is later work.

Do not add public RPC fields, alter session storage, or introduce configurable arbitrary host adapters in this phase. If a required integration cannot be implemented within those boundaries, revise this design before expanding the implementation.

## 11. Acceptance criteria

Tests assert provider inputs, actual operation dispatches, observed outcomes, and lifecycle state, not source-code substrings. Use `test/suite/harness.ts` and the faux provider for coding-agent integration; no real auxiliary model/API calls. Race cases pause execution at the relevant await rather than relying on sleeps.

| Area | Required observable behavior |
| --- | --- |
| Disabled baseline | Disabled factory is never evaluated; zero preparation reads/tasks/auth discovery; unchanged model request content. |
| No auxiliary provider | Deterministic extension works with no helper credentials; missing optional credentials leave main inference usable. |
| Direct and queued input | Prompt, `steer`, `followUp`, and batch modes produce one correctly owned scope at consumption; no work from uncommitted/failed delivery. |
| Context boundaries | Conversational calls collect; compaction/tree summaries do not; retries get no extra wait; final response creates no new work. |
| Restrictions | Excluded/inactive tools, Plan restrictions, custom overrides, host policies, and revoked grants prevent execution with explicit outcomes. |
| Hook races | Argument mutation is revalidated; tool replacement or revocation during a gate cannot dispatch the old implementation; gate exceptions fail closed. |
| Redaction | Conditional reducers run before publication; changes or exceptions withhold raw structured data/handles; no-op reducers and passive foreground triage still work. |
| LSP | Reuses configured manager, no install prompt or install dispatch, unsupported/empty/unknown coverage remain distinct. |
| Sources | File edits outside Volt, deletion, symlink retargeting, resource reload, and unknown revisions cannot silently appear as fresh evidence. |
| Budgets | Multiple tasks/extensions share ceilings; no unbounded pending queue; validation bytes count; callback return/throw or a cancellation request cannot release quota while a fire-and-forget operation remains unsettled. |
| Validation ownership | Completed-task evidence validates under a separate current lease; grant revocation, timeout, and reload prevent late admission and retain cleanup ownership. |
| No wake | Success/failure after foreground settlement causes no new provider call, queued message, or transcript append. |
| Cancellation | Abort, steer admission, reload, disable, tree navigation, and authority loss fence late operations/results; follow-up admission does not cancel current work prematurely. |
| Closure | Cooperative host work drains; unresponsive callbacks stay revoked and counted; replacement never reports undrained host resources as closed. |
| Context isolation | Owned JSON data cannot be mutated after admission; forged/foreign evidence handles fail; one extension cannot overwrite another's key. |
| Composition | Stable ordering, aggregate limits, required-context preservation, no orphan tool results, no automatic compaction for optional material. |
| Timing | A slow task cannot exceed the shared wait allowance; missed validation deadlines omit contributions; later attempts do not accumulate waits per extension. |
| Observability | Operation origin is host-owned, observer errors are contained, generic diagnostics contain no source/credentials, prepared versus admitted is distinguished. |
| Recursion | Post-await gate calls through retained repository/task facades and two-extension operation-observer ping-pong dispatch no managed work. |
| Modes and shutdown | TUI/print/JSON/RPC do not require dialogs; disposal and authority retirement suppress new work and stale publication. |

Also retain existing tests for delivery transactions, extension hook chaining/stale inertness, Plan policy, tool overrides, normal background jobs, and source exports. Run each new/modified test and `npm run check` for implementation changes. Do not run a full build or full test suite merely for this design document.

## 12. Completion and follow-on work

The full foundation is complete when test-only extension consumers can obtain the structured observations specified here through current policy, overlap bounded preparation with a main run, contribute optional evidence at the next eligible boundary, and be disabled without changing baseline behavior. The acceptance matrix must pass without a classifier. The first PR has the narrower completion criteria in its delivery plan; it must not claim that deferred APIs are implemented.

Only then evaluate a separately packaged decision-model extension against no preparation and deterministic preparation. Measure end-to-end task quality/latency, unused work, stale-result rejection, and context-induced regressions. Vendor confidence is not calibrated task success.

Transparent prefetch remains a separate design: it must define exact operation equivalence, override/policy identity, freshness, shared ownership/cancellation, and audit semantics before replacing any foreground tool result. Micro-workflows likewise require a separate finite-action execution contract. Neither is smuggled into this foundation as an unbounded task callback or a generic tool executor.

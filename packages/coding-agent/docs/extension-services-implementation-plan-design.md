# Extension services: first implementation PR

- Status: Implemented and validated first-PR slice.
- Tracking: [#431](https://github.com/volt-hq/Volt/issues/431), branch `feat/extension-services-foundation`.
- Date: 2026-09-18
- Parent design: [Extension services foundation](extension-services-design.md).
- Suggested PR title: `feat(coding-agent): add managed extension context services`.
- Deliverable: One usable end-to-end foundation, with no shipped extension or auxiliary model.

## 1. PR boundary

The full parent design spans several independently useful facilities. Implementing all of them at once would mix request-lifecycle changes, structured LSP adaptation, resource-handle authority, and a new preparation task owner. This PR deliberately implements a smaller complete path:

```text
committed conversational request
  -> notification-only request boundary
  -> optional extension-owned managed task
  -> authorized structured file/search observations
  -> ready-only, source-checked context at a later model boundary
```

This is the implemented delivery slice, not a claim that every facility in the parent design ships here. The parent design remains the target contract; the inclusion/exclusion table below controls this PR. Do not publish stubs for deferred methods.

| Include | Defer |
| --- | --- |
| Request/branch/runtime ownership and stable snapshots | Structured LSP navigation and per-operation LSP install controls |
| Bounded managed tasks, cancellation, draining, and no-wake behavior | `readSkill`, resource-handle reads, and skill-specific authority |
| `readText`, `findPaths`, and `searchText` | Optional blocking preparation waits / `requestWait` |
| Applicable host and extension policy gates | Transparent foreground tool-cache reuse and single-flight |
| Evidence handles and bounded ready-only context admission | Repository indexes, import graphs, and test-association engines |
| Task/operation metadata and extension-local status | New TUI/mobile inspectors, RPC fields, and persistent task storage |
| Deterministic test-only extension factories | Actual extensions, distributable examples, auxiliary-model adapters, model/provider dependencies |
| User-facing API documentation and changeset | Autonomous workflows, speculative commands/tests/edits |

**User-visible tradeoff:** this PR does not guarantee preparation before the first model call. It never waits for unfinished preparation; ready work can improve later calls in the same request. First-call bounded waiting can be added separately without weakening task or authorization semantics.

This slice is still a medium-to-large runtime PR. Keep it reviewable through the commit order below and strict subsystem boundaries, not by omitting race tests or weakening the contract.

## 2. Public API shipped by this PR

Implement only these parts of the parent design:

- `volt.on("request_boundary", handler)`: notification-only conversational boundary with host-issued scope/attempt identity and cause. No optional-wait fields or method in this PR.
- `ctx.work`: scoped readonly snapshot plus task admission; absent outside an eligible conversational scope, and always absent in policy/diagnostic callbacks. Include current inputs, execution mode, cwd, model identity, and available managed read capabilities. Do not introduce a new skill catalog API yet; existing explicit resource inspection remains unchanged.
- `ctx.work.tasks.start({ key, label, timeoutMs? }, callback)`: immediate handle or typed admission result; no nested managed starts.
- Task handle: identity/status, `cancel()`, and cancellable `wait()`; no arbitrary result-persistence API.
- Task context: captured snapshot, fixed signal/deadline, `repository.readText`, `repository.findPaths`, `repository.searchText`, and `context.put/remove`.
- `volt.on("extension_operation", handler)`: bounded diagnostic-only observation, not a reactive work trigger.
- `volt.getWorkStatus()`: extension-local task/contribution metadata available even while idle.
- Host-stamped origin on extension `tool_call`/`tool_result` policy events. Do not add preparation fields to public RPC or canonical tool messages.

Keep data JSON-owned and types erasable. Do not expose internal managers, accept caller-selected ownership IDs, grant a generic tool executor, or add permissive `any` types to make the adapter convenient.

Configuration stays small: validated host limits passed through the SDK/session construction path, defaulted internally and allowed only to tighten initial ceilings. No new settings UI, profile system, or installation path. Tests may inject stricter limits and a controllable clock; these do not become permissive production escape hatches.

## 3. Accepted implementation checklist

The requirements below record the accepted plan. The implementation consolidates task, scope, evidence, and collection ownership into `work-runtime.ts`, its host-only interfaces into `work-host.ts`, and public contracts into `work-types.ts`; it does not create separate manager layers for each checklist heading. Native structured producers share `tools/repository-observation.ts`. No authorization, storage, or RPC redesign was needed.

The end-to-end path and documentation are implemented. Focused Harness/session/runtime/producer tests pass, and an independent security review's policy-registration, task-join, and delayed-timer findings have behavioral regressions. Final validation on 2026-09-18: `npm run check` passed; `./test.sh` passed with 8,397 tests passed and 829 skipped across the workspace. The test launcher restored the auth file. No paid inference, daemon restart, or mobile build was used.

### 1. Establish a real conversational request boundary

Primary files:

- `packages/agent/src/harness/{types.ts,agent-harness.ts}`.
- `packages/agent/src/types.ts` only if existing committed-delivery metadata cannot carry the necessary identity.
- `packages/coding-agent/src/core/agent-session.ts`.
- `packages/coding-agent/src/core/extensions/work-runtime.ts` (scope ownership).

Work:

- [x] Trace canonical committed deliveries into each conversational provider request. Add the minimum internal Harness metadata needed for delivery batch, request cause, and attempt identity.
- [x] Place the host extension boundary after canonical delivery settlement and existing context transforms, but before final provider admission. Do not rely on the high-level `before_agent_start` hook alone.
- [x] Create one scope for the new committed user-input batch; retain it across tool turns/retries and compaction recovery.
- [x] Fence the scope on abort, accepted steering, foreground settlement, navigation, reload, replacement, and loss of conversation authority. Follow-up admission alone does not revoke it.
- [x] Exclude compaction/tree-summary calls and provider-only extension-triggered runs without a live user scope. Old background completions cannot borrow a new scope.
- [x] Preserve delivery ownership, queue acknowledgements, canonical persistence, and model request behavior when no extension subscribes.

Verification: focused Harness boundary tests for direct input, direct SDK steer/follow-up, batch drain, retry, structural model calls, delivery failure, final response, and reentrant abort. Use barriers at awaits; no wall-clock sleeps.

**Gate:** if this requires redesigning delivery transactions or session storage, stop and revise the plan rather than expanding this PR.

### 2. Implement owned tasks and bounded lifecycle

Primary files:

- `packages/coding-agent/src/core/extensions/work-runtime.ts` (task and process-level admission).
- `packages/coding-agent/src/core/extensions/{types.ts,runner.ts,loader.ts}`.
- `packages/coding-agent/src/core/agent-session.ts` lifecycle wiring.

Work:

- [x] Implement host-owned handles and `running -> draining -> completed/failed` or `running/draining -> cancelling -> cancelled` transitions.
- [x] Enforce runtime, extension, process, deadline, operation, and byte ceilings from the parent design; reject excess admissions instead of creating an unbounded queue.
- [x] Capture origin/scope/signal at task creation. Never resolve these through a getter that can silently switch to a later request.
- [x] Fence task methods when callbacks return or throw; cancel and drain unawaited host operations before releasing any task capacity.
- [x] Retain unresponsive revoked tasks in process accounting until callback and host work settle. Contain rejection and report bounded reason codes.
- [x] Keep this owner distinct from native Bash/subagent background jobs. Task completion must not enqueue messages, resume the agent, or request inference.
- [x] Add async-context guards against nested starts and managed execution in gate/reducer/operation-observer lineage, including retained facades used after an await or timer.

Verification: deterministic admission/cancellation unit tests, fire-and-forget read drainage, duplicate live keys, callback failure, unresponsive callbacks, cross-runtime capacity, and zero provider wakes after task completion.

### 3. Add structured text/search reads behind existing policy

Primary files:

- `packages/coding-agent/src/core/tools/{read.ts,find.ts,grep.ts}` and narrowly shared internal producer module(s).
- `packages/coding-agent/src/core/extensions/{work-host.ts,work-runtime.ts}`.
- Existing authorization from `packages/coding-agent/src/core/operation-authorization.ts` (unchanged).
- Policy extraction from `packages/coding-agent/src/core/agent-session.ts` and internal runner support.

Work:

- [x] Preserve bounded structured text ranges, resolved source identities, discovered paths, and search matches before native tool formatting. Native model-visible tool behavior stays unchanged.
- [x] Require the corresponding active trusted native tool: `read`, `find`, or `grep`. No automatic enabling or fallback through Bash. An unavailable capability is a typed result.
- [x] Reject unclassified SDK/extension overrides without executing or bypassing them. Use the same configured environment/operations for supported native producers.
- [x] Apply the full applicable gate chain: current authority and grants, schema validation, extension call gates, host before-tool policies, post-hook revalidation, and a preparation-only read profile.
- [x] Keep Plan research bookkeeping and foreground transcript publication out of this execution adapter.
- [x] Run existing result reducers on the ordinary rendered result before publishing structured data. No-op reducers coexist; changed content/details/error status withhold raw structured data and evidence handles. Managed reducer exceptions fail closed without changing ordinary foreground error semantics.
- [x] Validate implementation/policy identity across awaits and before returning data. Supply task signals to policies, not an unrelated foreground signal.
- [x] Apply source-byte/operation budgets and result ownership before exposing any result.

Verification: native text/search parity; grant/mode restrictions; blocking and argument-patching gates; runtime tool replacement; conditional redaction and thrown reducers; no-op reducer interoperability; binary and truncation cases; recursion through captured facades.

**Gate:** do not turn this into a general filesystem abstraction, custom adapter registration API, or structured LSP rewrite.

### 4. Admit ready context with provenance and freshness

Primary files:

- `packages/coding-agent/src/core/extensions/work-runtime.ts` contains the bounded evidence/contribution store and collection-validation owner.
- Boundary wiring in `packages/coding-agent/src/core/agent-session.ts` and the Harness adapter from step 1.

Work:

- [x] Mint evidence handles only for observations that survived authorization/result policy. Bind handles to extension, scope, source, and implementation identity.
- [x] Support extension-local replacement/removal keys, snapshot-dependent and source-only contributions, and explicit unverified suggestions without evidence handles.
- [x] Collect ready candidates only. No waits on unfinished tasks and no `requestWait` implementation or configuration.
- [x] Revalidate source observations through a separate host-owned collection lease after producer tasks finish. Charge scope budgets and retain cleanup ownership after collection timeout.
- [x] Cap collection at the parent's 25 ms initial deadline; omit evidence that cannot be checked in time. This is bounded validation overhead, not a zero-latency promise.
- [x] Reject forged/foreign/stale handles, changed/deleted/retargeted sources, revoked grants, and stale conversation-dependent contributions.
- [x] Append a stable, labeled untrusted suffix only to the request-local projection, within byte and context-reserve limits. Never evict mandatory context, break tool-message pairing, or trigger compaction to fit optional work.
- [x] Reconcile scope and canonical cursor at dispatch. No late result may amend an already-running provider request.
- [x] Keep fresh observations as checked-at evidence, not a claim of an atomic repository snapshot or successful verification.

Verification: fake-provider context assertions; out-of-band edits and symlink retargeting; collection after producer completion; validation timeout racing reload; multi-extension ordering/limits; unchanged canonical transcript; compaction exclusion; source-only retention and snapshot-dependent invalidation.

### 5. Wire public exports, observability, and regression coverage

Primary files:

- `packages/coding-agent/src/core/extensions/{types.ts,index.ts,runner.ts,loader.ts}`.
- `packages/coding-agent/src/{index.ts,core/sdk.ts,core/agent-session-services.ts}` only as required for validated host options and exports.
- Focused tests described below.

Work:

- [x] Export the supported API subset only; no placeholder LSP/skill/wait functions.
- [x] Expose bounded extension-local status, diagnostic-only operations, and contribution inclusion/exclusion reasons. Never log raw source, credentials, or arbitrary exception text in generic diagnostics.
- [x] Ensure observer failures do not change outcomes and observer lineage cannot schedule more managed operations.
- [x] Preserve resource filtering: an excluded module is not evaluated. Reload revokes work before disposing its environment; new extension instances do not inherit old handles.
- [x] Exercise TUI-independent behavior through SDK/print/JSON/RPC bindings without adding protocol fields or native UI.
- [x] Use private test-only extension factories to demonstrate the complete path and disabled baseline. Do not add files under `examples/extensions/` or a shipped preparation extension in this PR.

### 6. Document, validate, and prepare the PR

- [x] Update `docs/extensions.md` and `docs/sdk.md` with the actual API, timing contract, typed failure outcomes, override/redaction limitations, trusted-code caveat, and enable/disable behavior.
- [x] Link the development design from user docs using an absolute GitHub URL; keep both `*-design.md` documents out of published navigation/package content.
- [x] Add one feature changeset covering `@hansjm10/volt-coding-agent` and `@hansjm10/volt-agent-core` if both product packages change. Use patch bumps for additive API changes; do not add compatibility shims.
- [x] Run every added/modified test, relevant existing regressions, and `npm run check` with full output. Run the required non-e2e `./test.sh` gate before PR submission.
- [x] Review the final diff for unrelated refactors, changed native tool output, new dependencies, generated RPC/storage changes, or actual extension implementation.
- [ ] Open the PR only after validation succeeds or the user explicitly accepts a documented blocker. Do not silently fix unrelated failures.

## 4. Test layout and verification commands

Added test files:

- `packages/agent/test/harness/agent-harness-request-boundary.test.ts`.
- `packages/coding-agent/test/extension-work-runtime.test.ts`.
- `packages/coding-agent/test/extension-work-runner.test.ts`.
- `packages/coding-agent/test/repository-observation.test.ts`.
- `packages/coding-agent/test/suite/extension-work.test.ts` using `test/suite/harness.ts` and the faux provider.

Private factories live in the relevant test or a test-only fixture, not a new example/package. If tracking reveals a specific existing bug, put its regression under `test/suite/regressions/<issue-number>-<slug>.test.ts`; do not invent an issue number.

Run selected tests from their package roots. Both relevant Vitest CLIs currently exist in package-local `node_modules`; recheck paths rather than reinstalling dependencies if the environment changes.

```bash
cd packages/agent
node node_modules/vitest/dist/cli.js --run --config vitest.harness.config.ts \
  test/harness/agent-harness-request-boundary.test.ts \
  test/harness/agent-harness-delivery-transaction.test.ts \
  test/harness/agent-harness-lifecycle.test.ts
```

```bash
cd packages/coding-agent
node node_modules/vitest/dist/cli.js --run \
  test/extension-work-runtime.test.ts \
  test/extension-work-runner.test.ts \
  test/repository-observation.test.ts \
  test/suite/extension-work.test.ts \
  test/extensions-runner.test.ts \
  test/extension-runner-stale-inertness.test.ts \
  test/agent-session-conversation-generation.test.ts \
  test/suite/agent-session-model-extension.test.ts \
  test/suite/regressions/206-delivery-transaction-contract.test.ts \
  test/planning-state.test.ts \
  test/suite/background-jobs.test.ts \
  test/tools.test.ts
```

Add any other modified tests to the targeted run. Before PR submission, from the repository root:

```bash
npm run check
./test.sh
```

`./test.sh` temporarily moves the user's auth file and restores it through a trap; run it serially and do not kill it mid-cleanup. Never substitute an unfiltered full Vitest invocation. No `npm run build`, direct `npm test`, paid inference, daemon restart, or mobile build is needed for this work.

## 5. PR workflow and review focus

[CONTRIBUTING.md](../../../CONTRIBUTING.md) requires an issue before a nontrivial PR. Issue [#431](https://github.com/volt-hq/Volt/issues/431) tracks this slice with the affected package labels and `inprogress`. Implementation uses `feat/extension-services-foundation`. No roadmap acceptance is implied.

Use one branch and coherent commits covering the six groups above. Stage only owned paths. The PR description should lead with the new extension contract, explicitly state that no preparation extension/model ships, list deferred methods, and include exact validation results.

Highest-risk review boundaries:

1. Canonical delivery versus observational request notification: no replay or altered receipt semantics.
2. Task/validation leases versus teardown: no quota release or resource destruction before owned operations drain.
3. Native result producers versus installed policy/redaction hooks: no raw-data bypass.
4. Canonical history versus ephemeral context: no transcript pollution, context leakage, or new model wake-ups.

Do not promise a line-count or timing estimate until the first boundary adapter and producer extraction are implemented. If review cannot follow these four boundaries without a larger Harness or filesystem redesign, split at a completed internal milestone rather than exposing a partial unsafe public API.

## 6. Definition of done

A test-only extension can observe a committed user request, start a bounded task, perform authorized text/search reads, and provide fresh optional evidence to the next eligible conversational model call. Disabling that extension leaves baseline request content and task/provider activity unchanged.

All lifecycle/policy/freshness tests pass; required checks pass; existing native tools and background jobs retain their behavior. No actual extension, auxiliary model, provider dependency, protocol change, or task-storage format is included. The PR documents exactly this subset rather than claiming completion of the entire parent design.

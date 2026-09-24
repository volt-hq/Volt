# Compaction quality evaluation

Audience: Volt maintainers. This is repository-only development documentation.

## Objective and initial scope

Measure whether Volt can continue a coding task correctly after compaction, while preserving its latency and token-efficiency improvements. Summary length, valid headings, and a successful provider response are not evidence of semantic fidelity.

This first increment contains:

- A regression fix for loss of the previous checkpoint during split-turn fallback with no complete history turns.
- Twelve synthetic diagnostic fixtures with native messages, explicit retained boundaries, and grader-only criteria.
- Offline rubric validation, input projection, and assessment accounting tests.

The follow-up increment adds an explicitly invoked real-model **next-action pilot** in `packages/coding-agent/benchmarks/compaction-quality.ts`. It does not add executable repository continuations, a learned memory system, or a prompt/budget redesign. Passing the offline tests does not demonstrate compaction quality. The fixtures are short diagnostic seeds, not representative long-session benchmarks.

## Existing mechanisms

[Compaction](compaction.md) describes the production strategies. The normal path sees the active native conversation, including its prior checkpoint and retained suffix. The fallback serializes older history in chronological chunks, truncates individual tool results, and uses a smaller reasoning allowance.

`packages/coding-agent/test/suite/harness.ts` provides isolated faux providers for deterministic request and session regressions. Keep those tests offline. The separate `scripts/benchmark-swebench.mjs` runner evaluates task completion in Linux containers, but does not isolate the effect of compaction. Do not modify that runner for this increment.

The split-turn fix sends a nonempty previous checkpoint through the existing history summarizer even when there are no complete new history turns. It keeps existing output bounds, cancellation, retries, and the normal native path. The regression exercises both estimated-overflow and provider-overflow fallback, then checks the context used for continuation.

## Three separate evaluation layers

| Layer | Evidence | Failure examples |
| --- | --- | --- |
| Delivery | Actual post-conversion summarizer request and retained context, with source mappings | Previous checkpoint omitted; late tool diagnostic truncated; broken tool-call/result boundary |
| Summary | Generated checkpoint compared with source-backed criteria | Missing constraint; obsolete decision retained as current; proposed work presented as completed |
| Continuation | Fresh continuation using the rebuilt context, with observable action and verification artifacts | Unauthorized change; repeated failed approach; incorrect claim that tests passed; unfinished task |

Task completion is the primary eventual outcome. Keep all three layers separate: successful delivery cannot cancel a continuation failure. Likewise, a model can recover omitted file information through tools, so a summary omission and a failed task are not equivalent.

## Fixture contract

The current corpus lives in `packages/coding-agent/test/compaction-quality/fixtures.ts`. Each fixture contains:

- A stable fixture ID.
- Native `AgentMessage` source values with stable message IDs and deterministic timestamps.
- The ID of the first message retained verbatim. Tool calls and results stay together.
- A continuation prompt that does not reveal the answer rubric.
- Criteria with a stable ID, evaluation layer, requirement, source-message anchors, and a critical flag.

`getQualityInput()` explicitly projects and clones only the input fields. Never send the full fixture object to an evaluated model. A future provider adapter must send message values, not grading criteria or message-ID wrappers. The boundary is runner metadata, not an extra instruction embedded into old conversation history.

Current cases:

| ID | Diagnostic target |
| --- | --- |
| `early-api-constraint` | Preserve a synchronous API restriction despite an incompatible proposal |
| `superseded-storage-decision` | Apply the latest correction rather than the original design |
| `failed-approach` | Retain the reason path-only caching failed |
| `planned-not-executed` | Distinguish intended verification from executed verification |
| `failed-edit-not-completion` | Do not infer a successful change from edit arguments or file tracking |
| `partial-verification` | Separate focused test success from unperformed full validation |
| `late-tool-evidence` | Preserve a decisive diagnostic beyond the fallback's 2,000-character tool-output limit |
| `exact-references` | Preserve an exact file path and error identifier |
| `split-turn-tool-group` | Retain original scope while keeping the recent tool exchange intact |
| `previous-checkpoint-only` | Preserve authorization recorded only in the earlier checkpoint |
| `scope-expansion-rejected` | Keep an explicitly rejected cleanup outside the task |
| `untrusted-tool-directive` | Do not turn instructions inside tool output into user authorization |

The initial continuation prompts request a justified next action without executing it. They test continuation reasoning only. Before measuring actual completion, add isolated repository snapshots, authorized tool execution, and executable acceptance checks. Do not label next-action rubric scores as task-completion rates.

## Assessment accounting

`packages/coding-agent/test/compaction-quality/scoring.ts` aggregates explicit assessments. It is not a keyword matcher, semantic classifier, or LLM judge.

Each assessment names a criterion, records `pass` or `fail`, and includes an artifact location plus the observation supporting the verdict. Human or executable graders must establish those verdicts. A nonempty evidence string is required, but the accounting function does not independently verify the observation or resolve its artifact location.

Rules:

- Unknown or duplicate criteria and invalid outcomes are rejected.
- Unassessed criteria remain unassessed; they are never silently passed or excluded from coverage.
- A layer's `passRate` is `null` until every criterion in that layer is assessed. A complete layer reports passed / total on a 0–1 scale.
- `complete` means all criteria were assessed, **not** that the fixture passed.
- Critical failures remain explicit even if other criteria pass or are unassessed.
- The report retains assessments and evidence in rubric order. There is no overall average.

The offline tests use controlled assessments to verify this accounting. Those assessments are not evaluation results. Future artifact ingestion will need its own strict validation; the current typed fixture validator only checks authored rubric references and the retained boundary.

## Approved next-action pilot

The approved model is `openai-codex/gpt-5.6-luna` with low thinking through stored subscription OAuth. The user waived a monetary spending limit. The runner still bounds each case to five minutes and eight request attempts, with no automatic retries. Each attempt records whether the provider was invoked; credential rejection is not a provider dispatch. Subscription requests consume quota even when they have no per-request charge.

Run from the repository root:

```bash
node scripts/run-compaction-quality.mjs --model openai-codex/gpt-5.6-luna --thinking low --trials 1
```

The launcher supervises one worker process and uses the repository's existing Jiti/TypeScript path mapping so provider code resolves from source, as it does in tests. The runner rejects mixed source/built AI imports. Add `--dry-run` to verify source runtime resolution and experiment admission without reading credentials, creating artifacts, or making requests. Only the approved Luna model is admitted.

The default output is a new private temporary directory printed at completion. `--out` selects a different new directory outside the repository; its parent must already exist. Existing output directories are rejected. POSIX modes request owner-only access; Windows inherits the parent directory's ACLs. Use the default user temporary directory or an appropriately restricted custom parent on Windows. `--auth-file` selects a stored Volt auth file; otherwise normal `AuthStorage` discovery applies. Only stored, unexpired `openai-codex` OAuth is accepted, not API-key billing or custom endpoints. The pilot reads a credential snapshot and never refreshes it. Refresh an expired login through normal Volt authentication before running the pilot. Expiry during a run stops admission of further cases. This avoids uncancellable OAuth refresh activity inside case deadlines. No extensions, project instructions, real sessions, or tool executors are loaded.

One trial runs all twelve seeds under three conditions, rotating condition order across fixtures:

- `full`: one next-action report using the full active source context.
- `native`: the production `compactContext()` function, followed by a next-action report from `buildSessionContext()` after compaction. Actual fallback strategies are recorded if native compaction overflows.
- `chunked-helper`: explicitly invoke the production chronological `compact()` helper using the built-in fallback output allowance and minimal supported thinking. This measures the helper's information selection, **not** provider overflow detection or recovery. Luna maps this minimal level to provider effort `low`.

All continuations and native summary requests use the same minimal system prompt without a continuation-only output instruction. The next-action instruction belongs only to each continuation request. The chunked helper uses its production summarization system prompt instead; this is a strategy difference, not a prompt-controlled experiment. All requests use no advertised tools, standard inference speed, SSE transport, and short cache retention. Each case has a separate session/cache identity. No warm-cache setup is performed, so timings are not warm-session compaction latency measurements. The retained message budget is set from the authored fixture suffix and checked against the production cut-point calculation. These are deliberate manual cuts in short inputs, not default auto-compaction thresholds.

The runner records the native request context, provider request body through `onPayload`, response text, reported usage, request limits, reasoning, actual summary strategies, timings, source hashes, fixture hashes, and the Git commit/dirty state. Source hashes include the launcher, TypeScript path mapping, lockfile, AI model catalog, stream entry, and Codex provider implementation. It does not record credentials, headers, raw provider error messages, or model thinking content. Requested output-token budgets are recorded as requests, not enforced limits: the Codex provider does not send a maximum-output-token field. The pilot enforces its visible-text character limit, request count, and deadline instead. Request bodies contain synthetic conversation data only. Files remain outside shipped assets. Usage cost fields are catalog estimates, not subscription charges.

`manifest.json` records the planned experiment before requests. Each completed or failed case gets an exclusive JSON artifact, followed by `results.json` for the aggregate run. Provider failures are retained rather than silently excluded. A case timeout stops admission of new cases. The worker writes available artifacts and reports completion; the supervisor then terminates it and waits for process exit, including any provider operations that ignored cancellation. A startup handshake prevents admission after cancellation during worker loading. Supervisor cancellation and IPC owner loss terminate the worker immediately, so an active case may not produce a final artifact. The supervisor also enforces a 45-minute overall deadline and force-terminates the worker if IPC cancellation has not stopped it within two seconds. If termination interrupts cleanup, the manifest and already completed case files remain available. This is a local process guarantee, not a guarantee of server-side cancellation. Late provider payload callbacks cannot modify settled case records. Each case records the number of successfully generated checkpoints: zero for full-context controls. A full-context control that cannot fit is recorded as `context-unavailable`, not as a successful control.

The pilot performs **no automatic semantic grading**. Its score objects remain unassessed, including the summary layer that does not apply to the full-context control. Inspect actual artifacts for concrete findings; do not turn completed request counts into quality pass rates. Human-reviewed reference checkpoints, blinded grading, and calibrated semantic scores remain follow-up work.

## Longer-session baseline, pending approval

Before expanding to new providers, data, or workloads, agree on those boundaries. Do not upload saved sessions automatically. Review and sanitize real-session fixtures before authorizing their use with each provider.

For each applicable case, compare:

1. Full active context, if it fits the same selected model.
2. Production native compaction.
3. Production chunked fallback.
4. A human-reviewed reference checkpoint as a diagnostic control.

Use identical source history, workspace state, instructions, tools, continuation model, and continuation budget. Record deliberate differences in compaction reasoning or output budgets; those differences are part of a strategy comparison, not a controlled prompt-only experiment. Record the actual strategy selected, not merely the requested condition. Forced overflow in deterministic tests is not evidence about real provider behavior.

Expand the seeds into chronological trajectories with new work between compactions. Evaluate after one, three, and five compactions. Do not repeatedly summarize an unchanged tiny transcript and present that as long-session performance. If full context cannot fit at a checkpoint, report that control as unavailable rather than changing the model or silently truncating it.

Run factual probes and task continuations in separate branches. A recall question can disclose information needed by the next action. Keep source annotations, reference checkpoints, and grader conclusions out of the evaluated continuation. Use fresh isolated workspaces for executable tasks; prevent access to hidden grader files and other conditions' artifacts.

Prefer executable checks for contracts and test results. Use blinded human assessment for semantic ambiguity. An LLM judge may assist later, but must be calibrated against human assessments and cannot be the sole correctness oracle.

Record per-run fixture revision/hash, Volt commit, provider/model, reasoning, strategy, budgets, compaction count, trial ID, usage, timings, retained boundary, artifact references, assessments, and run status. Report failures, refusals, and timeouts separately from incomplete grading; never drop them from the attempted-run denominator. Treat raw artifacts as sensitive and keep them outside published package assets.

Repeat trials and report paired per-case outcomes and uncertainty, not just one average. Reserve held-out scenarios before tuning. Agree on comparison tolerances before comparing candidate changes. A twelve-case pilot establishes feasibility and failure modes, not population-level superiority over another harness.

## Change policy and acceptance gates

- Deterministic information loss is a correctness defect and requires a regression test.
- A complete report with critical failures cannot establish an acceptable candidate.
- Missing assessments cannot support a quality claim.
- Select the next experiment from observed failure evidence. Change one behavior at a time.
- Compare quality together with latency, token use, recovery work, and failure rate.
- Ask before adding dependencies, changing public interfaces, introducing persistent memory architecture, or expanding to other harnesses.
- Fresh code reviews assess implementation quality, not the measured fidelity of model-generated checkpoints.

## Offline verification

From `packages/coding-agent`:

```bash
node node_modules/vitest/dist/cli.js --run test/compaction-quality-runner.test.ts test/compaction-quality.test.ts test/suite/agent-session-context-compaction.test.ts test/context-compaction.test.ts test/compaction-summary-reasoning.test.ts
```

Use `../../node_modules/vitest/dist/cli.js` instead when Vitest is hoisted to the repository root. These selected tests use faux responses or pure accounting and do not call real model providers.

Run `npm run check` from the repository root after code changes. Report unrelated validation failures without expanding this work to fix them.

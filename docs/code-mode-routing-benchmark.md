# Local code-mode routing benchmark

Small development-only benchmark for deciding whether selected data tools should be callable only through `run_code`. No production tools, grants, settings, dependencies, or default routing change.

## Run

From the repository root, using the existing installation of dependencies:

```bash
npm run benchmark:code-mode -- --help

# No credentials, provider calls, or output directory; inspect the plan and limits.
npm run benchmark:code-mode -- --dry-run --trials 6 --seed 1

# No provider calls; reference programs run through real sessions, MCP, and QuickJS.
npm run benchmark:code-mode -- --self-test --max-tokens 2000000

# Small live control: one task × three routes. Budgets never expand automatically.
npm run benchmark:code-mode -- --live --task single-lookup

# One 60-case batch: twenty tasks × three routes.
npm run benchmark:code-mode -- --live --trials 1 --trial-start 1 --seed 1 --max-requests 400 --max-tokens 1800000 --minutes 30

# Re-read saved results without credentials or provider calls.
npm run benchmark:code-mode -- --report /path/to/run

# Combine distinct compatible runs; optionally save the comparison outside the repo.
npm run benchmark:code-mode -- --report /path/to/run-a --report /path/to/run-b --out /path/to/new-comparison
```

`node scripts/run-code-routing.mjs` is the equivalent direct entry point. `--trials` accepts 1–50; `--trial-start` sets the first trial number (default 1, last trial cannot exceed 50). This preserves the six-order schedule across separate bounded batches: use trial starts 1 through 6 with one trial per batch, retaining the same seed. Review each batch before starting the next; do not discard or retry unsuccessful cases to manufacture a clean sample.

`--seed` accepts an unsigned 32-bit integer and controls ordering only, not provider sampling. Use a new output directory for every batch. There is no unlimited mode, automatic retry-until-success, or automatic restart after a cap. Default budgets are unchanged and may truncate the larger suite; select explicit caps for full-suite runs.

The live model is `openai-codex/gpt-6-astra` with `xhigh` thinking, as requested for this experiment. The runner reads the existing Codex OAuth credential from Volt's `auth.json`. It never logs credentials, refreshes or writes credentials, starts login, or falls back to environment/API keys. An absent or expired credential stops admission; refresh through the normal Volt login outside the runner before retrying.

`--task` selects one fixture from the twenty listed below; `--dry-run` prints all IDs and the exact schedule. `--out` selects a new directory whose parent exists outside the repository. Existing directories are never overwritten. By default artifacts go into a unique OS temporary directory, whose path the runner prints.

## Experimental arms

- **hybrid:** current native `mcp` and `run_code` schemas and Volt's normal guidance.
- **code-first:** same tools, plus stage-specific guidance favoring scripts for pagination, filtering, joining, and aggregation while retaining direct one-off calls.
- **code-only:** native MCP discovery/cache/lifecycle actions stay direct; the model-facing MCP schema omits `action: "call"`. A benchmark-only extension checks the host-supplied operation origin and rejects direct MCP invocation. Nested calls still use the real session policy and active tool grants.

This is an experimental presentation projection, not a new production routing API. It does not disable an active tool to hide its schema, bypass per-call policy, or expose tools the session lacks. MCP metadata starts warm for every case; the model still discovers the schemas through the gateway. Each task/arm has fresh fixture data and an independent in-memory session. A seeded schedule presents all six route permutations exactly once per task in each six-trial block. Every route appears twice in each position, and every pair appears in both orders equally often. Partial blocks need not be balanced. Task order also varies deterministically by trial and seed so interrupted runs do not always omit the same final tasks.

## Tasks and scoring

| Fixture ID | Behavior covered |
|---|---|
| `single-lookup` | One service lookup; scripting-overhead control |
| `paginated-aggregate` | Six pages, 120 noisy invoices, integer reduction |
| `join-filter` | Join accounts and tickets; distinct counts |
| `adaptive-troubleshooting` | Follow current textual evidence and a conditional runbook branch |
| `cursor-dedup` | Opaque cursor pagination with overlapping event IDs |
| `grouped-top-k` | Cross-page group sums and deterministic rank ties |
| `temporal-asof` | Inclusive time cutoff, revision precedence, future exclusion |
| `reconciliation` | Missing, unexpected, duplicate, and matched IDs |
| `sparse-summary` | Distinguish absent fields, nulls, zero, and negative values |
| `three-way-join` | Deduplicated customers/orders/refunds without join fanout |
| `independent-fanout` | Six independent resource lookups |
| `empty-result` | Correctly return no matches from populated data |
| `nested-projection` | Explicit false/zero overrides and exact escaped text |
| `hierarchy-rollup` | Traverse shared child links without double counting |
| `interval-overlap` | Half-open boundaries, clipping, and interval union |
| `text-log-extraction` | Paginated log parsing; columns versus misleading message text |
| `policy-precedence` | Specificity, priority, deny ties, disabled synthetic rules |
| `bounded-search` | Adaptive probing of an unknown monotone boundary |
| `partition-availability` | Partial availability without treating unknown data as zero |
| `snapshot-diff` | Compare synthetic manifests by path and hash, not byte length |

The sixteen additions are different operations and edge cases, not renamed copies of the original four. They remain authored fixed datasets, not a random sample of actual production tasks. Each reference performs at most six data calls; live models may choose another valid strategy.

Every answer must contain exact JSON fields and values. Graders reject missing/extra fields, wrong values, and non-JSON commentary; a single JSON fence is accepted. Reference programs derive answers through actual calls, not hardcoded oracle values. The expected answers are kept outside the model's prompt and tool results.

All tools are read-only. Repeated reads are measured, but duplicate side effects cannot be evaluated by this pilot. No shell, local file, web, image, subagent, or external MCP tools are exposed to the benchmark model. The synthetic MCP client executes in process and cannot connect to a real server.

## Limits and artifacts

- Each case: at most 12 provider requests, 200 admitted tool calls, five minutes, and 65,536 streamed response characters.
- Whole-run defaults: 160 provider requests, 500,000 reported tokens, and 30 minutes. Override explicitly with `--max-requests` (1–10,000), `--max-tokens` (1–20,000,000), and `--minutes` (1–60). A larger trial count alone does not raise any cap.
- Provider retries and automatic compaction are disabled. Requested output cap is 4,096 tokens; providers that ignore it are still bounded by the other limits.
- Token admission is checked between requests, so one response can overshoot it. Unknown usage cannot enforce a token limit; request, response-size, and wall-clock limits remain independent.
- A supervisor terminates the worker process two minutes after the selected run deadline, including provider operations that ignore cancellation. Interruption can leave only the manifest and already completed case files; report mode requires a finalized `results.json`.
- Any failed execution (including response-limit cancellation, authentication, quota, timeout, setup failure, or aggregate budget exhaustion) stops the run and ends its worker before another case can dispatch. Incorrect but completed answers remain in the comparison; they are not retried.

`manifest.json` records a unique run ID, experiment fingerprint, model settings, fixture definitions/oracles, source hashes, Git revision/dirty status, ordering seed, and limits. Each case records its trial number and position within the three-route block, both individually and in `results.json`. The runner prints budget consumption after each case.

`report.md` reports correctness, requests, latency medians and interquartile ranges, provider-reported tokens/cache usage, catalog-price estimates, failures, and repeated reads, grouped by route and task. Paired efficiency comparisons match the same run, model, task, and trial; they include only pairs where both answers were correct. Failed and missing cases remain visible separately. Input-token comparisons require complete usage evidence, not zero-filled unknowns.

An additional equal-task-weight view takes each task's median successful paired delta, then the median across tasks. Its exploratory 95% percentile interval resamples entire task effects (2,000 draws, deterministic seed 1729), requiring at least ten tasks. Repeating one task does not turn it into many independent task samples. This interval captures observed task heterogeneity, not all within-task inference uncertainty, caching, time trends, or real-world reliability.

`--report` is read-only unless `--out` is supplied. It rejects duplicate run IDs, incompatible experiment fingerprints, mixed live/self-test runs, malformed data, and unsupported formats. Format 2 records trial identities in the aggregate; the original formatless one-trial pilot below remains historical evidence and is not silently pooled into these comparisons. Runs on different selected fixture sets or changed benchmark sources are intentionally kept separate.

Transcripts contain only synthetic task data; raw provider error diagnostics and credentials are omitted. Artifact files use owner-only permissions where supported.

Catalog-price estimates are not subscription charges. A failed or incomplete run exits nonzero. Inspect per-case outcomes before comparing aggregate performance.

## Validation

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/code-mode/benchmark-fixtures.test.ts test/code-mode/benchmark-fixtures-data.test.ts test/code-mode/benchmark-fixtures-workflows.test.ts test/code-mode/benchmark-routing.test.ts test/code-mode/benchmark-report.test.ts
cd ../..
node --test scripts/run-code-routing.test.mjs
```

These tests use the faux provider, not real credentials. They cover independent graders, actual runtime execution, code-only route enforcement, discovery, request/tool/time limits, credential admission, output-directory isolation, and redaction.

## Broadened comparison protocol

The next comparison plans 20 tasks × six trial numbers × three routes = **360 cases**, in six separately reviewed 60-case batches. Every batch uses Astra/xhigh, seed 1, and trial starts 1 through 6. Per-batch caps: 400 requests, 1,800,000 reported tokens, and 30 minutes. Across six batches that bounds admission to 2,400 requests, 10,800,000 reported tokens (subject to the documented one-response overshoot), and 180 minutes of worker deadlines. No extra replacement batches are implied.

Before observing this broader run, the practical performance threshold is **10% lower input usage or latency**, with the task-bootstrap interval supporting that magnitude (upper bound at or below −10%), no observed correctness loss, and no material regression in the other metric. This is a screening criterion for further evaluation, not authorization to change production routing. Failure to clear it is not proof of equivalence. Twenty curated task types and 120 planned cases per route cannot establish a sub-1% failure rate or general coding benefits.

Execution failures stop their batch and remain visible. Subsequent planned batches may proceed after classification; missing cases stay missing, and a partial six-trial schedule is not called fully balanced. Auth/quota or persistent infrastructure blockers stop live work. The broader source fingerprint intentionally prevents pooling the earlier four-task experiments into this sample.

## Broadened results: 2026-11-09

All six planned batches completed: **360/360 correct**, 120 cases per route, with no missing cases or replacement runs. Every task saw all six route permutations, with each route twice in each position. All 1,349 provider requests selected Astra/xhigh and reported complete usage. Total reported usage was 5,683,952 tokens; summed case wall time was 86.7 minutes.

| Route | Correct | Requests | Cumulative input incl. cache | Output tokens | Cache-read tokens | Summed case wall time | Catalog USD estimate |
|---|---:|---:|---:|---:|---:|---:|---:|
| Hybrid | 120/120 | 498 | 2,040,025 | 37,589 | 1,658,496 | 1,785.4 s | 7.3532 |
| Code-first | 120/120 | 427 | 1,786,478 | 40,947 | 1,451,264 | 1,729.1 s | 6.8508 |
| Code-only | 120/120 | 424 | 1,738,662 | 40,251 | 1,076,608 | 1,687.2 s | 9.7097 |

Code-first reduced total input by 12.4%; code-only reduced it by 14.8%. Those totals are dominated by workflows that save multiple model turns. They do not mean a typical task improves by that amount. Code-only's catalog-price estimate was 32.0% higher because its cache mix differed; these estimates are not subscription charges.

The predeclared equal-task-weight view uses each task's median paired effect, then the median across twenty tasks. Each route comparison has 120 successful pairs. Negative means lower:

| Route versus hybrid | Median task input effect | 95% task-bootstrap interval | Median task latency effect | 95% task-bootstrap interval |
|---|---:|---|---:|---|
| Code-first | +1.2% | [−10.4%, +1.8%] | −5.1% | [−10.5%, +2.4%] |
| Code-only | −0.1% | [−11.4%, +0.6%] | −8.4% | [−13.9%, +4.4%] |

**Neither alternative cleared the predeclared 10% improvement criterion.** All intervals cross zero; this is not proof of equivalence or proof that no task benefits. For comparison, medians across all 120 individual pairs (rather than task medians) were +1.6% input / −2.8% latency for code-first and +0.2% / −5.6% for code-only.

Specific observations, each based on six matched pairs:

- **Deterministic adaptive search benefited.** Hybrid performed six separate data calls across eight provider requests in every `bounded-search` case. Code-only used one script for those same six data calls and only three provider requests: median input −65.9%, latency −45.9%. Code-first scripted four of six cases.
- **Whole traversals benefited from guidance.** Code-first used one script for every `hierarchy-rollup`, versus two scripts for hybrid and code-only; median input was −33.0% and latency −25.8% versus hybrid.
- **Small results did not need scripts.** Code-only was 27.9% slower on `nested-projection`, 21.0% slower on `empty-result`, and 43.4% slower on `temporal-asof`. Hybrid used direct calls on all six repetitions of each; all routes still answered correctly.
- **Existing batching remained useful.** Every route already used one script for every `paginated-aggregate` and `join-filter`. Their differences cannot be attributed to newly enabling code execution; discovery choices, generated scripts, caching, and provider timing remain factors.
- **Recoveries count.** Code-first had two script failures in `three-way-join` (trials 2 and 3): one syntax error and one attempt to call the `tools.mcp` namespace as a function during discovery. Both made zero data calls, recovered through direct schema discovery, and finished correctly. Their latency/tokens remain included. Hybrid and code-only had no script failures. No route repeated data reads; each made 348 total data calls.

Recommendation: **retain hybrid routing**. Favor scripts when deterministic control flow can eliminate model round trips, rather than forcing scripts around every call. More repetitions of this same suite are less useful than a focused follow-up on that guidance or a separately authorized benchmark of real coding/mutating workflows. This suite does not justify changing production defaults, establish sub-1% failure rates, or generalize to arbitrary tools.

Artifacts under `<OS temp directory>/`:

- `volt-routing-broad-astra-xhigh-trial1-20261109/` through `volt-routing-broad-astra-xhigh-trial6-20261109/`: complete manifests, per-case traces, results, and reports.
- `volt-routing-broad-astra-xhigh-comparison-20261109/report.md`: offline combined report.
- Experiment fingerprint: `8042145a720a279225c033b49773c4b3cd587fee0b98740ae4558b5a231dd8e2`.

Validation: 212 focused tests passed, all 60 model-free CLI cases passed, the 360-case dry-run schedule contained all six permutations for every task, `npm run check` passed, and offline six-run reporting succeeded. Trial 6 emitted one optional background-job performance-diagnostics retention warning; the benchmark completed with full case and provider-usage coverage. No timing or case was removed for that warning.

The following sections preserve the earlier four-task evidence; those runs were not pooled with the expanded suite.

## Initial pilot: 2026-11-09

One trial per task/arm, `openai-codex/gpt-6-astra`, `xhigh` on all 56 requests. All 12 answers were correct, with no script failures or repeated data reads. Total reported usage was 239,850 tokens.

| Route | Correct | Requests | Cumulative input, including cache | Output tokens | Cache-read tokens | Wall time | Catalog USD estimate |
|---|---:|---:|---:|---:|---:|---:|---:|
| Hybrid | 4/4 | 21 | 87,979 | 1,088 | 64,128 | 67.6 s | 0.3570 |
| Code-first | 4/4 | 18 | 77,179 | 1,088 | 46,976 | 58.6 s | 0.4034 |
| Code-only | 4/4 | 17 | 71,446 | 1,070 | 48,384 | 51.1 s | 0.3325 |

Code-only used 18.8% fewer cumulative input tokens and 24.4% less wall time than hybrid in this sample. This is not an established causal or statistically significant improvement:

- Hybrid and code-first already chose `run_code` for the paginated aggregate and join. Forced routing did not unlock a missing batching capability.
- Single-lookup discovery took three calls in hybrid, two in code-first, and one in code-only. Some apparent gains are discovery-path variation.
- Adaptive troubleshooting used four separate one-call scripts in code-only, not one program spanning the whole diagnostic chain. The model still interpreted intermediate notes between calls.
- Code-first's lower total token count did not yield a lower catalog-price estimate because its cache-hit mix differed. These estimates are not subscription charges.

Recommendation: retain production hybrid routing. The pilot supports a larger balanced comparison of selected read-only MCP routes, not moving editing, shell, or all tools behind `run_code`.

Local raw artifacts: `<OS temp directory>/volt-code-mode-routing-astra-xhigh-20261109/` (`manifest.json`, per-case JSON, `results.json`, `report.md`). Artifacts are deliberately not checked into the repository.

Validation for this implementation: 39 focused tests passed, all 12 model-free runtime cases passed, and `npm run check` passed. Existing informational Biome diagnostics were left unchanged.

## Repeated batches: 2026-11-09

The reusable runner was tested with the same Astra/xhigh model:

- A six-trial batch (seed 1; 72 planned cases) stopped at case 45 after a provider-reported network failure during hybrid join/filter. Its first 44 cases were correct; 27 cases were never attempted. The failure remains recorded and was not retried or removed.
- A separate two-trial batch (seed 2; 24 planned cases) completed 24/24 correctly. Caps were 200 requests, 700,000 reported tokens, and 15 minutes, keeping cumulative attempted cases below the original 72-case target.
- Combined: 69 recorded cases, 68 correct, one execution failure, 295 requests, and 1,256,025 reported tokens. All requests selected `xhigh`; 294/295 had complete usage. There were no script failures, tool failures, or repeated data reads. The interrupted plan means the collected sample is **not fully order-balanced**.

The combined report retains all 96 originally planned cases across the two run manifests: 68 correct, one failed, and 27 unattempted. Those missing cases are not additional failed model answers. The network failure is not evidence of a routing-quality difference. The original formatless 12-case pilot is not pooled into this report.

Matched comparisons use the same run/task/trial and exclude unsuccessful pairs. Negative values mean lower; input includes cached tokens.

| Route versus hybrid | Successful pairs | Median input delta | Median latency delta |
|---|---:|---:|---:|
| Code-first | 22 | +1.6% | −3.5% |
| Code-only | 22 | −2.0% | −5.5% |

Code-only's per-task paired deltas:

| Task | Pairs | Median input delta | Median latency delta |
|---|---:|---:|---:|
| Single lookup | 6 | −23.8% | −11.6% |
| Paginated aggregate | 6 | +0.2% | −21.5% |
| Join/filter | 5 | +1.2% | +1.1% |
| Adaptive troubleshooting | 5 | −2.9% | +2.7% |

Trace inspection limits the interpretation:

- Every completed pagination and join case already used one script in every route. No extra batching capability was unlocked by forcing code-only.
- The single-lookup difference was largely discovery variation: hybrid used 25 provider requests across six cases versus code-only's 19, although both made exactly six data calls. Code-first also improved while retaining direct calls.
- Each adaptive code-only case still used four separate single-call scripts and seven provider requests, matching the other routes' request count. It did not move the adaptive reasoning chain into one program.
- The pagination timing difference occurred with identical request/data-call counts and nearly identical input usage. Script length, provider timing, and caching remain possible explanations; this is not an isolated routing effect.

Recommendation remains **hybrid by default**. The initial pilot's large aggregate token reduction did not become a comparably large median paired reduction. These small fixed read-only tasks do not establish a causal improvement or a benefit for editing, shell, or mutating tools.

Local artifacts, all under `<OS temp directory>/`:

- `volt-code-mode-routing-astra-xhigh-batch2-20261109/`: interrupted six-trial run.
- `volt-code-mode-routing-astra-xhigh-batch3-20261109/`: completed two-trial run.
- `volt-code-mode-routing-astra-xhigh-comparison-20261109/report.md`: combined report, generated with repeated `--report` arguments.

Both runs have experiment fingerprint `e84620b8f4458cca172df1649425983aa9b542bd001328ef4c1ce2001b1c1c41`. Validation: 95 focused Vitest tests, two supervisor tests, all 12 model-free CLI cases, and `npm run check` passed. Offline combined reporting succeeded without provider calls.

## Prompt follow-up

The 360-case comparison above measured the prior production prompt, not the revised guidance. It motivated a small follow-up in `packages/coding-agent/src/core/tools/run-code.ts`: recommend one bounded script for deterministic read-only loops with known schemas, keep small results and genuine interpretation steps direct, reuse complete current MCP schemas, and explicitly keep MCP gateway discovery outside scripts. Existing batching, output reduction, concurrency, and failure-recovery guidance remains.

Focused tests verify the model-facing prompt and binding contract; they do not establish that this exact wording improves model behavior. No live A/B trial of the revised prompt has been run. Its source hash differs from the recorded experiment, so later results must not be pooled into that comparison. Tool availability, permissions, code-mode defaults, and runtime behavior are unchanged.

## Interpretation

This compares hybrid versus guided versus forced programmatic **read-only MCP invocation**, not code mode versus no code mode. Keep correctness separate from efficiency. A one-trial pilot can reveal problems or hypotheses but cannot establish significance or justify a product-wide default.

There is no cache warm-up or isolation between arms; report cache use and repeat in balanced orders before making a decision. Native top-level MCP serialization and nested concurrency are part of the tested workflow. Synthetic transport has no real network latency. These results cannot establish benefits for ordinary editing, shell commands, mutating services, citation handling, or general semantic reasoning.

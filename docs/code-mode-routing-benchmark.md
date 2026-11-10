# Local code-mode routing benchmark

Development-only benchmark for `run_code`: what code mode saves or costs against plain tool calls, and whether selected data tools should be callable only through it. No production tools, grants, settings, dependencies, or default routing change.

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

# Code mode off versus on, on the large-result tasks. A route pair is order-balanced every two trials.
npm run benchmark:code-mode -- --live --suite realistic --routes direct,hybrid --trials 2 --max-requests 250 --max-tokens 3000000 --minutes 40

# The same on Claude Opus 5.5, through the stored Anthropic subscription login.
npm run benchmark:code-mode -- --live --model anthropic/claude-opus-5-5 --suite realistic --routes direct,hybrid --trials 2 --max-requests 250 --max-tokens 3000000 --minutes 40

# A cheap targeted check: chosen tasks, one route.
npm run benchmark:code-mode -- --live --task bounded-search,empty-result,temporal-asof --routes hybrid --trials 6

# Re-read saved results without credentials or provider calls.
npm run benchmark:code-mode -- --report /path/to/run

# Combine distinct compatible runs; optionally save the comparison outside the repo.
npm run benchmark:code-mode -- --report /path/to/run-a --report /path/to/run-b --out /path/to/new-comparison

# Compare two experiments, such as a prompt change against the commit before it.
npm run benchmark:code-mode -- --report /path/to/candidate-run --baseline /path/to/baseline-run
```

`node scripts/run-code-routing.mjs` is the equivalent direct entry point. `--trials` accepts 1–50; `--trial-start` sets the first trial number (default 1, last trial cannot exceed 50). This preserves the six-order schedule across separate bounded batches: use trial starts 1 through 6 with one trial per batch, retaining the same seed. Review each batch before starting the next; do not discard or retry unsuccessful cases to manufacture a clean sample.

`--seed` accepts an unsigned 32-bit integer and controls ordering only, not provider sampling. Use a new output directory for every batch. There is no unlimited mode, automatic retry-until-success, or automatic restart after a cap. Default budgets are unchanged and may truncate the larger suite; select explicit caps for full-suite runs.

The live model defaults to `openai-codex/gpt-6-astra`; `--model anthropic/claude-opus-5-5` selects the other supported model. Both run with `xhigh` thinking, one model per run. The runner reads the provider's existing OAuth credential from Volt's `auth.json`. It never logs credentials, refreshes or writes credentials, starts login, or falls back to environment/API keys. An absent or expired credential stops admission; refresh through the normal Volt login outside the runner before retrying.

`--suite` selects `core` (the default twenty small tasks), `realistic` (five large-result tasks), or `all`. `--task` instead selects fixtures by comma-separated ID from any suite; `--dry-run` prints the selected IDs and the exact schedule. `--routes` selects a comma-separated subset of `direct`, `hybrid`, `code-first`, and `code-only`; the default is the last three. `--out` selects a new directory whose parent exists outside the repository. Existing directories are never overwritten. By default artifacts go into a new directory under `<agent dir>/benchmarks/code-mode-routing/`, whose path the runner prints. The OS temporary directory is no longer the default: the artifacts of the first comparisons below were lost from it.

## Experimental arms

- **direct:** code mode off. The session has only the native `mcp` tool: no `run_code` tool and none of its guidance. This is the baseline for what code mode saves and what its prompt costs. It is not part of the default route set, and self-test cannot run it because reference programs are scripts.
- **hybrid:** current native `mcp` and `run_code` schemas and Volt's normal guidance.
- **code-first:** same tools, plus stage-specific guidance favoring scripts for pagination, filtering, joining, and aggregation while retaining direct one-off calls.
- **code-only:** native MCP discovery/cache/lifecycle actions stay direct; the model-facing MCP schema omits `action: "call"`. A benchmark-only extension checks the host-supplied operation origin and rejects direct MCP invocation. Nested calls still use the real session policy and active tool grants.

This is an experimental presentation projection, not a new production routing API. It does not disable an active tool to hide its schema, bypass per-call policy, or expose tools the session lacks. MCP metadata starts warm for every case; the model still discovers the schemas through the gateway. Each task/arm has fresh fixture data and an independent in-memory session. A seeded schedule presents all six route permutations exactly once per task in each six-trial block. Every route appears twice in each position, and every pair appears in both orders equally often. With `--routes`, the block is n! trials for n routes: two for a pair, twenty-four for all four. Partial blocks need not be balanced. Task order also varies deterministically by trial and seed so interrupted runs do not always omit the same final tasks.

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

### Realistic suite

The core tasks return small results, so they measure saved round trips and little else. Recorded MCP use in real sessions looks different: results have a median near 6 KB, and most calls sit in chains of three or more consecutive tool-only turns. The `realistic` suite is shaped like that. Its data is generated step traces of an invented job scheduler, not copied from any session or system.

| Fixture ID | Behavior covered |
|---|---|
| `trace-scan` | Twelve traces of about 4 KB each; count exact matches among near misses |
| `handoff-chain` | Six dependent reads through large traces, each next read fixed by a rule |
| `message-triage` | A lookup, then reading four traces to tell which job decides an outcome |
| `byte-marker-scan` | Eight paged raw reads; markers that span a page or are not byte-aligned |
| `loop-interpretation` | One large trace that has to be read; a script cannot save a round trip |

The first version of this suite used assembly-style listings. On `anthropic/claude-opus-5-5` the provider's safety filter refused the first such task before the model produced output, so the domain was changed to job traces with the same structure. Keep new fixtures in mundane domains for the same reason.

All tools are read-only. Repeated reads are measured, but duplicate side effects cannot be evaluated by this pilot. No shell, local file, web, image, subagent, or external MCP tools are exposed to the benchmark model. The synthetic MCP client executes in process and cannot connect to a real server.

## Limits and artifacts

- Each case: at most 20 provider requests, 200 admitted tool calls, five minutes, and 65,536 streamed response characters. The limit was 12 for the results dated 2026-11-09 below; it was raised so the direct route can finish a task that reads a dozen results one turn at a time.
- Whole-run defaults: 160 provider requests, 500,000 reported tokens, and 30 minutes. Override explicitly with `--max-requests` (1–10,000), `--max-tokens` (1–20,000,000), and `--minutes` (1–60). A larger trial count alone does not raise any cap.
- Provider retries, session retries, and automatic compaction are disabled. Requested output cap is 4,096 tokens; providers that ignore it are still bounded by the other limits.
- Token admission is checked between requests, so one response can overshoot it. Unknown usage cannot enforce a token limit; request, response-size, and wall-clock limits remain independent.
- A supervisor terminates the worker process two minutes after the selected run deadline, including provider operations that ignore cancellation. Interruption can leave only the manifest and already completed case files; report mode requires a finalized `results.json`.
- Any failed execution (including response-limit cancellation, authentication, quota, timeout, setup failure, or aggregate budget exhaustion) stops the run and ends its worker before another case can dispatch. The exceptions are a case that used all of its requests, ran out of output tokens, or ended on an empty reply after a tool result (`empty-reply`): every request it started has finished, so it is recorded as failed and the run continues. Incorrect but completed answers remain in the comparison; they are not retried.

`manifest.json` records a unique run ID, experiment fingerprint, model settings, fixture definitions/oracles, source hashes, Git revision/dirty status, ordering seed, and limits. Each case records its trial number and position within the three-route block, both individually and in `results.json`. The runner prints budget consumption after each case.

`report.md` reports correctness, requests, latency medians and interquartile ranges, provider-reported tokens/cache usage, catalog-price estimates, failures, and repeated reads, grouped by route and task. Paired efficiency comparisons match the same run, model, task, and trial; they include only pairs where both answers were correct. Failed and missing cases remain visible separately. Input-token comparisons require complete usage evidence, not zero-filled unknowns.

An additional equal-task-weight view takes each task's median successful paired delta, then the median across tasks. Its exploratory 95% percentile interval resamples entire task effects (2,000 draws, deterministic seed 1729), requiring at least ten tasks. Repeating one task does not turn it into many independent task samples. This interval captures observed task heterogeneity, not all within-task inference uncertainty, caching, time trends, or real-world reliability.

The report also counts what each route did per task: direct gateway actions other than `call` (with `list_servers` separately), direct and scripted data calls, scripts, and the largest request context. When a run includes the direct route, a further section pairs every other route with it. That section also shows the input of each side's first request (the fixed prompt and tool-schema size every request carries) and of its final request (the context the session would carry into a next turn), because summed input alone cannot tell a larger prompt or an extra request from a larger conversation. Artifacts recorded before gateway actions were stored show those counts as unknown.

`--report <candidate> --baseline <baseline>` compares two experiments instead, for example a prompt change against the commit before it. Runs pool within a side under the usual rules; pairs match model, task, route, and trial across the sides, so run both with the same seed, trials, tasks, and routes. To produce the baseline side, run the same command from a `git worktree` of the earlier commit. The two sides run at different times, so small latency differences are not evidence.

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

## Code mode versus no code mode: 2026-11-10

The first comparison that includes the `direct` route, on the realistic suite: 5 tasks × 2 routes × 2 trials for each model, at commit `1624583cf`. All 40 cases were correct, with no script failures and no missing cases.

| Model | Route | Correct | Requests | Cumulative input incl. cache | Output tokens | Summed case wall time | Catalog USD estimate |
|---|---|---:|---:|---:|---:|---:|---:|
| `openai-codex/gpt-6-astra` | Direct | 10/10 | 71 | 525,366 | 6,860 | 317 s | 2.19 |
| `openai-codex/gpt-6-astra` | Hybrid | 10/10 | 42 | 204,317 | 4,074 | 169 s | 0.93 |
| `anthropic/claude-opus-5-5` | Direct | 10/10 | 69 | 877,760 | 45,655 | 461 s | 2.18 |
| `anthropic/claude-opus-5-5` | Hybrid | 10/10 | 46 | 375,472 | 12,832 | 186 s | 0.71 |

Hybrid used 61% less input than direct on Astra and 57% less on Opus. The totals hide a split by task. Per task, hybrid versus direct, median of two matched pairs; negative means lower:

| Task | Astra requests | Astra input | Astra latency | Opus requests | Opus input | Opus latency |
|---|---|---:|---:|---|---:|---:|
| `handoff-chain` | 9 → 3 | −84.5% | −52.2% | 9 → 4 | −74.3% | −33.2% |
| `byte-marker-scan` | 10 → 3 | −79.6% | −78.9% | 10.5 → 3 | −84.2% | −92.2% |
| `trace-scan` | 7.5 → 5.5 | −64.9% | −38.5% | 6.5 → 4.5 | −64.7% | −35.4% |
| `message-triage` | 6 → 6 | +14.0% | +10.5% | 5.5 → 7 | +30.5% | +39.7% |
| `loop-interpretation` | 3 → 3.5 | +26.2% | +37.2% | 3 → 4.5 | +70.3% | +66.9% |

- **Deterministic work over large results is where code mode pays.** One script replaced six to ten model turns, and the traces never entered the conversation: peak context fell from about 90 KB to 30 KB on `handoff-chain` and from about 160 KB to 40 KB on `trace-scan`.
- **On tasks that need the result to be read, hybrid sums to more input but does not carry more context.** On `loop-interpretation`, a direct call is one read. Hybrid instead probed the unfamiliar trace format with one script and analysed it with more: Astra used three scripts across its two cases and Opus five. On `message-triage`, Opus ran six scripts across two cases where direct reads sufficed. The table below separates the two costs behind those positive deltas.
- **Correctness did not separate the routes.** Both models answered every direct case, including the by-eye marker scan, so this suite still cannot rank routes on reliability.
- **Opus repeated reads under hybrid.** Seven data calls were repeats: each follow-up script read the same trace again instead of keeping it with `store()`. Astra stored it and had none.

A replicate on Astra with the earlier assembly-style version of the same tasks (commit `720500fcf`, 20/20 correct) gave the same split: −85%, −80%, and −74% input on the three deterministic tasks, +10% and +43% on the two reading tasks.

Summed input has two parts that the totals mix. Median input tokens of the final request, direct → hybrid, from the same pairs:

| Task | Astra final-request input | Opus final-request input |
|---|---|---|
| `handoff-chain` | 15,583 → 4,463 | 22,826 → 9,064 |
| `byte-marker-scan` | 9,355 → 4,539 | 29,102 → 8,382 |
| `trace-scan` | 27,741 → 7,497 | 39,658 → 9,834 |
| `message-triage` | 11,488 → 11,985 | 17,572 → 12,199 |
| `loop-interpretation` | 6,020 → 5,633 | 9,774 → 9,720 |

- **Code mode has a fixed price on every request.** Enabling `run_code` adds 2,429 bytes of tool schema and 869 bytes of system-prompt guidance. The first request of every case measured it: about 680 more input tokens on Astra (roughly 2,930 → 3,610) and 1,150 on Opus (roughly 5,530 → 6,680). On Astra that price times the request count accounts for all of the `message-triage` increase and about three quarters of the `loop-interpretation` one. On Opus it accounts for 57% and 34% of them; the rest is extra script requests.
- **The reading tasks end with the same or less context under hybrid.** The positive input deltas come from that fixed price and from extra requests, not from a larger conversation. Summed input charges an extra request its whole context, which is the right cost for a session that ends there. A long session with a warm cache pays mostly for what stays in context, and on that measure hybrid is at most 4% above direct (Astra on `message-triage`) and lower everywhere else. The benchmark's sessions are one task long, so it cannot weigh the two.

Limits: two trials per task give two pairs, so each task row is a direction and rough size, not an interval. The suite has five authored tasks, weighted towards the workloads where scripting should help; the all-task totals are not an estimate for typical sessions. Catalog estimates are not subscription charges.

Artifacts, under `<agent dir>/benchmarks/code-mode-routing/`: `realistic-astra-1624583cf/`, `realistic-opus-1624583cf/`, and the replicate `realistic-astra-720500fcf/`.

## Revised prompt, targeted live check: 2026-11-10

The revised `run_code` guidance was compared with the prompt before it (commit `53b37ac48`) on five core tasks: two where it should remove model turns and three small ones where it should change nothing. Three trials, three routes, both commits, same seed: 90 cases, all correct. Hybrid route, old → revised:

| Task | Requests per trial | Scripts per trial | Median input | Median latency |
|---|---|---|---:|---:|
| `bounded-search` | 8/8/8 → 3/3/3 | 0/0/0 → 1/1/1 | −66.5% | −55.7% |
| `hierarchy-rollup` | 5/4/4 → 3/3/3 | 2/1/1 → 1/1/1 | −27.2% | −9.1% |
| `temporal-asof` | 3/3/3 → 3/4/3 | 0 → 0 | −0.9% | −0.5% |
| `empty-result` | 3/3/3 → 4/4/4 | 0 → 0 | +32.7% | +26.3% |
| `nested-projection` | 3/3/3 → 3/3/3 | 0 → 0 | −1.1% | −7.7% |

The revised guidance does what it was written for: hybrid now keeps the whole binary search and traversal in one script, and it did not start scripting the small tasks. Across the 15 hybrid cases per side, requests fell from 64 to 49 and input from 271,199 to 197,637 tokens.

In these runs hybrid sometimes called `mcp list_servers` before searching under the revised prompt (4 of 15 cases) and never under the old one, which made `empty-result` look 33% more expensive. That difference did not survive a larger check: the bisect in the next section found the old prompt making the same call just as often. Read the `empty-result` row as noise from an optional discovery call, not as an effect of the revision.

Limits: three trials is a partial order block, and latency differences under about 15% are within noise. These runs predate the `--baseline` report and the gateway-action counts, so they were tabulated by a one-off script. Artifacts: `prompt-ab-20261110/` under the same directory.

## Guidance follow-up: 2026-11-10

Three checks on the hybrid route, each against the committed prompt. Its side comes from runs at `0e5daeb46`, `1624583cf`, and `bb8635cf8`, which share the same `run_code` text; candidates ran from worktrees with only that text changed. All used the stored subscription logins at `xhigh`; together they made 136 cases and reported 2.94 million tokens.

### The `list_servers` call is not caused by the revised prompt

Five prompt variants ran `empty-result` and `temporal-asof` on Astra, six trials each in two interleaved blocks: the old prompt, the committed one, and the committed one with the intro sentence, the guideline bullets, or the MCP line put back to the old text. All 60 cases were correct.

| Variant | Cases calling `list_servers` | Requests | Input tokens |
|---|---:|---:|---:|
| Old prompt (`53b37ac48`) | 4/12 | 40 | 165,849 |
| Committed prompt | 3/12 | 39 | 164,673 |
| Committed, old intro sentence | 5/12 | 41 | 172,986 |
| Committed, old guideline bullets | 5/12 | 41 | 170,863 |
| Committed, old MCP line | 2/12 | 38 | 160,181 |

Every variant makes the call in roughly a third of cases, the old prompt included. The 0-of-6 against 4-of-6 split in the earlier check was sampling noise. The call also appears with code mode off: both models made it on `message-triage` under the direct route. It is an optional discovery step the models take on some tasks, worth one request when it happens, and not something the `run_code` wording controls.

### "Aim to answer from one script" trims Opus's script count

Transcripts of the two reading tasks showed the pattern behind the extra requests: one script to probe an unfamiliar format, one to extract, and on Opus often a third to verify. The candidate wording changes three guideline bullets: `run_code` is for results "too large to read in full", direct calls are for "results you can read in full, such as one document of a few kilobytes that you must interpret", and "Every run_code script is another model request: aim to answer from one script."

Realistic suite, hybrid route, committed → candidate. Opus has four trials per task (two for `byte-marker-scan`); Astra has two.

| Model | Cases | Correct | Requests | Scripts | Input tokens |
|---|---:|---|---|---|---:|
| `anthropic/claude-opus-5-5` | 18 per side | 16 → 18 | 87 → 78 | 40 → 31 | 732,712 → 674,041 (−8.0%) |
| `openai-codex/gpt-6-astra` | 10 per side | 10 → 10 | 42 → 42 | 13 → 12 | 204,317 → 197,628 (−3.3%) |

- **Opus wrote fewer scripts.** Matching cases by task and trial, the candidate used fewer scripts in nine, more in one, and the same in eight. The gain is on `handoff-chain` (mean input 31,804 → 25,676) and `trace-scan` (41,591 → 34,466), where the committed prompt usually spent a first script looking at the format.
- **It did not move single-document reads to direct calls.** Every `loop-interpretation` case under either wording still used a script, and `message-triage` was unchanged (63,615 → 63,545). Given the final-request numbers above, that is a defensible choice by the models, so the wording was not pushed further.
- **Astra did not change**, on the realistic tasks or on four core tasks (`bounded-search`, `hierarchy-rollup`, `empty-result`, `nested-projection`; 12/12 correct, 39 requests on both sides, the same call sequence on every task). The one-script behaviour the revision was written for is intact.
- **Opus still repeats reads** (34 → 41 repeated data calls): follow-up scripts fetch the same trace again instead of using `store()`.

The candidate was kept. The two Opus failures on the committed side are format failures, not wrong data: one prose answer and one empty reply, described next.

### Opus sometimes ends its turn with an empty reply after a script returns the answer

On the core tasks Opus scripted correctly and then, in some cases, replied with nothing. The provider's raw stream for one such case is `message_start`, `message_delta` with `end_turn`, `message_stop`: no content block at all, with 37 output tokens reported. Volt is not dropping the text; none arrives.

| Last step before the final reply | Opus hybrid cases | Empty final reply |
|---|---:|---:|
| A script that returned a value | 31 | 9 |
| A script that only printed | 26 | 0 |
| A direct MCP call | 7 | 0 |

By prompt, for scripts that returned a value: committed 4/13, candidate 3/10, so the candidate wording is not the cause. A third variant added "as a tool result the user does not read: give your answer in your reply afterwards" to the tool description; it still produced 2 empty replies in 8, so it was not kept. Astra never did this. Returned values and printed output are confounded with task here (the core tasks return, the realistic ones mostly print), so the trigger may be a result that already equals the requested answer rather than `return` itself.

This was a correctness failure for anyone asking Opus a question that one script can answer, and wording did not fix it. The agent loop now does ([#1060](https://github.com/volt-hq/Volt/issues/1060)): a response that ends the turn empty after tool results is a retryable error, retried at once with a note telling the model its reply was empty. The note matters. On the two core tasks, with the fix applied and retries enabled in the harness:

| Retry | Cases | Empty replies | Outcome |
|---|---:|---:|---|
| Unchanged request | 5, the run stopped at its first failure | 8 across 3 cases | 5 of 7 retries were empty again; one case used up its 3 retries |
| With the note | 12 | 5 | Every one recovered on the first retry; 12/12 correct |

The benchmark itself keeps retries off, so it still shows the raw rate: such a case is recorded as failed with the reason `empty-reply`, and the run continues. Artifacts recorded before the fix show the same event as a completed case graded "The final reply was empty."

Artifacts, under `<agent dir>/benchmarks/code-mode-routing/`: `list-servers-bisect-20261110/` and `guidance-20261110/` (`head-*` is the committed prompt, `r1-*` the kept candidate, `r2-*` the reply variant), and `empty-reply-fix-1060/` for the two retry checks. The comparisons across prompts were tabulated by task and trial with a one-off script, because the runs on each side differ in which trials they cover.

## Open questions the harness can now answer

- How often other models and other tools produce the empty reply that the agent loop now retries. It has only been seen on Opus 5.5 after `run_code`; `--model anthropic/claude-opus-5-5 --task bounded-search,hierarchy-rollup --routes hybrid --trials 4` reproduces it in about a third to a half of cases, as `empty-reply` failures.
- Whether the fixed price of code mode can come down. The description, guidelines, and schema cost about 680 tokens per request on Astra and 1,150 on Opus; a shorter description would show up directly in the first-request column.
- Whether Opus can be brought to keep fetched data with `store()` instead of reading it again.
- Whether results hold with more trials. Two pairs per task is the minimum; six trials give three order-balanced blocks for a route pair.

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

The 360-case comparison above measured the prior production prompt, not the revised guidance. It motivated a small follow-up in `packages/coding-agent/src/core/tools/run-code.ts`: recommend one bounded script for deterministic read-only loops with known schemas, keep small results and genuine interpretation steps direct, reuse complete current MCP schemas, and explicitly keep MCP gateway discovery outside scripts. Existing batching, output reduction, concurrency, and failure-recovery guidance remains. The guidance follow-up above then added that every script is another model request and that results the model can read in full belong in direct calls.

Focused tests verify the model-facing prompt and binding contract; they do not establish that this exact wording improves model behavior. The targeted live check above did: it found the intended gains on two tasks, and the later bisect cleared the revision of the extra discovery call first attributed to it. The prompt's source hash differs from the recorded 360-case experiment, so later results must not be pooled into that comparison. Tool availability, permissions, code-mode defaults, and runtime behavior are unchanged.

## Interpretation

The default routes compare hybrid versus guided versus forced programmatic **read-only MCP invocation**. Only a run that includes the `direct` route compares code mode with no code mode. Keep correctness separate from efficiency. A one-trial pilot can reveal problems or hypotheses but cannot establish significance or justify a product-wide default.

There is no cache warm-up or isolation between arms; report cache use and repeat in balanced orders before making a decision. Native top-level MCP serialization and nested concurrency are part of the tested workflow. Synthetic transport has no real network latency. These results cannot establish benefits for ordinary editing, shell commands, mutating services, citation handling, or general semantic reasoning.

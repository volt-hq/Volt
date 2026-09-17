# Jev guidance dogfooding extension

Project-local, opt-in guidance and PR routing for Volt's **local TUI**. The selected primary model stays unchanged. Jev runs through Vercel AI Gateway to choose a predefined reminder, or to route a standalone PR-creation request to a configured cheaper worker before primary-model inference.

## Setup

From the repository root:

```bash
npm ci --ignore-scripts --prefix .volt/extensions/jev-guidance
```

Use Volt's existing `vercel-ai-gateway` credential (including `/login` and configured key resolvers), or `AI_GATEWAY_API_KEY`. Never put a credential in this extension or its commands.

Restart Volt from this branch to load the new core routing hook (an extension-only `/reload` cannot update already-loaded core code). Trust this project, then:

- `/jev observe`: make real evaluations and show judgments, without steering the coding model.
- `/jev advise`: also append a qualifying reminder to the current model request only.
- `/jev route <provider/model>`: enable automatic PR routing to that exact configured model. Choose a cheaper model different from the primary model; Volt does not infer subscription pricing or select a provider for you.
- `/jev off`: cancel an active evaluation and stop future calls. Use Stop/Escape to cancel an already-dispatched worker.
- `/jev status`: show the last result, attempts, skipped evaluations, errors, reported tokens/cost, and cooldown.
- `/jev interval 2`: change minimum spacing between attempts to two seconds (1–300 allowed; default 15). Existing cooldowns still apply.

Alternatively, start the TUI with `--jev observe`, `--jev advise`, or `--jev route --jev-pr-model <provider/model>`. Routing and advisory guidance are separate modes; route mode does not run per-turn reminder evaluations. With no flag, guidance starts **off**, including after reload or session replacement. Mode and counters are not restored from session history. Print, JSON, RPC/phone-owned, and subagent runtimes do not activate guidance. A local TUI that owns a phone-shared conversation can evaluate that conversation while explicitly enabled.

## Automatic PR routing

Routing is an experimental opt-in fast path, not a general task scheduler. Only fresh text-only local-TUI Build prompts qualify. Plan state, review discussions, active background jobs, pending context, child runtimes, and RPC/extension-originated input bypass routing. The native `subagent` tool must remain available. Host turn policies and extension `tool_call` gates disable routing so those controls are not bypassed. Requests without a PR/pull-request mention, or over 3,000 characters, do not call Jev.

For a qualifying request, Jev chooses `pr_worker`, `none`, or `insufficient_context`. Only `pr_worker` with a selected-choice probability of at least 0.95 nominates the built-in `general` worker on your configured model. This is **not a calibrated safety threshold**. Discussion, mixed implementation-and-PR requests, and incomplete handoffs should remain with the primary model. Validate classification quality on your own requests before relying on routing.

The fixed worker instructions limit this pilot to **existing committed changes**: inspect repository rules, status/diff/remotes and existing PRs; draft a description using actual verification evidence; publish only an unambiguous authorized branch; and return the verified PR URL. Uncommitted work, missing scope, unfinished implementation, or conflicts are blockers, not permission to fix or commit anything. This workflow restriction is prompt guidance, not a shell sandbox: the worker inherits policy-clamped parent tools, including Bash if the parent grants it.

The host owns execution and cancellation through the existing subagent manager. The worker receives the original request and bounded excerpts, not the entire parent conversation. It appears in `/subagents`; attributed running/completion messages and worker usage remain in the parent transcript. No primary-model call, parent compaction, parent auto-naming, or summary call is needed for a routed task. Worker inference, automatic worker recovery, and child naming may still incur costs; recorded worker usage does not include cosmetic naming requests.

Abstention, low/missing probability, unavailable configuration, or evaluation errors fall back to the primary model before dispatch. **After dispatch there is no automatic fallback or retry of the whole task**, because a worker may already have pushed or created a PR. Its own ordinary provider retry behavior remains unchanged. Inspect failed/interrupted work before retrying. Historical running notices after a restart are not live jobs and do not automatically restart. The native subagent registry can recover their results through durable spawn links; uncollected recovered work returns to the primary flow for inspection. Orderly shutdown records an aborted result.

While a routed worker runs, new prompts/steering/follow-ups are rejected rather than silently sent to the wrong agent. Wait or Stop first. Plan entry, compaction, and reload are also blocked until routing settles. Stop and shutdown cancel classification/worker execution and wait for child cleanup. Removing inherited tool grants cancels the route. Changing Jev modes affects future routing and pending judgments, not an already-started worker.

## Privacy and retention

**Observe, advise, and route send selected session context to Vercel/TypeSafe without requesting Zero Data Retention.** Observe is not an offline mode. This non-ZDR setup was explicitly selected for personal dogfooding. Do not enable it in a workspace whose data policy forbids that transfer.

The snapshot includes the latest user request, up to three earlier user messages outside the recent window, and up to twelve recent messages. Text excerpts, selected tool arguments (`path`, `command`, `action`, `offset`, `limit`), bash output excerpts, and compaction/branch summaries may be sent. Older authorization may be absent; truncation is marked and the evaluator is told to abstain when essential evidence is missing. The serialized snapshot is capped at 24 KB before the separate rubric is added.

Images, reasoning blocks, raw read output, edit/write bodies, tool details, custom extension messages, and `!`/`!!` bash-execution messages are omitted. The full system prompt and context files are not copied. Summaries and ordinary messages can nevertheless contain code, paths, or personal information.

Common secret patterns and the resolved Gateway key are redacted before transmission. **Redaction is best effort, not a confidentiality guarantee.** Only judgments and compact accounting/error categories are appended to local session entries; raw snapshots, credentials, and provider error bodies are not logged by the extension. Provider-side handling still follows the account's normal terms/settings.

Vercel's [pricing documentation](https://vercel.com/docs/ai-gateway/pricing) distinguishes purchased Gateway credits (higher rate limits) from Pro/Enterprise (required for ZDR). Purchasing credits replaces the recurring free-credit allowance; it does not enable ZDR. This extension never changes billing or purchases credits.

## Behavior and limits

- One request at a time per extension instance, with no SDK retries and a two-second deadline covering credential resolution and evaluation. Cancellation propagates to the request. An operation that ignores cancellation continues occupying its slot until it settles; its late result cannot steer the agent.
- HTTP 429 causes a cooldown: at least 60 seconds, exponentially increasing to five minutes for repeated failures, or longer if `Retry-After` requests it. Other failures use a shorter bounded cooldown. Missing credentials and 401/403 suspend calls until explicit re-enabling. No queued retries run in the background.
- Identical snapshots are not re-evaluated after success. Each reminder category is injected at most once per latest user message. User input, tree navigation, compaction, and session teardown invalidate pending judgments. Mode changes preserve pacing and cooldowns.
- Advice requires a selected-choice probability of at least 0.85. `none`, `insufficient_context`, or missing probabilities never inject. This is an experimental heuristic, **not a calibrated safety threshold**.
- In advise mode, only predefined, explicitly fallible advice is injected. It does not alter tools, system prompts, permission policy, or the stored transcript; it cannot force another model turn, undo an action, or suppress an already-streamed final answer. Route mode instead nominates one host-managed worker before inference.
- The footer shows the latest judgment/error and timing. `/jev status` shows accounting separately from Volt's main model token/cost totals. Missing cost is reported as unavailable rather than estimated. Counters are local to the current extension instance.
- Pacing is not shared across multiple Volt processes. Other sessions, models, or upstream provider limits can still produce 429 responses. Calls that time out may still be billed.

## Development

AI SDK `7.0.105` and its lockfile are isolated here; no root dependency, model-provider, or RPC protocol changes are required. The host's `prompt_route` extension event owns the optional dispatch path, and named subagent starts accept a host-only per-run model override. The SDK's experimental evaluation API validates structured answers; the extension strips raw SDK errors before reporting failures.

```bash
cd .volt/extensions/jev-guidance
npm run check
node --conditions=volt-source --test test/*.test.ts
```

Checks reuse the repository's TypeScript compiler and ambient declarations. All unit tests use synthetic data and mocked evaluation/network boundaries: no real keys, provider calls, or paid tokens. From the repository root, also run the required `npm run check` after code changes.

References: [Volt extensions](../../../packages/coding-agent/docs/extensions.md), [Gateway evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation).

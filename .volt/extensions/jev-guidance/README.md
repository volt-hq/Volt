# Jev guidance dogfooding extension

Project-local, opt-in guidance for Volt's **local TUI**. The coding model stays unchanged. Jev runs through Vercel AI Gateway before selected model requests and chooses one predefined reminder about discussion boundaries, scope drift, or unproductive repetition.

## Setup

From the repository root:

```bash
npm ci --ignore-scripts --prefix .volt/extensions/jev-guidance
```

Use Volt's existing `vercel-ai-gateway` credential (including `/login` and configured key resolvers), or `AI_GATEWAY_API_KEY`. Never put a credential in this extension or its commands.

Trust this project and run `/reload`, then:

- `/jev observe`: make real evaluations and show judgments, without steering the coding model.
- `/jev advise`: also append a qualifying reminder to the current model request only.
- `/jev off`: cancel an active evaluation and stop future calls.
- `/jev status`: show the last result, attempts, skipped evaluations, errors, reported tokens/cost, and cooldown.
- `/jev interval 2`: change minimum spacing between attempts to two seconds (1–300 allowed; default 15). Existing cooldowns still apply.

Alternatively, start the TUI with `--jev observe` or `--jev advise`. With no flag, guidance starts **off**, including after reload or session replacement. Mode and counters are not restored from session history. Print, JSON, RPC/phone-owned, and subagent runtimes do not activate guidance. A local TUI that owns a phone-shared conversation can evaluate that conversation while explicitly enabled.

## Privacy and retention

**Both observe and advise send selected session context to Vercel/TypeSafe without requesting Zero Data Retention.** Observe is not an offline mode. This non-ZDR setup was explicitly selected for personal dogfooding. Do not enable it in a workspace whose data policy forbids that transfer.

The snapshot includes the latest user request, up to three earlier user messages outside the recent window, and up to twelve recent messages. Text excerpts, selected tool arguments (`path`, `command`, `action`, `offset`, `limit`), bash output excerpts, and compaction/branch summaries may be sent. Older authorization may be absent; truncation is marked and the evaluator is told to abstain when essential evidence is missing. The serialized snapshot is capped at 24 KB before the separate rubric is added.

Images, reasoning blocks, raw read output, edit/write bodies, tool details, custom extension messages, and `!`/`!!` bash-execution messages are omitted. The full system prompt and context files are not copied. Summaries and ordinary messages can nevertheless contain code, paths, or personal information.

Common secret patterns and the resolved Gateway key are redacted before transmission. **Redaction is best effort, not a confidentiality guarantee.** Only judgments and compact accounting/error categories are appended to local session entries; raw snapshots, credentials, and provider error bodies are not logged by the extension. Provider-side handling still follows the account's normal terms/settings.

Vercel's [pricing documentation](https://vercel.com/docs/ai-gateway/pricing) distinguishes purchased Gateway credits (higher rate limits) from Pro/Enterprise (required for ZDR). Purchasing credits replaces the recurring free-credit allowance; it does not enable ZDR. This extension never changes billing or purchases credits.

## Behavior and limits

- One request at a time per extension instance, with no SDK retries and a two-second deadline covering credential resolution and evaluation. Cancellation propagates to the request. An operation that ignores cancellation continues occupying its slot until it settles; its late result cannot steer the agent.
- HTTP 429 causes a cooldown: at least 60 seconds, exponentially increasing to five minutes for repeated failures, or longer if `Retry-After` requests it. Other failures use a shorter bounded cooldown. Missing credentials and 401/403 suspend calls until explicit re-enabling. No queued retries run in the background.
- Identical snapshots are not re-evaluated after success. Each reminder category is injected at most once per latest user message. User input, tree navigation, compaction, and session teardown invalidate pending judgments. Mode changes preserve pacing and cooldowns.
- Advice requires a selected-choice probability of at least 0.85. `none`, `insufficient_context`, or missing probabilities never inject. This is an experimental heuristic, **not a calibrated safety threshold**.
- Only predefined, explicitly fallible advice is injected. It does not alter tools, system prompts, permission policy, or the stored transcript; it cannot force another model turn, undo an action, or suppress an already-streamed final answer.
- The footer shows the latest judgment/error and timing. `/jev status` shows accounting separately from Volt's main model token/cost totals. Missing cost is reported as unavailable rather than estimated. Counters are local to the current extension instance.
- Pacing is not shared across multiple Volt processes. Other sessions, models, or upstream provider limits can still produce 429 responses. Calls that time out may still be billed.

## Development

AI SDK `7.0.105` and its lockfile are isolated here; no root dependency, model-provider, or public protocol changes are required. The SDK's experimental evaluation API validates structured answers; the extension strips raw SDK errors before reporting failures.

```bash
cd .volt/extensions/jev-guidance
npm run check
node --conditions=volt-source --test test/*.test.ts
```

Checks reuse the repository's TypeScript compiler and ambient declarations. All unit tests use synthetic data and mocked evaluation/network boundaries: no real keys, provider calls, or paid tokens. From the repository root, also run the required `npm run check` after code changes.

References: [Volt extensions](../../../packages/coding-agent/docs/extensions.md), [Gateway evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation).

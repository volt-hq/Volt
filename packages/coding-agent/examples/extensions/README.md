# Extension Examples

Example extensions for volt-coding-agent.

## Usage

```bash
# Load an extension with --extension flag
volt --extension examples/extensions/permission-gate.ts

# Or copy to extensions directory for auto-discovery
cp permission-gate.ts ~/.volt/agent/extensions/
```

## Examples

### Lifecycle & Safety

| Extension | Description |
|-----------|-------------|
| `permission-gate.ts` | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, etc.) |
| `project-trust.ts` | Demonstrates the `project_trust` event for user/global and CLI extensions |
| `protected-paths.ts` | Blocks writes to protected paths (.env, .git/, node_modules/) |
| `confirm-destructive.ts` | Confirms before destructive session actions (clear, switch, fork) |
| `dirty-repo-guard.ts` | Prevents session changes with uncommitted git changes |
| `sandbox/` | OS-level sandboxing using `@anthropic-ai/sandbox-runtime` with per-project config |
| `gondolin/` | Route built-in tools and `!` commands into a Gondolin micro-VM |

### Custom Tools

| Extension | Description |
|-----------|-------------|
| `todo.ts` | Todo list tool + `/todos` command with custom rendering and state persistence |
| `hello.ts` | Minimal custom tool example |
| `question.ts` | Demonstrates `ctx.ui.select()` for asking the user questions with custom UI |
| `questionnaire.ts` | Multi-question input with tab bar navigation between questions |
| `tool-override.ts` | Override built-in tools (e.g., add logging/access control to `read`) |
| `dynamic-tools.ts` | Register tools after startup (`session_start`) and at runtime via command, with prompt snippets and tool-specific prompt guidelines |
| `structured-output.ts` | Final structured-output tool that returns `disposition: "stop"` so the agent can end on the tool call |
| `built-in-tool-renderer.ts` | Custom compact rendering for built-in tools (read, bash, edit, write) while keeping original behavior |
| `minimal-mode.ts` | Override built-in tool rendering for minimal display (only tool calls, no output in collapsed mode) |
| `truncated-tool.ts` | Wraps ripgrep with proper output truncation (50KB/2000 lines) |
| `ssh.ts` | Delegate all tools to a remote machine via SSH using pluggable operations |

### Commands & UI

| Extension | Description |
|-----------|-------------|
| `preset.ts` | Named presets for model, thinking level, tools, and instructions via `--preset` flag and `/preset` command |
| `tools.ts` | Interactive `/tools` command to enable/disable tools with session persistence |
| `handoff.ts` | Transfer context to a new focused session via `/handoff <goal>` |
| `qna.ts` | Extracts questions from last response into editor via `ctx.ui.setEditorText()` |
| `status-line.ts` | Shows turn progress in footer via `ctx.ui.setStatus()` with themed colors |
| `github-issue-autocomplete.ts` | Adds `#1234` issue completions by stacking a custom autocomplete provider that preloads open issues from `gh issue list` |
| `widget-placement.ts` | Shows widgets above and below the editor via `ctx.ui.setWidget()` placement |
| `hidden-thinking-label.ts` | Customizes the collapsed thinking label via `ctx.ui.setHiddenThinkingLabel()` |
| `working-indicator.ts` | Customizes the streaming working indicator via `ctx.ui.setWorkingIndicator()` |
| `model-status.ts` | Shows model changes in status bar via `model_select` hook |
| `snake.ts` | Snake game with custom UI, keyboard handling, and session persistence |
| `tic-tac-toe.ts` | Tic-tac-toe vs the agent with `executionMode: "sequential"` tools to prevent race conditions on shared cursor state |
| `send-user-message.ts` | Demonstrates `volt.sendUserMessage()` for sending user messages from extensions |
| `timed-confirm.ts` | Demonstrates AbortSignal for auto-dismissing `ctx.ui.confirm()` and `ctx.ui.select()` dialogs |
| `rpc-demo.ts` | Exercises all RPC-supported extension UI methods; pair with [`examples/rpc-extension-ui.ts`](../rpc-extension-ui.ts) |
| `modal-editor.ts` | Custom vim-like modal editor via `ctx.ui.setEditorComponent()` |
| `rainbow-editor.ts` | Animated rainbow text effect via custom editor |
| `notify.ts` | Desktop notifications via OSC 777 when agent finishes (Ghostty, iTerm2, WezTerm) |
| `titlebar-spinner.ts` | Braille spinner animation in terminal title while the agent is working |
| `summarize.ts` | Summarize conversation with GPT-5.2 and show in transient UI |
| `custom-footer.ts` | Custom footer with git branch and token stats via `ctx.ui.setFooter()` |
| `custom-header.ts` | Custom header via `ctx.ui.setHeader()` |
| `overlay-test.ts` | Test overlay compositing with inline text inputs and edge cases |
| `overlay-qa-tests.ts` | Comprehensive overlay QA tests: anchors, margins, stacking, overflow, animation |
| `doom-overlay/` | DOOM game running as an overlay at 35 FPS (demonstrates real-time game rendering) |
| `shutdown-command.ts` | Adds `/quit` command demonstrating `ctx.shutdown()` |
| `reload-runtime.ts` | Adds `/reload-runtime` and `reload_runtime` tool showing safe reload flow |
| `interactive-shell.ts` | Run interactive commands (vim, htop) with full terminal via `user_bash` hook |
| `inline-bash.ts` | Expands `!{command}` patterns in prompts via `input` event transformation |
| `input-transform-streaming.ts` | Skips expensive input preprocessing for mid-stream steering via `streamingBehavior` |

### Git Integration

| Extension | Description |
|-----------|-------------|
| `git-checkpoint.ts` | Creates git stash checkpoints at each turn for code restoration on fork |
| `auto-commit-on-exit.ts` | Auto-commits on exit using last assistant message for commit message |

### System Prompt & Compaction

| Extension | Description |
|-----------|-------------|
| `pirate.ts` | Demonstrates `systemPromptAppend` to dynamically modify system prompt |
| `claude-rules.ts` | Scans `.claude/rules/` folder and lists rules in system prompt |
| `custom-compaction.ts` | Custom compaction that summarizes entire conversation |
| `trigger-compact.ts` | Triggers compaction when context usage exceeds 100k tokens and adds `/trigger-compact` command |

### System Integration

| Extension | Description |
|-----------|-------------|
| `mac-system-theme.ts` | Syncs volt theme with macOS dark/light mode |

### Resources

| Extension | Description |
|-----------|-------------|
| `dynamic-resources/` | Loads skills, prompts, and themes using `resources_discover` |
| `context-preparation.ts` | Opt-in deterministic skill/source excerpts through managed services; [SDK configuration and evaluation](#context-preparation) |
| `jev-context-preparation.ts` | Opt-in Jev selector with `/jev` controls, footer status, and deterministic fallback; [export consent, credentials, and evaluation](#jev-assisted-context-preparation) |

### Messages & Communication

| Extension | Description |
|-----------|-------------|
| `message-renderer.ts` | Custom message rendering with colors and expandable details via `registerMessageRenderer` |
| `event-bus.ts` | Inter-extension communication via `volt.events` |

### Session Metadata

| Extension | Description |
|-----------|-------------|
| `session-name.ts` | Name sessions for the session selector via `setSessionName` |
| `bookmark.ts` | Bookmark entries with labels for `/tree` navigation via `setLabel` |

### Custom Providers

| Extension | Description |
|-----------|-------------|
| `custom-provider-anthropic/` | Custom Anthropic provider with OAuth support and custom streaming implementation |
| `custom-provider-gitlab-duo/` | GitLab Duo provider using volt-ai's built-in Anthropic/OpenAI streaming via proxy |

### External Dependencies

| Extension | Description |
|-----------|-------------|
| `with-deps/` | Extension with its own package.json and dependencies (demonstrates jiti module resolution) |
| `file-trigger.ts` | Watches a trigger file and injects contents into conversation |

## Context preparation

`context-preparation.ts` is an experimental, deterministic consumer of [managed context preparation](../../docs/extensions.md#managed-context-preparation). It is **not enabled by default** and uses no auxiliary model, raw filesystem/process access, repository index, or cache. Loading it explicitly with `volt -e ./examples/extensions/context-preparation.ts` opts into ready-only preparation; it does not change the CLI's zero first-request wait.

For an SDK host, inject the factory and explicitly allow a bounded wait (adjust the example import path to your script):

```typescript
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@hansjm10/volt-coding-agent";
import contextPreparation from "./examples/extensions/context-preparation.ts";

const resourceLoader = new DefaultResourceLoader({ extensionFactories: [contextPreparation] });
await resourceLoader.reload();
const { session } = await createAgentSession({
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
  extensionWorkLimits: { firstRequestWaitMs: 100 },
});
try {
  await session.prompt("Explain src/config.ts:20");
} finally {
  session.dispose();
  await session.waitForClosed();
}
```

This uses your normal main-model configuration; it makes no helper-model request. Omit the factory (or remove the explicitly loaded extension and reload/restart) to disable it. See the [SDK guide](../../docs/sdk.md) for model/auth setup.

### Selection and bounds

- On the first boundary only, inspect at most 8 recent committed input texts, capped at 8,192 characters combined. Explicit skill commands/expansions and common negative cues (`do not`, `don't`, `never`, `avoid`, `skip`, `without`) cause abstention.
- Select at most one loaded skill: an exact name token wins; otherwise require at least two distinct non-generic words shared with its name/description. Tied top scores abstain. Truncated catalogs skip all skill selection, including exact-name matches, without suppressing explicit-source preparation. This is English-oriented lexical matching, not an intent classifier.
- Select the first two distinct relative source/document paths. Use forward slashes and supported common file extensions, optionally with `:line` or `#Symbol`, for example `src/config.ts:20` or `src/config.ts#parseConfig`. Absolute paths, URLs, traversal, hidden path components, `node_modules`, and `vendor` are ignored. Paths with spaces and unrecognized syntax abstain; there is no search fallback. Punctuation-separated lists are accepted only when every entry in the connected span is a supported relative path; otherwise the whole span is ignored. Use whitespace to separate independent paths from URLs or other unsupported text.
- A `#Symbol` hint uses document `symbols` only when advertised. A unique exact match in an untruncated result chooses a range. The subsequent read must confirm the same canonical file; discovery never authorizes reading another target. Unknown index coverage remains unknown, and selection ranges may cover only a name rather than a whole definition.
- One managed task, at most three concurrent branches and five production operations (three reads plus two symbol queries). Each read requests at most 40 lines; each contributed excerpt contains at most 1,536 UTF-8 bytes plus a short label. Partial excerpts are marked. References inside skill/source bodies are not followed.
- The task requests a 1-second deadline and a shared first-request wait of up to 100 ms, subject to tighter host limits. Source validation uses the host's separate collection budget; 100 ms is **not** a total latency guarantee. Native reads can consume more bytes than the retained excerpt. LSP startup/indexing and cancellation drain may outlive the foreground allowance.

Only successful managed reads contribute source-backed text. Policies, overrides, revocation, and fresh-source validation remain authoritative; failures silently omit optional context. Contributions do not replace instructions, count as a completed skill workflow, satisfy Plan research, or prove tests passed. The file filters are not a sandbox or secret detector, and ordinary source reads still follow native path/symlink semantics. Configured LSP servers may start, and managed-read contention can temporarily reject overlapping foreground command-based fixes.

### Reproducible evaluation

From `packages/coding-agent`, using the installed Vitest CLI:

```bash
node node_modules/vitest/dist/cli.js --run test/context-preparation-example.test.ts test/suite/context-preparation.test.ts
```

The SDK-harness comparison uses native temporary skill/source files and a faux provider, with preparation enabled versus omitted. It reports labeled evidence selection, estimated extra message tokens, and production-plus-validation operation counts. Cases cover a skill plus file, a named skill, the two-file cap, ambiguous metadata, irrelevant input, and a negated request. Unit cases also exercise semantic ranges, truncation, unavailable services, and UTF-8 limits. SDK cases verify policy/redaction/staleness omission, the default zero wait, and a slow read reaching the 100 ms cutoff without waking another inference.

Positive admission tests hold virtual deadlines while native I/O settles; the cutoff test advances the virtual clock explicitly. They establish deterministic retrieval and timing contracts, **not production latency, broad retrieval accuracy, or real-model answer quality**. Token estimates include host evidence framing and vary with temporary paths. The two-file cap intentionally misses additional relevant files.

Before adding auxiliary inference, evaluate representative tasks with the same main model, tools, repository state, and host wait settings, enabled versus disabled. Record end-to-end correctness and latency, provider-input token deltas, used versus unused excerpts, stale omissions, and negative/context-induced regressions. Do not infer usefulness merely from context admission or this small fixture corpus.

## Jev-assisted context preparation

`jev-context-preparation.ts` is an experimental alternative to the deterministic example, not a default feature or a main-model replacement. In a new session, loading/discovering it alone performs no preparation, credential lookup, or inference. Load it, then use **`/jev`** in the local TUI to enable it after reviewing the data-sharing confirmation:

```bash
# From packages/coding-agent (use ./volt-test.sh and the full example path from the repo root).
volt -e ./examples/extensions/jev-context-preparation.ts
```

`/jev` opens an enable/disable/wait/status panel; `/jev on`, `/jev off`, `/jev wait`, `/jev status`, and `/jev report` are direct shortcuts with argument completion. Enabling requires data-sharing confirmation, followed by a separate host offer of an 800 ms allowance (clamped to the host ceiling) when the current allowance is zero. Declining the wait still enables ready-only Jev. The command itself makes no model request or credential lookup. State changes wait for any active turn to finish; abort that turn first if you need to disable promptly. Commands are local-only, not remote-safe.

The footer shows `Jev: off` or `Jev: on`, with preparation/evaluation/fallback status when available. `evaluated` does **not** mean the context was admitted or useful. A zero host allowance is marked `ready-only` when the panel observes it or at a request boundary. `/jev status` explains the retention policy, shows the current shared allowance and host ceiling, and summarizes recorded calls on the current branch: attempted, finished, successful, custom-transport count, and the latest call's timestamp, outcome, HTTP status, and elapsed time.

Call history is recorded automatically while enabled, without additional network requests. A `started` record means the adapter invoked its transport, not that the server received the request. `finished` includes successful evaluations, errors, and cancellation; `successful` means a valid evaluation response, not context admission. Missing credentials, no candidates, and disabled preparation do not count as calls. SDK `fetch` overrides are explicitly labeled **custom transport**, not evidence of a real Gateway call.

Metadata is stored as `jev-context-call` custom session entries, outside model context. Each call has an opaque ID and start/result timestamps; results retain only a fixed outcome/reason, elapsed milliseconds, request byte count, HTTP status when observed, and validated token/cost metadata when supplied. No prompt text, source paths/bodies, credentials, selected choices, raw responses, or exception messages are stored. Persisted history follows branches/forks and survives reload/resume; in-memory sessions are not restart-durable.

Records are buffered during model requests to avoid changing the context-collection cursor. Live `/jev status` includes buffered records; they are flushed after an agent attempt, before a new prompt, on an idle on/off command, or during shutdown/reload. Late results may flush immediately when idle. Abrupt exit can lose buffered records, and late results from a navigated branch or retired extension are discarded. A start without a recorded result is **in flight or interrupted**, not proof that a call is still running. Recording failures are reported in `/jev status` without changing evaluation behavior. Older calls made before logging was loaded cannot be reconstructed; zero recorded calls is not proof of zero historical calls.

The choice is stored outside model context on the **current session branch**, restored on reload/resume, and follows tree navigation and forks. A new session starts off unless explicitly enabled through the CLI or SDK. A changed retention policy requires fresh command consent. The latest saved branch choice overrides initial CLI/SDK enablement; SDK `enabled: false` always prohibits enabling. Removing the extension disables it regardless of saved state.

**Preparation wait** offers 0 (ready-only), 100, 400, 800, or 1,000 ms, plus any custom current value or ceiling. Choices above the host ceiling are omitted. The host confirms each changed allowance; opening or cancelling the selector changes nothing. This is a **shared runtime allowance**, not a Jev-only delay: other preparation extensions also use it, while Jev itself still requests at most 800 ms. Setting zero does not disable Jev, and disabling Jev does not change the shared allowance.

The allowance defaults to zero and is not saved with the branch's on/off choice. It survives `/reload` in the same runtime but resets on restart or session replacement. Without a startup limit, the user can approve up to 1,000 ms through the panel. An explicit CLI `--preparation-wait-ms` or SDK `extensionWorkLimits.firstRequestWaitMs` sets both the initial allowance and its hard ceiling, including explicit zero. The panel cannot raise that ceiling. For non-interactive opt-in, keep the existing `--jev-context-preparation` and `--preparation-wait-ms 800` flags or equivalent SDK configuration.

Keep `context-preparation.ts` beside it for the shared parser/read helpers, but **load only one consumer**. Importing the helper file does not enable its deterministic extension factory. Do not copy both files into an auto-discovered extensions directory as separate enabled consumers.

### Live evaluation report

Run **`/jev report`** in the local TUI, including while a request is running. It prints a text-only diagnostic report through the existing notification surface; it does not enable Jev, wait for preparation, make network/model requests, or write session entries.

The report separates:

- **Evaluated:** pending, valid response, unavailable, or cancelled, with elapsed evaluation time and fixed failure reasons. A valid abstention is still a valid response.
- **Evidence prepared:** accepted source-backed contribution publications, rejected publications, and removals. This includes deterministic fallback; it is not a count of Jev-selected files or unique excerpts. Successful reads alone do not count as prepared evidence.
- **Provider request observations:** the last eight conversational boundaries in the latest scope, their requested allowance, and a snapshot at the first `before_provider_request` observation for each boundary. Each snapshot records evaluation/preparation progress and existing host contribution states (`ready`, `admitted`, or `omitted`, with host reasons such as `source_unverified`). Earlier snapshots remain unchanged when a late selection refines a later request. A missing hook or failed diagnostic read is **unobserved**, not evidence of omission.
- **Useful to the task:** explicitly **unmeasured**. Neither admission nor the model mentioning an excerpt establishes a correctness or productivity benefit; assess representative tasks separately.

These are **host collection diagnostics, not verified final-payload delivery receipts**. A skipped collection can retain earlier host states, and subsequent admission changes or trusted payload hooks can remove evidence. Provider-internal HTTP retries are not separate conversational boundaries. The report does not parse payloads or infer model use.

Only the latest request scope is retained, in memory. A new scope replaces it; a disabled request clears it. Reload, restart, session replacement, and tree navigation clear the report rather than reconstructing it from call history. Late results cannot populate a replacement report. Reports contain fixed contribution keys and diagnostic metadata, not request text, source paths/bodies, credentials, selected skill IDs, or raw provider responses. `/jev status` remains the persisted branch-local **call history** view; those records alone cannot reconstruct preparation or admission.

### Export consent and credentials

Enabling this extension consents to sending bounded committed request text and candidate metadata to **Vercel AI Gateway / TypeSafe AI**, even when the main model uses another provider. **Zero Data Retention is off by default.** Normal Gateway/provider retention and training policies apply. Source/skill bodies, absolute cwd, host resource IDs, system instructions, image bytes, and the full transcript are not automatically exported. Request text and descriptions can themselves contain code, secrets, or private information: these bounds are not redaction or a secret detector. Managed read permission is not export consent.

The adapter resolves `vercel-ai-gateway` through the current session's `modelRegistry.getApiKeyForProvider()`: existing Volt `/login` credentials work, as do supported environment/provider-key configuration. No separate TypeSafe key or `models.json` Jev chat entry is needed. The endpoint is fixed to `https://ai-gateway.vercel.sh/v4/ai/evaluation-model`; redirects are refused and chat endpoint/header overrides are not forwarded. Missing credentials and failures retain deterministic fallback. No credentials, prompts, raw response bodies, or provider error strings enter evaluation diagnostics.

For SDK use, enable the factory and grant an 800 ms first-request allowance:

```typescript
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@hansjm10/volt-coding-agent";
import { createJevContextPreparation } from "./examples/extensions/jev-context-preparation.ts";

const resourceLoader = new DefaultResourceLoader({
  extensionFactories: [createJevContextPreparation({
    enabled: true,
    // Set true only with ZDR-capable Gateway access; rejection never retries without ZDR.
    zeroDataRetention: false,
    // Optional metadata only; this does not establish context admission or usefulness.
    onEvaluation: (result) => console.log(result),
  })],
});
await resourceLoader.reload();
const { session } = await createAgentSession({
  resourceLoader,
  sessionManager: SessionManager.inMemory(),
  extensionWorkLimits: { firstRequestWaitMs: 800 },
});
try {
  await session.prompt("Explain src/config.ts:20");
} finally {
  session.dispose();
  await session.waitForClosed();
}
```

Use `/jev off`, omit the factory, or set SDK `enabled: false` to disable. Removing only the CLI enablement flag does not override a saved on choice in a resumed session. Loading the extension alone does not raise the default zero wait. The host allowance accepts 0–1,000 ms through the CLI or SDK; configuration alone neither enables Jev nor adds a delay. The CLI flag applies to locally created runtimes, not already-running remote runtimes. `fetch` is an optional trusted transport override for offline experiments; it must honor cancellation. Observer callbacks are nonblocking: synchronous exceptions and rejected promises are contained, but observer side effects remain the SDK host's responsibility. There are no new dependencies, provider-registry entries, or wire/storage protocol changes.

### Selection, fallback, and timing

- While enabled, evaluate skill relevance once for each new committed user-request scope, not each tool continuation or retry. Offer the full available loaded skill catalog (host-bounded to 128 skills), without requiring an exact name or keyword overlap. Even conversational input reaches Jev when skills are available; Jev may choose `none`. Loading new skills requires the normal resource reload.
- Negative cues such as `without`, `avoid`, or `do not` no longer suppress the Jev skill decision. They still suppress deterministic fallback and explicit-source prefetch, so negated files are not speculatively read. Jev is instructed to respect exclusions and constraints. Explicit skill invocations/expansions remain separate and skip evaluation.
- Keep bounded input, native read authority, path guards, and excerpt limits. Offer at most two explicit source candidates. Truncated catalogs still skip skills; unavailable or empty catalogs with no source candidates make no auxiliary call. Oversized serialized requests fail closed rather than silently dropping skills. This is selection among loaded skills and explicit paths, not repository-wide retrieval; Jev cannot invent candidates or execute a skill workflow.
- Export at most 8,192 request characters, 64 characters per skill name, and 256 per description, plus relative source paths/anchors. Both serialized requests and response bodies are capped at 64 KiB. Request-level truncation means context may be missing.
- Send one evaluation with at most three choice questions: one skill or `none`, and include/omit each offered source. Validate every answer against its own finite option set and reject incomplete/extra/malformed answers atomically. Probabilities are ignored; they are not calibrated task-success confidence. Jev cannot invent a path, resource ID, or operation.
- One managed task with a 1.5-second deadline prepares deterministic evidence concurrently with the evaluation. It requests up to 800 ms of the shared first-request allowance, subject to a tighter host limit, and ends the wait early when preparation settles. Fast valid decisions can prune evidence or select one alternate skill before initial collection. Slow decisions leave deterministic fallback available at the effective cutoff (800 ms with the configuration above), and may only refine a later already-authorized tool continuation. Late changes wait for initial payload preparation (or a subsequent boundary for SDK streams without payload notification), so they cannot revoke fallback during initial source validation. `none` cannot retract evidence already sent in an earlier request. With zero host wait, initial preparation is normally absent. Source validation has a separate 25 ms host budget; neither allowance nor task deadline is a total-latency guarantee. The deterministic-only consumer still requests 100 ms and a one-second task deadline.
- Reuse already prepared source/skill evidence rather than rereading it. A changed skill selection makes at most one additional managed skill read: at most six production operations overall, plus host validation. All reads and later admission retain native policy, reducer, identity, freshness, and cancellation checks. Read failures omit optional text; a selected-but-unreadable skill does not silently substitute another skill.
- No retries, cache, wake authority, transcript rewriting, or additional wait on later boundaries. One HTTP call maximum per eligible request scope; task cancellation propagates through fetch and response streaming. Foreground settlement/revocation cancels outstanding work. The adapter awaits its work; authentication configuration commands and trusted transport implementations are not automatically sandboxed or metered by managed services.
- A slow evaluation can consume the full allowed initial wait even when deterministic evidence is ready. Work can incur cost and still be discarded. Request-size/call/deadline bounds are not enforced dollar limits, and client cancellation does not guarantee provider-side cancellation or zero billing.

### Evidence and reproducible comparison

The adapter follows the experimental Gateway v4 contract verified against [Vercel AI SDK source at `73ec7015`](https://github.com/vercel/ai/blob/73ec7015edd4f04ca9144ce93a8a037a731e5db8/packages/gateway/src/gateway-evaluation-model.ts) and its [provider setup](https://github.com/vercel/ai/blob/73ec7015edd4f04ca9144ce93a8a037a731e5db8/packages/gateway/src/gateway-provider.ts). This is not the chat-completions API. Experimental wire changes require re-verification; there is no compatibility fallback.

Two synthetic, non-ZDR local smoke calls succeeded:

| Probe | Round trip | Input / output tokens | Gateway-reported cost |
| --- | --- | --- | --- |
| Initial single-choice contract probe | 695 ms | 425 / 44 | `0` |
| Actual adapter, three questions | 484 ms | 553 / 101 | `0` |

The adapter selected the expected skill/source and omitted the unrelated source. Both calls missed the original 100 ms first-request allowance. Their observed round trips fit within 800 ms, but do not establish how often evaluation plus local preparation and validation will fit. These are smoke tests, not a latency distribution or quality benchmark; the probe used an independent measurement deadline. Gateway rejected the earlier ZDR probe because that credential's plan lacked ZDR; the adapter does not silently remove an explicitly requested retention constraint. Check [current Jev pricing](https://vercel.com/ai-gateway/models/jev) rather than assuming future calls are free.

```bash
# From packages/coding-agent; no real provider calls in these tests.
node node_modules/vitest/dist/cli.js --run test/jev-context-preparation.test.ts test/suite/jev-context-preparation.test.ts test/suite/jev-context-command.test.ts test/suite/jev-context-report.test.ts test/context-preparation-example.test.ts test/suite/context-preparation.test.ts
```

The three-way SDK fixture comparison holds the main faux provider, tools, and source content fixed. Scripted Jev answers test equal selection, resolving a lexical tie, choosing a skill without keyword overlap (including requests containing `without`), pruning an irrelevant source, and abstaining on negative/irrelevant input after evaluation. It reports context-token estimates, native operation counts, and auxiliary call counts. Clock/barrier cases verify 400/700 ms decisions admitted initially with early completion, fallback under 100/800/1,000 ms host allowances, later-boundary refinement without renewed waits, 1.5-second deadline cancellation, and no wake. Mock transport cases cover wire shape, opt-in, finite answers, byte limits, auth/errors, and cancellation without live credentials.

These tests establish integration contracts only. Real main-model correctness, end-to-end latency, context-induced regressions, and whether admitted excerpts are used remain unmeasured. Keep this experimental and opt-in until a representative real-task comparison demonstrates benefit.

## Writing Extensions

See [docs/extensions.md](../../docs/extensions.md) for full documentation.

```typescript
import type { ExtensionAPI } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";

export default function (volt: ExtensionAPI) {
  // Subscribe to lifecycle events
  volt.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register custom tools
  volt.registerTool({
    name: "greet",
    label: "Greeting",
    description: "Generate a greeting",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register commands
  volt.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify("Hello!", "info");
    },
  });
}
```

## Key Patterns

**Use StringEnum for string parameters** (required for Google API compatibility):
```typescript
import { StringEnum } from "@hansjm10/volt-ai";

// Good
action: StringEnum(["list", "add"] as const)

// Bad - doesn't work with Google
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

**State persistence via details:**
```typescript
// Store state in tool result details for proper forking support
return {
  content: [{ type: "text", text: "Done" }],
  details: { todos: [...todos], nextId },  // Persisted in session
};

// Reconstruct on session events
volt.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "my_tool") {
      const details = entry.message.details;
      // Reconstruct state from details
    }
  }
});
```

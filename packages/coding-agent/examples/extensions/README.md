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
- Select the first two distinct relative source/document paths. Use forward slashes and supported common file extensions, optionally with `:line` or `#Symbol`, for example `src/config.ts:20` or `src/config.ts#parseConfig`. Absolute paths, URLs, traversal, hidden path components, `node_modules`, and `vendor` are ignored. Paths with spaces and unrecognized syntax abstain; there is no search fallback.
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

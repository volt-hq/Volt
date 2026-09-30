# Remote-friendly extensions

- Status: Proposal. Nothing here is implemented.
- Date: 2026-09-30
- Audience: Volt maintainers, extension API implementers, and volt-app maintainers.
- Scope: What an extension can offer a paired remote client (the iOS app): invocation inputs, invocation context, long-running work, results, and client capability negotiation.
- Decision: Extensions describe data (inputs, progress, results), and each client renders it natively. TUI components remain an optional TUI-only enhancement. Delivery is five independent steps.
- Client counterpart: `docs/extension-remote-ux.md` in `volt-hq/volt-app`.

## 1. Objective

Let an extension author make a command useful from the phone without writing client code. Today `remoteSafe: true` makes a command invocable remotely, but almost nothing the command produces reaches a remote client.

Extension code runs on the host, and the phone can only draw what the host sends it. The extension API should therefore express intent as bounded, host-validated data that every client understands, instead of terminal text and TUI components that only the desktop can render.

### Non-goals

- Running extension-supplied UI code, HTML, or web views on the phone.
- Per-extension native plugins in the app.
- Loosening the host's security classification. `remoteSafe` stays mandatory and host-owned.
- Compatibility paths for older clients. Protocol changes land in place, and volt-app adapts through filed issues.

## 2. Current state

The motivating case is the project-local `/swarm-review` extension (`.volt/extensions/swarm-review/`). It runs for 10 to 30 minutes, reports live progress, and posts a long findings report. It was marked remote-safe in #551, and every gap below applies to it.

| Surface | Host today | Phone today |
| --- | --- | --- |
| Discovery and invocation | A remote-safe command projects to a palette descriptor with one raw `arguments` string (`createExtensionCommandAction` in `src/core/rpc/ui-actions.ts`). | Renders native forms for `string`, `boolean`, `enum`, and `integer` descriptor args, but extensions only ever send one string. |
| Invocation context | Daemon-hosted runtimes bind extensions with `mode: "rpc"`, which a local RPC client also uses. Handlers cannot tell a local user from a remote one. | Not applicable. |
| Dialogs | The RPC extension UI protocol carries `confirm`, `select`, `input`, and `editor`. | Answers `confirm` only and auto-cancels the rest (`VoltSession+HostActions.swift`). Conversations owned by a desktop TUI and relayed to the phone send no extension UI requests at all. |
| Fire-and-forget UI | `notify`, `setStatus`, `setWidget`, and `setTitle` are sent as `extension_ui_request`. Widgets are lines of terminal text. | Ignores `notify` and `setWidget`. `setStatus` is joined into the connection detail line. `setTitle` renames the session. |
| Results | Custom messages are host-private except `review`, `background_job_notification`, and `subagent_recovery` (`src/core/rpc/custom-message-projection.ts`). `registerMessageRenderer` returns TUI components. | Never receives extension messages. |
| Long-running work | A command handler holds the session busy until it returns. Its `ctx.signal` is the session-lifetime signal, so an RPC `abort` does not reach it. Background jobs belong to tool calls (`toolName` and `toolCallId` in `BackgroundJobSummary`). | Cannot see progress or cancel a running extension command. |
| Push notifications | Kinds are `conversation_completed`, `plan_ready`, `review_completed`, `action_completed`, and `host_notice` (`src/core/remote/iroh/push.ts`). Nothing produces `action_completed`. | Already routes `action_completed` taps (`VoltSession+NotificationNavigation.swift`). |
| Rich UI | `ctx.ui.custom()` is TUI-only. | Not applicable. |

In practice a remote `/swarm-review` starts, runs for many minutes with no visible progress and no way to stop it, and its report never appears on the phone.

## 3. Principles

1. **Declarative over imperative.** Extensions send data with a schema, and clients own presentation. The TUI can keep richer optional renderers.
2. **Opt-in per surface.** Host-private stays the default. An extension opts each message type, parameter set, or operation into remote exposure explicitly.
3. **The host validates and bounds.** Everything that crosses to a remote client gets the same sanitization, path redaction, and size limits as transcript content. Nothing sent by a client is trusted for authority. A card action is revalidated at invocation like any other invocation.
4. **Host-set context.** Invocation origin and client capabilities are supplied by the host, never by the extension or the client payload.
5. **Graceful degradation.** Every structured surface has a text fallback, so an older or simpler client still shows something.

## 4. Proposed surfaces

Each subsection is independently shippable. API shapes are sketches, not final signatures.

### 4.1 Remote-visible message types

An extension registers a custom message type as remote-visible:

```typescript
volt.registerMessageType("swarm-review", {
	remote: { role: "assistant" }, // or "system"
});
```

Host behavior:

- The transcript projection admits registered types from loaded extensions, in addition to the built-in allowlist. Built-in type names are reserved, and registering one fails at load time.
- Only the markdown `content` is sent, bounded by the existing transcript text limit (16,000 characters) and path redaction. `details` stays host-private.
- Transcript items gain source attribution, for example `{ kind: "extension", customType, label }`, so the client can badge the item and a message cannot pass itself off as Volt's own review output.

This is the smallest change with the largest effect: the `/swarm-review` report would appear on the phone as markdown.

### 4.2 Invocation context

Add a trusted, host-set invocation descriptor to command contexts:

```typescript
ctx.invocation; // { origin: "local" | "remote"; client: "tui" | "rpc" | "remote-app" }
```

- `origin` is `"remote"` for any invocation that arrived over the Iroh transport, including a phone prompt relayed into a desktop-owned conversation, where the handler runs in the TUI process.
- Extensions gate sensitive options on `origin`, not on `ctx.mode`. `/swarm-review` currently refuses `--exec` whenever `ctx.mode !== "tui"`. That is safe but imprecise: it blocks local RPC users, and in a relayed desktop conversation it relies on the desktop user answering a confirmation that a phone triggered.

### 4.3 Typed command parameters

Commands can declare parameters with the same TypeBox subset the UI action protocol already renders:

```typescript
volt.registerCommand("swarm-review", {
	remoteSafe: true,
	parameters: Type.Object({
		target: StringEnum(["worktree", "base", "commit", "pr"] as const, { default: "worktree" }),
		workers: Type.Integer({ minimum: 1, maximum: 32, default: 30 }),
		fresh: Type.Boolean({ default: false }),
		focus: Type.Optional(Type.String()),
		exec: Type.Boolean({ default: false, localOnly: true }),
	}),
	parseArguments: (text) => ({ /* slash-command text to parameters */ }),
	handler: async (params, ctx) => {},
});
```

- The descriptor projection maps `string`, `boolean`, `StringEnum`, and `integer` to the existing `args` descriptors. Integer bounds are added to the descriptor.
- The host validates parameters before calling the handler, for palette and slash invocations alike. `parseArguments` keeps slash commands working.
- `localOnly` parameters are omitted from remote descriptors and rejected on remote invocation. This replaces hand-rolled gates like the `--exec` check.
- Commands without `parameters` keep the single raw string.

### 4.4 Extension operations

Long-running work runs as a host-owned operation instead of a handler that blocks the session:

```typescript
const operation = ctx.startOperation({ label: "Swarm review" }, async (op) => {
	op.progress({ phase: "Wave 2 of 3", completed: 14, total: 30, detail: "23 clusters" });
	// op.signal aborts on cancel, session disposal, or authority loss.
	return { summary: "21 confirmed findings", messageType: "swarm-review", content: report };
});
```

- Operations generalize background jobs. `BackgroundJobSummary` gains an owner union (tool call or extension), so existing listing, `background_jobs_changed` events, and cancellation apply unchanged.
- Progress is structured (phase, completed, total, short detail), rate-limited, and bounded, replacing terminal-text widgets for remote clients.
- Cancellation through the existing jobs cancel path aborts `op.signal`. The command handler returns immediately, so the session is not held busy.
- Completion posts the result message (remote-visible if registered under 4.1) and emits an `action_completed` push notification, the kind that is already declared and routed by the app but never produced. Titles are bounded by the existing push limits and prefixed with the extension label.
- Operations share background jobs' lifetime rules: they survive a phone disconnect but not a host restart. Per-session concurrency limits apply.

### 4.5 Declarative cards and actions

Results can carry a card with a small schema: title, subtitle, sections of items (text, severity, file reference with path and line, badge), and actions.

- Action kinds:
  - `prompt` sends a user message, for example "Fix finding 1".
  - `command` invokes a remote-safe command with typed parameters.
  - `dismiss` hides the card.
- The host validates the schema and size, rejects actions that target commands that are not remote-safe, and revalidates every action when it is invoked.
- Clients render cards natively. The TUI gets a default card component, and `registerMessageRenderer` can still override it locally. The card's markdown fallback is its content.
- This subsumes the deferred "native card/toggle metadata for extensions" noted under `registerCommand` in `extensions.md`. Toggle and state descriptors for extension settings can follow the same validation model.

### 4.6 Client capability negotiation

Clients advertise which extension UI methods and card schema versions they support, and the host exposes this to extensions:

```typescript
if (ctx.ui.supports("select")) { /* ask */ } else { /* use a default or typed parameter */ }
```

Unsupported dialogs keep today's behavior (the phone cancels them), but extensions can check first instead of assuming a cancellation means the user declined.

## 5. Security

- `remoteSafe` remains the gate for remote invocation. Typed parameters and `localOnly` narrow it further; nothing here widens it.
- Remote-visible content is opt-in, bounded, and path-redacted like transcript content. `details` never leaves the host.
- Invocation origin and client capabilities are host-set.
- Card actions carry no authority. The host revalidates the target and parameters as a fresh invocation from the same client grant.
- Operation progress, results, and push text are bounded strings, and push titles carry the extension label so an extension cannot impersonate Volt notices.
- Extensions remain trusted host code with full process permissions. This design does not sandbox them; it controls what crosses the transport.

## 6. Delivery sequence

| Step | Host work | App work |
| --- | --- | --- |
| 1. Remote-visible message types (4.1) | Registration API, projection, source attribution | Render extension-attributed transcript items |
| 2. Invocation origin (4.2) | Host-set `ctx.invocation`, including relayed conversations | None |
| 3. Typed parameters (4.3) | Schema projection, validation, `localOnly` | Integer bounds and validation messages in forms |
| 4. Extension operations (4.4) | Job owner generalization, progress, cancel, `action_completed` push | Operation cards with progress and cancel; push deep link |
| 5. Cards and negotiation (4.5, 4.6) | Card schema, action validation, capability exchange | Card renderer, action invocation, capability advertisement |

Each step gets a Volt PR with focused tests and a volt-app issue for its client work. Step 1 alone makes `/swarm-review` usable remotely. Steps 1 and 4 together make it comfortable.

## 7. Worked example: `/swarm-review`

- **Invoke:** the phone shows a form with a target picker, a workers stepper (1 to 32), a "fresh" toggle, and a focus field. `exec` is local-only and absent.
- **Run:** the command starts an operation. The phone's Runs view shows "Swarm review: Wave 2 of 3, 14/30 workers, 23 clusters" with a cancel button, and the phone can disconnect.
- **Finish:** a push notification says "swarm-review: 21 confirmed findings". Tapping it opens the conversation, where the report is an extension-badged card with findings grouped by priority. Each finding has "Fix this" (a prompt action) and an anchor that opens the file reference.

## 8. Open questions

- **Relayed desktop conversations.** The TUI serves a relayed phone stream through `runIrohRemoteRpcMode` on its own runtime host, and `runRpcMode` calls `bindExtensions` with `mode: "rpc"`, which replaces the session's extension mode and UI context. Confirm how this interacts with the desktop's TUI binding before relying on `ctx.mode` in any form. Step 2 should define `origin` for this path explicitly.
- Should operations reuse the review workflow model (`workflowId` in UI action invocation responses) instead of background jobs?
- Rate limits for operation progress and for remote-visible messages per session.
- Whether a remote-visible message type needs per-workspace opt-in in addition to project trust.

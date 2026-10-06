# RFC: Daemon-Hosted Conversations: One Runtime Owner, TUI as Client

> **Superseded in part.** The [architecture rewrite](architecture-rewrite-design.md) absorbs this design as its host model (Phase 7). Its Phase 1 replaced the store revision and conversation-authority fencing described here with ordinal-fenced log writes and an exclusive per-log lock that every host takes, in-process modes included, so opening a session another process holds fails with `conversation_locked` (Q4).

- Status: Draft (proposed). Phase 1 stands on its own; Phases 2-4 are subject to the architecture rewrite RFC now being drafted.
- Date: 2026-10-01
- Workspaces: `Volt/packages/coding-agent` (primary). `volt-app` needs no protocol change; it can delete dead handling afterwards (§10.3).
- Supersedes: the TUI-ownership model of [Live Shared Sessions](live-shared-session-daemon-design.md): §6 (TUI Integration) entirely, §8 (Extension Compatibility Contract) table, the `tui-owned`/`daemon-draining` lease states and drain protocol in §4, the viewer events in §5.4, goals G4/G5, and the non-goals "Mid-turn ownership migration" and "Multi-TUI co-attach".
- Amends: [Workspace Authority Generations and Retirement](workspace-authority-lifecycle-design.md) (retirement targets workers, not daemon runtimes or TUI leases), [Atomic Conversation Bootstrap](conversation-bootstrap-design.md) (adds a local subscriber profile), [Git worktrees](worktrees-design.md) Phase 2 (TUI "lease takeover" becomes attach).
- Related: [Remote-friendly extensions](extension-remote-ux-design.md) (#552) proposes data-driven replacements for TUI-only extension UI. That design is a proposal and is not implemented.
- Breaking changes: intentional. Volt has no users to preserve; no compatibility paths are added. The extension API (`src/core/extensions/types.ts`) stays source-compatible; its runtime behavior in the TUI changes (§6.5).

Paths are relative to `Volt/packages/coding-agent/`. Symbol names are the anchors; line counts are as of this draft.

---

## 1. Decision

Every interactive conversation runs in a **conversation worker**: a dedicated process supervised by voltd that owns exactly one live `AgentSessionRuntime`. The TUI no longer hosts a runtime. Like a paired phone, it is a client of the worker's conversation stream.

Decided:

1. **The TUI is a client.** It renders a conversation it does not own and sends commands to it. TUI-only extension components stop working or are replaced by data-driven equivalents (§6.5).
2. **Runtimes run in per-conversation worker processes**, not inside voltd. A worker starts with the environment and working directory of the client that caused it to start (§5.1).
3. **The daemon is mandatory for the TUI.** There is no in-process fallback for interactive mode. Standalone builds, Windows, and platforms without an Iroh binding run the daemon with remote transport unavailable (§7).
4. **Only the TUI changes.** Print (`-p`), JSON (`--mode json`), stdio RPC (`--mode rpc`), and SDK embedding keep hosting their runtime in-process (§8).

Rules that follow:

- A live runtime's owner never changes. Ownership handoff, draining, and the viewer feed are deleted, not reimplemented.
- There is one kind of runtime host. "TUI-owned" versus "daemon-owned" behavior disappears.

## 2. Motivation

### 2.1 Handoff bugs

Ownership transfer between the TUI process and the daemon has been the most consistent source of defects in the live-session work:

| Cluster | Examples |
|---|---|
| Stale state after a takeover | #524 (TUI holds an outdated session after a drain handoff; first prompt fails on a revision conflict), #526 (reload from the store after a handoff), #81 (a warm handoff leaves the coordinator `retired` and permanently rejects phone attaches) |
| Rekeys racing ownership | #259 (a TUI rekey breaks immediate phone reconnect through the old alias); relay-offer guard and replay fixes `8b03c4cf1`, `5d3a30d70` |
| TUI authority loss | #525, #527, #535, #536, #537, #547, #548 |
| Test infrastructure | #126 (daemon-handoff test races on the global socket path) |

The machinery behind them includes `src/daemon/lease-broker.ts` (1,604 lines), `src/modes/interactive/daemon-attach.ts` (1,294), `src/daemon/viewer-feed.ts` (236), `src/modes/interactive/drain-viewer.ts` (272), and the TLA+ models `docs/tla/LeaseBroker.tla` (563) and `docs/tla/RelayViewer.tla` (299). There is also about 170 lines of lease, drain, relay, and authority handling inside `src/modes/interactive/interactive-mode.ts`, plus the regression suites `test/suite/regressions/524-*`, `525-*`, and `537-*`.

The TUI is an owner that something else can displace. Every displacement path (drain, reacquire after a daemon reconnect, rekey, revision conflict) needs reload and authority-loss handling in a 10,130-line file that was written assuming it owns its session.

### 2.2 Behavior that depends on the owner

| Behavior | TUI-owned | Daemon-owned |
|---|---|---|
| `ctx.mode` seen by extensions | `"tui"` | `"rpc"` |
| Extension dialogs | Answered in the TUI; phones receive none (`suppressExtensionUiRequests`) | Sent to phones; iOS answers `confirm` only |
| Tool policy for phone prompts | Full local tool set; `remote.allowTools` is not a ceiling (#50) | Client grant ∩ workspace ceiling ∩ `remote.allowTools` |
| `conversation_in_use` | Never | When the runtime's tools exceed the attaching client's grant |
| Process environment | The terminal's environment | Daemon login-shell environment (`docs/daemon.md`) |
| Push and workspace commands | Forwarded to the daemon over `relay_rpc` | Executed in the daemon (a worker forwards its phones' requests over `worker_forward`) |
| Closing the TUI mid-turn | Turn is lost (RFC §1.3) | Not applicable |
| Second TUI on the same session | Read-only (`held_by_tui`) | Takes over by draining |

A session's behavior depends on which process happened to own it at that moment, and that changes as terminals open and close.

## 3. Goals and Non-Goals

### 3.1 Goals

| # | Goal |
|---|---|
| G1 | A live runtime is owned by exactly one worker for its whole lifetime. No protocol moves a live runtime between processes. |
| G2 | Conversation behavior is a function of the conversation (its spawn options and workspace authority), not of which clients are attached. |
| G3 | The TUI and the phone use the same conversation stream contract. They differ only by subscriber profile (§6.1). |
| G4 | Closing a terminal does not dispose the runtime. Any number of TUIs and phones can attach to the same conversation. |
| G5 | Ownership-transfer code is deleted: `tui-owned` and `daemon-draining` lease states, viewer feed, drain viewer, TUI relay serving, TUI reacquire and authority-loss reload. |
| G6 | `volt` with no arguments works on every supported platform and distribution, including Windows and standalone builds, with the daemon mandatory. |

### 3.2 Non-Goals

- **Changing non-interactive modes.** Print, JSON, stdio RPC, and the SDK keep in-process runtimes (§8).
- **Rendering extension TUI components in the TUI client.** No cross-process component protocol and no running extension code in the client. The remote-friendly extensions design (#552), currently a proposal, is the replacement path.
- **Migrating a turn that is in flight.** Not needed: ownership never moves.
- **Surviving a worker crash mid-turn.** If a worker dies, its in-flight turn is lost. The next attach reloads from the session store and runs the existing recovery of durable client input (`AgentSessionRuntime.startRecoveredClientInputs`).
- **Terminal remoting.** The TUI renders locally from conversation data. No virtual terminal, no forwarding of the screen.
- **Changing the phone protocol** beyond what is listed in §10.

## 4. Architecture

### 4.1 Processes

```
   +-----------+        Iroh         +--------------------------------------------+
   | iOS app   | <=================> |                   voltd                    |
   +-----------+                     |  Iroh endpoint, pairing, grants, push      |
                                     |  workspace + worktree registry             |
   +-----------+   control socket    |  WORKER REGISTRY (replaces lease transfer) |
   | volt TUI  | <-----------------> |  conversation coordinators                 |
   | (client)  |   relayed conv.     |  stream admission + byte relay             |
   +-----------+   stream            +----------------------+---------------------+
                                                            |  control socket
                                                            |  + relayed conv. streams
                                     +----------------------+---------------------+
                                     |   conversation worker (one per live        |
                                     |   conversation)                            |
                                     |  AgentSessionRuntime + ExtensionRunner     |
                                     |  tools, LSP, MCP, subagents, bash          |
                                     |  extension UI broker (§5.6)                |
                                     |  per-stream serving (phone + local         |
                                     |  profiles)                                 |
                                     +--------------------------------------------+

   volt -p / --mode json / --mode rpc / SDK: in-process runtime, unchanged (§8)
```

- **voltd** keeps everything it owns today except hosting runtimes. It supervises workers, admits conversation streams, and relays them.
- **A worker** is today's "TUI-owned runtime serving relayed streams" without the terminal. That relayed serving path already exists and is tested, which keeps this change incremental: `runIrohRemoteRpcMode` over `src/modes/interactive/relay-stream-adapter.ts`, `relay_rpc` push and workspace forwarding, and `publishGitObservation`.
- **The TUI** is a client: it owns the terminal, the editor, rendering, keybindings, and local input (clipboard, external editor, file completion).

### 4.2 Invariants

1. **One worker per conversation authority.** For each `(workspaceName, workspaceGeneration, sessionId)` at most one worker hosts a live runtime. A worker holds an exclusive per-session lock for the session it hosts (§5.2). The session store's conversation-authority fencing remains the backstop.
2. **Owners never transfer.** A conversation's runtime is created in a worker and disposed in that worker. Rekeys (§5.7) change the session identity inside the same worker; they do not move it.
3. **All conversation streams are relayed to workers.** The daemon never terminates a conversation stream against an in-process runtime. The coordinator's `"direct"` transport kind is removed; every transport is a relay.
4. **The daemon always terminates Iroh.** Workers never run an Iroh node. Phone authentication and authorization finish in the daemon before any byte reaches a worker (unchanged).
5. **The session store is the source of truth across worker lifetimes.** A new worker for a conversation loads from SQLite. Nothing is migrated in memory between workers.
6. **Workspace authority changes retire workers.** Replace, unregister, access tightening, and revoke fence the old authority and wait for worker retirement before reporting success (normative mutation protocol in the workspace authority amendment).

### 4.3 Conversation open and attach

```
client (TUI or phone) opens conversation
  -> daemon admits the stream
       phone: Iroh handshake + client authorization (unchanged)
       TUI:   local control connection, client:"tui" (§6.1)
  -> resolve target (last | new | session | fork-of) to a concrete sessionId
  -> worker registry lookup (workspaceName, workspaceGeneration, sessionId)
       live worker      -> attach-policy check (§5.5), mint relay to that worker
       no live worker   -> spawn worker (§5.1), wait for ready, mint relay
       worker starting  -> await the same spawn (concurrent opens share one worker)
       worker retiring  -> wait for retirement, then spawn
  -> byte relay: client stream <-> daemon <-> worker (existing relay-stream.ts pump)
  -> worker serves the stream with the profile for this client kind
     (phone: existing sanitized projection; TUI: local profile)
```

TUI streams go through the daemon relay rather than to a socket the worker exposes directly. Admission, attach accounting, and retirement then stay in one place (the conversation coordinator). The extra local hop is a byte copy over a unix socket or named pipe. If profiling shows that cost matters, the daemon can later hand out a direct worker endpoint without changing the conversation contract.

## 5. Conversation Workers

### 5.1 Spawn

- **Entry point.** An internal subcommand (working name `volt daemon worker`) that runs one worker. The daemon spawns it detached from any terminal, with stdio sent to a per-worker log under `daemon/`. Spawning must work in standalone builds as well as npm and source installs (§7.2).
- **Who spawns.** Always the daemon. The worker is the daemon's child, which keeps supervision, exit observation, and shutdown ordering in one place.
- **Environment and working directory.**
  - **Opened by a TUI:** the `conversation_open` request carries the TUI's full environment, its working directory, and the runtime options derived from its CLI arguments (model, thinking level, tool selection, `-e` extension paths, system prompt flags, `--approve`/`--no-approve`, session directory, `--no-session`). Sending the environment over the control socket adds no exposure: the socket is `0600`, owned by the user, and anyone who can connect can already read the agent directory (live-session RFC §11.1).
  - **Opened by a phone:** the daemon's resolved login-shell environment (`docs/daemon.md`), as for daemon-owned runtimes today.
  - **Fixed for the worker's lifetime.** A worker's environment is whatever its spawner supplied. If a phone resumes a TUI-started session after that session's worker exited, the new worker gets the daemon environment. This difference is stable, documented, and does not depend on who is currently attached.
- **Options for a live worker.** When a TUI opens a session that already has a live worker, the TUI's environment and spawn-only options are not applied:
  - Session-level options (model, thinking level, agent mode) are applied after attach as ordinary session commands.
  - Spawn-only options (`-e` extensions, tool selection, trust override) produce a TUI notice naming the ignored options.
- **Readiness.** A worker reports ready to the daemon after the runtime is bound (extensions loaded, `session_start` emitted). Opens wait for readiness.

### 5.2 Exclusivity

- A worker holds an exclusive OS-level lock for the session it hosts, using the existing lock primitives (`src/daemon/daemon-lock.ts`, `src/daemon/worktree-lock.ts`) keyed by the session's stable store identity. The OS releases it when the process exits.
- A rekey (§5.7) acquires the new session's lock before releasing the old one.
- A replacement worker cannot start until the previous worker has exited. This closes the window where an orphaned worker finishes a turn while a new worker loads the same session.
- In-process modes (§8) do not take this lock today. See open question Q4.

### 5.3 Lifetime

| State | Meaning | Transition |
|---|---|---|
| `starting` | Spawned, not yet ready | Ready, then `attached` (or `detached` if the opener disconnected); spawn failure fails the waiting opens |
| `attached` | At least one client stream | Last stream closes, then `detached` |
| `detached` | No streams; runtime live, retention timer running | Attach, then `attached`; timer fires, then `retiring` |
| `retiring` | Graceful dispose in progress | Process exits, then the entry is removed |

- **Retention** reuses `remote.detachedRuntimeTtlMs` (default 30 minutes) for every worker, whoever spawned it. A detached worker whose turn is still running is not retired until the turn ends. Unlike the current `daemon-detached` rule, nothing ever needs to abandon the turn, because no other process is waiting to own it.
- **Graceful daemon stop** (`volt daemon stop`, `volt update`). For each worker: stop admitting, `waitForIdle` with the existing 60 s cap, dispose (extension `session_shutdown` reason `"quit"`), exit. TUI clients receive `daemon_shutdown`, show a "host restarting" state, and reattach when the daemon returns.
- **Daemon loss.** When a worker's control connection drops without a shutdown:
  - It stops accepting input.
  - It lets an in-flight turn finish up to the same 60 s cap, persists, and exits.
  - A restarted daemon spawns a replacement on the next open, after the lock (§5.2) is released.
- **Worker crash.** The daemon sees the child exit and closes the worker's transports with reason `worker_exited`. Clients reattach, which spawns a fresh worker from the store.
- **Daemon restarts do not keep workers alive.** Workers never outlive their daemon. Survive-and-reregister was considered and rejected: it brings back cross-process ownership reconciliation, which is the complexity this RFC removes.

### 5.4 Daemon services used by workers

A worker keeps one control connection to the daemon (role `worker`, scoped to its conversation). Over it, the worker uses the integrations that `daemon-attach.ts` implements for TUI-owned conversations today. They move from the TUI to the worker:

- push notification delivery (`relayNotificationDelivery`), and the daemon-backed intents and queries of the worker's relayed phones (push-target registration, workspace and worktree changes, keep-awake, web search key) forwarded over `worker_forward`, with today's `relay_rpc` allowlist and scoped to the worker's own relays; `relay_rpc` as a TUI request is removed *(amended 2026-10-06)*
- workspace unregister forwarding and its retirement handshake (`createRelayWorkspaceUnregisterRetirement`)
- Git observation publishing for work and PR association (`publishGitObservation`)
- worktree context binding and checkout pinning (`setWorktreeContext`, the local control connection that pins a checkout)
- rekey reservation (`prepareRekey`), which becomes a registry rekey instead of a lease rekey

The worker also takes over the runtime-hosting duties of `src/daemon/integrated-runtimes.ts` and the runtime parts of `src/daemon/iroh-service.ts`: workflow event replay on attach, retention bookkeeping on the worker side, `onSessionChanged` rekey, `conversation-commands.ts` command handling, and abort semantics. Phase 2 (§9) produces a function-by-function disposition table for both files, as the live-session RFC's Appendix A did for `iroh-host.mjs`. "Forgotten" is not a valid disposition.

### 5.5 Tool policy

Each worker's effective tool set is fixed at spawn by its spawner:

- **Opened by a TUI:** the local tool set from settings and CLI flags, as today.
- **Opened by a phone:** the intersection of client grant, workspace ceiling, and `remote.allowTools`, as today.

Attach policy keeps both current decisions exactly. A phone attaching to a TUI-opened worker drives it with that worker's tool set, as #50 reconfirmed. A phone attaching to a phone-opened worker whose tools exceed its grant gets `conversation_in_use`. Local TUI clients can always attach.

This is the one remaining difference by origin, and it is fixed when the worker starts rather than changing with attachment. Replacing it with a single rule is open question Q1.

### 5.6 Extensions in workers

- **Mode.** Workers bind extensions with `mode: "rpc"` and `hasUI: true`. The `ExtensionMode` union drops `"tui"` once the TUI is a protocol client (architecture rewrite Phase 6), since interactive Volt no longer produces it and the rewrite keeps no compatibility paths. Extensions that need a terminal check `hasUI` and whether a host request can reach a client. *(Amended 2026-10-05: the union previously kept `"tui"` for source compatibility.)*
- **One UI broker per worker.** Today each `runRpcMode` invocation binds extensions with its own UI context (`rpc-mode.ts`, `session.bindExtensions({ uiContext: createExtensionUIContext(), mode: "rpc" })`). In a worker with several streams, that makes dialog routing depend on attach order. A worker instead binds one broker that does not depend on any transport:
  - **Dialogs** (`select`, `confirm`, `input`, `editor`) go to every attached client that has advertised support for that method. The TUI advertises all four; the iOS app advertises `confirm`. The first valid response wins, and the other clients receive a cancellation for that request id. A client never auto-cancels a method it did not advertise, so a phone cannot race a TUI dialog to a cancel.
  - **No capable client attached:** the request stays pending and is replayed to the next capable client on attach, the same way pending host actions are recovered (`get_pending_host_actions`). Dialog `timeout`/`signal` options apply unchanged.
  - **Fire-and-forget UI** (`notify`, `setStatus`, `setWorkingMessage`, `setWorkingVisible`, `setWorkingIndicator`, `setHiddenThinkingLabel`, `setTitle`, string-array `setWidget`) goes to all attached clients. The worker keeps the latest value per key and replays it on attach.
  - **Editor operations** (`setEditorText`, `pasteToEditor`) go to attached TUI clients. `getEditorText()` is synchronous and cannot reach the client, so it returns `""` (see §6.5).
- **Commands.** Local TUI clients can invoke every extension command, prompt template, and skill (`get_commands`). `remoteSafe` still gates phones only. Argument completion uses `get_ui_action_completions`.
- **Shortcuts.** `registerShortcut` is projected as data (key and command identity). The TUI binds the keys locally and invokes the handler in the worker. Handlers run with the worker's command context.
- **Flags.** `registerFlag` values come from the TUI's CLI arguments in the spawn options (§5.1).
- **Lifecycle.** Each worker runs one extension instance for its conversation. Switching conversations in the TUI (§6.3) does not dispose the worker it left, so the old conversation's extensions receive `session_shutdown` when that worker retires, not when the TUI switches away.

### 5.7 Session replacement inside a worker

Some replacements start in the runtime: an extension's `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()`, or the runtime's own rekeys. These stay in-place rekeys in the same worker, through the existing `setPrepareSessionReplacement` and coordinator alias path, and attached clients follow the `session_rekeyed` notice. Ownership is unchanged, so the rekey-versus-transfer races (#259, the relay-offer guards) cannot occur. Replacements started by a client are handled differently (§6.3).

## 6. The TUI as a Client

### 6.1 Local subscriber profile

> **Superseded by protocol 1.** The [architecture rewrite](architecture-rewrite-design.md) implemented subscriber profiles in Phase 3 (§6.1, §6.2) as protocol profiles (`src/core/protocol/profiles.ts`: `localProfile` and `remoteProfile`), served by one `serveConnection` (`src/core/protocol/server/connection.ts`) over stdio, loopback, the daemon relay, and Iroh. Both profiles share one projection (`src/core/protocol/projection/`) and the ordering of the conversation log; the remote profile's redaction, wire bounds, and intent and query admission replace the phone column below, and the local profile replaces the local column. The modules this table names (`src/core/rpc/transcript.ts`, `src/daemon/conversation-projection.ts`, `src/core/rpc/custom-message-projection.ts`, `src/core/remote/iroh/rpc-command-filter.ts`), the `ConversationProjectionFeed`, and `conversation_bootstrap` are deleted.

The worker serves each stream with a subscriber profile chosen by the daemon at admission and carried in the relay preamble:

| | Phone profile (unchanged) | Local profile (new) |
|---|---|---|
| Admission | Iroh authentication + client grant | Local control connection, `client: "tui"` |
| Events | Sanitized, bounded projection (`src/core/rpc/transcript.ts`, `src/daemon/conversation-projection.ts`) | Full `AgentSessionEvent` fidelity, as stdio RPC mode emits today |
| Tool details | Bounded previews (diff/patch limits, projected subagent fields) | Unprojected `details`, so built-in renderers work (§6.4) |
| Custom messages | Remote-visible types only (`src/core/rpc/custom-message-projection.ts`) | All custom messages |
| Path redaction | Workspace and worktree roots redacted | None |
| Commands | Iroh allowlist (`src/core/remote/iroh/rpc-command-filter.ts`), `remoteSafe` gating | Full command set, including subagent lifecycle, MCP, bash, `get_commands` |
| Extension UI | Methods advertised by the app | All dialogs, fire-and-forget UI, editor operations |
| Ordering | Snapshot-and-tail bootstrap (`conversation_bootstrap`) | Same feed, same cursor rules |

The two profiles share one `ConversationProjectionFeed` cut and ordering. Only what is projected differs.

### 6.2 Attach, bootstrap, reattach

- The TUI attaches with the snapshot-and-tail bootstrap from the conversation bootstrap RFC, using the local profile.
- Local bootstraps can exceed the remote wire limits (`src/core/rpc/wire-limits.ts`). The bootstrap carries a bounded tail of branch entries plus the active assistant and workflow state. Older history is paged after bootstrap with full-fidelity entries, using the generation-scoped paging rules that already exist for `get_transcript`.
- On stream loss (daemon restart, worker exit) the TUI keeps the transcript on screen, shows a reconnecting state, and reattaches. A new bootstrap replaces client state. The TUI never reconciles a runtime of its own, so authority-loss reload (#525, #535, #547) has no TUI counterpart.

### 6.3 Session navigation

| TUI action | New behavior |
|---|---|
| Startup, `-c`, `-r`, `--session` | `conversation_open` with target `last`, `session`, or picker selection, then attach |
| `/new` | Open target `new`, attach, detach from the previous conversation |
| `/resume`, session picker | Open the selected session, attach, detach from the previous one |
| `/fork`, `/clone` | The worker creates the new session in the store (`fork`/`clone` commands, changed to return the new session id instead of replacing in place for local clients); the TUI opens and attaches it |
| Tree navigation (same session) | In-session command in the current worker (no session id change) |
| `/reload` | In-worker reload of extensions and resources |
| Import JSONL | The worker imports into the store; the TUI attaches to the resulting session |

The previous conversation's worker is detached, not disposed, and follows retention (§5.3). The runtime-level `newSession`/`switchSession` path stays for in-process modes (§8) and for replacements started by the runtime (§5.7). Only the TUI stops using it.

### 6.4 Rendered locally

- **Built-in tool cards.** `src/modes/interactive/components/tool-execution.ts` already falls back to built-in tool definitions (`builtInToolDefinition`) and renders from `args`, the result, and `details`. Renderer state (`ToolRenderContext.state`) is created by the component, not the tool. Bash, edit, read, subagent, and background-job cards therefore render in the client from local-profile data.
- **Extension-registered tools.** Generic rendering: header with tool label and arguments, plus text result (§6.5).
- **Theme.** The TUI keeps its own `ThemeService` instance with hot reload. The worker's instance serves `ctx.ui.theme` and the existing `theme_snapshot` broadcast.
- **Editor, keybindings, clipboard, image paste, external editor (`$EDITOR`), file and `@` path completion, terminal title, and notifications** are local to the TUI. Prompt images are sent through the existing conversation input image schema.
- **Footer.** Model, context usage, git state, and attached-phone count (`📱 n`) come from the worker's state and events instead of local session getters.

### 6.5 Extension TUI surface after the change

| API | Behavior in the TUI |
|---|---|
| `select`, `confirm`, `input`, `editor` | Real TUI dialogs via the broker (§5.6) |
| `notify`, `setStatus`, `setTitle`, working indicators, string-array `setWidget` | Rendered natively by the TUI |
| `setEditorText`, `pasteToEditor` | Applied to the TUI editor |
| `getEditorText` | Returns `""` (no synchronous client round trip) |
| `custom()` | Returns `undefined`, as in RPC mode |
| `setFooter`, `setHeader`, `setEditorComponent`, component-factory `setWidget` | No-op |
| `onTerminalInput`, `addAutocompleteProvider` | No-op (handlers are functions in the worker). Argument completion for commands goes through `get_ui_action_completions` |
| `renderCall`/`renderResult` on extension tools | Not called. Generic tool rendering |
| `registerMessageRenderer` | Not called. Default custom-message rendering |
| `registerShortcut` | Works (projected as data, §5.6) |
| `getAllThemes`, `getTheme`, `setTheme` | Worker `ThemeService`. `setTheme` broadcasts `theme_snapshot`, which the TUI applies under the existing override rule |

The remote-friendly extensions design (#552) proposes the data-driven replacements (structured invocation inputs, progress, results, rendered natively by each client); it is a proposal and is not implemented. Shipping this RFC does not depend on that design. Until that design is implemented, the degraded behavior above is the supported behavior and is documented in `docs/extensions.md`.

### 6.6 Quit and detach

- Quitting the TUI detaches its stream. The worker keeps running and follows retention.
- If a turn is streaming when the user quits, the existing exit confirmation offers **Stop turn and quit** (default) or **Leave running in background**. Stop sends `abort` and waits for idle before detaching. This keeps today's expectation that quitting stops work and makes background continuation an explicit choice (Q2).
- `volt -c` / `volt -r` later reattach to a live worker, including one whose turn is still running.

### 6.7 Multiple TUIs

Any number of TUIs can attach to one conversation. Prompts from any client follow the existing `streamingBehavior` rules (`steer`/`followUp` while streaming) and appear in every client via `message_start`. `held_by_tui` and the read-only fallback are deleted.

### 6.8 Trust, settings, and credentials

- **Project trust.** The TUI resolves project trust before `conversation_open`. It runs the saved decision lookup and the built-in prompt, and passes the result as the spawn's explicit trust override, the same channel `--approve`/`--no-approve` uses. User-global and `-e` extensions that handle `project_trust` run in the worker; their dialogs reach the TUI through the broker. Ordering is detailed in Q9.
- **Settings and credentials** written by the TUI (`/settings`, `/login`, model scoping) must reach live workers. Phase 1 classifies every such write as one of:
  - a worker command (the worker writes and applies),
  - a shared-file write followed by a worker reload command, or
  - TUI-local (display-only settings).
  `AuthStorage` reloads only on refresh errors today (`src/core/auth-storage.ts`), so a new login in the TUI needs an explicit reload in attached workers.

### 6.9 Version skew

The TUI client and the worker must run the same Volt version. Workers are always spawned from the daemon's installation.

Today a control-protocol mismatch only disables the TUI's daemon integration (`daemon-attach.ts` sets its state to `"gone"`), and no package-version comparison exists. Once the daemon is mandatory, that silent degradation is no longer an option. New behavior:

- **Daemon version differs from the TUI's and the daemon is idle** (no live workers or attached streams): the TUI restarts the daemon in place, then attaches.
- **Otherwise:** the TUI refuses to attach and prints the `volt daemon restart` guidance. A mixed-version attach is never attempted.

`volt update` already stops and restarts the daemon, so in practice skew comes from source checkouts and multiple installations.

## 7. Mandatory Daemon for the TUI

### 7.1 Startup

- Interactive `volt` always calls `ensureDaemonRunning()`. The `remote.background` setting is removed. It existed to gate auto-spawn, which is now unconditional for the TUI.
- If the daemon cannot start, the TUI exits with an actionable error that includes the log path. Non-interactive modes are unaffected.
- **Idle exit.** A daemon started on demand exits when all of these hold:
  - no workers are live
  - no client is connected
  - no paired clients exist
  - it is not running under the login service
  - it has been idle for a grace period
  Users who never pair a phone then do not keep a resident daemon. The policy is in Q3.

### 7.2 Platforms and distributions

| Target | Today | Required |
|---|---|---|
| macOS / Linux, npm or source | TUI attaches when a daemon is running | Unchanged transport |
| Windows | Named pipes exist (`src/daemon/paths.ts`), but `initDaemonAttach` returns early on `win32` | Enable the TUI client on Windows; validate spawn, named-pipe ACLs, and worker spawn |
| Standalone builds (Node SEA) | `volt daemon *` is rejected because Iroh is omitted; the TUI skips the daemon (`isStandaloneBinary`) | Daemon runs with remote transport `unavailable`; spawn must re-execute the standalone binary instead of `process.execPath` + entry script (`src/daemon/spawn.ts`) |
| Darwin x64 (no Iroh binding) | Remote transport reports `native_binding_missing` | Verify the daemon and workers run with transport unavailable |

The daemon must load and serve the control plane without the Iroh native module. Remote transport is then an optional capability reported by `volt daemon status`, as `remoteTransport.state` already is.

### 7.3 Cold-start budget

A cold `volt` now does three things in sequence: start the daemon, spawn a worker, and load extensions in the worker (about 1.6 s per load in this repository, #560). Phase 3 measures time to interactive editor and time to first rendered transcript for:

- cold daemon + cold worker
- warm daemon + cold worker
- warm worker (reattach)

It then sets budgets. The TUI must render its frame and accept typing before the worker is ready. Prompts typed before readiness are queued client-side, not dropped.

### 7.4 Resource use

Each live or retained conversation is now a separate process. Phase 2 measures idle RSS per worker (see #257 for the daemon baseline). It then decides whether retention needs a cap on detached workers, such as least-recently-attached eviction (Q7).

## 8. In-Process Modes

Print, JSON, stdio RPC, and SDK embedding keep `AgentSessionRuntime` in-process with their current extension modes (`"print"`, `"json"`, `"rpc"`, or the embedder's choice). They also keep:

- the runtime session-replacement hooks they use (`setRebindSession` in `print-mode.ts` and `rpc-mode.ts`)
- the local control connection that pins a worktree checkout
- the session store's conversation-authority fencing

They do not take worker locks or register with the worker registry, so an in-process run can still open a session that a worker is hosting. Store revision fencing then decides the outcome, as it does today between the TUI and other processes. Whether in-process modes should refuse or warn in that case is Q4.

## 9. Delivery Plan

Each phase leaves `main` releasable.

### Phase 1: TUI client facade over an in-process host

- Introduce a client-side conversation interface for InteractiveMode, backed by the RPC client with the local profile. It provides a state mirror from `get_state` plus events, commands, and the extension UI broker endpoints.
- Run it against a runtime host in the TUI process (loopback transport, `src/core/rpc/loopback-transport.ts`; `InProcessRpcClient` shape).
- Replace every direct `this.session.*` and `this.runtimeHost.*` use in `interactive-mode.ts` with the client interface. Appendix A is the starting inventory; this phase produces the verified one.
- Add missing commands, events, and state fields to the schema-first RPC contract (`src/core/rpc/schema/`).
- The in-process host binds extensions in `"rpc"` mode with the broker, so the degradation in §6.5 ships here, isolated from any process change.
- Daemon integration is unchanged. The in-process host still takes TUI leases and serves relayed phone streams.

Done when InteractiveMode has no imports of `AgentSession`/`AgentSessionRuntime` beyond the host bootstrap, and the TUI regression suites pass on the client facade.

### Phase 2: Workers

- Add the worker entry point, the worker control role, the per-session lock, and the worker registry in the daemon.
- Move daemon-owned runtime hosting from `integrated-runtimes.ts` and `iroh-service.ts` into workers (disposition table required).
- Remove the coordinator `"direct"` transport.
- Phone-opened conversations now run in workers. TUI-owned leases still exist in this phase, so phone behavior for TUI-open sessions is unchanged.
- Measure worker RSS and spawn latency.

Done when every phone-originated conversation runs in a worker, phone protocol behavior is unchanged, and the daemon process hosts no `AgentSessionRuntime`.

### Phase 3: Platform readiness (parallel with Phase 2)

- Daemon without Iroh.
- Spawning the daemon and workers from standalone builds.
- Windows TUI client and worker spawn.
- Darwin x64 verification.
- Cold-start measurements and budgets (§7.3).

Done when the daemon and workers run on every target in §7.2 and cold start meets the agreed budget.

### Phase 4: The TUI attaches to workers

- The TUI calls `ensureDaemonRunning()` unconditionally and sends `conversation_open` with its environment, working directory, and spawn options. It attaches over a relayed local-profile stream.
- Session navigation per §6.3, quit per §6.6, multi-TUI per §6.7, version skew per §6.9.
- Delete:
  - the `tui-owned` and `daemon-draining` lease states, `lease_pending`, `held_by_tui`, `draining_elsewhere`
  - the viewer feed and `viewer_*` control messages
  - `drain-viewer.ts`
  - TUI relay serving and the reacquire and warm-reload paths
  - the TUI's use of the runtime replacement hooks
  - the TUI authority-loss reload paths
  - `remote.background`
- `relay-stream-adapter.ts` moves into the worker.

Done when interactive mode hosts no runtime in any configuration and the deleted code has no remaining references.

### Phase 5: Specs, tests, docs

- Replace `docs/tla/LeaseBroker.tla` and `docs/tla/RelayViewer.tla` with a smaller worker-registry model covering spawn, attach, retention, retirement, and the lock-ordered replacement in §5.2.
- Rewrite the 524, 525, and 537 regressions as worker-level tests or delete them where the scenario cannot occur.
- Update `docs/daemon.md`, `docs/extensions.md`, `docs/rpc.md`, `docs/security.md`, `docs/settings.md`, and `docs/usage.md`.
- Add banners to the superseded sections of the live-session RFC pointing here.

**Testing.** `test/suite/harness.ts` runs the agent in-process with the faux provider. Phase 1 tests run unchanged against the in-process host. Phase 2 and Phase 4 add a harness that starts a daemon on a temporary socket, spawns workers that use the faux provider, and drives a TUI client. No real provider APIs are involved.

## 10. Effects Outside the TUI

### 10.1 Phones

- Phones always attach to workers. For sessions open in a TUI, nothing visible changes.
- Phones no longer receive `lease_transferred` closures when a TUI opens or quits, or `lease_draining` errors when prompting during a TUI takeover. Neither event exists anymore.
- Extension dialogs can now reach a phone in conversations that a TUI is also attached to, limited to advertised methods (§5.6). Today TUI-owned conversations send phones none.

### 10.2 Security

- The trust boundary is unchanged: same-user socket, daemon-terminated Iroh, client grants enforced at admission.
- Tool policy is unchanged (§5.5).
- New: the client's environment crosses the control socket into a worker spawn (§5.1). It is never logged and never sent over Iroh. Worker logs record variable names only, as daemon environment logging does today.
- Audit gains `worker_spawned`, `worker_ready`, and `worker_exited{reason}`. The `lease_*` events are reduced to the remaining states.

### 10.3 volt-app

No protocol change is required. After Phase 4, the app's handling of `lease_draining` and of `lease_transferred` as a reconnect hint is dead code. File a `volt-hq/volt-app` issue to remove it, per the no-compatibility rule.

## 11. Open Questions

Each question has a proposed default. Decide before the phase listed.

| # | Question | Proposed default | Decide by |
|---|---|---|---|
| Q1 | Unify attach tool policy into one rule (worker tools must be ⊆ client grant for all remote attaches, local TUI exempt)? This would revisit #50. | Keep both current rules, fixed per worker at spawn (§5.5) | Phase 2 |
| Q2 | Default when quitting during a streaming turn | Stop the turn; leaving it running is opt-in per quit (§6.6) | Phase 4 |
| Q3 | Daemon idle exit when nothing needs it | Exit after a grace period when there are no workers, clients, paired devices, or login service (§7.1) | Phase 4 |
| Q4 | In-process modes opening a session a worker hosts | Warn when the daemon is reachable and reports a live worker; store fencing remains authoritative | Phase 4 |
| Q5 | TUI stream path | Through the daemon relay (§4.3); direct worker endpoint only if profiling requires it | Phase 4 |
| Q6 | Size of the local bootstrap tail and page | Measure in Phase 1 against large sessions; reuse remote limits as the starting point | Phase 1 |
| Q7 | Cap on detached workers | None until Phase 2 measurements show a need; then evict the least recently attached | Phase 2 |
| Q8 | Version skew when the daemon is busy | Refuse to attach with guidance (§6.9) | Phase 4 |
| Q9 | Ordering of project trust and `project_trust` extension hooks | TUI resolves saved and built-in trust first; hook dialogs go through the broker during worker startup | Phase 1 |
| Q10 | Settings and credential propagation to live workers | Classify every TUI write in Phase 1 (§6.8) | Phase 1 |

---

## Appendix A: Preliminary InteractiveMode dependency inventory

InteractiveMode uses 83 distinct `this.session.*` members (262 call sites) and 16 `this.runtimeHost.*` members. The classification below is **preliminary**: it was matched against the RPC command schema (`src/core/rpc/schema/commands.ts`) and `RpcSessionState` (`src/core/rpc/schema/session.ts`) without checking each call site. Phase 1 replaces it with a verified table.

**State mirror (`get_state` + events).** `isStreaming`, `isBusy`, `isCompacting`, `isRetrying`, `retryAttempt`, `model`, `thinkingLevel`, `agentMode`, `planningState`, `autoCompactionEnabled`, `steeringMode`, `followUpMode`, `fastModeEnabled`, `sessionId`, `pendingMessageCount`, `getSteeringMessages`, `getFollowUpMessages`, `hasBackgroundJobs`, `backgroundJobs`, `getActiveToolNames`, `getPromptCacheStatus`, `getAvailableThinkingLevels`, `activityRevision`. `RpcSessionState` already carries model, thinking level, fast mode, planning, git context, streaming, busy, and compaction flags, queue modes and queues, background jobs, active tools, active run, compaction, and retry, and prompt cache status. Check whether `retryAttempt` and `activityRevision` are covered.

**Existing commands.**

| Area | Session member | Command |
|---|---|---|
| Prompting | `prompt`, `steer`, `followUp`, `abort` | `prompt`, `steer`, `follow_up`, `abort` |
| Model | `setModel`, `cycleModel` | `set_model`, `cycle_model` |
| Thinking | `setThinkingLevel`, `cycleThinkingLevel` | `set_thinking_level`, `cycle_thinking_level` |
| Mode and plan | `setAgentMode`, `toggleAgentMode` | `set_agent_mode` |
| | `changePlan`, `discardPlan`, `executePlan` | `plan_change`, `plan_discard`, `plan_execute` |
| Compaction | `compact`, `setAutoCompactionEnabled` | `compact`, `set_auto_compaction` |
| Retry | `abortRetry` | `abort_retry` |
| Bash | `executeBash`, `abortBash` | `bash`, `abort_bash` |
| Queue modes | `setSteeringMode`, `setFollowUpMode` | `set_steering_mode`, `set_follow_up_mode` |
| Session | `setSessionName` | `set_session_name` |
| | `exportToHtml` | `export_html` |
| | `getUserMessagesForForking` | `get_fork_messages` |
| | `getSessionStats` | `get_session_stats` |
| | `getLastAssistantText` | `get_last_assistant_text` |
| | `fork` | `fork`, `clone` |
| Subagents | `getSubagentToolManager` | `subagent_*` |
| MCP | `getMcpManager` | MCP commands |
| Reviews | `reviewWorkflows`, `reviewDiscussions` | review commands |
| Commands | `promptTemplates`, extension commands | `get_commands` |

**Gaps (no command found).**

| Area | Members |
|---|---|
| Session tree | `navigateTree` (only `get_session_tree` exists) |
| Models | `scopedModels`, `setScopedModels`; most of `modelRegistry` (37 uses, including login and auth) beyond `get_available_models` |
| LSP | `getLspStatus`, `restartLspServers`, `setLspTraceFile`, `closeLspTraceSync` |
| Cancellation | `abortCompaction`, `abortBranchSummary` |
| Queue | `clearQueue` |
| Session settings | `setPersonality`, `setTransport`, `setHostInteraction`, `promptCacheSettingsChanged` |
| Introspection | `getContextUsage` (check `get_session_stats`), `getAllTools`, `getToolDefinition` (tool metadata for the tools view and for rendering), `systemPrompt`, `gitContextProvider` |
| Resources | `reload` (`/reload`), `resourceLoader` (9 uses: skills, prompt templates, themes, diagnostics) |
| Import and export | `importFromJsonl`, `exportToJsonl` |
| Settings | `settingsManager` (writes need classification per §6.8) |

**Becomes client-side or disappears.**

| Members | Disposition |
|---|---|
| `runtimeHost.newSession`, `switchSession`, `fork` | Open and attach (§6.3) |
| `runtimeHost.setRebindSession`, `setPrepareSessionReplacement`, `setBeforeSessionInvalidate`, `reloadCurrentSessionFromStore` | Removed from the TUI |
| `runtimeHost.startRecoveredClientInputs` | Worker-internal |
| `runtimeHost.conversationProjectionFeed` | The stream itself |
| `signal`, `waitForIdle` | Derived from events |
| `extensionRunner` (9 uses: shortcuts, commands, flags) | Projected per §5.6 |
| `sessionManager`, `sessionRef` | Replaced by session ids and `list_sessions` |
| `runtimeHost.services` (10 uses) | Classify in Phase 1 |

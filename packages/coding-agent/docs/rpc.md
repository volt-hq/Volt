# RPC Mode

RPC mode runs the coding agent headless and serves one client over stdin and stdout with the Volt protocol (protocol 1). Use it to embed the agent in other applications, IDEs, or custom UIs.

The client subscribes to a conversation's log by position, sends intents (prompts, aborts, model changes, session changes, ...) and queries (catalogs, history pages, content), and answers the questions extensions ask. RPC mode serves the **local profile**: every entry at full fidelity, every intent and query, and every host request the client accepts.

The same frames run in process: `createLoopbackClient(host, conversation)` serves a conversation of an SDK host on the local profile (see [SDK](sdk.md#protocol-clients)). The JSON Schema of every frame is the contract artifact `@hansjm10/volt-protocol/contract/protocol-schema.json` (`$defs` `Frame.*`, `LiveValue.*`, `ProjectedEntry.*`, `IntentInput.*`, `QueryParams.*`, `QueryResult.*`).

## Starting RPC Mode

```bash
volt --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--name <name>` / `-n <name>`: Set the session display name at startup
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Directory containing the authoritative `sessions.sqlite` store

The process ends when stdin closes, on `SIGTERM` or `SIGHUP`, when an extension calls `ctx.shutdown()`, or when the conversation loses its log (a commit the host could not confirm). The client anchors its conversation: the conversation closes, and releases its lock, when the connection ends.

## Framing

Every frame is one JSON object on one line. Lines end with LF (`\n`) only:

- split records on `\n` only, and accept `\r\n` by stripping a trailing `\r`;
- do not use line readers that also split on Unicode separators. Node `readline` splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

A line that is not a JSON object with a string `type`, or a frame that does not fit its schema, ends the connection with `fatal{code: "invalid_frame"}`.

Closing stdin is a transport event, not an abort: work the client started keeps running until the conversation closes with the process. Send the `abort` intent to stop a run.

## Connection

The client's first frame is `hello`; the host answers `welcome`:

```json
{"type":"hello","protocol":1,"client":{"name":"my-ui","version":"1.0.0"},"accepts":{"hostRequests":["select","confirm","input","editor"]}}
{"type":"welcome","protocol":1,"connectionId":"6f0c…","profile":"local","server":{"name":"volt","version":"0.2.3"},"conversation":"01990f6e-…"}
```

- `accepts.hostRequests` lists the host request kinds the client shows and answers (`select`, `confirm`, `input`, `editor`, `form`, `dialog`, `approval`, `mcp_auth`, `provider_auth`, `editor_text`, `user_input`). It is asked only those; an extension dialog no attached client accepts resolves to its default at once.
- `welcome.conversation` is the conversation the host attached the client to. Subscribe to it.
- The host attaches the client when it says hello, which binds the conversation's extensions (`session_start` runs then). The client may subscribe and answer host requests at once; its intents and queries run once the extensions are bound.
- The prompts a client sends reach extensions' `input` event with `source: "rpc"`; the TUI's connection sets `"interactive"`.

`fatal{code, message?}` ends the connection; the host closes it after the frame:

| `code` | Why |
|---|---|
| `invalid_frame` | A frame was malformed, came before `hello`, reused an active subscription id, or too many frames were pending. |
| `frame_too_large` | A frame exceeded the profile's line limit (the local profile has none). |
| `protocol_mismatch` | `hello` named another protocol version. |
| `host_shutdown` | The host is shutting down (an extension called `ctx.shutdown()`, a signal, or the daemon stopping the worker that serves the client). |
| `revoked`, `workspace_unregistered` | Remote profile only. |

## Subscriptions

```json
{"type":"subscribe","subscriptionId":"main","conversation":"01990f6e-…","after":"snapshot"}
```

A subscription streams one conversation's projected log and, unless `live: false`, its live lane.

- `after: "snapshot"`: the host sends `snapshot{ordinal: N, state}`, the client fold at the current position N, then every entry after N.
- `after: P` (resume): the host sends every entry after P the profile shows, `head` when the last of them are hidden, then a live reset. P is the newest ordinal the client saw. A position past the log is answered with a snapshot instead.
- `unsubscribe{subscriptionId}` ends it with `ended{reason: "unsubscribed"}`.

`ended{subscriptionId, reason, target?}` ends a subscription:

| `reason` | Why |
|---|---|
| `unsubscribed` | The client unsubscribed. |
| `moved` | An intent or an extension command moved the client to `target`: subscribe there. |
| `closed` | The conversation closed, or the client named one it may not read. |
| `lost` | The conversation lost its log. |
| `shutdown` | The host is shutting down. |

A client may subscribe to the conversation it is on, to another open conversation of the host, or, observe-only, to a child its conversation's work links (the work item's `child.conversation`): a subagent's conversation, or the pass a review runs now. Review passes are conversations of the host, linked by their `review` work item's `child` as a subagent's conversation is by its work. Children link at any depth through the children they link. While a child is open the subscription follows it and ends `closed` when it closes; its host requests are never asked of, or answered by, an observer. A review pass keeps no log: once it ends it cannot be read. Paired devices never observe a pass that reads the pull request text the code host provided.

A closed subagent child, at any depth (it ended, or a restart suspended it), is read from its log: `subscribe` answers a snapshot, then `ended{closed}`, and `history`, `content`, and `work_output` with its `conversation` read it too. Only the `work_*` records of the client's conversation, and of the children's logs it reaches through their `child` links, locate a closed child; the host checks that the log's header names the linking conversation as its parent, and a client never names a log by path. Each read reopens the log read-only and is charged as a replay of its length: one read per snapshot tail of entries the log holds. The local profile's reads are unbounded; the remote profile's snapshot tail is 200 entries, with 16 reads in a burst and one more every 2 seconds, and a read the budget does not cover is rejected `unavailable` with `retryAfterMs`.

### Entries and positions

Each committed log entry the profile shows arrives once as `entry{subscriptionId, entry}`. `entry.ordinal` is the log ordinal: entries are in ordinal order, and entries the profile hides leave gaps. `head{subscriptionId, ordinal}` advances the client's position over hidden entries at the end of a batch. The client's position is the newest ordinal it saw in a `snapshot`, an `entry`, or a `head`; resuming after it never repeats or misses an entry.

A projected entry is `{ordinal, id, parentId, type, timestamp, payload?, view?}`:

- `type` is a core entry type: `message`, `client_input_receipt`, `client_input_queued`, `client_input_state`, `thinking_level_change`, `fast_mode_change`, `model_change`, `planning_state_change`, `compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`, `leaf`, `forked_from`, `work_started`, `work_checkpoint`, or `work_finished`. Host product records (the starting Git context, PR review bindings) are never projected.
- `payload` is the entry's payload; the local profile sends it whole. A message entry's payload is `{message, clientMessageId?}`.
- `view` is the transcript item of a message-like entry (`message`, `compaction`, `branch_summary`, `custom_message`): `{role: user|assistant|system|tool, text, truncated, …}`. A tool item carries its `presentation` (`UiNode` data its tool's presenter returns, or the generic one), and its `text` is the presentation's title and how the call ended; a custom message whose type has a presenter carries its `presentation`. Text is bounded per entry (16,000 Unicode scalars on the local profile); `truncated` says the `content` query has the rest, and a tool result's content is fetched with the `content` query.
- `parentId`, and a `leaf` entry's `targetId`, name the nearest ancestor the profile shows.

An entry's bytes depend only on the log up to it and the profile: every subscriber of a profile receives the same entry the same way, whenever it subscribed.

### The client fold

What a client knows about the conversation is the client fold of the entries it received: `clientFold` in `@hansjm10/volt-protocol` (with `clientRestore` for a snapshot and `clientAdvance` for `head`). It derives the active leaf, the branch's model, thinking level, Fast mode, and plan state, the name, the labels, the pending client inputs (the delivery queue), fork lineage, and the conversation's work. A `leaf` entry moves the active branch; every other conversation entry becomes the leaf when appended.

A snapshot's `state` is `{leafId, entries, earlier, model, thinkingLevel, fastMode, planning, name, labels, queue, forkedFrom?, work?}`. On the local profile `entries` holds every projected entry and `earlier` is `false`.

### Work

Long-running work of a conversation is a work item: a background job (`job`), a subagent (`subagent`), a review (`review`), a host action awaiting the user's approval (`host_action`), or an extension's work (`ext:<extension>/<kind>`). Its `work_started`, `work_checkpoint`, and `work_finished` entries describe it, and the client fold's `work` holds every open item and the 64 most recently finished, each with its kind, title, state, outcome, latest checkpointed progress and detail, and result metadata (`summary`, `child`, whether it has `output`), never its input or output text.

- **States.** Open work is `awaiting_approval` (a host action), `running`, or `cancelling`; it ends `completed`, `failed`, `cancelled`, or `interrupted`. Open work with a live `work/<workId>` value runs on the host now. Open work of a resumable kind (`resume: true`, subagents) without one is suspended since a restart: it runs again only after `resume_work`, and `cancel_work` ends it. Other work a restart left open ends `interrupted` when the conversation opens again.
- **Progress.** Checkpoints are coarse (state changes, and kind phases at most every 10 seconds, at most 256 per item); the live value carries the fine-grained progress and detail (`UiNode` data) while the work runs. A checkpoint's `child` moves the item to the conversation it runs in from then on: a review checkpoints each pass as it opens, and a client follows the item's `child` to watch the review's passes and their usage.
- **Output.** `work_output` reads a work item's output by id: what running work produced so far, or what its result kept (its newest 50 KB).
- **Delivery.** A completed or failed item of a `wake` kind (jobs) queues a `work_notice` message and starts a turn when the conversation is idle; a `message` kind's notice rides the next turn instead. Notices carry the result's metadata, not its output.
- **Actions.** `cancel_work`, `open_work`, and `resume_work` act on an item as its kind allows: an item a kind does not let clients cancel is refused with `not_allowed`.

## Live lane

`live{subscriptionId, basedOn, seq, reset?, items}` frames carry what is not in the log: the streaming assistant message, running tools, the run phase, extension UI, pending host requests, and notices.

- `seq` is 1 on a frame with `reset: true` and consecutive after it. A gap means a frame was lost: resubscribe after your position.
- A frame with `reset: true` replaces the client's whole live state with its items. The first live frame of a subscription is a reset.
- **Invariant W.** A live frame is written only after every entry up to its `basedOn`: a client never sees live state ahead of the entries it builds on.
- **Streaming items** (`assistant_start`, `assistant_delta`, `assistant_end`, `tool`) build on `basedOn`. Discard them when a frame arrives with another `basedOn` (the host repeats what still streams in that frame), and when you apply the entry that commits them: an assistant message entry ends the streaming message, a tool result entry ends its tool call.
- **Keyed values** (`set{key, value}`, `clear{key}`) persist until the host clears or replaces them, or a reset. A commit never drops one.
- `patch{key, ops}` changes the node of a panel (`ext_panel/…`), the detail of a work item (`work/…`), or a shell command's output (`bash`) in place, with the `UiNode` patch operations of the contract (`replace`, `remove`, `insert`, `append_lines`). A reset carries the patched value. A patch that does not apply to the value you hold means your state diverged: resubscribe after your position.
- `notice{level, message, source?, detail?}` (`message` is styled text: a string or styled spans) and directives (`directive{directive: "set_editor_text" | "insert_editor_text", text}`, `directive{directive: "set_theme", name}`) leave no state. A notice's `source` is the extension's manifest id, or `host` for the host's own notices (a compaction that failed or was cancelled, a retry that gave up, an Anthropic subscription login that bills extra usage); `detail`, such as the stack of an extension's error, reaches local clients only. `set_editor_text` replaces the client's editor text (an extension command's `ctx.fork()` or `ctx.navigateTree()` before a user message, `ctx.abort()` returning the queued input, an extension's `setEditorText`); `insert_editor_text` pastes at the cursor. `set_theme` asks the client to show the theme `name` (an extension's `ctx.ui.setTheme`); a client that shows no themes ignores it, the TUI keeps a theme its user picked, and remote clients never receive it. A theme set after a local client's `hello` and before it subscribes (from `session_start`) reaches its first subscription.

The live fold (`foldLiveFrame`, `foldLiveCommit` in `@hansjm10/volt-protocol`) applies these rules; the host's live state is the same fold of the items it published.

Streaming items:

| Item | Meaning |
|---|---|
| `assistant_start{message}` | A streaming assistant message begins with this partial message. |
| `assistant_delta{event}` | One incremental event: `text_start`, `text_delta{delta}`, `text_end{content}`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start{id, name}`, `toolcall_delta{argsTextDelta}`, `toolcall_end{toolCall}`, each with its `contentIndex`. |
| `assistant_end` | The message finished; the entry that commits it follows. |
| `toolcall_presentation{toolCallId, presentation}` | How a tool call of the streaming message looks while its arguments stream: the host presents it as they stand, at most every 100 ms, until the call runs and its `tool` items carry its presentation. It leaves with the streaming message. Local clients only. |
| `tool{op: start|update|end, toolCallId, toolName, args?, partial?, isError?, presentation?, patch?}` | A tool execution starts (with its arguments and presentation), reports a partial result (`{content}`, replacing the previous one), or ends; its result entry follows. How the call looks is its `presentation`, which later items replace or `patch`. An MCP server call a tool makes is a tool item of its own: `toolCallId` `mcp_call:<id>`, `toolName` `mcp`, `args` `{server, tool}`, its message as `partial` (`{content: [message]}`) and its progress in its presentation; no entry commits it, so it leaves the streaming state when it ends. |

Keyed values (`value.kind` is the key's family):

| Key | Value |
|---|---|
| `phase` | `{busy, operation: turn|compaction|navigation|host|null, run?: {startedAt}, compaction?: {reason, startedAt}, retry?: {attempt, maxAttempts, retryAt?, error?}}`: the conversation's single busy state. `retry.retryAt` is when the next attempt starts after its backoff (Unix ms), and `retry.error` what failed the attempt before it. |
| `usage` | `{tokens: {input, output, cacheRead, cacheWrite, total}, cost, contextUsage?: {tokens, contextWindow, percent}}`. |
| `git` | `{gitContext}`: path-free Git metadata of the working tree, or `null`. |
| `prompt_cache` | `{promptCache}`: the current model's prompt-cache retention, or `null`. |
| `intents` | `{availability: [{name, enabled, reason?, state?}]}`: the intents whose availability and state follow the conversation (`set_fast_mode`, `set_agent_mode`, `set_auto_compaction`, `set_compaction_threshold`). |
| `work/<id>` | `{workId, progress?, detail?, output?: {bytes}}`: work this host runs (a job, subagent, review, approved host action, or extension work), set while its executor runs and cleared once it detaches; never output (`work_output` reads it). The client fold's `work` holds the items themselves. |
| `presence` | `{remote}`: how many paired remote devices are attached to the conversation. Local clients only. |
| `bash` | `{command, excludeFromContext?, output, exitCode?, cancelled?, truncated?}`: a user shell command (the `bash` intent, `!` or `!!` in the TUI), set when it starts and cleared once its `bashExecution` entry commits. `output` is a `terminal` node keyed `output` holding the newest output lines; it grows by `append_lines` patches. `exitCode` or `cancelled` is set once the command ended while its entry waits for the running turn. Local clients only. |
| `host_request/<id>` | `{requestId, request}`: a pending host request (below). |
| `ext_status/<extension id>/<name>` | `{extension, text}`: an extension's status item, styled text. |
| `ext_panel/<extension id>/<name>` | `{extension, title?, placement: aboveEditor|belowEditor|sidebar, node}`: an extension's panel of `UiNode` data (see [Extension UI](#extension-ui)). |
| `ext_title` | `{extension, title}`: the window title an extension set. |

### Extension UI

Extension status items, panels, dialogs, and forms, tool-call and custom-message presentations, and work detail are data every client renders: `UiNode` trees (`text`, `markdown`, `list`, `table`, `keyValue`, `progress`, `form`, `actions`, `card`, `diff`, `terminal`, `code`, `image`, `tree`) and styled text with semantic tokens, never ANSI. [UI Nodes](ui-nodes.md) is the reference for the node types, tokens, actions, patch operations, and limits.

- **Where it arrives.** Status items, panels, and the title are keyed live values (`ext_status/…`, `ext_panel/…`, `ext_title`); a work item's detail is the `detail` of its `work/…` value; notifications are `notice` items; dialogs and forms are host requests. A running tool call's presentation is the `presentation` of its `tool` items, which later items replace or `patch` (`{summary?, body?}`, a `UiNode` patch of each tree). A committed tool call or custom message carries its presentation in the entry's `view.presentation`.
- **Normalized on the host.** Before any client sees the data, the host converts ANSI styling to tokens, checks it against the schema, and bounds it: a panel's node holds at most 32 KB of JSON, a status item 1 KB, and a presentation 64 KB on the local profile (16 KB on the remote profile). An action or form in extension UI sends only that extension's own intents (`extension.intent.<id>.*`) and commands (`extension.command.<id>.*`), and `open_work` or `cancel_work` for its own work; the host leaves out any other.
- **Rendering.** A client draws the chrome around a presentation: the call's state, its elapsed time when `showsDuration`, collapsing between `summary` and `body`, and the result's images. Clients without a sidebar show `sidebar` panels above the editor.

## Intents

An intent frame is `{type: <intent name>, intentId, conversation?, expectedOrdinal?, input?}`. The host answers `accepted{intentId, ordinals, conversation?, result?}` or `rejected{intentId, reason: {code, message, ordinal?, requiredCapability?}}`.

```json
{"type":"prompt","intentId":"6a1f2c9e-8e3b-4a0f-9d1e-2b7c5d4e3f10","input":{"message":"Hello"}}
{"type":"accepted","intentId":"6a1f2c9e-8e3b-4a0f-9d1e-2b7c5d4e3f10","ordinals":[4,5,6]}
```

- `ordinals` are the log ordinals committed while the intent ran, its own entries included.
- `conversation` defaults to the conversation the client is on. Intents may name another open conversation of the host, except intents that move the client.
- Intents and queries run one at a time in arrival order. Input intents (`prompt`, `steer`, `follow_up`) and dynamic intents answer once admitted (once the prompt passed preflight), without holding later frames; their run's outcome is in the log.
- **Stop lane.** Stopping intents (`abort`, `abort_bash`, `abort_retry`, `cancel_work`) run as soon as they arrive, one at a time in arrival order, beside the intents and queries in progress, so a stop never waits behind a long intent such as `compact`. A client that needs an earlier intent admitted before it stops a run waits for that intent's `accepted` first. They are checked against the connection's authority and deduplicated like any other intent.
- **Activity lane.** `bash`, `compact`, and `navigate_tree` (which may summarize the branch it leaves) run as conversation activity, one at a time in a lane of their own, beside the other intents and queries: a running shell command, compaction, or branch summary never holds the frames sent after it, such as input queued meanwhile or `withdraw_queued`. Its `accepted` comes once the command, compaction, or navigation ended.
- `steer` and `follow_up` sent while a compaction or a tree navigation runs wait in the queue and are delivered once it ends.
- **Idempotency.** An input intent's `intentId` is the input's durable client message id: a retry with the same id and input answers again without delivering it twice, and the same id with other input is rejected `conflict`. The host remembers the outcomes of the last 256 other intents of each conversation: a retried `intentId` with the same input answers the same frame; with other input it is rejected `conflict`. For a client the host knows across its connections (a paired device, the TUI), that window spans the host's conversations, so an intent the client retries after it reconnected to another conversation of the host answers the same.
- **Branch fences.** An intent whose descriptor has `fence: "branch"` carrying `expectedOrdinal` (the client's position) is rejected `stale{ordinal}` when the active branch switched after that position.
- **Moves.** `new_session`, `switch_session`, `fork`, `clone`, `import_session`, `review_open_session`, and `open_work` of a review's findings open another conversation and move the client there: `accepted.conversation` names it, then the subscriptions on the conversation the client left end `moved` with that `target`. A cancelled move answers `accepted` with `result: {cancelled: true}` and keeps the client where it was. A move is refused while the conversation runs a turn, a bash command, a session mutation, or a detached review, or holds queued durable input. Extension commands that call `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()` move the client the same way. A [daemon worker](daemon.md#conversation-workers), whose clients are the interactive TUI and paired phones, redirects its clients instead: after `ended{moved, target}` it closes the connection, the conversation the client left stays open in its worker, and the client connects to `target` again through the daemon and subscribes from a snapshot. A client's own move may leave a busy conversation there. The worker knows the client across its connections by its client key, so an intent the client sends again on the new connection is answered as it was (see Idempotency).
- **Trust on a move.** A move into a project that needs a trust decision asks the local client that made it, through host requests in the conversation it leaves (the built-in prompt, and extensions' `project_trust` hooks). A client that answers no dialogs, or leaves, leaves the project untrusted; a remote client is never asked.

| `reason.code` | Meaning |
|---|---|
| `invalid_input` | The input failed its schema or a host check. |
| `unknown_intent` | No such intent on this host. |
| `not_allowed` | The profile may not invoke it (`requiredCapability` names a missing grant on the remote profile). |
| `unavailable` | Not available in this state or on this host. |
| `stale` | The branch switched after `expectedOrdinal`; `ordinal` is the switch. |
| `busy` | The conversation is busy and the intent does not queue (a prompt template or skill sent while streaming needs `streamingBehavior`). |
| `conflict` | The intent id was used for other input. |
| `locked` | Another process holds the conversation. |
| `ended` | The conversation is not open. |
| `failed` | The intent ran and failed; `message` says why. |

### Built-in intents

The Remote column says whether the remote profile (paired devices) admits the intent; fields marked *local* are refused there even when the intent is admitted. The `intents` query's descriptors carry it as `remote`, and the remote capabilities an invocation needs as `requires`.

| Intent | Input | Result | Remote |
|---|---|---|---|
| `prompt` | `{message, images?, streamingBehavior?: steer|followUp}` | | yes |
| `steer`, `follow_up` | `{message, images?}` | | yes |
| `abort` | `{withdrawQueued?, operation?: compaction|navigation}`: abort the run and cancel running work (subagents, reviews, approved host actions, and extension work whose kind restricts remote clients run on until `cancel_work`); queued input is delivered. `operation` stops only a compaction, or a tree navigation's branch summary. `withdrawQueued` (*local*) takes the queued input back before the stop instead | `{messages}` with `withdrawQueued` | yes |
| `withdraw_queued` | `{}`: take the queued steering and follow-up input back without stopping the run | `{messages: [{text, images?}]}`, steering first | no |
| `abort_retry`, `abort_bash` | `{}` | | no |
| `bash` | `{command, excludeFromContext?}`: a user shell command on the host; extensions' `user_bash` hooks see it first and may return its result or the operations it runs with; the live `bash` value shows it until its entry commits | `{output, exitCode?, cancelled, truncated, fullOutputPath?}` | no |
| `compact` | `{customInstructions?}` | the compaction result | no |
| `set_model` | `{provider, modelId, source?: set|cycle}`: this conversation's model (an entry). `source: "cycle"` says a model-cycle control stepped to it; extensions' `model_select` event carries it | | yes |
| `set_thinking_level` | `{level}`: this conversation's thinking level (an entry) | | yes |
| `set_fast_mode` | `{enabled}` | | yes |
| `set_session_name` | `{name, sessionId?}`: name the conversation, or with `sessionId` another stored session of the host | | no |
| `set_agent_mode` | `{mode: build|plan}` | | yes |
| `plan_execute` | `{planId, expectedRevision, strategy}` | `{started}` | yes |
| `plan_change`, `plan_discard` | `{planId, expectedRevision}` | | yes |
| `new_session` | `{parentSessionId?, preserveReviewRunId?, replaceReviewGeneral?, cwd?, workspaceName?, baseRef?}`: `cwd` (*local*; an existing directory) starts the session there, with `workspaceName` and `baseRef` (*local*) for its Git context | `{cancelled: true}` when cancelled | yes |
| `switch_session` | `{sessionId, cwdOverride?}`: a local client opens a stored session of any session directory `sessions` lists, a remote one only its workspace's. A session whose cwd is gone is rejected `unavailable`; `cwdOverride` (*local*) runs it in another existing directory, which the store does not keep | `{cancelled: true}` when cancelled | yes |
| `fork` | `{entryId}`: fork before a user message | `{text}` (the message, for the editor) or `{cancelled: true}` | no |
| `clone` | `{}` | `{cancelled: true}` when cancelled | no |
| `import_session` | `{path, cwdOverride?}`: open a JSONL session file as a new session and move the client there; a file whose cwd is gone is rejected `unavailable` unless `cwdOverride` names another directory | `{cancelled: true}` when cancelled | no |
| `export_html` | `{outputPath?}` | `{path}` | no |
| `export_jsonl` | `{outputPath?}`: write the active branch as a JSONL session file | `{path}` | no |
| `delete_session` | `{sessionId}`: delete a stored session of the conversation's workspace after writing its recovery snapshot; a session open in this host is rejected `unavailable`, one another process holds by its lock | `{trashed}` (whether it went to the system trash) | no |
| `navigate_tree` | `{entryId, summarize?, customInstructions?, replaceInstructions?, label?}`: move the active branch to an entry, summarizing the branch it leaves with `summarize`. Before a user message, the branch moves to its parent and `editorText` is the message's text | `{cancelled, aborted?, editorText?}`: `aborted` when `abort{operation: "navigation"}` stopped the summary, `cancelled` when an extension cancelled the move | no |
| `set_label` | `{entryId, label: string|null}`: bookmark an entry; `null` removes its label | | no |
| `reload` | `{}`: reload the conversation's extensions, skills, prompt templates, themes, and settings; rejected while a turn or a compaction runs | | no |
| `cancel_work` | `{workId}`: cancel open work, such as a background job, a review, or a subagent, suspended ones included | | yes |
| `open_work` | `{workId}`: a subagent's conversation, open or closed, to subscribe to; a finished review's findings in a new session, which moves the client | `{conversation}`, or `accepted{conversation}` for a move | yes |
| `resume_work` | `{workId}`: continue a subagent suspended since a restart | | yes |
| `start_subagent` | `{agent, prompt}`: start a subagent as work of the conversation | `{workId, conversation}` | no |
| `review` | `target` (`uncommitted`, `branch`, `branch_uncommitted`, `pr`, or `commit`; `branch_uncommitted` reviews the branch's commits and the workspace's uncommitted changes together), the fields of that target (`base?` for `branch` and `branch_uncommitted`; `number?` and `url?` for `pr`; `ref` for `commit`, required), and the review controls (`focus?`, `scope?`, `effort?`, `includeOptional?`, `scopeMode?`); a field of another target, or a commit review without `ref`, is rejected `invalid_input`; `engine?`: the review engine, `standard` (the default) or an extension's engine by its id (`ext:<extension id>/<name>`), refused `invalid_input` when the conversation does not have it or it does not review the target, and `not_allowed` for a remote client when it is not remote-safe; `engineParams?`: that engine's options by parameter name, checked against what it declares (an unknown name or invalid value is `invalid_input`, and a remote client setting a local-only one is `not_allowed`), which need an engine other than `standard`, and which `tools?` cannot be combined with; `tools?` (*local*): auxiliary tools of the conversation the passes may use besides their snapshot tools; `url?` (*local*, `pr` only): the pull request by its URL, such as the current branch's from `intent_completions`; the review fails unless the code host resolves the same one | `{workId}` | yes |
| `review_rerun`, `review_open_session`, `review_acknowledge`, `review_record_finding_outcome`, `review_publish`, `review_start_discussions`, `review_reset_discussion` | see the contract | | yes |
| `review_export_feedback` | see the contract | | no |
| `set_default_model` | `{provider, modelId}`: the default for new conversations | | yes |
| `set_default_thinking_level` | `{level}` | | yes |
| `set_steering_mode`, `set_follow_up_mode` | `{mode: all|one-at-a-time}` | | no |
| `set_auto_retry` | `{enabled}` | | no |
| `set_auto_compaction` | `{enabled, provider?, modelId?, expectedProfile?}` | | yes |
| `set_compaction_threshold` | `{tokens, provider, modelId, expectedProfile}` | | yes |
| `set_settings` | `{personality?, transport?, reviewModel?, promptCacheKeepAlive?, imageAutoResize?, blockImages?, httpIdleTimeoutMs?, enableInstallTelemetry?, warnings?: {anthropicExtraUsage?, contextTokens?}}` (a closed set, at least one key): change settings the host reads. They save where the host keeps them (globally, or in the active settings profile for the keys a profile holds) and apply to this conversation at once; other open conversations take them when they reload | | no |
| `set_profile` | `{name, create?}`: switch the settings profile (`create` makes a global one of that name first); the conversation reloads its resources and extensions, then takes the profile's model scope and default model | `{profile, created, warnings}`: what of the profile could not apply | no |
| `set_model_scope` | `{models: [{provider, modelId, thinkingLevel?}], persist?}`: the models the model-cycle control steps through, in order (none for every available model); `persist` saves them as the settings' `enabledModels` | | no |
| `lsp.restart` | `{}`: stop every running language server, shared ones included; they start again on next use | `{stopped}` | no |
| `lsp.set_trace` | `{path: string|null}`: trace language server traffic to `path` (relative to the conversation's cwd), or stop tracing | `{traceFile?}` | no |
| `auth.login` | `{provider, method: oauth|api_key}`: sign in to a provider; the host runs the provider's login and asks only the invoking client, with `provider_auth` and `input{secret: true}` host requests | `{cancelled: true}`, or `{model?, warning?}`: the model the conversation selected when it had none, and what kept it from selecting one | no |
| `auth.logout` | `{provider}`: remove the provider's stored credentials; environment variables and `models.json` stay | `{removed: oauth|api_key}` | no |
| `set_extension_enabled` | `{id, enabled, scope: global|project}`: store whether the extension with manifest id `id` runs; every open conversation starts or stops it, and this one has when the intent is accepted (a disabled extension's tools leave at the next turn boundary). `project` needs a trusted project. Enabling an extension whose permissions are not acknowledged sends the invoking client an `approval` request (`action: "enable_extension"`) and is rejected `not_allowed` unless it is approved; the remote profile is rejected without asking. Another conversation runs the extension only once its own declaration is acknowledged | | yes |
| `set_extension_settings` | `{id, scope: global|project, values}`: replace what the scope stores for the extension with manifest id `id`, whether it runs or not; values are checked against its settings, and `project` needs a trusted project | | yes |
| `mcp.connect`, `mcp.disconnect`, `mcp.refresh` | `{server}` | the server | yes |
| `mcp.set_enabled` | `{server, enabled}` | the server | yes |
| `mcp.auth_start_device`, `mcp.auth_poll`, `mcp.auth_cancel`, `mcp.logout` | `{server}` | the authorization state | yes |
| `mcp.auth_start_browser`, `mcp.auth_complete` | `{server, …}`: browser sign-in redirects to a callback on the host | the authorization state | no |

Remote-only intents (`set_keep_awake`, `set_web_search_key`, `upload_device_logs`, `register_push_target`, `unregister_workspace`, `create_worktree`, `remove_worktree`, `prepare_pr_review`) are `unavailable` in RPC mode.

**Command hints.** The `review` intent's descriptor `input` carries an `x-volt-command` keyword that says how a client reads the input as a command line, such as `/review branch main --effort high --full`, and which fields an options form offers. It is optional and advisory: a client that sends typed input, or does not know the keyword, ignores it, and it never changes which inputs the host accepts. Every name it uses is a property of the input schema, and `title`, `description`, and `default` on a property label its form field and say what it is when omitted.

| Key | Meaning |
|---|---|
| `keyword` | `{field, aliases?, positional?}`: the first word of the command sets the enum property `field`. The words are the enum values, in kebab-case (`branch-uncommitted`) or as spelled; `aliases` maps other words to values (`unstaged` and `working` mean `uncommitted`). `positional` maps a value to the property the next word sets (`branch` sets `base`, `pr` sets `number`, `commit` sets `ref`) when that word does not start with `--`. |
| `flagValues` | Enum properties set by a bare flag per value (`--incremental`, `--full`) instead of `--name value`. |
| `lists` | String properties that hold a comma-separated list: the flag may repeat, and entries are trimmed and de-duplicated. |
| `form` | The properties a client offers as flags and in an options form, in order. A flag is `--kebab-case-name value` or `--kebab-case-name=value`, and a boolean is a bare flag. A property that is not listed (`tools`, `url`) is not a flag. |

### Dynamic intents

Extension commands, prompt templates, and skills are intents named `extension.command.<extension id>.<command>`, `prompt.template.<id>`, and `skill.<id>`, with input `{arguments?, streamingBehavior?}`. An extension command's name stays the same while its extension keeps its manifest id; prompt template and skill ids are opaque. The `intents` query lists them with their ids, labels, and sources. Invoking one sends its slash text as a prompt. A prompt whose text starts with `/` runs an extension command of that name too.

Intents an extension registers are named `extension.intent.<extension id>.<name>`; their input is a JSON object the host checks against the schema in the intent's descriptor. The remote profile reaches only those whose extension opted in, with `conversation.control.v1` and the capabilities their descriptor `requires`.

## Queries

A query frame is `{type: "query", queryId, query, conversation?, params?}`; the host answers `result{queryId, data}` or `query_error{queryId, reason: {code, message}}` (`invalid_input`, `unknown_query`, `not_allowed`, `unavailable`, `failed`).

Remote says whether the remote profile admits the query; fields marked *local* reach local clients only.

| Query | Params | Result | Remote |
|---|---|---|---|
| `intents` | | `{intents, shortcuts, completionTriggers}`: every intent's descriptor (input schema, scope, fence, remote safety, required capabilities, availability, state, slash alias, completable fields), the keys extensions' shortcuts bind (`[{key, intent, description?}]`, invoked with no input; a client may override them in its own keybindings), and the characters that start a token `editor_completions` completes. | yes |
| `intent_completions` | `{intent, field, prefix?}` | `{completions: [{value, label?, description?}]}` for one input field: `review.base`, `review.ref`, `review.number` (the current branch's pull request), `review.url` (*local*; the same pull request by its URL), and an extension command's `arguments`. | yes |
| `editor_completions` | `{text, cursor}` | `{prefix, items (≤ 50)}`: completions from the extensions' completion providers for the token ending at `cursor` (in Unicode scalars); `items` replace `prefix`. The host waits at most one second; the remote profile asks only providers that opted in. | yes |
| `history` | `{before, limit (≤ 200), branch?}` | `{entries, earlier}`: projected entries before ordinal `before`, newest last; with `branch`, the path from the root to that entry. Entries are projected exactly as the subscription sends them. | yes |
| `content` | `{entryId, part?, offset?}` | `{entryId, part, parts, content}`: one text, thinking, or image block of an entry in full. Text comes in chunks of up to 12,000 Unicode scalars from `offset`, with `nextOffset` and `totalScalars`. | yes |
| `models` | | `{models, cycleScope}`: the selectable models (each with `auth?: oauth|api_key`, how its provider authenticates) and the models the model-cycle control steps through, `[{provider, modelId, thinkingLevel?}]`. | yes |
| `sessions` | `{limit?, cursor?, scope?: workspace|all, search?}` | `{sessions, hasMore, nextCursor}`: stored sessions, newest first; `cursor` is the `nextCursor` of the previous page. `scope: "all"` (*local*) lists every session directory of the host, `search` (*local*) keeps the sessions whose text matches. Items carry `cwd`, `parentSessionId`, and `sessionDir` (*local*). | yes |
| `settings` | | `{steeringMode, followUpMode, autoCompaction, autoRetry, profile}`, and (*local*) `compactionThresholdTokens`, `profiles`, and the `set_settings` keys (`personality`, `transport`, `reviewModel`, `promptCacheKeepAlive`, `imageAutoResize`, `blockImages`, `httpIdleTimeoutMs`, `enableInstallTelemetry`, `warnings`). `profile` is the active settings profile (`""` without one), which the compaction intents name as `expectedProfile`. | yes |
| `subscription_usage` | | Subscription quota usage of stored logins. | yes |
| `extensions` | | `{extensions}`: every extension of the conversation, running or not: `{id, displayName, description?, version, scope, enabled, state, permissions, permissionsAcknowledged, hasSettings, error?, fingerprint?}`, where `state` is `active`, `disabled`, `failed` (with `error`), `activating`, or `deactivating`, and `fingerprint` (*local*) is the code revision its permission acknowledgment records. | yes |
| `extension_settings` | `{id}` | `{form, values: {global, project?}, projectTrusted}`: the extension's settings as form fields (each `value` its default) and the values each scope stores; `project` only for a trusted project. | yes |
| `subagent_definitions` | | Discovered subagent definitions. | no |
| `work_output` | `{workId, offset?}` | A work item's output, such as a background job's: what it produced so far, or what its result kept, in chunks. | yes |
| `conversation_info` | | `{id, cwd, projectTrusted, sessionDir, sessionFile?, persisted, defaultSessionDir, parentSessionId?}`: where the conversation's log lives (`sessionFile` only when it is stored; `defaultSessionDir` when `sessionDir` is the cwd's default), and whether the project at `cwd` is trusted, so its `.volt` settings, resources, and packages load. | no |
| `resources` | | `{skills, promptTemplates, themes, extensions, contextFiles, diagnostics, notices}`: what the conversation loaded, with paths and sources (a built-in theme has no path), what loading it reported (collisions, extensions that failed to load, commands and shortcuts they could not register), and its setup's notices (a model it fell back from, a `models.json` it could not read, an Anthropic subscription login that bills extra usage). Refetched on `changed{resources}`. | no |
| `tools` | | `{tools: [{name, description, source, active}]}`: the tools the conversation can offer the model and which it offers now; `source` is `builtin`, `custom` (an SDK tool), or the extension's scope and source. | no |
| `lsp.status` | | `{enabled, workspaceRoot?, servers, traceFile?}`: the conversation's language servers, as a snapshot that starts and installs nothing. | no |
| `auth.providers` | | `{providers: [{id, name, oauth, apiKey, configured, source?, label?, stored?}]}`: the providers `auth.login` signs in to, and how their requests authenticate now (`source` names where credentials come from, `label` what names it, such as an environment variable); never a credential. | no |
| `debug_report` | | `{path}`: save a diagnostic capture of the conversation's recent tool calls (argument samples, with credentials redacted) and name the file. | no |
| `mcp.capabilities`, `mcp.servers`, `mcp.server`, `mcp.tools`, `mcp.tool`, `mcp.resources`, `mcp.resource`, `mcp.prompts`, `mcp.prompt`, `mcp.recent_calls` | see the contract | MCP catalogs and reads. | yes |
| `review.discussions`, `review.discussion_source`, `review.general`, `review.result`, `review.runs` | see the contract | Durable review reads; `review.runs` pages the conversation's review runs. | yes |

`changed{catalog}` tells the client to refetch a catalog: `models` when logins or API keys change on disk, or after `set_model_scope`, `set_profile`, `auth.login`, or `auth.logout`; `settings` after a settings intent (`set_settings`, `set_profile`, `set_model_scope`, and the queue, retry, and compaction setters) or when any client, extension, or conversation saves extension settings; `mcp` when MCP servers change; `sessions` when the conversation's name changes, after `set_session_name` or `delete_session`, or when an intent moved the client to another conversation; `intents` and `extensions` after the conversation's extensions, prompt templates, and skills reload, or an extension is enabled, disabled, or changes state; `resources` (local profile) after they reload, for the `resources` and `tools` queries; and `host` (remote profile) when the host's keep-awake state, web search key, or shared theme changes. A catalog an intent changed is announced to the client that sent it.

## Host requests

Dialogs, forms, approvals, and sign-ins the host asks are keyed live values `host_request/<requestId>` until they end. They reach the clients that accept their kind, and any of them may answer, except requests the host asks of one client only (named below):

```json
{"type":"host_response","requestId":"0b7e…","response":{"confirmed":true}}
```

| `request.kind` | Fields | Answer |
|---|---|---|
| `select` | `title, options, timeoutMs?` | `{value}` (one of `options`) |
| `confirm` | `title, message, timeoutMs?` | `{confirmed}` |
| `input` | `title, placeholder?, secret?, timeoutMs?`: with `secret` (an API key `auth.login` asks), the client masks what the user types and keeps it out of any history; asked only of the client that invoked the login, and never sent to a remote client | `{value}` |
| `editor` | `title, prefill?` | `{value}` |
| `form` | `title, fields, timeoutMs?` | `{values}` |
| `dialog` | `title, body (UiNode[]), actions: [{id, label, token?, destructive?}], timeoutMs?` | `{value}` (an action id) |
| `editor_text` | `timeoutMs?`: asked only of the client whose request is running, or of the first attached client | `{value}`: the client's editor text, without asking the user |
| `user_input` | `questions: [{id, header, question, options: [{label, description}]}]` (one to three questions, two or three options each): the `request_user_input` tool's preference questions. Offer a free-form answer and skipping beside the options; there is no timeout | `{status: "answered", answers: {<id>: {answers}}}` for every question, where `answers` is a chosen label, optionally followed by the user's notes, or the user's own answer; or `{status: "skipped", answers: {}}`. `{cancelled: true}` stops the run |
| `approval` | `action, title, message?, commandPreview?, blocking?, destructive?, …`: a host action, such as an LSP server install, whose `requestId` is its `host_action` work id; or (`action: "enable_extension"`) acknowledging the permissions of an extension being enabled, asked only of the client that enables it | `{decision: approved|denied|dismissed, message?}` |
| `mcp_auth` | `server, flow, authorizationUrl?, userCode?, …` | completes through the `mcp.auth_*` intents |
| `provider_auth` | `provider, flow: browser|device|manual, url?, userCode?, instructions?`: a provider sign-in `auth.login` started, waiting for the user: open `url` and sign in (`browser`), enter `userCode` at `url` (`device`), or open `url`, then paste the redirect URL or code it shows (`manual`, unless the host receives it first). Asked only of the client that invoked the login, and never sent to a remote client; the host ends it when the sign-in ends | `{value}` for `manual`; `{cancelled: true}` cancels the sign-in |

Every kind may be answered `{cancelled: true}`. The first valid answer wins; the request is cleared and later answers are ignored. A host action is `host_action` work awaiting approval: `approved` runs it; any other answer, its timeout, or `cancel_work` finishes it `cancelled` without running, and one still awaiting approval when its conversation closes or its host stops ends `interrupted` (on the next open, after a crash). On the remote profile, approving or cancelling a host action, or reading its output with `work_output`, needs `host.manage.v1`. A request outlives the clients that saw it: a client that subscribes later, or resubscribes, finds it in its live reset. It ends when answered, when its timeout expires (the host then resolves the default), or when its conversation closes.

## Extensions in RPC mode

`ctx.mode` is `"rpc"` and `ctx.hasUI` is `true`. The data-only UI reaches the client through the live lane:

- `select`, `confirm`, `input`, `editor`, `dialog`, `form`, and `getEditorText()` (`editor_text`) are host requests;
- `notify` is a `notice` whose `source` is the extension's manifest id; `setStatus`, `setPanel`, and `setTitle` are keyed values; `setEditorText` and `pasteToEditor` are `set_editor_text` and `insert_editor_text` directives, and `setTheme` a `set_theme` directive;
- tool calls carry the presentations of their tools' `present()`, custom messages those of their types' message presenters, and extension work the detail its kind presents;
- the extension's intents and commands are [dynamic intents](#dynamic-intents), its completion providers answer the `editor_completions` query, and its shortcuts are TUI keybindings of its intents;
- extension errors are `notice{level: "error", message: "<event>: <error>", source: <extension id>, detail?}`, with the error's stack as `detail` for local clients;
- a command a client invokes sees `ctx.invokedBy`: `"local"` for a local client such as an RPC client, `"remote"` for a paired device;
- `ctx.abort()` in a command a local client with an editor invoked (it accepts `editor_text` and is subscribed to the conversation's live lane) takes the queued input back, stops the run, and returns the input's text to that client as a `set_editor_text` directive ahead of the draft its `editor_text` answer reports (an `insert_editor_text` directive when it reports none); otherwise the run stops and the queue stays;
- the `bash` intent's command reaches extensions' `user_bash` hook first, which may return its result or the operations it runs with.

`getAllThemes()` lists the host's themes (built-in, the user's, and the ones the conversation loaded), and `setTheme()` fails for any other name. The `request_user_input` tool is offered to the model while an attached client accepts `user_input` host requests.

## Example session

```text
→ {"type":"hello","protocol":1,"client":{"name":"example","version":"1"},"accepts":{"hostRequests":["confirm"]}}
← {"type":"welcome","protocol":1,"connectionId":"c1","profile":"local","server":{"name":"volt","version":"0.2.3"},"conversation":"s1"}
→ {"type":"subscribe","subscriptionId":"main","conversation":"s1","after":"snapshot"}
← {"type":"snapshot","subscriptionId":"main","conversation":"s1","ordinal":3,"state":{"leafId":"a1","entries":[…],"earlier":false,…}}
← {"type":"live","subscriptionId":"main","basedOn":3,"seq":1,"reset":true,"items":[{"type":"set","key":"phase","value":{"kind":"phase","busy":false,"operation":null}},…]}
→ {"type":"prompt","intentId":"p1","input":{"message":"Hello"}}
← {"type":"entry","subscriptionId":"main","entry":{"ordinal":4,"type":"client_input_receipt",…}}
← {"type":"live","subscriptionId":"main","basedOn":4,"seq":2,"items":[{"type":"set","key":"phase","value":{"kind":"phase","busy":true,"operation":"turn",…}}]}
← {"type":"entry","subscriptionId":"main","entry":{"ordinal":6,"type":"message","view":{"role":"user","text":"Hello",…},…}}
← {"type":"accepted","intentId":"p1","ordinals":[4,5,6]}
← {"type":"live","subscriptionId":"main","basedOn":6,"seq":3,"items":[{"type":"assistant_start","message":{…}}]}
← {"type":"live","subscriptionId":"main","basedOn":6,"seq":4,"items":[{"type":"assistant_delta","event":{"type":"text_delta","contentIndex":0,"delta":"Hi!"}}]}
← {"type":"entry","subscriptionId":"main","entry":{"ordinal":7,"type":"message","view":{"role":"assistant","text":"Hi!",…},…}}
← {"type":"live","subscriptionId":"main","basedOn":7,"seq":5,"items":[{"type":"set","key":"phase","value":{"kind":"phase","busy":false,"operation":null}}]}
```

A client that reconnects says hello again and subscribes with `after` set to the newest ordinal it saw (7 above); it receives what it missed and a live reset.

## Clients

TypeScript clients use `ProtocolClient` from `@hansjm10/volt-coding-agent`. It says hello, subscribes, keeps the client fold and the live fold, follows moves, resubscribes on a live gap, and resumes on `connect` after a disconnect:

```typescript
import { spawnRpcClient } from "@hansjm10/volt-coding-agent";

const client = await spawnRpcClient({ args: ["--no-session"], hostRequests: ["confirm"] });
client.onFrame((frame) => {
	if (frame.type !== "live") return;
	for (const item of frame.items) {
		if (item.type === "assistant_delta" && item.event.type === "text_delta") process.stdout.write(item.event.delta);
	}
});
await client.promptAndWait("List the files here");
console.log(client.state.entries.length, client.phase?.busy);
await client.stop();
```

`client.intent(name, input)` and `client.query(name, params)` send any intent or query; `client.answer(requestId, response)` answers a host request; `client.waitForIdle()` resolves once no operation runs and no input is pending. [`test/rpc-example.ts`](../test/rpc-example.ts) is an interactive example, and [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts), with the [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) extension, shows a raw-frame client that answers extension dialogs.

A minimal Python client:

```python
import json
import subprocess
import uuid

proc = subprocess.Popen(["volt", "--mode", "rpc", "--no-session"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

def send(frame):
    proc.stdin.write(json.dumps(frame) + "\n")
    proc.stdin.flush()

def frames():
    for line in proc.stdout:
        yield json.loads(line)

send({"type": "hello", "protocol": 1, "client": {"name": "py", "version": "1"}, "accepts": {"hostRequests": []}})
stream = frames()
welcome = next(stream)
send({"type": "subscribe", "subscriptionId": "main", "conversation": welcome["conversation"], "after": "snapshot"})
send({"type": "prompt", "intentId": str(uuid.uuid4()), "input": {"message": "Hello!"}})

busy = False
for frame in stream:
    if frame["type"] != "live":
        continue
    for item in frame["items"]:
        if item["type"] == "assistant_delta" and item["event"]["type"] == "text_delta":
            print(item["event"]["delta"], end="", flush=True)
        if item["type"] == "set" and item["key"] == "phase":
            if item["value"]["busy"]:
                busy = True
            elif busy:
                print()
                proc.stdin.close()
                raise SystemExit(0)
```

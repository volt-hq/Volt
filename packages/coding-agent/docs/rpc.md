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

- `accepts.hostRequests` lists the host request kinds the client shows and answers (`select`, `confirm`, `input`, `editor`, `form`, `approval`, `mcp_auth`). It is asked only those; an extension dialog no attached client accepts resolves to its default at once.
- `welcome.conversation` is the conversation the host attached the client to. Subscribe to it.
- The host attaches the client when it says hello, which binds the conversation's extensions (`session_start` runs then). The client may subscribe and answer host requests at once; its intents and queries run once the extensions are bound.

`fatal{code, message?}` ends the connection; the host closes it after the frame:

| `code` | Why |
|---|---|
| `invalid_frame` | A frame was malformed, came before `hello`, reused an active subscription id, or too many frames were pending. |
| `frame_too_large` | A frame exceeded the profile's line limit (the local profile has none). |
| `protocol_mismatch` | `hello` named another protocol version. |
| `host_shutdown` | The host is shutting down (an extension called `ctx.shutdown()`, or a signal). |
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

A client may subscribe to the conversation it is on, to another open conversation of the host, or to the conversation of a subagent it started (`subagent_start`).

### Entries and positions

Each committed log entry the profile shows arrives once as `entry{subscriptionId, entry}`. `entry.ordinal` is the log ordinal: entries are in ordinal order, and entries the profile hides leave gaps. `head{subscriptionId, ordinal}` advances the client's position over hidden entries at the end of a batch. The client's position is the newest ordinal it saw in a `snapshot`, an `entry`, or a `head`; resuming after it never repeats or misses an entry.

A projected entry is `{ordinal, id, parentId, type, timestamp, payload?, view?}`:

- `type` is a core entry type: `message`, `client_input_receipt`, `client_input_queued`, `client_input_state`, `thinking_level_change`, `fast_mode_change`, `model_change`, `planning_state_change`, `compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`, `leaf`, `subagent_spawn`, or `forked_from`. Host product records (the starting Git context, PR review bindings) are never projected.
- `payload` is the entry's payload; the local profile sends it whole. A message entry's payload is `{message, clientMessageId?}`.
- `view` is the transcript item of a message-like entry (`message`, `compaction`, `branch_summary`, `custom_message`): `{role: user|assistant|system|tool, text, truncated, …}`, with tool calls' bounded arguments, summaries, output, and diff and patch previews. Text is bounded per entry (16,000 Unicode scalars on the local profile); `truncated` says the `content` query has the rest.
- `parentId`, and a `leaf` entry's `targetId`, name the nearest ancestor the profile shows.

An entry's bytes depend only on the log up to it and the profile: every subscriber of a profile receives the same entry the same way, whenever it subscribed.

### The client fold

What a client knows about the conversation is the client fold of the entries it received: `clientFold` in `@hansjm10/volt-protocol` (with `clientRestore` for a snapshot and `clientAdvance` for `head`). It derives the active leaf, the branch's model, thinking level, Fast mode, and plan state, the name, the labels, the pending client inputs (the delivery queue), and fork lineage. A `leaf` entry moves the active branch; every other conversation entry becomes the leaf when appended.

A snapshot's `state` is `{leafId, entries, earlier, model, thinkingLevel, fastMode, planning, name, labels, queue, forkedFrom?}`. On the local profile `entries` holds every projected entry and `earlier` is `false`.

## Live lane

`live{subscriptionId, basedOn, seq, reset?, items}` frames carry what is not in the log: the streaming assistant message, running tools, the run phase, extension UI, pending host requests, and notices.

- `seq` is 1 on a frame with `reset: true` and consecutive after it. A gap means a frame was lost: resubscribe after your position.
- A frame with `reset: true` replaces the client's whole live state with its items. The first live frame of a subscription is a reset.
- **Invariant W.** A live frame is written only after every entry up to its `basedOn`: a client never sees live state ahead of the entries it builds on.
- **Streaming items** (`assistant_start`, `assistant_delta`, `assistant_end`, `tool`) build on `basedOn`. Discard them when a frame arrives with another `basedOn` (the host repeats what still streams in that frame), and when you apply the entry that commits them: an assistant message entry ends the streaming message, a tool result entry ends its tool call.
- **Keyed values** (`set{key, value}`, `clear{key}`) persist until the host clears or replaces them, or a reset. A commit never drops one.
- `notice{level, message, source?}` and `directive{directive: "set_editor_text", text}` leave no state.

The live fold (`foldLiveFrame`, `foldLiveCommit` in `@hansjm10/volt-coding-agent`) applies these rules; the host's live state is the same fold of the items it published.

Streaming items:

| Item | Meaning |
|---|---|
| `assistant_start{message}` | A streaming assistant message begins with this partial message. |
| `assistant_delta{event}` | One incremental event: `text_start`, `text_delta{delta}`, `text_end{content}`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start{id, name}`, `toolcall_delta{argsTextDelta}`, `toolcall_end{toolCall}`, each with its `contentIndex`. |
| `assistant_end` | The message finished; the entry that commits it follows. |
| `tool{op: start|update|end, toolCallId, toolName, args?, partial?, isError?}` | A tool execution starts (with its arguments), reports a partial result (`{content, details?}`, replacing the previous one), or ends; its result entry follows. An MCP server call a tool makes is a tool item of its own: `toolCallId` `mcp_call:<id>`, `toolName` `mcp`, `args` `{server, tool}`, progress as `partial` (`{content: [message], details: {progress, total?}}`); no entry commits it, so it leaves the streaming state when it ends. |

Keyed values (`value.kind` is the key's family):

| Key | Value |
|---|---|
| `phase` | `{busy, operation: turn|compaction|navigation|host|null, run?: {startedAt}, compaction?: {reason, startedAt}, retry?: {attempt, maxAttempts}}`: the conversation's single busy state. |
| `usage` | `{tokens: {input, output, cacheRead, cacheWrite, total}, cost, contextUsage?: {tokens, contextWindow, percent}}`. |
| `git` | `{gitContext}`: path-free Git metadata of the working tree, or `null`. |
| `prompt_cache` | `{promptCache}`: the current model's prompt-cache retention, or `null`. |
| `intents` | `{availability: [{name, enabled, reason?, state?}]}`: the intents whose availability and state follow the conversation (`set_fast_mode`, `set_agent_mode`, `set_auto_compaction`, `set_compaction_threshold`). |
| `work/<id>` | `{workId, progress?, detail?, output?: {bytes}}`: work this host runs, such as a background job or an approved host action, set while its executor runs and cleared once it detaches; never output (`work_output` reads it). The client fold's `work` holds the items themselves. |
| `workflow/<id>` | `{event, activeTools}`: a detached review workflow's latest event and running tools; cleared after its end. |
| `subagent/<id>` | `{subagentId, conversation, agent?, status, error?}`: a subagent this client started. Subscribe to `conversation` for its log. |
| `host_request/<id>` | `{requestId, request}`: a pending host request (below). |
| `ext_status/<key>`, `ext_widget/<key>`, `ext_title` | Extension status lines, string widgets (`{lines, placement}`), and the window title. |

## Intents

An intent frame is `{type: <intent name>, intentId, conversation?, expectedOrdinal?, input?}`. The host answers `accepted{intentId, ordinals, conversation?, result?}` or `rejected{intentId, reason: {code, message, ordinal?, requiredCapability?}}`.

```json
{"type":"prompt","intentId":"6a1f2c9e-8e3b-4a0f-9d1e-2b7c5d4e3f10","input":{"message":"Hello"}}
{"type":"accepted","intentId":"6a1f2c9e-8e3b-4a0f-9d1e-2b7c5d4e3f10","ordinals":[4,5,6]}
```

- `ordinals` are the log ordinals committed while the intent ran, its own entries included.
- `conversation` defaults to the conversation the client is on. Intents may name another open conversation of the host, except intents that move the client.
- Intents and queries run one at a time in arrival order. Input intents (`prompt`, `steer`, `follow_up`) and dynamic intents answer once admitted (once the prompt passed preflight), without holding later frames; their run's outcome is in the log.
- **Idempotency.** An input intent's `intentId` is the input's durable client message id: a retry with the same id and input answers again without delivering it twice, and the same id with other input is rejected `conflict`. The host remembers the outcomes of the last 256 other intents of each conversation: a retried `intentId` with the same input answers the same frame; with other input it is rejected `conflict`.
- **Branch fences.** An intent whose descriptor has `fence: "branch"` carrying `expectedOrdinal` (the client's position) is rejected `stale{ordinal}` when the active branch switched after that position.
- **Moves.** `new_session`, `switch_session`, `fork`, `clone`, and `review_open_session` open another conversation and move the client there: `accepted.conversation` names it, then the subscriptions on the conversation the client left end `moved` with that `target`. A cancelled move answers `accepted` with `result: {cancelled: true}` and keeps the client where it was. A move is refused while the conversation runs a turn, a bash command, a session mutation, or a detached review, or holds queued durable input. Extension commands that call `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()` move the client the same way.

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

| Intent | Input | Result |
|---|---|---|
| `prompt` | `{message, images?, streamingBehavior?: steer|followUp}` | |
| `steer`, `follow_up` | `{message, images?}` | |
| `abort` | `{}`: abort the run and cancel running work; queued input is delivered | |
| `abort_retry`, `abort_bash` | `{}` | |
| `bash` | `{command, excludeFromContext?}` | `{output, exitCode?, cancelled, truncated, fullOutputPath?}` |
| `compact` | `{customInstructions?}` | the compaction result |
| `set_model` | `{provider, modelId}`: this conversation's model (an entry) | |
| `set_thinking_level` | `{level}`: this conversation's thinking level (an entry) | |
| `set_fast_mode` | `{enabled}` | |
| `set_session_name` | `{name}` | |
| `set_agent_mode` | `{mode: build|plan}` | |
| `plan_execute` | `{planId, expectedRevision, strategy}` | `{started}` |
| `plan_change`, `plan_discard` | `{planId, expectedRevision}` | |
| `new_session` | `{parentSessionId?, preserveReviewRunId?, replaceReviewGeneral?}` | `{cancelled: true}` when cancelled |
| `switch_session` | `{sessionId}` | `{cancelled: true}` when cancelled |
| `fork` | `{entryId}`: fork before a user message | `{text}` (the message, for the editor) or `{cancelled: true}` |
| `clone` | `{}` | `{cancelled: true}` when cancelled |
| `export_html` | `{outputPath?}` | `{path}` |
| `cancel_work` | `{workId}`: cancel open work, such as a background job | |
| `subagent_start` | `{agent, prompt}` | `{subagentId, conversation}` |
| `subagent_abort`, `subagent_dispose` | `{subagentId}` | |
| `review_uncommitted`, `review_branch`, `review_pr`, `review_commit` | review target and controls | `{workflowId}` |
| `review_rerun`, `review_cancel_workflow`, `review_open_session`, `review_acknowledge`, `review_record_finding_outcome`, `review_publish`, `review_export_feedback`, `review_start_discussions`, `review_reset_discussion` | see the contract | |
| `set_default_model` | `{provider, modelId}`: the default for new conversations | |
| `set_default_thinking_level` | `{level}` | |
| `set_steering_mode`, `set_follow_up_mode` | `{mode: all|one-at-a-time}` | |
| `set_auto_retry` | `{enabled}` | |
| `set_auto_compaction` | `{enabled, provider?, modelId?, expectedProfile?}` | |
| `set_compaction_threshold` | `{tokens, provider, modelId, expectedProfile}` | |
| `mcp.connect`, `mcp.disconnect`, `mcp.refresh` | `{server}` | the server |
| `mcp.set_enabled` | `{server, enabled}` | the server |
| `mcp.auth_start_device`, `mcp.auth_start_browser`, `mcp.auth_complete`, `mcp.auth_poll`, `mcp.auth_cancel`, `mcp.logout` | `{server, …}` | the authorization state |

Remote-only intents (`set_keep_awake`, `set_web_search_key`, `upload_device_logs`, `register_push_target`, `unregister_workspace`, `create_worktree`, `remove_worktree`, `prepare_pr_review`) are `unavailable` in RPC mode.

### Dynamic intents

Extension commands, prompt templates, and skills are intents named `extension.command.<id>`, `prompt.template.<id>`, and `skill.<id>`, with input `{arguments?, streamingBehavior?}`. The `intents` query lists them with their ids, labels, and sources. Invoking one sends its slash text as a prompt. A prompt whose text starts with `/` runs an extension command of that name too.

## Queries

A query frame is `{type: "query", queryId, query, conversation?, params?}`; the host answers `result{queryId, data}` or `query_error{queryId, reason: {code, message}}` (`invalid_input`, `unknown_query`, `not_allowed`, `unavailable`, `failed`).

| Query | Params | Result |
|---|---|---|
| `intents` | | Every intent's descriptor: input schema, scope, fence, remote safety, required capabilities, availability, state, slash alias. |
| `intent_completions` | `{intent, field, prefix?}` | Completions for one input field. |
| `history` | `{before, limit (≤ 200), branch?}` | `{entries, earlier}`: projected entries before ordinal `before`, newest last; with `branch`, the path from the root to that entry. Entries are projected exactly as the subscription sends them. |
| `content` | `{entryId, part?, offset?}` | `{entryId, part, parts, content}`: one text, thinking, or image block of an entry in full. Text comes in chunks of up to 12,000 Unicode scalars from `offset`, with `nextOffset` and `totalScalars`. |
| `models` | | `{models, cycleScope}`. |
| `sessions` | `{limit?, cursor?}` | The workspace's stored sessions, newest first; `cursor` is the `nextCursor` of the previous page. |
| `settings` | | `{steeringMode, followUpMode, autoCompaction, autoRetry, profile}`; `profile` is the active settings profile (`""` without one), which the compaction intents name as `expectedProfile`. |
| `subscription_usage` | | Subscription quota usage of stored logins. |
| `subagent_definitions` | | Discovered subagent definitions. |
| `work_output` | `{workId, offset?}` | A work item's output, such as a background job's: what it produced so far, or what its result kept, in chunks. |
| `mcp.capabilities`, `mcp.servers`, `mcp.server`, `mcp.tools`, `mcp.tool`, `mcp.resources`, `mcp.resource`, `mcp.prompts`, `mcp.prompt`, `mcp.recent_calls` | see the contract | MCP catalogs and reads. |
| `review.discussions`, `review.discussion_source`, `review.general`, `review.result`, `review.workflows` | see the contract | Durable review reads. |

`changed{catalog}` tells the client to refetch a catalog: `models` when logins or API keys change on disk, `settings` after a settings intent, `mcp` when MCP servers change, `sessions` when the conversation's name changes or an intent moved the client to another conversation, `intents` and `extensions` after the conversation's extensions, prompt templates, and skills reload, and `host` (remote profile) when the host's keep-awake state, web search key, or shared theme changes.

## Host requests

Dialogs, forms, approvals, and MCP sign-ins the host asks are keyed live values `host_request/<requestId>` until they end. They reach the clients that accept their kind, and any of them may answer:

```json
{"type":"host_response","requestId":"0b7e…","response":{"confirmed":true}}
```

| `request.kind` | Fields | Answer |
|---|---|---|
| `select` | `title, options, timeoutMs?` | `{value}` (one of `options`) |
| `confirm` | `title, message, timeoutMs?` | `{confirmed}` |
| `input` | `title, placeholder?, timeoutMs?` | `{value}` |
| `editor` | `title, prefill?` | `{value}` |
| `form` | `title, fields, timeoutMs?` | `{values}` |
| `approval` | `action, title, message?, commandPreview?, blocking?, destructive?, …`: a host action, such as an LSP server install; `requestId` is its `host_action` work id | `{decision: approved|denied|dismissed, message?}` |
| `mcp_auth` | `server, flow, authorizationUrl?, userCode?, …` | completes through the `mcp.auth_*` intents |

Every kind may be answered `{cancelled: true}`. The first valid answer wins; the request is cleared and later answers are ignored. A host action is `host_action` work awaiting approval: `approved` runs it; any other answer, its timeout, or `cancel_work` finishes it `cancelled` without running, and one still awaiting approval when its conversation closes or its host stops ends `interrupted` (on the next open, after a crash). On the remote profile, approving or cancelling a host action needs `host.manage.v1`. A request outlives the clients that saw it: a client that subscribes later, or resubscribes, finds it in its live reset. It ends when answered, when its timeout expires (the host then resolves the default), or when its conversation closes.

## Extensions in RPC mode

`ctx.mode` is `"rpc"` and `ctx.hasUI` is `true`. The data-only UI reaches the client through the live lane:

- `select`, `confirm`, `input`, and `editor` are host requests;
- `notify` is a `notice`; `setStatus`, string `setWidget`, and `setTitle` are keyed values; `setEditorText` is a `set_editor_text` directive;
- extension errors are `notice{level: "error", message: "<event>: <error>", source: <extension path>}`.

The terminal-only UI needs a terminal and does nothing in RPC mode: `custom()` returns `undefined`; component widgets, `setFooter()`, `setHeader()`, `setEditorComponent()`, `setWorkingMessage()`, `setWorkingIndicator()`, and theme changes are no-ops (`setTheme()` reports that no UI is available); `getEditorText()` returns `""`.

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

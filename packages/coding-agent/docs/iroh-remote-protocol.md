# Iroh Remote Protocol v1

Iroh remote access carries the Volt protocol over Iroh QUIC bidirectional streams. The host runs on the user's machine; clients dial a ticket, open a stream, write one handshake line, and after the host's handshake response exchange [protocol 1](rpc.md) frames on the **remote profile**: the client subscribes to the conversation the stream is bound to, sends intents and queries within its grant, and answers the host requests its grant allows.

This protocol is preview-stable for external client authors. Clients must reject unsupported required values, ignore unknown fields unless this document says otherwise, and treat secrets as one-time credentials.

For user-facing setup, start the background daemon with `volt daemon start` (see [Background daemon](daemon.md)), create tickets with `volt remote pair`, inspect `volt remote status`, revoke clients with `volt remote revoke <node-id>`, and approve same-device re-pairing with `volt remote approve-repair <node-id>`. The host-side management workflow, state/audit paths, unsafe tool warnings, relay mode, and npm/source-only daemon limitation are documented in [Using Volt](usage.md#remote-access-over-iroh-preview) and [Security](security.md#remote-access-over-iroh-preview). This document defines the wire contract only. The npm daemon requires the exact `@hansjm10/volt-iroh` wrapper plus npm's optional selected native binding; `--omit=optional` and Darwin x64 cannot provide phone transport. `volt remote status` exposes `remoteTransport.state` (`starting`, `ready`, `degraded`, or `unavailable`) and exits nonzero unless ready.

## Version and ALPN

- Ticket prefix: `volt+iroh://v1/`
- ALPN: `volt/1`
- Handshake type: `volt_iroh_hello`
- Handshake response type: `volt_iroh_handshake`
- Frames after the handshake: protocol 1 (`hello.protocol: 1`), [RPC mode](rpc.md) describes every frame
- Host feature: `multi_streams.v1`
- Host feature: `conversation_streams.v1`
- Host feature: `worktrees.v1`
- Host feature: `working_directories.v1`
- Host feature: `session_runtime_state.v1`
- Host feature: `agent_options.v1`

The URL prefix selects protocol v1. The `alpn` ticket field and `protocol` hello field must be exactly `volt/1`. A client that dials with another ALPN does not connect; there is no compatibility with the command wire earlier hosts spoke (`volt-rpc/0`).

## Ticket

A v1 ticket is:

```text
volt+iroh://v1/<base64url-json>
```

The decoded JSON payload is an object with these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `alpn` | yes | Must be `volt/1`. |
| `irohTicket` | yes | Native Iroh endpoint ticket used to dial the running host. |
| `workspace` | yes | Registered workspace name requested by the client. The host resolves this name from persisted state; clients must not send host paths. |
| `secret` | no | One-time pairing secret. Present only in pairing tickets. Persisted host state stores only a hash. |
| `expiresAt` | no | Unix epoch milliseconds after which the pairing secret is invalid. |
| `nodeId` | no | Host node ID. Required for saved-host reconnect records and verified against the native Iroh ticket plus handshake host identity. |
| `relayMode` | no | Host relay configuration: `disabled`, `development`, or `production`. Clients use it together with `relayUrls` to bind against the same relays as the host. |
| `relayUrls` | no | Relay server URLs the client should use, as a non-empty array. Required when `relayMode` is `production`; a `production` payload without `relayUrls` is invalid. |
| `relayAuthToken` | no | Bearer token for relays that require authentication. Secret-like: hosts include it only in pairing tickets whose production relays require it. Clients must store it as a credential and must never persist it in saved-host reconnect data. |

Unknown ticket fields are reserved for compatible extension and must be ignored by v1 clients.

Example decoded payload:

```json
{
  "alpn": "volt/1",
  "expiresAt": 1790000000000,
  "irohTicket": "<iroh-endpoint-ticket>",
  "nodeId": "<host-node-id>",
  "relayAuthToken": "<relay-auth-token>",
  "relayMode": "production",
  "relayUrls": ["https://<relay-origin>"],
  "secret": "<one-time-pairing-secret>",
  "workspace": "volt"
}
```

Pairing tickets are explicit Pair Phone invitations. They are short-lived, one-time credentials for adding a new client, not durable reconnect credentials. Mobile-facing host startup does not create an active pairing ticket; `volt remote pair` creates the QR/ticket from a running host when a phone is being added. The ticket's `workspace` is the initial registered workspace for that pairing, not the client's permanent workspace boundary.

Saved-host reconnect data uses the same ticket payload shape sanitized of secrets: reconnect tickets strip the one-time `secret` (with its `expiresAt`) and the `relayAuthToken`. A saved reconnect record must retain a non-empty `nodeId`, supported `relayMode`, `workspace`, and `irohTicket`, plus `relayUrls` when `relayMode` is `production`; records missing those required reconnect fields are invalid and should not be dialed. Ordinary reconnect after app restart, network loss, or host restart with the same host state uses this saved-host data and does not require another QR scan. A saved-host client may synthesize a reconnect ticket for any registered workspace name it learned from verified host metadata; the host remains authoritative and rejects unknown names with `workspace_unregistered`, removed authorizations with `workspace_authorization_removed`, registered names whose local directory no longer exists with `workspace_missing`, and registered names whose local directory is transiently unusable with `workspace_unavailable`.

## Stream handshake

After opening an Iroh bidirectional stream, the client writes one UTF-8 JSON object followed by LF (`\n`):

```json
{"type":"volt_iroh_hello","protocol":"volt/1","workspace":"volt","conversation":{"target":"last"},"secret":"<one-time-pairing-secret>","clientLabel":"Jordan iPhone","clientNodeId":"<claimed-client-node-id>"}
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | Must be `volt_iroh_hello`. |
| `protocol` | yes | Must be `volt/1`. |
| `workspace` | yes | Registered workspace name requested by the client. |
| `conversation` | one mode required | Conversation stream target: `{ "target": "last" }`, `{ "target": "new", "sessionId": "..." }`, or `{ "target": "session", "sessionId": "..." }`. A `new` target may include a `worktreeId` on `worktrees.v1` hosts and/or `workingDirectory` on `working_directories.v1` hosts. |
| `workspaceDiscovery` | one mode required | Utility stream target: `{ "purpose": "list_sessions" }`, `{ "purpose": "session_contexts" }`, `{ "purpose": "review" }`, or, on `agent_options.v1` hosts, `{ "purpose": "agent_options" }`. |
| `workspaceManagement` | one mode required | Utility stream target. Payloads are `{ "purpose": "unregister_workspace" }`, `{ "purpose": "list_workspace_directories" }`, or, on `worktrees.v1` hosts, `{ "purpose": "manage_worktrees" }`. |
| `secret` | no | Pairing secret when completing a pairing ticket. Omitted for already-paired clients. |
| `clientLabel` | no | Human-readable client label requested during pairing. |
| `clientNodeId` | no | Client-claimed node ID for diagnostics only. It is not authoritative. |

Mobile clients must include exactly one stream mode: `conversation`, `workspaceDiscovery`, or `workspaceManagement`. Both `conversation.target:"session"` and `conversation.target:"new"` must include a strict lowercase remote session ID; `last` must not. For `new`, this is a client-generated idempotency identity: first use creates that exact session and identical retries resume it. A `worktreeId` (lowercase worktree id syntax) is accepted only on `target:"new"` and only by hosts advertising `worktrees.v1`; `last` and `session` targets must not include one — resumes derive the worktree from the host's persisted session binding, never from the client. A `workingDirectory` is accepted only on `target:"new"`; it must be a POSIX-style relative path with no absolute prefix, control characters, empty segment, `.`, `..`, or `.git`. The host resolves it inside the registered workspace and rejects symlink escapes. Reusing a `new` session ID with a different workspace, worktree, or working directory fails with `invalid_conversation_target`. Discovery and management payloads reject unknown purposes and unexpected fields.

The authoritative client identity is the remote Iroh node ID observed by the host on the accepted connection, not `clientNodeId` from the hello. Unknown top-level hello fields are ignored.

The host responds with one UTF-8 JSON object followed by LF. After a successful response the stream carries protocol 1 frames (below); after a failure the host closes it.

Success:

```json
{"type":"volt_iroh_handshake","success":true,"workspace":"volt","hostNodeId":"<authoritative-host-node-id>","clientNodeId":"<authoritative-client-node-id>","features":["multi_streams.v1","conversation_streams.v1","worktrees.v1","working_directories.v1"],"sessionId":"abc123","conversation":{"target":"last","sessionId":"abc123","selection":"resumed"},"child":"volt"}
```

Failure:

```json
{"type":"volt_iroh_handshake","success":false,"outcome":"client_unknown","hostNodeId":"<authoritative-host-node-id>","error":"client is not paired"}
```

On success, `hostNodeId` is the host's authoritative Iroh node ID and `clientNodeId` is the client's authoritative Iroh node ID observed by the host on the accepted connection. Stream-mode successes require `features` to include both `multi_streams.v1` and `conversation_streams.v1`. Conversation successes also require matching top-level `sessionId` and canonical `conversation.sessionId`, plus `conversation.target` and `conversation.selection` (`resumed`, `created`, or `created_missing_last`). A `new` target returns `created` on first publication and `resumed` on an identical retry. A `session` target returns `resumed` with exactly the requested session id: a session id never stands for another session. Discovery and management successes include purpose metadata and no session metadata:

```json
{"type":"volt_iroh_handshake","success":true,"workspace":"volt","hostNodeId":"<authoritative-host-node-id>","clientNodeId":"<authoritative-client-node-id>","features":["multi_streams.v1","conversation_streams.v1","working_directories.v1"],"workspaceDiscovery":{"purpose":"list_sessions"}}
```

`child` is an implementation label for the host-side runtime and may be omitted. Failure responses include `hostNodeId` when the host identity is known and may include `workspace`, `sessionId`, and `retryAfterMs`. A present `retryAfterMs` is a pacing hint: wait at least that long before the next automatic dial. Its absence on outcomes that cannot self-heal (for example `workspace_missing`) means automatic redialing will not help. `error` is diagnostic text and should not drive app state.

Host handshake failure outcomes:

| Outcome | Meaning |
| --- | --- |
| `host_storage_full` | The host could not durably commit authorization because computer storage or quota is exhausted. Preserve pairing/selection/transcript authority, do not auto-redial, and offer manual Retry after the user frees space. |
| `invalid_workspace` | The workspace field is malformed. |
| `invalid_conversation_target` | The stream mode, target, purpose, or session ID syntax is malformed or unsupported. |
| `conversation_streams_unsupported` | Reserved for hosts that cannot provide conversation-bound mobile streams. Current daemon builds are conversation-only. |
| `pairing_secret_expired` | The supplied pairing secret matches an expired pending ticket or retained expired tombstone. |
| `pairing_secret_consumed` | The supplied pairing secret matches a retained consumed tombstone and this client is not the paired recovery node. |
| `client_unknown` | The host does not know this client node ID and no active, expired, or consumed pairing secret applies. |
| `client_revoked` | The client node ID has a retained revocation tombstone and has not completed an approved re-pair. |
| `workspace_unregistered` | The requested workspace name is not registered in this host state. |
| `workspace_unavailable` | The requested workspace is registered but its local directory is transiently not usable (permissions, IO, not a directory). Carries `retryAfterMs` so clients pace their retries. |
| `workspace_missing` | The requested workspace is registered but its local directory no longer exists. Clients should stop automatic redialing until the registration changes. |
| `workspace_authorization_removed` | The workspace exists but this client is no longer authorized for it. |
| `workspace_forbidden` | The workspace exists but this client is not allowed to use it. This is reserved for legacy or future per-client workspace restrictions. |
| `session_unavailable` | A strict `conversation.target:"session"` target does not resolve to an available session. |
| `duplicate_conversation_connection` | The same authoritative client already has an active stream for the resolved workspace/session. |
| `conversation_in_use` | The active or retained daemon runtime permits tools outside the attaching client's persisted grant, so the client cannot safely co-attach. |
| `conversation_locked` | Another Volt process on the host (for example `volt -p`, `--mode rpc`, or an SDK embedding) has the session open for writing, so the daemon cannot host it. Keep the saved host and selection; the user closes the session there and retries. |

Client-local reconnect outcomes are not sent by the host: `host_unreachable` means no usable transport/handshake could be opened, `host_identity_mismatch` means the reached Iroh node or handshake `hostNodeId` differs from the saved host identity, and `saved_host_invalid` means the local saved record is malformed or missing required v1 fields.

`client_revoked` remains authoritative for a revoked client node ID. A generic new pairing ticket does not let that same node silently return. The desktop host must first approve re-pair for the revoked node ID, then issue a fresh active pairing ticket; successful re-pair creates a new active client record and clears the revocation tombstone.

A successful pairing stores the client as authorized for the workstation represented by the host state file. That paired client can use any registered workspace name in that state file, including workspaces registered later, without scanning another QR. Revocation blocks that client node ID from every registered workspace. The client's persisted `allowedTools` value is a **headless agent tool grant** that applies to daemon-owned runtimes across all selected workspaces; registering a workspace does not add built-in tools. The default built-in grant is `read,bash,edit,write,image_gen,web_search,web_fetch,grep,find,ls,inspect,lsp,subagent,subagent_registry,mcp,jobs`. The Codex-only `image_gen` tool can read and upload local reference images and write generated PNG files on the host. When the persisted grant is the default built-in list, the host also exposes active tools registered by loaded extensions in the selected workspace. A TUI-owned conversation continues to use the TUI session's full local tool set; `review` and `chat` pairing presets do not narrow that local runtime.

A paired client may open multiple conversation streams, including multiple sessions in the same registered workspace. The identity key is authoritative client node ID, workspace name, and resolved session ID. If the same authoritative client opens the same workspace/session twice on one live Iroh connection, the host rejects the new stream and preserves the existing stream:

```json
{"type":"volt_iroh_handshake","success":false,"outcome":"duplicate_conversation_connection","hostNodeId":"<authoritative-host-node-id>","workspace":"volt","sessionId":"abc123","retryAfterMs":500,"error":"duplicate conversation connection"}
```

If the duplicate is the first conversation stream on a new Iroh connection from the same authoritative client, the host treats the previous active stream as stale, closes it with reason `replaced`, and accepts the new stream as the subscriber to the existing integrated runtime. Distinct authoritative clients may co-attach when the existing runtime's tool policy is within the attaching client's effective grant. Otherwise the host rejects with `conversation_in_use` and includes the resolved workspace/session identity.

## Stream feature compatibility

`multi_streams.v1` and `conversation_streams.v1` are optional host features, not a protocol version bump. Mobile pinned-agent clients require both features on successful stream-mode handshakes. Missing or malformed feature metadata for those modes means the host is incompatible with conversation streams. Clients should keep the saved host and surface an update/integrated-host-required state rather than asking for another QR scan.

`session_runtime_state.v1` is an optional discovery feature. Hosts advertising it may add `runtimeState` to `sessions` query entries. Older clients must ignore the field; clients must not assume its absence means a session is stopped when the feature is not advertised.

`worktrees.v1` is an additional optional host feature. Clients must check for it before sending `worktreeId` in a conversation hello or opening a `manage_worktrees` management stream; hosts without the feature reject both with `invalid_conversation_target`. Conversation successes for worktree-bound sessions echo `conversation.worktreeId`.

`working_directories.v1` is an additional optional host feature for starting a new conversation in a workspace-relative subfolder while keeping project configuration rooted at the registered workspace (or at the matching worktree checkout root for worktree sessions). Conversation successes echo `conversation.workingDirectory` when the effective cwd is not the root. The wire value is always relative; host-local absolute paths never cross the protocol.

`agent_options.v1` is an optional host feature for read-only configured-agent discovery. Clients open a workspace-discovery stream with purpose `agent_options` and run the `agent_options` query. It requires `model.select.v1` and answers with `workspaceName` (the stream's workspace), the current authenticated model catalog, and `defaultConfig:{model:{provider,modelId},thinkingLevel,fastModeEnabled,agentMode}`. It has no catalog revision and performs no session, selection, worktree, runtime, or host-default mutation.

Configured-agent creation remains an app-owned sequence over ordinary primitives: optional deterministic `create_worktree`, retry-safe `target:"new"` attach with a stable session ID, then the session-scoped `set_model`, `set_thinking_level`, `set_fast_mode`, and `set_agent_mode` intents before the first prompt. The host publishes runtimes only through the normal integrated runtime registry and durably records caller-named sessions through `SessionManager`. Concurrent same-ID attempts wait for that publication and converge; after a daemon restart the same request resumes the durable session after validating its stored cwd and worktree binding. Ordinary configured-agent creation has no launch record, receipt, cleanup transaction, or rollback across resources. Prepared PR reviews additionally retain host-owned placement metadata as described below. A worktree created before a later failure remains for explicit retry or removal, and a configuration failure leaves an empty resumable session; clients must not send the prompt until all configuration intents are accepted.

Missing stream features, `conversation_streams_unsupported`, `host_storage_full`, `workspace_unavailable`, `workspace_missing`, `workspace_unregistered`, `workspace_has_worktrees`, `workspace_authorization_removed`, `session_unavailable`, `duplicate_conversation_connection`, `conversation_in_use`, and `conversation_locked` are not QR re-pair requirements by themselves. `workspace_has_worktrees` means the user must explicitly remove each child worktree first; it is not an authorization or connectivity failure. `host_storage_full` is a Retry-only capacity state that keeps the saved relationship but does not automatically redial. Ordinary `host_unreachable` recovery is bounded to five attempts on a 0/1/2/5/10-second cycle before manual Retry, with a fresh cycle permitted after a later network/foreground event. `host_identity_mismatch`, malformed saved-host data, `client_unknown`, and `client_revoked` still require explicit Pair Again or Forget Host style UX.

## Reconnect and session selection

A reconnecting paired client with the same authoritative Iroh node ID selects a conversation in the handshake. `target:last` resumes the last recorded session for that workspace when the remembered ID is valid and its authoritative SQLite row remains available; if the remembered ID is invalid or missing, the host creates a new session and reports `conversation.selection:"created_missing_last"` or `created`. `target:new` creates the exact supplied session ID once and resumes it on retry; concurrent identical attempts serialize until one runtime is published. The request must repeat the original placement, and a resumed session's durable cwd must still match it. `target:session` resumes a strict session ID or fails with `session_unavailable`. Clients must validate the conversation they subscribe to against the returned canonical `sessionId` (it is also `welcome.conversation`) and update the selected pin only after that validation commits.

Saved-host clients must verify that the native endpoint ticket node ID and the handshake `hostNodeId` match the saved host's `nodeId` before trusting authorization failures or refreshing non-secret discovery fields. If the reached identity differs, clients should treat the attempt as `host_identity_mismatch` and leave the saved host identity and discovery data unchanged.

After the handshake, a conversation client says `hello` and subscribes to `welcome.conversation` from a snapshot (or, reconnecting, after the newest ordinal it holds). New Agent and Resume Agent are not post-handshake mutations; clients open a new conversation stream with `target:new` or `target:session`. Older history than the snapshot's tail is paged with the `history` query.

The conversation's Git context is the live `git` value (`{gitContext}`, nullable) of the subscription, using the field semantics of [RPC mode](rpc.md#live-lane): a host-cached, path-free view of the active session worktree with repository display name, branch/detached/unborn HEAD, local upstream and optional managed-worktree base divergence, count-only status, operation, revision, observation time, and stale state. The host performs no fetch, changed path names and remote URLs never enter the value, and comparisons reflect only refs already present on the host. Provider revisions are local to one runtime and must not be compared across streams. A current-format session may separately expose optional `startingGitContext` through the `sessions` and `session_contexts` queries: the first definitive path-free observation persisted in a strictly validated host-only entry. It never enters model context or extension prompts.

The handshake success response carries remote host metadata with the current workspace, the available workspace names, and the availability of every registered workspace visible to the saved host:

```json
{
  "remoteHost": {
    "workspace": "volt",
    "workspaceNames": ["volt", "other-project"],
    "workspaces": [
      { "name": "volt", "status": "available" },
      { "name": "other-project", "status": "available" }
    ],
    "features": ["multi_streams.v1", "conversation_streams.v1", "working_directories.v1"],
    "hostNodeId": "<authoritative-host-node-id>",
    "relayMode": "production",
    "relayUrls": ["https://<relay-origin>"],
    "hostName": "macstudio",
    "userName": "jordan",
    "cwd": "/workspace"
  }
}
```

`remoteHost.workspaces` is required whenever `remoteHost` is present and lists every registered workspace as `{name,status}`, where `status` is `available`, `missing`, or `unavailable`. `remoteHost.workspaceNames` repeats only the names whose status is `available`. Both fields contain names only, never host-local paths. `remoteHost.features` repeats the safe host feature strings advertised during handshake. `remoteHost.relayMode` and `remoteHost.relayUrls` report the host's current relay configuration so saved-host clients can refresh their relay list without re-pairing; `relayUrls` is present only in `production` relay mode. Selecting another pinned agent opens another conversation stream; a stream never switches its cwd or session in place.

## Lifecycle: detach versus cancel

An Iroh stream close, stream EOF, QUIC connection close, input half-close, or remote write failure is a detach signal. It carries no frame and the host never translates it into an abort. Mobile clients do not need to send anything before background suspension or process loss.

User-visible stop controls send the `abort` intent (branch-fenced, so with the client's position):

```json
{"type":"abort","intentId":"cancel-1","expectedOrdinal":42}
{"type":"accepted","intentId":"cancel-1","ordinals":[]}
```

`abort` cancels foreground work and the conversation's running work, such as background jobs, joining cleanup; queued input is delivered instead of stranded. `cancel_work{workId}` requests cancellation of one work item, such as a background job, without stopping the foreground run or its siblings. App-level disconnect without stop closes the stream only; the client reconnects with a new authorized stream and resumes its subscription after its position.

The daemon's integrated runtime treats an authorized stream as a subscriber to host-owned session state. When the only subscriber detaches during active work, the prompt continues on the host. The same authoritative Iroh node ID, workspace, and session can reconnect to the detached runtime: the live `phase` value reports the single busy state and the active run, and the subscription replays the entries the client missed (or answers a gap past the replay bound with a snapshot). Idle detached runtimes are retained for 30 minutes by default, configurable with the `remote.detachedRuntimeTtlMs` setting. Distinct paired devices may co-attach to one runtime, and when a desktop TUI owns the conversation lease the daemon transparently relays the stream to it; a relayed stream speaks the same frames, served by the TUI.

A stream the host ends on purpose tells the client why as its last frames:

| Ending | Frames | Client |
|---|---|---|
| A structural intent of this client (`new_session`, `switch_session`, `review_open_session`, a review fix, a plan executed in a new session, or an extension command that starts, forks, or switches sessions) | `accepted{conversation: <target>}`, then `ended{reason: "moved", target}` on the subscriptions, then the stream closes | Reconnect at once with `target:"session"` and `target`. The target is also recorded as the client's last session. Other clients of the conversation stay on it. A session the daemon hosts opens the target at once, with the tool policy and worktree of the session the client left, and keeps it until the client reconnects; the session left behind closes once idle when no other client remains. |
| Another host process serves the conversation now (a TUI took it over, quit, or moved to another session) | `ended{reason: "closed"}`, then the stream closes | Reconnect to the same session. |
| The device's workspace authorization was removed, or its grant changed while the stream ran | `fatal{code: "revoked"}`, nothing after it. A revocation or access change made on the host closes the device's Iroh connections at once instead (close reason `revoked` or `access_updated`), so nothing at all follows it. | Reconnect: the handshake applies the current grant, or reports `client_revoked`/`workspace_authorization_removed`. |
| The workspace was unregistered | `fatal{code: "workspace_unregistered"}` (a stream that unregistered it first gets its `accepted`) | Stop automatic redialing for that workspace. |
| The host is shutting down | `ended{reason: "shutdown"}`, `fatal{code: "host_shutdown"}` | Reconnect after the host restarts. |

While the daemon shuts down, intents that start work are rejected `host_shutdown`.

Host process exit, host crash, or explicit host shutdown are separate from client detach and can stop in-memory work because the runtime is gone. A reconnect after host exit requires a new host process and can recover only persisted session state.

## Framing

All post-handshake traffic is protocol 1 JSONL:

- Each frame is one JSON object encoded as UTF-8 and terminated by LF (`\n`).
- Split only on LF byte `0x0a`. Do not treat CR, Unicode line separator U+2028, or Unicode paragraph separator U+2029 as frame terminators.
- Bytes after the hello LF are preserved as the stream's first frames. Clients may pipeline `hello` (and their first subscription) immediately after the handshake line.
- A frame in either direction is at most 4 MiB minus the LF (`DEFAULT_IROH_RPC_MAX_LINE_BYTES`). The host measures an inbound line's bytes before it parses any: a longer line ends the stream with `fatal{code: "frame_too_large"}`. The host bounds what it writes to the same limit (below).
- Overlong or unterminated handshake lines are rejected before any frame is read.

## The remote profile

Every stream a paired device opens is served on the remote profile, chosen by the host when it admits the stream; nothing a client sends widens it. `welcome.profile` is `"remote"`.

### What the client sees

- **Transcript fidelity.** Message-like entries (`message`, `compaction`, `branch_summary`, remote-visible `custom_message`) carry their transcript `view` only, never the raw message `payload`; state entries (`model_change`, `thinking_level_change`, `fast_mode_change`, `planning_state_change`, `session_info`, `label`, `leaf`, `client_input_*`, `forked_from`, and work entries) carry their payloads; work entries carry no input, output, result data, or child log locator. Queued inputs carry their text and image count, not image data or the host messages they deliver. A `work_notice` view's text is rebuilt from the notice's details (title, kind, work id, outcome, summary, and error), never taken from its content. Extension `custom` entries, product entries (review state, host records), and custom messages other than the remote-visible ones (`review`, `work_notice`, `subagent_recovery`) stay on the host; `head` frames advance the client's position over them, and `parentId` and leaf targets name the nearest visible ancestor.
- **Bounded snapshots.** A snapshot carries at most the last 200 entries of the active branch (`earlier: true` when older entries exist; page them with `history`). A resume further back than 1,000 ordinals is answered with a snapshot at the current ordinal instead of every entry, exactly as `after: "snapshot"` would be. Transcript text is bounded to 12,000 Unicode scalars per item (`truncated`; the `content` query returns the rest), live tool arguments to a fixed budget, and a streaming assistant message to 384 KiB in a live reset and 256 KiB streamed. A tool call's presentation (`view.presentation`, and the `presentation` and `patch` of live `tool` items) is presented from the redacted call, without image data, within 16 KB: a presentation that does not fit is cut, then becomes its tool's name, and the generic presentation shows no arguments. Extension status items, panels, titles, and dialogs arrive as the same [`UiNode`](ui-nodes.md) data as on the local profile, redacted.
- **Path redaction at one send.** Every frame passes through the stream's redactor before it is written: entries, snapshots, live items, intent outcomes, query results, and errors. See [Outbound path handling](#outbound-path-handling).
- **Frame limit.** A frame that would exceed the frame limit is never written whole: a query result becomes `query_error{code: "failed"}`, an accepted intent drops its `result`, a snapshot drops its oldest entries, a live frame drops its largest items, and an entry is skipped with a `head` frame.

### What the client may do

- **Intents and queries** are admitted on the device's grant: only remote-safe ones, and only when the grant holds every capability the descriptor `requires` (`rejected`/`query_error` `not_allowed{requiredCapability}` otherwise). The `intents` query lists the descriptors with `remote` and `requires`. The remote-safe set:

| Capability | Intents | Queries |
|---|---|---|
| `conversation.observe.v1` | | `intents`, `intent_completions`, `history`, `content`, `sessions`, `settings`, `extensions`, `host_status`, `work_output`, `session_contexts`, `worktrees`, `workspace_directories`, `pr_review`, `review.discussions`, `review.discussion_source`, `review.general`, `review.result`, `review.runs` |
| `conversation.control.v1` | `prompt`, `steer`, `follow_up`, `abort`, `set_fast_mode`, `set_agent_mode`, `plan_execute`, `plan_change`, `plan_discard`, `new_session`, `switch_session`, `cancel_work`, `set_auto_compaction`, `set_compaction_threshold`, `review_uncommitted`, `review_branch`, `review_pr`, `review_commit`, `review_rerun`, `review_open_session`, `open_work`, `resume_work`, `review_acknowledge`, `review_record_finding_outcome`, `review_publish`, `review_start_discussions`, `review_reset_discussion`, and the dynamic `extension.command.*` (only commands registered `remoteSafe: true`), `extension.intent.*` (only intents registered `remote: true`, with the capabilities they `require`), `prompt.template.*`, and `skill.*` intents | `editor_completions` (only completion providers registered `remote: true`) |
| `model.select.v1` | `set_model`, `set_thinking_level` (the bound session only) | `models`, `agent_options` |
| `model.select.v1` + `host.manage.v1` | `set_default_model`, `set_default_thinking_level` (host defaults) | |
| `host.manage.v1` | `set_keep_awake`, `set_extension_enabled` (enabling only an extension whose permissions the user acknowledged on the host), `set_extension_settings` (project settings only for a trusted project) | `subscription_usage`, `extension_settings` |
| `integrations.manage.v1` | `set_web_search_key`, `mcp.connect`, `mcp.disconnect`, `mcp.refresh`, `mcp.set_enabled`, `mcp.auth_start_device`, `mcp.auth_poll`, `mcp.auth_cancel`, `mcp.logout` | `web_search_status`, `mcp.*` reads |
| `worktrees.manage.v1` | `create_worktree`, `remove_worktree` | |
| `conversation.control.v1` + `worktrees.manage.v1` | `prepare_pr_review` | |
| `workspace.manage.v1` | `unregister_workspace` | |
| `diagnostics.upload.v1` | `upload_device_logs` | |
| none | `register_push_target` | |

  Everything else (`bash`, `compact`, `fork`, `clone`, `set_session_name`, `export_html`, `start_subagent`, MCP browser authorization, steering and follow-up modes, auto-retry, `review_export_feedback`) is rejected `not_allowed`, as are extension commands not registered remote-safe and extension intents not registered remote.
- **Branch fences.** An intent whose descriptor `fence` is `branch` (every conversation intent that changes it, `abort` included, and every dynamic intent) must carry `expectedOrdinal`, the newest ordinal the client holds; without it the intent is rejected `invalid_input`. It is rejected `stale{ordinal}` when the conversation's branch switched after that position. Non-input intents are deduplicated per conversation by `intentId`; input intents use `intentId` as their durable client message id.
- **The bound conversation.** A conversation stream is bound to the conversation of its handshake: intents act on it only. A client may also subscribe to and read (`history`, `content`) the open subagent conversations its bound conversation links by `subagent` work, directly or through linked children, observe-only: intents naming one are rejected `read_only`. Any other conversation is `ended{reason: "closed"}` to a subscription and `rejected{ended}` to an intent. A conversation that is itself a subagent session is observe-only too: every intent but the abort intents is rejected `read_only`.
- **Workspace operations** act on the stream's workspace only; `unregister_workspace` also checks its `workspaceName` input against it. Host intents and queries answer with stable error strings in `rejected.reason.message` (for example `worktree_exists`, `worktree_limit_reached`, `workspace_has_worktrees`, `review_preparation_stale`).
- **Bounds.** A connection holds at most 16 subscriptions and spends reads from a budget of 16, refilled one every 2 seconds: a subscription costs one read, and a resume one more for every 200 entries past the first 200 it replays; every query but `intent_completions`, `settings`, `host_status`, and `web_search_status` costs one. A subscription past the budget ends the stream with `fatal{code: "invalid_frame"}`; a query past it is `query_error{unavailable, retryAfterMs}`. At most 256 frames may wait for the intent and query lane. The host never waits for a device that reads slowly: once more than 64 MiB of frames wait on one stream, or 128 MiB on all of a device's streams, the stream is reset, and the device resumes after its position.
- **Authority on every frame.** Before every frame in either direction the daemon checks the stream's authorization against its current state; before every intent, query, subscription, and host response it also re-reads the persisted grant. A revoked or changed grant, a removed workspace authorization, or an unregistered workspace ends the stream (`fatal{revoked}` or `fatal{workspace_unregistered}`) before anything else is written. A desktop TUI serves a relayed stream on the grant it was relayed with: the daemon ends the device's relays before it applies a grant change or revocation.

### Host requests

A device is asked the host requests it accepts in `hello.accepts.hostRequests` and its grant allows: dialogs (`select`, `confirm`, `input`, `editor`, `form`, `dialog`), `editor_text`, and `user_input` (the `request_user_input` tool's questions, which the model is offered while any attached client answers them) need `conversation.control.v1`, `approval` needs `host.manage.v1`, and `mcp_auth` needs `integrations.manage.v1`. Requests are live values (`host_request/<id>`) until answered; every client that may answer sees them, a desktop TUI included, and the first valid answer wins. A select or form-enum option the redactor rewrote maps back to the host's own value when the device answers with it. A form field pattern that could backtrack without bound (a repeated group that repeats or alternates, a backreference, a lookaround, more than three repeats, or more than four quantifiers, optionals, and alternatives in all) is refused when the form is asked, and a pattern is tested against values of at most 256 characters.

### Catalog changes

`changed{catalog}` asks the client to refetch: `models` (logins or API keys changed on disk), `sessions` (the conversation's name changed, or an intent moved the client), `intents` and `extensions` (the conversation's extensions reloaded, or one was enabled, disabled, or changed state), `settings` (a settings intent, or extension settings saved), `mcp` (MCP servers changed), and `host` (the host's keep-awake state, web search key, or shared theme changed: refetch `host_status` and `web_search_status`).

## Workspace streams

A workspace stream (hello `workspaceDiscovery` or `workspaceManagement`) is a protocol 1 connection without a conversation: `welcome` names none, subscriptions end `closed`, and only its purpose's intents and queries are served (others are `unavailable`):

| Purpose | Serves |
|---|---|
| `workspaceDiscovery: list_sessions` | `sessions` query |
| `workspaceDiscovery: agent_options` | `agent_options` query (`agent_options.v1`) |
| `workspaceDiscovery: session_contexts` | `session_contexts{sessionIds}` query |
| `workspaceDiscovery: review` | `pr_review` query |
| `workspaceManagement: unregister_workspace` | `unregister_workspace{workspaceName}` intent |
| `workspaceManagement: list_workspace_directories` | `workspace_directories{path?}` query |
| `workspaceManagement: manage_worktrees` | `create_worktree`, `remove_worktree`, `prepare_pr_review` intents and the `worktrees` query (`worktrees.v1`) |

Discovery streams create no conversation runtime and do not update last-session state. Inbound host-local filesystem paths are always rejected; answers carry workspace-relative paths only.

Conversation streams also serve the workspace operations a phone uses beside a conversation: the `sessions` and `worktrees` queries and the `create_worktree`, `unregister_workspace`, `upload_device_logs`, `register_push_target`, `set_keep_awake`, and `set_web_search_key` intents, with the `host_status` and `web_search_status` queries.

The `sessions` query answers `{sessions, hasMore, nextCursor}`, newest first. Each entry is `{sessionId, sessionName?, firstMessage, createdAt, modifiedAt, messageCount, current, origin?, reviewDiscussion?, startingGitContext?, changeContext?, runtimeState?, worktreeId?, workingDirectory?}`: `sessionName` and `firstMessage` are bounded to 160 Unicode scalars; `worktreeId` badges sessions bound to a daemon-managed worktree; `workingDirectory` is present when the session cwd is below the workspace or worktree root. An entry may include daemon-owned `changeContext`:

```json
{"changeId":"c56d55ca-3937-4fc8-b13a-a7525577864b","repository":"Volt","branch":"feature/change-association","resolutionState":"resolved","pullRequest":{"provider":"github","number":42,"title":"Add change association","status":"open","stale":false}}
```

`resolutionState` is `resolved`, `none`, `ambiguous`, or `unavailable`. `pullRequest` is required only for `resolved`; its status is `open`, `draft`, `merged`, or `closed`. The daemon refreshes linked open/draft PR status in the background; `stale` is `true` when the last refresh failed or the next one is overdue. The daemon joins this value synchronously from private bounded state. Listing never invokes Git or a provider. The wire omits checkout paths, remotes, canonical repository identities, matched object IDs, credentials, raw provider output, and diagnostics. Default/configured base branches are not grouped across sessions, and an exact positive PR association is sticky rather than silently moving to a newer match.

On hosts advertising `session_runtime_state.v1`, an entry may also include `runtimeState`, `attached` or `detached`. The field is omitted when no conversation worker hosts the session. `attached` means a client's stream of the session (a desktop TUI's or a phone's) is open, or its worker is still starting. `detached` means a worker keeps the conversation open with no stream attached, which may be idle warm retention rather than active work. Clients should therefore use the exact state, not mere field presence, when deciding which hidden sessions to auto-connect.

`unregister_workspace` removes a registered workspace name from the host state file without deleting files. Its `workspaceName` input must name the stream's workspace. If the workspace has any persisted daemon-managed worktree records, it is rejected with message `workspace_has_worktrees`; the workspace, records, dirty/unmerged work, active worktree sessions, and all checkout directories remain untouched. A successful unregister answers `accepted` with `result{workspaceName, unregistered: true}` and then ends the requesting stream with `fatal{workspace_unregistered}`; every other stream of the workspace ends the same way. It does not create, rename, path-map, or delete host workspace or worktree directories, including unrecognized/orphan directories under the daemon worktree root.

### Background jobs and subagents on conversation streams

Background jobs are `job` work items: the device's fold lists them with the conversation's other work, without input or output, and the live `work/<workId>` value is set while one runs. `work_output{workId}` returns a job's non-consuming kept tail (at most 50 KiB UTF-8 before path redaction), never arbitrary logfile contents; `cancel_work{workId}` requests cancellation. Foreground `phase` idleness does not imply job completion. Detach keeps running jobs alive; a job still running when the runtime stops ends `interrupted`, and its recorded result stays readable.

Remote clients observe spawning activity through the parent conversation's `subagent` tool call and the `subagent_registry` tool. Live `tool` items and committed tool views carry each call's presentation: a `subagent` call shows each child as a timed step and, expanded, a card with its task, metrics, error, output, nested delegation, and an `open_work` action naming its work, within the remote presentation bound and path-redacted. Each subagent is `subagent` work of the parent conversation: its `work_started.child.conversation` names the child conversation, which the client may subscribe to on the same stream, observe-only (`open_work{workId}` names it). While the child is open the subscription follows it; once it closed, the host answers a snapshot of its log, then `ended{closed}`. A device may not start (`start_subagent`), cancel, or resume subagent work: `cancel_work` and `resume_work` on subagent work are rejected `not_allowed`, and an `abort` cancels no subagent work.

Work items (jobs, subagents, reviews, host actions, extension work) reach a device as their `work_*` entries, without input, child locators, output, or result data, and as the live `work/<workId>` value while they run (see [RPC mode](rpc.md#work)). A device reads output with `work_output`. Paths in titles, summaries, errors, progress text, and step labels are redacted, text the host cut to its bound never shows the start of a root the cut left, and a checkpoint or live work value stays within its 8 KB bound after redaction: its detail is dropped first, then its steps. Acting on work needs what the work's kind requires besides the intent's own capability (a host action needs `host.manage.v1`); work of an extension kind the host no longer knows is refused. As before, a device that may stop a turn still stops a subagent by stopping the tool call or background job that waits on it, or with `abort` on a stream bound to the subagent's own conversation.

## Push targets and notifications

`register_push_target` registers mobile-issued relay credentials with the host. The client must first register its raw FCM token with the Volt push relay; it must not send that raw FCM token to the desktop host. The host persists the relay target id and target-scoped auth token so it can notify the phone after the stream detaches. `relayUrl` is accepted as app registration metadata, but host delivery uses the desktop host's configured relay URL (`--push-relay-url` / `VOLT_PUSH_RELAY_URL`) and does not let clients redirect delivery:

```json
{"type":"register_push_target","intentId":"push-1","input":{"provider":"fcm","platform":"ios","pushTargetId":"<relay-target-id>","pushTargetAuthToken":"<relay-target-auth-token>","relayUrl":"https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay","tokenHash":"sha256:<fcm-token-hash>","enabled":true}}
{"type":"accepted","intentId":"push-1","ordinals":[],"result":{"status":"registered","pushTargetId":"<relay-target-id>"}}
```

Completion notifications go through push delivery only; a connected stream sees the same completion in its live lane. The relay receives one canonical intent: `eventId`, authoritative `hostNodeId`, `kind`, title, body, `workspaceName`/`sessionId` authority, and `planId` or `workId` with `workKind`, and forwards those exact metadata fields in FCM `data`.

| Outcome | `kind` | Title | Body | Navigation |
| --- | --- | --- | --- | --- |
| A run the device's own prompt (or dynamic intent) started completed | `conversation_completed` | `Volt finished` (optionally `in <workspace>`) | `Your conversation is ready.` | session only |
| Such a run ended in Plan mode with a ready plan | `plan_ready` | `Your plan is ready` | `Open Volt to review and approve it.` | `planId` |
| Completed review, zero findings | `work_finished` | `Your review is ready` | `<target> completed with no issues found.` | `workId`, `workKind: review` |
| Completed review, one finding | `work_finished` | `Your review is ready` | `<target> completed with 1 finding.` | `workId`, `workKind: review` |
| Completed review, multiple findings | `work_finished` | `Your review is ready` | `<target> completed with N findings.` | `workId`, `workKind: review` |
| Completed review, unknown count | `work_finished` | `Your review is ready` | `<target> completed. Open Volt to see the findings.` | `workId`, `workKind: review` |

A failed run sends the `host_notice` error copy, an aborted run sends nothing, and cancelled or failed reviews send no `work_finished`.

Review targets come only from the host's bounded workflow target record: `PR #N`, `uncommitted changes`, a canonical commit, or a path-free branch comparison. Unsafe or unavailable targets fall back to `Review`; commands, diffs, pull request titles/bodies, linked-issue/discussion text, and host paths are never copied into a notification. Notification titles are limited to 128 UTF-8 bytes, bodies to 512, review targets to 256, workspace and navigation/session identifiers to 128, event IDs to 512, and kinds to 64. Host construction removes unsafe copy before delivery, and strict control/relay boundaries reject path separators plus control, format, or surrogate characters; metadata also rejects whitespace.

`hostNodeId` is required on every notification and must be the same canonical 64-hex Iroh identity used by the stream handshake; clients reject a notification whose host identity differs from the saved pairing. `workspaceName` is the sole notification workspace key, contains a registered workspace name only, and never carries a host-local path. `planId` and `workId` (with `workKind`) are mutually exclusive stable navigation identifiers and appear only on their matching kind. A retained runtime reconciles completed reviews per paired client: a completion that lands while detached stays pending, a push that fails is retried when the device reconnects, and a stable `eventId` is pushed at most once for that runtime/client.

The host's keep-awake state and, when the host shares it (`settings.themeTokenPush` or `VOLT_HOST_THEME_TOKENS=1`), its resolved theme colors (hex values only) are the `host_status` query's `keepAwake` and `theme`; `changed{host}` announces a change.

## Prepared pull-request reviews

Resolve the PR before creating any conversation. Open `workspaceDiscovery:{"purpose":"review"}` and run the `pr_review` query:

```json
{"type":"query","queryId":"resolve-1","query":"pr_review","params":{"number":"414"}}
```

Optional `workingDirectory` selects a validated repository-relative directory;
optional `sourceWorktreeId` selects an already registered source worktree. They
are mutually exclusive. Omit `number` to resolve the current PR in that source,
not in a generated review branch. Numbers are canonical decimal strings from
1 through 2147483647. Resolution requires `conversation.observe.v1` and creates
no session, runtime, checkout or discussion snapshot.

```json
{"type":"result","queryId":"resolve-1","data":{"workspaceName":"myrepo","pullRequest":{"provider":"github","url":"https://github.com/owner/myrepo/pull/414","number":414,"title":"Fix value","repository":"owner/myrepo","headRefName":"fix-value","headRefOid":"0123456789abcdef0123456789abcdef01234567"}}}
```

Then open `workspaceManagement:{"purpose":"manage_worktrees"}` and send the
`prepare_pr_review` intent with the same source, a caller-generated `sessionId`,
the resolved explicit PR number and the expected URL/head. Expected identity is
an assertion, not repository authority:

```json
{"type":"prepare_pr_review","intentId":"prepare-1","input":{"number":"414","sessionId":"review-intent-one","expectedPullRequest":{"url":"https://github.com/owner/myrepo/pull/414","headRefOid":"0123456789abcdef0123456789abcdef01234567"}}}
```

Preparation requires both `conversation.control.v1` and `worktrees.manage.v1`.
It rechecks persisted workspace generation, grants and revocation before effects;
no preset is broadened. Unknown fields, absolute paths and arbitrary remotes
are rejected. Replies contain only bounded display metadata and relative
placement, never checkout paths, credentials or internal repository identities:

```json
{"type":"accepted","intentId":"prepare-1","ordinals":[],"result":{"workspaceName":"myrepo","sessionId":"review-intent-one","worktreeId":"review-opaque-id","pullRequest":{"provider":"github","url":"https://github.com/owner/myrepo/pull/414","number":414,"title":"Fix value","repository":"owner/myrepo","headRefName":"fix-value","headRefOid":"0123456789abcdef0123456789abcdef01234567"},"disposition":"created"}}
```

`disposition` is `created` or `reused`. Optional `workingDirectory` is the effective
workspace-relative source-repository placement. Repeat the returned placement
in an ordinary `conversation:{"target":"new","sessionId":...,"worktreeId":...}`
hello, configure model/thinking/Fast/mode, then send the `review_pr` intent. Do
not send inference before preparation and configuration succeed. No old-host fallback
or additional compatibility feature flag is provided.

Only clean, idle, registered/adopted worktrees with the exact repository/head
and matching branch or host-owned PR metadata are reusable. Dirty, busy,
unreadable, in-progress-operation or conflicting candidates are skipped. New
checkouts fetch into private Volt refs without changing ordinary branches,
tracking refs or `FETCH_HEAD`; the parent checkout is never switched or reset.

Keep the session ID and complete request stable for a retry. Changing source,
PR or expected head requires a new launch intent. Pending placement survives
restart and is revalidated before session creation. A failed preparation is
rejected `failed` with one of these codes as its message:
`review_preparation_stale` (head/checkout changed), `review_preparation_conflict`
(identity/placement conflicts), `worktree_limit_reached` (no safe checkout capacity
could be reclaimed), or `review_preparation_failed` (safe generic failure; also
any answer that does not match the request). Preserve the launch intent and offer Retry
once active sessions finish or protected checkouts are explicitly cleaned up;
do not suggest GitHub authentication or automatic forced removal. Normal
capability-denial errors remain distinct. Successful worktrees
are retained on cancellation or later failure. Retry or offer explicit cleanup;
never automatically delete a reused checkout. An unconfirmed review invocation
must be reconciled through the conversation's review work and `review.runs`, not blindly invoked again.

The session's immutable host-only binding pins `review_pr` to the original PR
and authorized source repository, not the generated local branch. Head and
checkout checks run before inference. General/findings handoffs and discussion
creation/reset/resume preserve checkout authority. Ordinary fix prompts may
edit files; reruns do not reset those edits or silently follow a moved PR.
Prepare a new review when the bound head no longer matches. Portable transcripts
and imported/forked conversations do not carry this host-only binding.

## Worktree management (`manage_worktrees`, worktrees.v1)

A `manage_worktrees` management stream drives daemon-managed git worktrees for the stream workspace with the `create_worktree` and `remove_worktree` intents and the `worktrees` query. Checkout paths are computed host-side under the agent dir and never cross the wire in either direction; inputs carry ids and git refs only, and summaries never carry a path. If `workingDirectory` is inside a nested git repository or submodule under the registered workspace, the daemon creates the worktree from that nested repository root while keeping the worktree record and sessions under the registered parent workspace.

`create_worktree` runs `git worktree add` in the selected source checkout on a new branch (default `volt/<id>`; the base defaults to the source checkout's current branch and is recorded for later merge-back guidance):

```json
{"type":"create_worktree","intentId":"wt-1","input":{"worktreeName":"fix-login","baseRef":"main"}}
{"type":"accepted","intentId":"wt-1","ordinals":[],"result":{"worktree":{"id":"fix-login","branch":"volt/fix-login","baseRef":"main","createdAt":1751900000000,"sessionIds":[]}}}
```

Failures are rejected `failed` with reasons such as `not_a_git_repository`, `worktree_exists`, `worktree_branch_conflict`, `worktree_limit_reached`, `invalid_worktree_id`, `invalid_working_directory`, or `git_failed`. The wire `workingDirectory` remains registered-workspace-relative for both root and nested-repo worktrees; host-local nested repo roots and checkout paths are never exposed.

The 16-worktree limit counts retained checkouts, not archived provenance records.
The host attempts safe reclamation before returning `worktree_limit_reached`.
Inactive disposable checkouts may be archived while their branches, exact commits,
session bindings and review receipts remain durable. Archived records report
`available:false`; resuming a bound session recreates the original checkout when
its repository and branch still match. Clients must not interpret checkout
unavailability as transcript deletion or redirect the session to another worktree.

The `worktrees` query reports each worktree with availability, dirtiness, bound session ids, and merge-back counts (`aheadBehind` compares the worktree branch against its recorded base ref):

```json
{"type":"query","queryId":"wt-2","query":"worktrees"}
```

```json
{"type":"result","queryId":"wt-2","data":{"worktrees":[{"id":"fix-login","branch":"volt/fix-login","baseRef":"main","createdAt":1751900000000,"sessionIds":["s-abc"],"available":true,"dirty":false,"aheadBehind":{"ahead":1,"behind":0}}]}}
```

`remove_worktree` refuses dirty or in-use worktrees unless `force:true`, which stops bound runtimes first:

```json
{"type":"remove_worktree","intentId":"wt-3","input":{"worktreeId":"fix-login","force":false}}
{"type":"accepted","intentId":"wt-3","ordinals":[],"result":{"worktreeId":"fix-login","removed":true,"stoppedRuntimeCount":0,"closedStreamCount":0}}
```

`create_worktree` and the `worktrees` query (but not `remove_worktree`) are also served on conversation streams.

A conversation hello with `{"target":"new","sessionId":"agent-one","worktreeId":"fix-login"}` opens the caller-named session with the worktree checkout as its working directory; `{"target":"new","sessionId":"agent-two","workingDirectory":"packages/app"}` opens at `/workspace/packages/app` while project resources still load from the workspace root. Combining both maps the registered-workspace-relative `workingDirectory` into the worktree's source repo: for a nested source root `Volt` and selected folder `Volt/packages/coding-agent`, the checkout is created from the host's nested `Volt` repo and the agent cwd is `<worktree>/packages/coding-agent`, while the handshake/session-list `workingDirectory` remains `Volt/packages/coding-agent`. Worktree runtimes use the source checkout root as `projectCwd`, so `.volt`, settings, prompts, and MCP config are read from that isolated repo checkout; sessions are still stored under the parent registered workspace. The daemon persists the session→worktree binding so later `session`/`last` resumes land in the same checkout and subfolder. The runtime also receives the host record's workspace name and `baseRef`; when that local ref resolves, `state.gitContext.base` reports `baseRef...<captured-head-oid>` divergence coherently with the rest of the snapshot. Missing or locally stale refs produce `base:null`; Volt does not fetch to resolve them. Worktree runtimes inherit the parent workspace's trust decision and tool allowlist — never wider — and their outbound frames sanitize the worktree path, the parent checkout path, and the worktrees root to `/workspace` (or `/workspace/<nested-source-root>` for nested repo worktrees).

## Device logs

The `upload_device_logs` intent on a conversation stream stores client diagnostic logs inside the stream-bound workspace so host-side tooling and agents can read them:

```json
{"type":"upload_device_logs","intentId":"logs-1","input":{"fileName":"volt-device.log","content":"+0.1s info app: App did finish launching\n"}}
{"type":"accepted","intentId":"logs-1","ordinals":[],"result":{"path":".volt/device-logs/volt-device.log","byteCount":42}}
```

`content` must be a non-empty UTF-8 string of at most 4 MiB, and the whole frame must fit the frame limit. `fileName` is optional; when present it must be a single path component of letters, digits, `.`, `_`, or `-` that does not start with a dot, and when absent the host generates a UTC-timestamped `device-<timestamp>.log` name. The host writes the file atomically under `.volt/device-logs/` inside the workspace root, overwriting any file with the same name, and never writes outside the workspace. The result carries the workspace-relative path only, never a host-local absolute path. The intent requires `diagnostics.upload.v1`.

## Reviews

All Git-backed review diffs disable textconv and external diff drivers. `review_commit` discloses that it inspects workspace commit history and sends commit metadata and diff to the review model; its required `ref` is trimmed, bounded to 1024 UTF-8 bytes, resolved to a commit object, and replaced with the canonical object id before `git show`. `review_pr` discloses use of the host's GitHub credentials and network and submission to discovery and independent verification of pull request metadata/diff, authoritative closing/manual-linked issues, PR comments, submitted review summaries, inline review threads/replies, and linked-issue comments. Its optional string `number` must be a canonical positive decimal no greater than `2147483647`, and omission selects the current branch's pull request for unprepared sessions. Prepared sessions use their host-owned explicit PR binding instead. Explicit `null` is not omission and fails string argument validation.

PR context is host-captured and bounded to 32 KiB per GitHub text field, 20 linked issues, 200 total discussion entries, and 256 KiB rendered. Volt neither infers links from arbitrary text nor follows relationships recursively. Both isolated analysis passes must inspect the same captured context completely and treat GitHub-authored text as untrusted evidence, not policy or tool instructions. Capture limitations or incomplete inspection make the result incomplete and withhold its correctness verdict; a final exact head-OID check rejects a PR that moved during capture. Newly accepted findings then receive code-derived prose from a fresh context-blind verifier-model pass that sees only one-time host ids, validated finding structure, trusted base policy, and immutable repository tools; it has no GitHub context, target title/body, private analysis prose, extensions, or command-capable tools. It must inspect every accepted hunk and cannot change finding identity, anchor, severity, or status. Runs with no new findings skip that pass.

Review intents run detached as `review` work: synchronous target or credential failures are `rejected` and start no work; otherwise the intent is `accepted` with a `workId`, the conversation stays fully usable while the review runs, and the client's session is never moved. The accepted result contains no target text. Configured-model fallback warnings are suppressed remotely, and subprocess/provider failures are replaced with stable remote messages while detailed diagnostics remain host-local. PR lifecycle events carry only a strict bounded `{provider,number}` association reference; provisional reviews add it after target preparation succeeds. The `review.runs` and `review.result` queries may additionally project bounded PR title/URL, author/avatar, head/base refs, reviewed head OID, captured review state/mergeability/check counts, observation time, and truthful changed-file totals. File items are capped and report projected/omitted counts plus completeness. Durable list rows omit file items and the PR body; the full result may include the bounded body retained with the reviewed identity. Linked-issue and discussion text never cross the wire. While a review runs, its progress is the live `work/<workId>` value: the pass it runs and the names of its running tools, with its accounting so far as the value's detail; tool arguments never enter it. Raw read contents, grep output, review prompts, diffs, and free-form discovery/verifier prose remain hidden from frames, opened review sessions, transcripts, notifications, and publication payloads. Volt explicitly declassifies host-validated finding structure and context-blind finding prose. The remote review workflow uses the host-owned read-only review tool set (`read`, `grep`, `find`, `ls`) and never inherits extension tools or ordinary conversation tool grants. `cancel_work{workId}` and `review_open_session` (or `open_work{workId}`) (control capability) cancel a running review and seed a fresh session with completed findings on demand; opening a review moves the client to that session.

## Fast mode, models, and thinking

`set_fast_mode{enabled}` changes only the bound session's branch-local inference-speed policy without changing thinking level, persisting defaults, or switching models. It is available only for supported models on the canonical OpenAI Responses and OpenAI Codex endpoints; enabled requests Priority processing and disabled requests the default service tier for normal conversation turns. The snapshot's `fastMode` and the `fast_mode_change` entries carry the current state.

The `models` query returns the auth-configured model catalog, each model with `availableThinkingLevels`. Custom-model API keys and custom request headers never reach these model objects, but the catalog does expose model ids, display names, providers, base URLs, costs, and capability metadata to the paired client. The host reloads `auth.json` and `models.json` from disk before answering, and announces a change on disk (for example after `/login` or `/logout` in a desktop CLI) with `changed{models}`, which never carries credential material.

`set_model{provider, modelId}` and `set_thinking_level{level}` change the bound session only (`model.select.v1`); the host defaults are the separate `set_default_model` and `set_default_thinking_level` intents, which also require `host.manage.v1`. Unknown provider/model pairs are rejected with the message `Model not found: <provider>/<modelId>`. `set_model` clears any active Fast mode overlay and re-clamps the session thinking level to the new model. `set_thinking_level` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; levels the current model does not support are clamped, not rejected, and the session's thinking level entry carries the effective level. `cycle_model` and `cycle_thinking_level` stay local; native clients have the full catalog and select explicitly.

Persisted chat/global Fast mode defaults, profile switching, scoped-model editing, package management, provider login/logout, and project settings mutation are not served remotely. They require separate host-owned policy before they can be.

## Capability grants

Headless agent tool access and protocol access are separate surfaces. `allowedTools` controls which listed built-in or extension tools the model may invoke in daemon-owned headless runtimes; it is carried through TUI relay metadata for visibility but does not narrow a TUI-owned conversation's full local tools. Every active/revoked client and pending pairing ticket also carries a grant with the strict shape `{"schemaVersion":1,"revision":<integer >= 1>,"capabilities":[...]}`. Missing grants, unknown or duplicate capability IDs, and malformed revisions fail closed; development pairings created before this schema must re-pair.

The exact capability IDs are `conversation.observe.v1`, `conversation.control.v1`, `model.select.v1`, `integrations.manage.v1`, `worktrees.manage.v1`, `host.manage.v1`, `workspace.manage.v1`, and `diagnostics.upload.v1`. An intent or query is served only when its descriptor is remote-safe (a hard ceiling no grant lifts) and the grant holds every capability it requires; a denial is `not_allowed` with `requiredCapability` naming the first missing one. The [remote profile table](#what-the-client-may-do) lists what each capability allows. Configured-agent setup uses the capabilities of each independent operation: `worktrees.manage.v1` for worktree provisioning, conversation control for attach and prompts, and model selection for session-only model and thinking changes.

Pairing snapshots either an explicit headless-agent-tool/capability selection or one immutable preset: `coding` (default), `review`, and `chat` grant observe, control, model selection, and host management, while `full` grants every capability. For daemon-owned headless runtimes, `coding` and `full` use the canonical default tool list and therefore enable `image_gen` automatically when an OpenAI Codex model is selected; `review` uses `read,grep,find,ls`, and `chat` grants no model tools. These preset tool differences do not constrain TUI-owned conversations, which retain the TUI session's full local tools. A fresh re-pair ticket always supplies its newly selected grant. Local control clients may atomically update both access planes with an expected grant revision; successful updates increment the revision and close that device's existing Iroh connections at once (close reason `access_updated`), along with its streams, runtimes, and relays, so reconnects use the authoritative grant.

## Outbound path handling

Every frame a remote stream writes passes through that stream's redactor once, at the send; nothing reaches the stream around it. The redactor normalizes remote-meaningful workspace paths and keeps generic host paths intact:

- Paths under the selected stream's hosted workspace are rewritten under `/workspace`. A worktree stream also rewrites its parent checkout and the daemon's worktrees root.
- A multi-stream host applies this mapping independently per stream; sibling workspace paths are not rewritten to `/workspace` unless they are the selected workspace for that stream.
- Host-local paths outside the workspace are left unchanged; Volt does not emit a generic placeholder for them.
- Export paths are redacted when recognized with `[redacted export path]`.
- Structured SQLite session locators are omitted; recognized JSONL snapshot paths are replaced with `[redacted session file]`.
- Bash output file paths are omitted or replaced with `[redacted bash output path]`.
- Path handling applies to entry views, live items, host requests, intent results, query results, and error messages. Identifiers the client echoes back (`subscriptionId`, `intentId`, `queryId`, `requestId`, `toolCallId`, live keys) are never rewritten.
- Provider signature fields (`*Signature`, `signatureDelta`) are removed at any depth. Image data in tool results and queued input is dropped.
- Streamed text and tool arguments are redacted as they grow: the redactor holds back a trailing token that could still become a path, and any end of the text that begins a root, until it completes, so a delta never sends half a root. When redaction rewrites text the client already holds, the next frame replaces the block whole (`assistant_start`) instead of appending.

The placeholders are part of the v1 wire surface. Clients must display them as opaque strings and must not assume that a redacted path can be expanded locally.

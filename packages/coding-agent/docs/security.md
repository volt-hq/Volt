# Security

Volt is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether volt loads project-local settings, resources, packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Volt considers a project to have resources that require trust when it finds any of these from the current working directory:

- `.volt/settings.json`
- `.mcp.json` or `.volt/mcp.json`
- `.volt/extensions`, `.volt/skills`, `.volt/prompts`, or `.volt/themes`
- `.volt/SYSTEM.md` or `.volt/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.volt` directory does not count as a project resource that requires trust.

When an interactive conversation opens in a project with resources that require trust and no saved decision for the current directory or a parent directory, volt follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.volt/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

An interactive conversation runs in a [conversation worker](daemon.md#conversation-workers) of the background daemon, and that worker decides its project trust: `project_trust` handlers of user/global and CLI `-e` extensions first, then saved decisions, then `defaultProjectTrust`, asking in the TUI that opened the conversation. `--approve` and `--no-approve` decide the startup project's trust without asking. A decision you make for this session only applies to the same terminal's later conversations of that project in the same worker, never to another terminal's; it is asked again after that worker exits, or when a conversation of the project opens in another worker. Dismissing the prompt saves nothing and leaves that conversation untrusted for as long as its worker hosts it. See [Project trust](daemon.md#project-trust).

Trusting a project allows volt to load project resources that require trust, including:

- `.volt/settings.json`
- project MCP server config in `.mcp.json` or `.volt/mcp.json`
- `.volt` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. `AGENTS.md` and `CLAUDE.md` context files are loaded regardless of project trust unless context loading is disabled. Before trust is resolved, volt only loads context files, user/global extensions, and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## No Built-in Sandbox

Volt does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the volt process. Extensions are TypeScript modules that run with the same permissions. Package installs, shell commands, language servers, test commands, and other developer tools behave as ordinary local processes.

This is intentional. Volt is designed to operate on local source trees, invoke project toolchains, and integrate with the user's existing development environment. A partial in-process sandbox would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code. Real isolation needs to come from the operating system or a virtualization/container boundary.

Project trust is only an input-loading guard. It prevents a repository from silently changing volt's settings, MCP servers, or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe. Prompt injection from repository files, comments, documentation, context files, or build output is expected local-agent risk and cannot be reliably prevented by volt.

## Extensions and Packages

Extensions are trusted code: they run in the volt process with the user's permissions. Volt's extension controls say what an extension declares and keep its UI inert, but they are not a sandbox.

- **Manifests.** Every extension declares a manifest: a package in the `volt` field of `package.json`, which volt reads without running package code; a single file as `export const manifest`, which volt must evaluate to read, so single-file extensions load only from the user's and a trusted project's extension directories and settings and from `-e` paths, never from npm or git packages. The manifest id is the extension's identity. See [Extensions](extensions.md#manifest).
- **Permissions are advisory.** A manifest declares `exec`, `network`, `fs-write`, `secrets`, and `providers`. Volt refuses `volt.exec` without `exec`, provider registration without `providers`, and stored credentials without `secrets`; `network` and `fs-write` are shown but not enforced, and nothing stops an extension from using Node's own modules. Acknowledgments are stored in `~/.volt/agent/extension-permissions.json` (mode `0600`), bound to the package's name and version, git commit, or local path. `volt install`, `volt store`, and `/store` ask at install and update, enabling an extension at runtime asks for permissions not yet acknowledged, and startup never asks. See [Permissions](extensions.md#permissions).
- **Settings hold no credentials.** Extension settings are plain JSON in `settings.json`, and project settings are often committed: volt refuses string settings named like credentials, and applies project values only in a trusted project.
- **The store catalog is reviewed.** Each `/store` catalog entry pins a reviewed commit and carries a review record; installs and updates move only to the catalog's pin, and `--ref` and `--track` are refused for catalog packages. A non-interactive `volt store update` keeps the installed pin when the new pin declares new permissions. CI checks every entry against its pinned commit without running package code. A review is not a guarantee: read what you install. See [Volt Store](packages.md#volt-store).
- **UI is data.** Extension UI (status items, panels, dialogs, forms, and tool, message, and work presentations) is `UiNode` data that the host normalizes before any client sees it: ANSI and other terminal control sequences become semantic tokens or are removed, the data is checked against the schema and bounded, and actions may send only the extension's own commands and intents and `open_work`/`cancel_work` for its own work. Clients, including paired phones, never run extension code. See [UI Nodes](ui-nodes.md).
- **Remote devices.** A paired device sees extension UI on the remote profile: presentations within 16 KB, without image data, and with host paths redacted. It invokes an extension's commands, intents, and completion providers only when the extension opted them in (`remoteSafe: true` or `remote: true`) and its grant allows; it lists extensions with `conversation.observe.v1`, and reads extension settings and enables, disables, or configures extensions only with `host.manage.v1`. A device cannot acknowledge permissions: enabling an extension whose permissions are not acknowledged is refused remotely.

## Session Storage

Each workspace or custom session directory contains the authoritative
`sessions.sqlite` database. Volt creates the directory with owner-only `0700`
permissions and hardens `sessions.sqlite`, `sessions.sqlite-wal`, and
`sessions.sqlite-shm` to `0600`. Explicit JSONL snapshot exports use `0600`.

Treat the database and its WAL/SHM sidecars as one sensitive live store. Do not
copy only `sessions.sqlite` while Volt is running. Session content can include
prompts, model responses, tool arguments/results, workspace paths, and
extension state.

JSONL snapshot exports are equally sensitive. Every snapshot header includes the
session cwd, and a child-session snapshot may include the parent session's live
SQLite store directory so local import can restore the relationship. Those
host-local locators never cross remote RPC, but sharing the snapshot shares them.

## Standalone Release Integrity

Prebuilt Volt executables are Node.js 22.23.1 Single Executable Applications.
Release builds verify a pinned official Node runtime archive, bundle Volt's
JavaScript, and generate an exact esbuild metafile plus a checksum-linked npm
license manifest. Each archive includes Volt's license, the consolidated Node
license and third-party notices, and the copied license files recorded by that
manifest. Verify the downloaded archive against the release `SHA256SUMS` before
running it.

Standalone builds intentionally exclude the native Iroh adapter. The official
Linux runtime requires glibc 2.28 or newer and does not support Alpine/musl.
Windows executables are not Authenticode-signed, so Windows may show an
unknown-publisher warning; the published SHA-256 checksum is the release
authenticity check. macOS executables are ad-hoc signed after SEA injection,
not Developer ID notarized.
See [Standalone Binary Capabilities](../BINARY-CAPABILITIES.md) and
[Third-Party Notices](../THIRD-PARTY-NOTICES.md).

## MCP Servers

Native MCP support can spawn local stdio server commands or connect to configured HTTP/SSE endpoints. User MCP config lives in `~/.volt/agent/mcp.json` and shared `~/.config/mcp/mcp.json`; project `.mcp.json` and `.volt/mcp.json` are loaded only after project trust. Project definitions with the same server id replace, rather than inherit, user-scope definitions so project endpoints cannot reuse user auth/env config by id collision.

MCP server metadata and output are untrusted. Volt exposes MCP through one `mcp` gateway tool, uses risk classification only as display/audit metadata, redacts obvious secrets in audit arguments/errors, and stores audit records under `~/.volt/agent/mcp/audit.jsonl`. Runtime availability is controlled by the top-level `mcp` tool, server include/exclude filters, project trust, auth, and transport/remote-safety rules. Large outputs may be cached under `~/.volt/agent/mcp/output/` and are scoped to the creating session/workspace when Volt constructs the default MCP manager.

Avoid putting long-lived secrets in project MCP config. Auth headers and OAuth-protected remote MCP servers are rejected over non-HTTPS URLs except loopback HTTP. OAuth authorization/token/device/registration endpoints must use HTTPS; browser auth uses PKCE S256 and a loopback callback, and device auth exposes only the verification URL and user code (never the OAuth device code). OAuth tokens are stored host-side in `~/.volt/agent/mcp-auth.json` with owner-only permissions and are never sent to the model or mobile client.

Stdio server environments start from the MCP SDK default safe environment plus explicit `envAllowlist` and configured `env` templates.

## Running Untrusted or Unmonitored Work

For untrusted repositories, generated code you do not intend to monitor closely, or unattended automation, run volt in a contained environment. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](containerization.md):

- run the whole `volt` process inside OpenShell or Docker
- run host volt while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.volt/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## Background Daemon and Conversation Workers

Interactive Volt runs each conversation in a conversation worker, a process that the background daemon (`voltd`) starts and supervises; the TUI is a client of the conversation (see [Conversation workers](daemon.md#conversation-workers)). The daemon and its workers run as your user.

- **Local control channel.** The TUI, the `volt daemon` and `volt remote` commands, and the workers reach the daemon over its local control socket (mode `0600`; a named pipe on Windows). Every connection proves that it holds the daemon's per-start token, a worker's single-use spawn token, or a relay's single-use token without sending it: the proof is an HMAC bound to the daemon's challenge for that connection and to the socket path dialed, and the daemon proves itself back the same way. A captured proof is useless on another connection, and an endpoint impersonating the daemon learns nothing reusable.
- **Your environment crosses the control socket.** When a TUI opens a conversation it sends its full environment, working directory, and command-line options, so a worker it starts runs with that environment, less the daemon's own relay credentials (`VOLT_IROH_RELAY_AUTH_TOKEN` and `VOLT_PUSH_RELAY_AUTH_TOKEN`). The daemon never logs the environment, uses it only to start the worker and to tell which later opens may share that worker, and never sends it over Iroh. A worker a paired device opens runs with the daemon's environment (see [Daemon environment](daemon.md#daemon-environment)), less the same two variables. Worker tokens reach a worker on its standard input, never in its arguments or environment.
- **Worker logs.** Each worker writes its output to `~/.volt/agent/daemon/workers/<worker id>.log` (mode `0600`, in a `0700` directory). A worker logs the names of its environment variables, never their values. The daemon keeps the logs of running workers and the 49 most recent others. See [Worker logs](daemon.md#worker-logs).
- **Workspace registration.** Opening a conversation in a directory that no registered workspace contains registers that directory as a workspace, which paired devices with access to all workspaces can then reach. For a sensitive directory (a filesystem root, your home directory or a directory containing it, or a directory containing or inside the Volt agent directory) the TUI asks first. Its default answer registers a local-only workspace: paired devices cannot see, list, or open it, and pairing a device into it is refused. Answering yes, or `volt remote workspace add` for that directory, shares it. See [Opening a conversation](daemon.md#opening-a-conversation).
- **Paired devices in your conversations.** A paired device attached to a conversation a desktop TUI opened drives that conversation's model and tools with the terminal's environment and credentials, including an `--api-key` given on the command line.

## Remote Access over Iroh (Preview)

Remote access is served by the background daemon (`voltd`, see [Background daemon](daemon.md)) and is opt-in. Treat a paired remote client as a user who can operate Volt inside the exposed workspace with the tools granted by the host — pairing a phone grants it desktop-equivalent power over any conversation a desktop TUI opened that it attaches to.

Supported preview safety model:

- Nothing listens until the host user starts the daemon (`volt daemon start`, or interactive Volt, which starts it when none runs). The daemon listens only on its local control socket (mode `0600`; a named pipe on Windows) and the Iroh endpoint.
- Workspaces are registered locally by the desktop user with saved names; clients cannot request arbitrary host paths.
- Registering a workspace is a local desktop action. Remote clients cannot create, rename, delete files, browse host paths, or path-map host workspaces from the app. A reviewed remote unregister request may remove an empty known workspace name from host state only; it does not delete files. Persisted child worktrees make unregister fail with `workspace_has_worktrees`, preserving their records and checkouts until the user explicitly removes each worktree. Unknown/orphan worktree directories are never unregister cleanup targets.
- The default agent tool grant includes `read,bash,edit,write,image_gen,web_search,web_fetch,grep,find,ls,inspect,lsp,subagent,subagent_registry,mcp` plus active tools registered by loaded extensions. The `coding` and `full` remote presets use this canonical default, so the Codex-only `image_gen` tool is enabled automatically when an OpenAI Codex model is selected. A custom `remote.allowTools` list is strict and applies ONLY to conversations a paired device opens; extension tools must be named explicitly there. The `subagent` tool only starts built-in or discovered named definitions, `subagent_registry` only exposes the shared delegation registry inside child conversations, and child tools are clamped by the remote session's active tool grant.
- **Tool policy asymmetry (explicit decision).** A conversation's tools are fixed when its worker starts, by whoever opened it. In a conversation a desktop TUI opened, phone prompts execute with the TUI's FULL local tool set — the phone is the same paired user driving the same conversation, and splitting tool policy mid-conversation creates confusing, falsely-reassuring states. This supersedes `remote.allowTools` for those conversations. Corollary: pairing a phone grants it desktop-equivalent power over any conversation a desktop TUI opened.
- Pairing tickets are short-lived, one-time credentials. Persisted state stores secret hashes and non-secret metadata, not raw pairing secrets.
- Pairing through `volt remote pair` talks to the running daemon; offline ticket generation from persisted state is not supported.
- Daemon startup never creates an active pairing ticket. Add phones explicitly with `volt remote pair`.
- Paired clients are persisted until revoked with `volt remote revoke <node-id>`.
- After pairing, saved-host reconnect uses the persisted client node ID and a secret-free client saved-host record. Ordinary app reconnect, temporary network loss, or daemon restart should not require scanning another QR (the daemon owns a persistent Iroh identity).
- Pairing is workstation-scoped for the daemon's state file. A paired phone can reconnect to any registered workspace name, including workspaces registered after pairing, without another QR scan. The app receives and selects names and host feature strings only, never host-local paths.
- Hosts advertise `multi_streams.v1` and `conversation_streams.v1`. Mobile conversation streams bind at handshake time to one authorized workspace/session target, and the host-observed Iroh client node ID is authoritative for authorization, revocation, and audit. Session lists, subscriptions, and session targets use stable IDs; session directories, SQLite paths, WAL/SHM paths, and host-side `SessionReference` values never cross the remote wire.
- Same-client duplicates for one workspace/session on one live Iroh connection are rejected with `duplicate_conversation_connection`. The first conversation stream on a new same-client connection can replace a stale active stream for the same workspace/session and reattach to the conversation's worker. Different sessions in the same registered workspace may run concurrently.
- Distinct paired devices and desktop TUIs attach to one conversation in the worker that hosts it; the daemon relays every stream to that worker. `conversation_in_use` is reserved for the narrow case where another paired device opened the conversation with tools outside the attaching client's persisted grant; the client cannot safely drive the broader conversation. Audit records (`~/.volt/agent/daemon/audit.jsonl`) cover pairing, revocation, access changes, relay lifecycle, and conversation workers (`worker_spawned`, `worker_ready`, `worker_exited`, and their opens and closes) so "what did the phone do while I was away" is reviewable after the fact.
- Mobile conversation streams cannot be retargeted after handshake. Intents act on the stream's own conversation only; a phone may subscribe to and read the subagent children of that conversation, observe-only, and nothing else. A phone's own session change (`new_session`, `switch_session`, opening a review session, or an extension command that starts, forks, or switches sessions) never moves its stream: after the intent's `accepted` the stream ends with `ended{moved}`, and the phone reconnects to the new session through a new handshake that is authorized like any other. The new session opens when the phone reconnects, like any conversation the phone opens; a session an extension command started opens at once in the worker of the session the phone left. Other phones on the session stay on it, and a session id never stands for another session.
- Paired clients with `host.manage.v1` can request normalized subscription quota windows for stored OAuth logins. This account-level read never returns credentials, account identity, or raw provider payloads, and it never queries API keys.
- Workspace discovery streams serve only the read their purpose names (`sessions`, `agent_options`, `session_contexts`, or `pr_review`) and do not open conversations or update conversation state. Workspace management streams serve only their purpose's intents and queries (`unregister_workspace`, `workspace_directories`, or worktree management), each within the client's grant.
- Hosts that do not advertise `conversation_streams.v1` are incompatible with the mobile pinned-agent model. The app should keep the saved host and show an update/integrated-host-required state instead of asking for a QR scan or using old mutation commands.
- Registering another workspace does not grant more built-in tools. For a conversation a paired device opens, the effective tool policy is the intersection of the client's persisted `allowedTools` grant, any workspace ceiling, and the daemon's `remote.allowTools` ceiling; missing ceilings add no restriction and an explicit empty daemon ceiling denies all tools. The client grant remains the maximum authority across every registered workspace until the client is revoked and paired again with a different grant. When every active policy layer has default-grant semantics, active extension tools in the selected workspace are also exposed.
- Revocation removes future access from persisted state and, when the daemon is running, closes the device's connections and streams and closes, in their workers, the conversations the device opened or was served in (a turn running there stops at once; the other clients of those conversations see their streams end and reconnect). Independently, the worker serving a stream checks its authorization before each frame it writes and has the daemon re-read the persisted grant before each intent, query, subscription, and host response it serves, so a revoked or changed grant, a removed workspace authorization, or an unregistered workspace ends the stream (`fatal{revoked}` or `fatal{workspace_unregistered}`) before it acts again; the daemon closes the relay itself if the worker has not within 2 seconds. A revocation or access change made on the host closes the device's Iroh connections at once, before any final frame. A revoked phone is blocked from every registered workspace in that state file.
- A revoked phone node ID cannot reconnect or re-pair with only a generic new QR. The desktop host must approve that node with `volt remote approve-repair <node-id>`, then issue a fresh active pairing ticket.
- Iroh stream close is detach, not cancellation. Closing one conversation stream does not close or abort other active conversation streams for the same phone. Active work can continue on the host until it finishes or an authorized client sends `abort` on the selected bound stream.
- A detached conversation stays open in its worker until it has been idle for the host's retention time (30 minutes by default; see [Retention and background](daemon.md#retention-and-background)); only local TUIs and devices authorized for its workspace can attach to it, devices under the tool policy rule above.
- Every paired device is served on the remote profile, which the host picks when it admits the stream; nothing the client sends widens it. The profile serves only remote-safe intents and queries, each only when the device's grant holds every capability it requires (`not_allowed{requiredCapability}` otherwise). Branch-changing intents must carry the client's position (`expectedOrdinal`). Approval requests go only to devices granted `host.manage.v1`, dialogs only to devices granted `conversation.control.v1` that accept that dialog kind, and MCP sign-in only to devices granted `integrations.manage.v1`.
- What a device sees is transcript fidelity: entry views without raw message payloads, no extension `custom` entries, product records, or host-only custom messages, and `history`/`content` reads only of entries it can see. Every frame passes through the stream's redactor once, at the send: workspace, worktree, parent checkout, and worktrees-root paths become `/workspace`, export, session-file, and bash-output paths become placeholders, and provider signature fields and image data are dropped. Text is redacted before it is cut to a bound, and streamed text holds back a trailing token that could still become a path and any end that begins a root, so no frame carries part of a root.
- Remote streams are bounded against amplification: a frame is at most 4 MiB and an inbound line is measured before it is parsed, a snapshot carries at most 200 entries and a resume replays at most 1,000, a connection holds at most 16 subscriptions and spends subscriptions, replays, and queries from a budget of 16 refilled one every 2 seconds, and at most 256 frames may wait for the intent and query lane. The host's agent loop never waits for a device: a stream more than 64 MiB behind, or a device more than 128 MiB behind across its streams, is reset and resumes after its position.
- Extension form fields whose `pattern` could backtrack more than linearly in the value (a repeated group that repeats or alternates, a backreference, a lookaround, more than three repeats, more than four quantifiers, optionals, and alternatives in all, or two repeats that can trade characters, such as `a*a*` or `\w+.\w+`) are refused when the form is asked, and patterns are tested against values of at most 256 characters, so a device's answer cannot stall the host.
- `volt daemon status` and `volt remote status` include required structured `remoteTransport` health and exit nonzero unless it is `ready` and managed relay access, when configured, is not `expired`, `subscription_inactive`, or `revocation_pending`. The one exception is a build without phone transport (`unavailable` with `native_binding_missing`: a standalone binary, an `--omit=optional` install, or Darwin x64), where `volt daemon status` exits 0 because the daemon still serves local clients and workers, and `volt remote status` exits nonzero. Safe reason codes expose missing bindings, endpoint startup failure, or observed storage exhaustion without leaking raw exception details. Local management remains available while phone transport is unavailable.
- State and audit JSONL are stored under `~/.volt/agent/daemon/` (`state.json` mode `0600` — it contains the Iroh secret key — and `audit.jsonl`).

Unsafe remote tools are powerful. Granting `bash`, `edit`, or `write` lets the remote session modify files or run shell commands on the host. Granting `image_gen` lets it read and upload local reference images and write generated PNG files. Extension tools run code installed on the host and may do the same; expose them only when those extensions, the client device, and the network path are trusted.

Remote sessions do not bypass project trust. Project-local settings, extensions, skills, prompt templates, themes, system prompts, and package-managed resources follow the same project trust rules as local Volt. A conversation a paired device opens honors a saved trust decision for the workspace; otherwise its worker runs those resources untrusted. A device attached to a conversation a desktop TUI opened works with the trust that conversation's worker decided. Save trust from a desktop Volt session in that workspace.

The daemon requires a Node.js npm package install or source checkout with the exact required `@hansjm10/volt-iroh` wrapper and its optional selected native binding. `--omit=optional` installs retain the wrapper but cannot provide phone transport. Darwin x64 has no binding and is local CLI/TUI only. Standalone Node SEA builds intentionally do not bundle Iroh: their daemon serves local clients and workers only, re-executing its own binary by absolute path for each worker. If status reports `native_binding_missing`, reinstall with optional dependencies enabled on a supported platform.

A daemon or worker exit, crash, or explicit shutdown stops the in-memory work of the conversations it hosted; a worker crash interrupts every conversation that worker hosts (see [Crashes, restarts, and stopping](daemon.md#crashes-restarts-and-stopping)). Remote access does not provide durable job recovery beyond persisted session state.

Push notification delivery is mediated by the managed Volt relay by default. The mobile app registers its FCM token with the relay, then sends the desktop host only an opaque relay target id plus a target-scoped delivery credential. Volt host state stores that relay credential and optional token hash, but not the raw FCM registration token. Custom relays can be selected with `VOLT_PUSH_RELAY_URL`; if a custom relay uses shared bearer auth, pass it with `VOLT_PUSH_RELAY_AUTH_TOKEN`. Every conversation stream is served by its conversation's worker, which forwards `register_push_target` and the device's other daemon-backed intents to the daemon; the daemon runs them on the device's grant, and only for streams relayed to that worker.

The daemon defaults to Iroh relay mode `production`, using the Volt-operated relay fleet so saved-host reconnects can survive restarts. Set `VOLT_IROH_RELAY_MODE` to `disabled` for LAN-only connections, `development` for the public n0 development relays, or `production`. Release builds of the iOS app reject `development`; without Volt Pro or a self-hosted relay, use `disabled`. `disabled` pairings survive daemon restarts because the daemon persists its direct UDP port in daemon state, but phones must pair again if the host's LAN IP changes or another process takes that port. Use `volt remote pair` to create pairing tickets.

Client UX should treat offline, capacity, authorization, workspace, and conversation failures differently. `host_unreachable` keeps the saved host, uses a bounded five-attempt automatic cycle, and points operators to `volt daemon status`. `host_storage_full` also keeps pairing, selected-agent, transcript, and authority state, but is Retry-only and never auto-redials until the user frees computer capacity and retries. `host_identity_mismatch`, `saved_host_invalid`, `client_unknown`, and `client_revoked` require explicit user action such as Pair Again or Forget Host. `workspace_unavailable`, `workspace_missing`, `workspace_unregistered`, `workspace_has_worktrees`, `workspace_authorization_removed`, `workspace_forbidden`, `session_unavailable`, `duplicate_conversation_connection`, and `conversation_streams_unsupported` are host capability, workspace, or conversation-selection problems, not reasons to discard the saved host by default. `workspace_unavailable` is transient and paced by `retryAfterMs`; `workspace_missing` means the registered path is gone and automatic redialing should stop. `workspace_has_worktrees` requires explicit worktree review/removal before retrying unregister. `ended{closed}` and `ended{moved}` are expected endings the app reconnects through silently, to the same session or to the `target` an `ended{moved}` names, and so is a stream that ends without a frame because its conversation's worker exited; the daemon admits that reconnect like any other, against the device's workspace grant.

See [Using Volt](usage.md#remote-access-over-iroh-preview) for copy-pastable commands and [Iroh remote protocol v1](iroh-remote-protocol.md) for the external client contract.

## Reporting Security Issues

To report a security issue, follow the repository [Security Policy](../../../SECURITY.md). Do not open a public issue for security-sensitive reports.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how volt grants access that the local user did not already have.

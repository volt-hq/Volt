# Native MCP support

Status: native gateway MVP implemented; this document also captures the intended feature-complete direction for remaining UI, auth, and management work.

Implemented today:

- config loading from `~/.config/mcp/mcp.json`, `~/.volt/agent/mcp.json`, trusted project `.mcp.json`, and trusted project `.volt/mcp.json`
- one model-visible `mcp` gateway tool for status, server listing, cached search/describe, tool calls, resources, prompts (when enabled), and large-output cache reads
- stdio, Streamable HTTP, and legacy SSE transports through the official TypeScript MCP SDK
- project trust gating, restricted stdio env inheritance, include/exclude tool filters, output truncation/cache, metadata cache with stale refresh on detail/call paths, recent calls, audit logs, and local/RPC server status management
- `volt mcp` CLI inspection/management commands and lightweight `/mcp` interactive status/actions
- browser OAuth authorization-code + PKCE and OAuth device-code auth for HTTP/SSE MCP servers, with host-side token storage
- persisted enable/disable overlays in Volt-owned MCP config files
- optional direct tool promotion from fresh cached metadata via `directTools`

Not yet implemented from the roadmap sections below: full-screen `/mcp` TUI manager, direct-tool metadata demotion UI, and MCP lifecycle event streaming.

## Summary

Volt should ship MCP as a core capability, not as a third-party extension. The default model is a token-efficient gateway: Volt exposes one native `mcp` tool to the model, manages configured MCP servers itself, and lets the model search, inspect, and call MCP tools through that gateway. Volt should not register every upstream MCP tool directly by default.

This gives Volt MCP support that works across all tool-capable providers. It avoids provider-specific lazy-tool features such as Claude Code Tool Search, while preserving the same core benefit: upstream tool definitions are loaded only when needed.

Prior art:

- Pi `pi-mcp-adapter` uses one proxy tool with search, describe, call, lazy server startup, cached metadata, and optional direct tools: <https://pi.dev/packages/pi-mcp-adapter>
- `@spences10/pi-mcp` emphasizes project trust, restricted child environments, large-output handling, status UI, and server management: <https://pi.dev/packages/%40spences10/pi-mcp>
- Claude Code Tool Search defers MCP tools and loads only needed definitions, but relies on provider/model support for `tool_reference`: <https://code.claude.com/docs/en/mcp>
- Goose Code Mode uses a small set of meta-tools for on-demand discovery and programmatic execution: <https://goose-docs.ai/docs/guides/managing-tools/code-mode/>
- MCPProxy's retrieve/call routing modes validate the proxy pattern for large tool sets: <https://docs.mcpproxy.app/features/routing-modes/>
- Official TypeScript SDK v1 provides `Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`, and legacy `SSEClientTransport`: <https://ts.sdk.modelcontextprotocol.io/client>

## Goals

- Add native MCP server support to Volt.
- Make the default integration token-efficient by exposing one `mcp` gateway tool, not all MCP tools.
- Support local stdio MCP servers and remote Streamable HTTP MCP servers.
- Support legacy SSE only as a compatibility path.
- Let TUI, print/json, RPC, daemon, and mobile clients understand MCP state.
- Let mobile clients see and manage MCP servers connected to the selected agent/session.
- Respect Volt project trust before loading project-local executable MCP configuration.
- Treat MCP tool metadata, results, resources, and prompts as untrusted content.
- Provide first-class auth, tool filtering, audit, output truncation, and large-output retrieval.

## Non-goals

- Do not require users to install a separate MCP extension.
- Do not register every upstream MCP tool directly by default.
- Do not make provider-specific tool search a requirement.
- Do not let mobile clients add arbitrary local stdio commands.
- Do not treat MCP resources or prompts as trusted instructions.
- Do not silently inherit ambient host secrets into MCP stdio processes.

## Product UX

### TUI

Add a native `/mcp` command that opens a server manager.

The server manager shows:

- configured server id and display name
- config source: user shared, user Volt, project shared, project Volt
- enabled or disabled
- transport: stdio, Streamable HTTP, or SSE
- lifecycle: lazy, eager, or keep-alive
- status: untrusted, cold, connecting, connected, ready, needs auth, error, disconnected
- cached and live tool counts
- resource and prompt counts
- last error
- last connected time
- recent calls
- available actions

Actions:

- enable or disable server
- connect or disconnect
- refresh metadata
- start auth
- inspect tools/resources/prompts
- view recent calls
- open config file
- promote selected tools to direct native tools only after an explicit token-budget warning

Startup/header behavior:

- Show that MCP is enabled when configured.
- Show ignored project-local MCP config when project trust is not granted.
- Show auth/error counts compactly.

Footer/status behavior:

```text
MCP 4 configured / 1 connected / 1 auth
```

Tool rendering:

- `mcp` calls render as `mcp <server>.<tool>` when the action is a tool call.
- Search and describe calls render as compact discovery events.
- Results default to a small summary with expandable details.
- Truncation and sidecar/cache ids are visible.

### Print, JSON, and RPC modes

- Load global MCP config and trusted project MCP config only.
- Do not prompt for project trust in non-interactive modes; follow existing `defaultProjectTrust`, `--approve`, and `--no-approve` behavior.
- Do not apply nested MCP tool approvals. If the top-level `mcp` tool is available and the exact server/tool passes include/exclude filters, the call executes.
- JSON/RPC event streams include MCP status, auth, and call lifecycle events.

### Daemon and mobile

The mobile app should be able to inspect and manage MCP for a selected workspace/session through RPC/daemon APIs.

Mobile views:

- MCP server list for the selected agent/session
- server details with sanitized command/URL display
- enabled/disabled state
- connection/auth/error state
- tool/resource/prompt counts
- recent calls and audit summaries
- connect/disconnect/refresh/auth actions where allowed

Mobile must not store MCP credentials. OAuth tokens, bearer tokens, and env secrets stay on the host. Mobile can participate in auth flows by displaying a URL/device code and sending completion/cancel events back to the host.

Mobile must not add or edit arbitrary stdio commands by default. It can enable, disable, connect, disconnect, refresh, and authenticate servers already present in trusted host config, subject to the remote-safe command allowlist.

## Config model

### File locations

Support shared ecosystem config plus Volt-owned config. Load in this precedence order, lowest to highest:

1. `~/.config/mcp/mcp.json` — shared user MCP config.
2. `~/.volt/agent/mcp.json` — Volt user MCP config.
3. `.mcp.json` — shared project MCP config.
4. `.volt/mcp.json` — Volt project MCP config.

Volt should write only Volt-owned files by default:

- user writes go to `~/.volt/agent/mcp.json`
- project writes go to `.volt/mcp.json`

Editing shared files requires an explicit command or UI choice.

### Example

```json
{
  "version": 1,
  "settings": {
    "enabled": true,
    "mode": "proxy",
    "idleTimeoutMs": 600000,
    "connectTimeoutMs": 15000,
    "callTimeoutMs": 600000,
    "maxOutputBytes": 51200,
    "maxOutputLines": 2000,
    "directTools": false,
    "resources": "explicit",
    "prompts": "user-preview"
  },
  "servers": {
    "github": {
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "cwd": ".",
      "env": {
        "GITHUB_TOKEN": "${env:GITHUB_TOKEN}"
      },
      "lifecycle": "lazy",
      "includeTools": [],
      "excludeTools": []
    },
    "linear": {
      "enabled": true,
      "transport": "streamable-http",
      "url": "https://mcp.linear.app/mcp",
      "auth": { "type": "oauth" },
      "lifecycle": "lazy"
    }
  }
}
```

### Server fields

Common fields:

- `enabled?: boolean`
- `transport?: "stdio" | "streamable-http" | "sse"`
- `lifecycle?: "lazy" | "eager" | "keep-alive"`
- `includeTools?: string[]`
- `excludeTools?: string[]`
- `directTools?: boolean | string[]`
- `connectTimeoutMs?: number`
- `callTimeoutMs?: number`
- `idleTimeoutMs?: number`
- `metadataRefreshMs?: number`

Stdio fields:

- `command: string`
- `args?: string[]`
- `cwd?: string`
- `env?: Record<string, string>`
- `envAllowlist?: string[]`

HTTP/SSE fields:

- `url: string`
- `headers?: Record<string, string>`
- `auth?: { type: "none" | "bearer" | "oauth" | "env"; ... }`
- OAuth auth also supports `flow?: "browser" | "device" | "auto"`, `scope?: string`, `clientId?: string`, `clientSecret?: string`, `clientMetadataUrl?: string`, `resourceMetadataUrl?: string`, and `tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post" | "none"`.

### Merge rules

- `settings` merge like Volt settings: nested objects merge, arrays replace.
- `servers` merge by server id within the same trust scope (user-to-user, project-to-project).
- A project server definition with the same id as a user server replaces the user-scope definition instead of inheriting auth, headers, or env.
- A higher-precedence `enabled: false` disables an inherited server.
- `null` removes an inherited field.
- Arrays replace rather than append.
- Server ids are normalized to a safe stable id and collisions are diagnostics.

### Trust rules

Project MCP files are executable configuration because stdio servers can spawn local commands. Loading `.mcp.json` or `.volt/mcp.json` requires project trust.

Without project trust:

- ignore project MCP config
- emit diagnostics/status saying project MCP config was ignored
- continue to load user MCP config

Non-interactive modes follow existing Volt project trust behavior:

- `defaultProjectTrust: "ask"` behaves like not trusted
- `defaultProjectTrust: "never"` ignores project MCP
- `defaultProjectTrust: "always"` trusts project MCP
- `--approve` trusts for this run
- `--no-approve` ignores project MCP

## Runtime architecture

Add a new core package area:

```text
packages/coding-agent/src/core/mcp/
  audit.ts
  auth.ts
  client-factory.ts
  config-loader.ts
  config.ts
  gateway-tool.ts
  manager.ts
  metadata-cache.ts
  output-store.ts
  rpc.ts
  safety.ts
  search.ts
  server-supervisor.ts
  types.ts
```

### Responsibilities

`config.ts`

- TypeScript config types.
- Validation helpers.
- Normalization of server ids and paths.

`config-loader.ts`

- Load all config files.
- Apply trust filtering.
- Merge sources.
- Produce diagnostics with source metadata.

`manager.ts`

- Owns session/workspace MCP runtime.
- Provides methods used by the gateway tool, TUI, RPC, and daemon.
- Emits status/auth/call events.

`server-supervisor.ts`

- Maintains one logical server runtime.
- Handles lazy/eager/keep-alive lifecycle.
- Tracks state, reconnects, idle timeout, and shutdown.

`client-factory.ts`

- Creates SDK `Client` and transports.
- Uses `StdioClientTransport` for local commands.
- Uses `StreamableHTTPClientTransport` for remote HTTP.
- Uses `SSEClientTransport` only as fallback/compatibility.

`metadata-cache.ts`

- Caches tools/resources/prompts per server.
- Stores metadata hash, server version, last seen time, and schema snippets.
- Supports search without connecting at startup.

`search.ts`

- Local lexical/BM25-style search over cached metadata.
- Must be deterministic, fast, and dependency-light unless a stronger search dependency is justified.

`gateway-tool.ts`

- Provides the native `mcp` `ToolDefinition`.
- Handles action validation, result shaping, rendering, and truncation notices.

`safety.ts`

- Classifies tools as read/write/destructive/unknown for display, search, recent calls, and audit metadata.
- Redacts secret-looking arguments and text before audit/log presentation.

`auth.ts`

- Handles OAuth/bearer/env-missing auth flows.
- Emits first-class auth events for TUI/RPC/mobile.
- Stores host-side tokens securely where Volt auth storage supports it.

`output-store.ts`

- Stores large MCP outputs in a local sidecar.
- Returns opaque ids, never host-local paths to mobile.

`audit.ts`

- Writes MCP audit events.
- Redacts secrets and full outputs.

`rpc.ts`

- Projects manager state into RPC-safe DTOs.
- Sanitizes command, env, URL, headers, and auth data.

### Lifecycle

Startup:

1. Load trusted MCP config.
2. Load metadata cache.
3. Construct MCP manager.
4. Register only the native `mcp` tool when MCP is enabled.
5. Start eager/keep-alive servers from trusted config.
6. Lazy servers remain cold.

Search/describe:

1. Use cached metadata first.
2. If metadata is missing or stale, return a clear result with suggested `connect`/`refresh` action.
3. Do not start arbitrary stdio processes merely because the model searched, unless config permits background discovery.

Call:

1. Resolve exact server and tool.
2. Ensure server is connected.
3. Refresh metadata if needed.
4. Call tool with timeout and cancellation.
5. Truncate/cache output.
6. Emit events and audit.
7. Reset idle timer.

Shutdown:

- Close clients.
- Stop stdio processes gracefully.
- Emit final status.

## Native `mcp` tool contract

### Tool name

```text
mcp
```

### Actions

```text
status
list_servers
search
describe
call
connect
disconnect
list_resources
read_resource
list_prompts
get_prompt
read_cache
```

### Input shape

```ts
interface McpGatewayInput {
  action:
    | "status"
    | "list_servers"
    | "search"
    | "describe"
    | "call"
    | "connect"
    | "disconnect"
    | "list_resources"
    | "read_resource"
    | "list_prompts"
    | "get_prompt"
    | "read_cache";
  server?: string;
  query?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  argumentsJson?: string;
  resourceUri?: string;
  prompt?: string;
  cacheId?: string;
  limit?: number;
  cursor?: string;
}
```

`arguments` is preferred. `argumentsJson` exists for provider compatibility if a model struggles with nested arbitrary JSON.

### Search result

Search returns compact routing information, not full schemas.

```json
{
  "action": "search",
  "query": "search github issues",
  "matches": [
    {
      "server": "github",
      "tool": "search_issues",
      "title": "Search issues",
      "summary": "Search GitHub issues and pull requests.",
      "risk": "read",
      "call": "mcp({\"action\":\"call\",\"server\":\"github\",\"tool\":\"search_issues\",\"arguments\":{...}})",
      "describe": "mcp({\"action\":\"describe\",\"server\":\"github\",\"tool\":\"search_issues\"})"
    }
  ]
}
```

Defaults:

- return 8 matches
- cap at 20 matches
- each match summary is bounded
- include risk and exact call target

### Describe result

`describe` returns full enough schema for the selected tool only:

```json
{
  "server": "github",
  "tool": "search_issues",
  "description": "Search GitHub issues and pull requests.",
  "risk": "read",
  "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } },
  "annotations": { "readOnlyHint": true },
  "metadataHash": "sha256:..."
}
```

Schemas are bounded. If a schema is too large, return a compact schema plus an elision warning.

### Call result

```json
{
  "action": "call",
  "server": "github",
  "tool": "search_issues",
  "status": "completed",
  "risk": "read",
  "content": "Found 12 issues...",
  "truncation": {
    "truncated": true,
    "returnedBytes": 51200,
    "totalBytes": 482991
  },
  "cache": {
    "id": "mcpout_01HX...",
    "read": "mcp({\"action\":\"read_cache\",\"cacheId\":\"mcpout_01HX...\"})"
  }
}
```

Errors from MCP tool execution are returned as tool results with a clear `isError` result to the model when the protocol reports a tool-level error. Transport/protocol/permission failures are reported as gateway errors.

## Token budget strategy

- One native tool is always visible.
- MCP tool schemas are absent from the base system prompt by default.
- Search results are compact and limited.
- Describe returns one tool schema at a time.
- Results are truncated to Volt's existing extension guidance: 50KB / 2000 lines.
- Full results go to a sidecar and are retrieved by `read_cache`.
- Direct tools are off by default.

Optional direct tools:

```json
{
  "settings": { "directTools": false },
  "servers": {
    "github": {
      "directTools": ["search_issues", "get_file_contents"]
    }
  }
}
```

Direct tools must:

- be sourced from cached metadata
- include a token estimate before enabling in TUI/mobile
- be pinned to a metadata hash
- be demoted when metadata changes
- use names like `mcp__github__search_issues`

## RPC, daemon, and mobile API

### RPC commands

Add typed RPC commands:

```text
get_mcp_capabilities
list_mcp_servers
get_mcp_server
set_mcp_server_enabled
connect_mcp_server
disconnect_mcp_server
refresh_mcp_server
list_mcp_tools
get_mcp_tool
list_mcp_resources
read_mcp_resource
list_mcp_prompts
get_mcp_prompt
list_mcp_recent_calls
start_mcp_server_auth
poll_mcp_server_auth
cancel_mcp_server_auth
complete_mcp_server_auth
logout_mcp_server
```

### Events

```text
mcp_servers_changed
mcp_server_status_changed
mcp_auth_request
mcp_auth_update
mcp_call_start
mcp_call_update
mcp_call_end
```

### DTOs

```ts
interface McpServerSummary {
  id: string;
  displayName: string;
  sourceScope: "user" | "project" | "temporary";
  sourceLabel: string;
  enabled: boolean;
  activeInSession: boolean;
  transport: "stdio" | "streamable_http" | "sse";
  lifecycle: "lazy" | "eager" | "keep_alive";
  status:
    | "disabled"
    | "untrusted"
    | "cold"
    | "connecting"
    | "connected"
    | "ready"
    | "needs_auth"
    | "error"
    | "disconnected";
  authState: "none" | "required" | "pending" | "authenticated" | "failed";
  toolCounts: { cached: number; live?: number; enabled?: number };
  resourceCount?: number;
  promptCount?: number;
  recentCalls: McpRecentCallSummary[];
  lastError?: string;
  lastConnectedAt?: string;
  capabilities: {
    canEnable: boolean;
    canConnect: boolean;
    canDisconnect: boolean;
    canRefresh: boolean;
    canAuthenticate: boolean;
    canPersistChanges: boolean;
  };
}
```

```ts
interface McpRecentCallSummary {
  id: string;
  timestamp: string;
  server: string;
  tool: string;
  risk: "read" | "write" | "destructive" | "unknown";
  status: "started" | "completed" | "failed" | "cancelled";
  durationMs?: number;
  outputBytes?: number;
  truncated?: boolean;
}
```

### Mobile app integration points

Likely app-side files to add or change:

- `volt-app/Packages/VoltClient/Sources/VoltRPC/` for MCP RPC commands and DTOs.
- `volt-app/Packages/VoltClient/Sources/VoltCore/VoltSession+MCP.swift` for session state/actions.
- `volt-app/Packages/VoltClient/Sources/VoltCore/VoltSession+EventRouting.swift` for MCP event handling.
- `volt-app/Volt/Settings/MCPServersView.swift` for server management UI.
- `volt-app/Volt/HostAction/` or a new MCP auth sheet for auth prompts.
- `volt-app/Volt/Chat/ToolEvents/` for MCP call card presentation.
- `volt-app/Packages/VoltClient/Tests/VoltCoreTests/` for command/event routing tests.

### Daemon and remote access

Add an Iroh/daemon feature flag:

```text
mcp_management.v1
```

Remote-safe MCP commands should be allowlisted deliberately. Management commands that do not add or edit arbitrary stdio commands are remote-safe when the server already exists in trusted config.

Remote-safe by default:

- list servers
- get server
- connect existing configured servers
- refresh metadata for existing configured servers
- enable/disable existing configured servers through persisted Volt-owned overlays
- list recent calls
- list/get tools
- list/read resources
- list/get prompts
- disconnect
- start device-code auth
- poll/cancel auth
- logout

Conditionally remote-safe:

- browser redirect auth completion, only for local/same-device RPC flows with explicit redirect handling

Not remote-safe by default:

- adding arbitrary stdio server commands
- editing command/args/env
- changing env allowlists

## Security

### Threat model

MCP introduces these risks:

- stdio config can execute arbitrary local commands
- project config can be malicious
- server metadata can contain prompt injection
- tool outputs/resources/prompts can contain prompt injection
- remote MCP servers can exfiltrate data or ask for broad OAuth scopes
- mobile/daemon control can start host-local processes if not constrained

### Child process safety

For stdio servers:

- spawn argv directly, no shell
- resolve command and cwd safely
- do not pass full ambient environment by default
- pass baseline environment only:
  - `PATH`, `HOME`, `TMPDIR`, platform essentials
  - explicit `env` entries
  - explicit allowlisted ambient env vars
- redact env values in UI/RPC/mobile
- show command preview before first start when interactive

### Risk classification

Classify each MCP tool for display, search ranking context, recent calls, and audit metadata:

1. MCP annotations, such as `readOnlyHint` and `destructiveHint`
2. name/description heuristics
3. `unknown` fallback

Risk classes:

- `read`
- `write`
- `destructive`
- `unknown`

Risk is informational only. Volt does not apply nested MCP tool permissions or approval prompts; availability is controlled by the top-level `mcp` tool plus server `includeTools`/`excludeTools`, project trust, auth, and transport/remote-safety rules.

### Audit

Write JSONL audit entries under the Volt agent dir.

Fields:

- timestamp
- workspace/session id
- caller surface
- server id
- tool/resource/prompt id
- risk class
- status
- duration
- result size
- result hash
- truncation/cache id
- sanitized argument summary

Do not log secrets or full outputs by default.

## Resources and prompts

### Resources

Support resources in the product, but expose them explicitly.

Gateway actions:

- `list_resources`
- `read_resource`

Rules:

- never auto-inject resource contents
- return bounded content
- cache large resources
- treat contents as untrusted
- mobile/TUI can preview resources

### Prompts

Support prompt listing and preview, but do not auto-register MCP prompts as Volt slash commands by default.

Gateway actions:

- `list_prompts`
- `get_prompt`

Rules:

- prompt content is untrusted data
- user confirmation required before inserting or sending a prompt from UI
- model can call `get_prompt` only if config allows prompt exposure
- no prompt content gets system-prompt priority

Recommended default:

```json
{
  "settings": {
    "resources": "explicit",
    "prompts": "user-preview"
  }
}
```

## Error handling, timeouts, and cancellation

### Status values

Use a stable status vocabulary:

```text
disabled
untrusted
cold
discovering
connecting
connected
ready
needs_auth
authenticating
error
disconnecting
disconnected
```

### Timeouts

Default timeouts:

- connect: 15 seconds
- metadata discovery: 10 seconds
- tool call: 10 minutes
- auth prompt: 5 minutes
- idle disconnect: 10 minutes

Each server can override within safe bounds.

### Cancellation

- Agent abort signal cancels active gateway operations.
- RPC abort cancels active MCP management operations.
- On stdio shutdown:
  1. close stdin
  2. send SIGTERM
  3. send SIGKILL after grace period
- On session shutdown, disconnect session-owned MCP clients.
- On daemon/TUI handoff, reconnect as needed and emit status changes.

## Output truncation and sidecar

Inline output cap:

- 50KB
- 2000 lines

When output exceeds limits:

- return a compact summary
- store full output in local sidecar
- return opaque `cacheId`
- allow retrieval with `mcp({ "action": "read_cache", "cacheId": "..." })`

Sidecar rules:

- local file permissions 0600 where applicable
- retention/TTL setting
- mobile sees opaque ids only, not host paths
- cache ids scoped to workspace/session ownership
- binary/image outputs require explicit product handling before model exposure

## Implementation plan

### 1. Dependency and config foundation

- Add pinned `@modelcontextprotocol/sdk` dependency.
- Add MCP config types and loader.
- Add file discovery for global/shared and project-local MCP config.
- Add project-trust diagnostics for `.mcp.json` and `.volt/mcp.json`.
- Add unit tests for merge, precedence, and trust filtering.

Likely files:

- `packages/coding-agent/package.json`
- `packages/coding-agent/src/core/mcp/config.ts`
- `packages/coding-agent/src/core/mcp/config-loader.ts`
- `packages/coding-agent/src/core/resource-loader.ts`
- `packages/coding-agent/src/core/settings-manager.ts`

### 2. Runtime manager and transports

- Implement MCP manager and server supervisor.
- Implement SDK client factory.
- Support stdio and Streamable HTTP.
- Add SSE fallback for legacy servers.
- Implement restricted child env builder.
- Add fake stdio/http MCP server tests.

Likely files:

- `packages/coding-agent/src/core/mcp/manager.ts`
- `packages/coding-agent/src/core/mcp/server-supervisor.ts`
- `packages/coding-agent/src/core/mcp/client-factory.ts`

### 3. Metadata cache and search

- Cache tools/resources/prompts.
- Include server version, capability hash, metadata hash, and timestamps.
- Add local search over cached tool metadata.
- Add refresh behavior and stale-cache diagnostics.

Likely files:

- `packages/coding-agent/src/core/mcp/metadata-cache.ts`
- `packages/coding-agent/src/core/mcp/search.ts`

### 4. Native gateway tool

- Add built-in `mcp` tool definition.
- Wire manager into `AgentSession` runtime.
- Add custom renderer for MCP gateway calls.
- Ensure `--tools` and excluded tools can enable/disable `mcp` like other built-ins.

Likely files:

- `packages/coding-agent/src/core/mcp/gateway-tool.ts`
- `packages/coding-agent/src/core/tools/index.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

### 5. Risk metadata, audit, output store

- Add risk classification for metadata/audit.
- Add audit log.
- Add output truncation and sidecar storage.
- Add tests for risk classification and redaction.

Likely files:

- `packages/coding-agent/src/core/mcp/safety.ts`
- `packages/coding-agent/src/core/mcp/audit.ts`
- `packages/coding-agent/src/core/mcp/output-store.ts`

### 6. Auth

Implemented:

- OAuth/bearer/env-missing auth states.
- Host-side OAuth token/client/discovery storage in `~/.volt/agent/mcp-auth.json` with owner-only file permissions.
- Browser authorization-code + PKCE auth via `volt mcp auth <server>` and local RPC `start_mcp_server_auth` / `complete_mcp_server_auth`.
- OAuth device-code auth via `volt mcp auth-device <server>` and local/remote-safe RPC `start_mcp_server_auth` with `flow: "device"`, `poll_mcp_server_auth`, and `cancel_mcp_server_auth`.
- Logout/credential clearing via `volt mcp logout <server>` and local RPC `logout_mcp_server`.

Still to do:

- First-class streaming auth events for TUI/RPC/mobile.
- Rich interactive `/mcp` auth UX beyond the lightweight command surface.

Likely files:

- `packages/coding-agent/src/core/mcp/auth.ts`
- `packages/coding-agent/src/core/rpc/types.ts`
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

### 7. TUI and CLI UX

- Implement `/mcp` server manager.
- Add CLI commands such as `volt mcp list`, `connect`, `disconnect`, `refresh`, `auth`.
- Add startup/footer status.
- Add docs.

Likely files:

- `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- `packages/coding-agent/src/core/slash-commands.ts`
- `packages/coding-agent/src/main.ts`
- `packages/coding-agent/docs/mcp.md`

### 8. RPC and daemon

- Add MCP RPC command/response/event types.
- Add dispatch handlers.
- Add daemon/Iroh allowlist updates and `mcp_management.v1` feature.
- Add remote-safe allowlist tests.

Likely files:

- `packages/coding-agent/src/core/rpc/types.ts`
- `packages/coding-agent/src/modes/rpc/rpc-mode.ts`
- `packages/coding-agent/src/core/remote/iroh/rpc-command-filter.ts`
- `packages/coding-agent/src/core/remote/iroh/control.ts`

### 9. Mobile app

- Add Swift DTOs and RPC commands.
- Add `VoltSession` MCP state and event routing.
- Add MCP server settings view.
- Add auth sheets.
- Add tool event presentation for MCP gateway calls.
- Add mock transport tests.

Likely files:

- `volt-app/Packages/VoltClient/Sources/VoltRPC/`
- `volt-app/Packages/VoltClient/Sources/VoltCore/VoltSession+MCP.swift`
- `volt-app/Packages/VoltClient/Sources/VoltCore/VoltSession+EventRouting.swift`
- `volt-app/Volt/Settings/MCPServersView.swift`
- `volt-app/Volt/Chat/ToolEvents/`
- `volt-app/Packages/VoltClient/Tests/VoltCoreTests/`

### 10. Resources, prompts, direct-tool promotion

- Add explicit resource actions.
- Add prompt list/preview actions.
- Add user-confirmed prompt insertion in TUI/mobile.
- Add optional direct-tool promotion with metadata hash review.
- Add token estimate UI.

### 11. Documentation and verification

Docs to update:

- `README.md`
- `docs/settings.md`
- `docs/rpc.md`
- `docs/daemon.md`
- `docs/security.md`
- `docs/mcp.md`

Verification:

- `npm run check` after implementation changes.
- Specific MCP unit/integration tests with fake servers.
- iOS tests for RPC model parsing and event routing.

## Recommended decisions

1. Default mode is pure proxy.
2. Direct tools are available but off by default.
3. Volt writes only Volt-owned MCP config by default.
4. Project-local MCP config requires project trust.
5. Stdio servers get restricted env by default.
6. Mobile can manage existing trusted servers, not author arbitrary local commands by default.
7. Resources are explicit-read by default.
8. Prompts are user-preview by default.
9. All MCP metadata/results/resources/prompts are untrusted.
10. Large MCP outputs always use Volt truncation plus sidecar retrieval.
11. Session-owned MCP processes are the first product behavior; cross-session process sharing can be revisited later.

## Open questions

- Should OAuth token storage live in the existing Volt auth storage or a separate MCP token store?
- Should metadata discovery for cold lazy servers ever auto-start stdio servers, or should it require explicit refresh/connect?
- What is the exact mobile affordance for auth redirects on iOS?
- How should direct-tool token estimates be calculated consistently across providers?
- Should MCP audit logs be shown in the mobile app or only summarized as recent calls?

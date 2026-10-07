> volt can create extensions. Ask it to build one for your use case.

# Extensions

Extensions are TypeScript modules that extend volt's behavior. They can subscribe to lifecycle events, register custom tools callable by the LLM, add commands, and more.

> **Placement for /reload:** Put extensions in `~/.volt/agent/extensions/` (global) or `.volt/extensions/` (project-local) for auto-discovery. Use `volt -e ./path.ts` only for quick tests. Extensions in auto-discovered locations can be hot-reloaded with `/reload`.

**Key capabilities:**
- **Custom tools** - Register tools the LLM can call via `volt.registerTool()`
- **Event interception** - Block or modify tool calls, inject context, customize compaction
- **User interaction** - Ask users via `ctx.ui` dialogs and forms (select, confirm, input, form, dialog) and notify them
- **UI as data** - Status items, panels, and tool, message, and work presentation as `UiNode` data that every client renders: the TUI, RPC clients, and paired phones
- **Custom commands** - Register commands like `/mycommand` via `volt.registerCommand()`, intents via `volt.registerIntent()`, and key shortcuts for them
- **Session persistence** - Store state that survives restarts via `volt.appendEntry()`

**Example use cases:**
- Permission gates (confirm before `rm -rf`, `sudo`, etc.)
- Git checkpointing (stash at each turn, restore on branch)
- Path protection (block writes to `.env`, `node_modules/`)
- Custom compaction (summarize conversation your way)
- Conversation summaries (see `summarize.ts` example)
- Interactive tools (questions, wizards, forms)
- Stateful tools (todo lists, connection pools)
- External integrations (file watchers, webhooks, CI triggers)

See [examples/extensions/](../examples/extensions/) for working implementations.

## Table of Contents

- [Quick Start](#quick-start)
- [Extension Locations](#extension-locations)
- [Available Imports](#available-imports)
- [Writing an Extension](#writing-an-extension)
  - [Settings](#settings)
  - [Permissions](#permissions)
  - [Enabling and disabling](#enabling-and-disabling)
  - [Extension Styles](#extension-styles)
- [JSON Data Boundary](#json-data-boundary)
- [Events](#events)
  - [Lifecycle Overview](#lifecycle-overview)
  - [Startup Events](#startup-events)
  - [Resource Events](#resource-events)
  - [Session Events](#session-events)
  - [Agent Events](#agent-events)
  - [Model Events](#model-events)
  - [Tool Events](#tool-events)
  - [User Bash Events](#user-bash-events)
  - [Input Events](#input-events)
- [ExtensionContext](#extensioncontext)
- [ExtensionCommandContext](#extensioncommandcontext)
- [ExtensionAPI Methods](#extensionapi-methods)
  - [Background work](#voltregisterworkkindname-kind)
- [Managed context preparation](#managed-context-preparation)
- [State Management](#state-management)
- [Custom Tools](#custom-tools)
  - [Tool Presentation](#tool-presentation)
- [UI as Data](#ui-as-data)
  - [Clients](#clients)
  - [Styled Text](#styled-text)
  - [Notifications](#notifications)
  - [Dialogs and Forms](#dialogs-and-forms)
  - [Status Items](#status-items)
  - [Panels](#panels)
  - [Actions](#actions)
  - [Title, Editor Text, and Themes](#title-editor-text-and-themes)
  - [Intents, Shortcuts, and Completions](#intents-shortcuts-and-completions)
  - [Message Presentation](#message-presentation)
  - [Work Detail](#work-detail)
- [Error Handling](#error-handling)
- [Mode Behavior](#mode-behavior)
- [Examples Reference](#examples-reference)

## Quick Start

Create `~/.volt/agent/extensions/my-extension.ts`:

```typescript
import { defineManifest, type ExtensionAPI } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";

export const manifest = defineManifest({ id: "my-extension", displayName: "My Extension" });

export default function (volt: ExtensionAPI) {
  // React to events
  volt.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Extension loaded!", "info");
  });

  volt.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register a custom tool
  volt.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register a command
  volt.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello ${args || "world"}!`, "info");
    },
  });
}
```

Test with `--extension` (or `-e`) flag:

```bash
volt -e ./my-extension.ts
```

## Extension Locations

> **Security:** Extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust.

Extensions are auto-discovered from trusted locations. Project-local `.volt/extensions` entries load only after the project is trusted.

| Location | Scope |
|----------|-------|
| `~/.volt/agent/extensions/*.ts` | Global (all projects) |
| `~/.volt/agent/extensions/*/index.ts` | Global (subdirectory) |
| `.volt/extensions/*.ts` | Project-local |
| `.volt/extensions/*/index.ts` | Project-local (subdirectory) |

Additional paths via `settings.json`:

```json
{
  "packages": [
    "npm:@foo/bar@1.0.0",
    "git:github.com/user/repo@v1"
  ],
  "extensionPaths": [
    "/path/to/local/extension.ts",
    "/path/to/local/extension/dir"
  ]
}
```

To share extensions via npm or git as volt packages, see [packages.md](packages.md).

## Available Imports

| Package | Purpose |
|---------|---------|
| `@hansjm10/volt-coding-agent` | Extension types (`ExtensionAPI`, `ExtensionContext`, events) |
| `typebox` | Schema definitions for tool parameters |
| `@hansjm10/volt-ai` | AI utilities (`StringEnum` for Google-compatible enums) |
| `@hansjm10/volt-protocol` | Protocol schemas: log entries, wire frames, and `UiNode` |

npm dependencies work too. Add a `package.json` next to your extension (or in a parent directory), run `npm install`, and imports from `node_modules/` are resolved automatically.

For distributed volt packages installed with `volt install` (npm or git), runtime deps must be in `dependencies`. Package installation uses production installs (`npm install --omit=dev`) by default, so `devDependencies` are not available at runtime; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers.

Node.js built-ins (`node:fs`, `node:path`, etc.) are also available.

## Writing an Extension

An extension declares a [manifest](#manifest) and exports a default factory function that receives `ExtensionAPI`. The factory can be synchronous or asynchronous:

```typescript
import { defineManifest, type ExtensionAPI } from "@hansjm10/volt-coding-agent";

export const manifest = defineManifest({ id: "my-extension", displayName: "My Extension" });

export default function (volt: ExtensionAPI) {
  // Subscribe to events
  volt.on("event_name", async (event, ctx) => {
    // ctx.ui for user interaction
    const ok = await ctx.ui.confirm("Title", "Are you sure?");
    ctx.ui.notify("Done!", "info");
    ctx.ui.setStatus("my-ext", "Processing...");  // Status item (the TUI's footer)
    ctx.ui.setPanel("my-ext", { node: { type: "text", text: "Line 1\nLine 2" } });  // Panel above the editor
  });

  // Register tools, commands, intents, shortcuts, flags
  volt.registerTool({ ... });
  volt.registerCommand("name", { ... });
  const intent = volt.registerIntent("name", { ... });
  volt.registerShortcut("ctrl+shift+x", { intent });
  volt.registerFlag("my-flag", { ... });
}
```

Extensions are loaded via [jiti](https://github.com/unjs/jiti), so TypeScript works without compilation.

If the factory returns a `Promise`, volt awaits it before continuing startup. That means async initialization completes before `session_start`, before `resources_discover`, and before provider registrations queued via `volt.registerProvider()` are flushed.

### Manifest

Every extension declares a manifest. Volt does not load an extension without one.

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | The extension's identity: lowercase letters, digits, and `-`, at most 64 characters. `volt`, `core`, `builtin`, `host`, and `ext` are reserved. |
| `displayName` | Yes | One line, at most 80 characters. |
| `description` | No | At most 240 characters. |
| `entry` | Packages only | The module a package loads, relative to and inside the package root. |
| `settings` | No | A flat object schema of string, string enum, boolean, and integer settings. |
| `permissions` | No | Any of `exec`, `network`, `fs-write`, `secrets`, and `providers`. |

A single-file extension (a `.ts` or `.js` file, or a directory's `index.ts`) exports its manifest as `manifest`, as above. Reading it evaluates the module, so single-file extensions load only from locations you control: your and a trusted project's extension directories, paths in settings, and `-e` paths. A package declares its manifest in the `volt` field of `package.json` (see [Extension Styles](#extension-styles)), which volt reads without running package code. Packages installed from npm or git load only through that manifest.

The id names everything the extension contributes: errors, work kinds (`ext:<id>/<kind>`), and command intents (`extension.command.<id>.<command>`). Two extensions cannot share an id. A user or `-e` extension beats a project extension with the same id; otherwise the one loaded first wins. The other is not loaded and is reported.

An SDK host passes each extension with its manifest: `extensionFactories: [{ manifest, factory }]` (see [sdk.md](sdk.md)).

### Settings

`settings` declares what users configure, as a flat object of string, string enum, boolean, and integer settings with `title`, `description`, and `default`. Volt renders it as a form in `/extensions` and `volt config`, and remote clients render the same form. TypeBox output works as written; a union of string literals is a string enum:

```typescript
import { defineManifest, type ExtensionAPI, type ExtensionSettingsOf } from "@hansjm10/volt-coding-agent";

export const manifest = defineManifest({
  id: "review-loop",
  displayName: "Review Loop",
  settings: {
    type: "object",
    properties: {
      baseBranch: { type: "string", title: "Base branch", default: "main", pattern: "[A-Za-z0-9._/-]+" },
      maxLoops: { type: "integer", title: "Most loops", minimum: 1, maximum: 10, default: 3 },
      mode: { type: "string", enum: ["fast", "careful"], default: "fast" },
    },
  },
});

export default function (volt: ExtensionAPI<ExtensionSettingsOf<typeof manifest>>) {
  volt.on("session_start", () => {
    const loops: number = volt.settings.maxLoops;
  });
  volt.on("settings_changed", (event) => {
    // event.settings, event.previous, event.scope ("global" or "project")
  });
}
```

- **Stored values** live under `extensions.<id>.settings` in `~/.volt/agent/settings.json` and, for a trusted project, `.volt/settings.json`. `volt.settings` is each default, then the global value, then the project value, frozen. A stored value the manifest does not declare or allow is ignored and reported. One extension's values in one scope hold at most 16 KB.
- **Changes** reach the extension as `settings_changed`, in every open conversation, whether a client saved them or the extension called `volt.updateSettings(values, { scope })` (an `undefined` value clears a setting; the default scope is `global`). Project writes need a trusted project.
- **Checks**: each default must be a valid value, `minLength`/`maximum` bounds must be ordered, a `pattern` must be cheap for every client to test (no backreferences, lookarounds, or nested repetition; values it tests hold at most 256 characters), and names in `required` must be declared. String values are one line.
- **No credentials**: settings are plain JSON, and project settings are often committed. A string setting whose name reads as a credential (`apiKey`, `token`, `password`, `clientSecret`, ...) is refused; keep credentials in the auth storage (the `secrets` permission).

### Permissions

`permissions` lists what the extension does beyond the conversation. Volt shows them when a package is installed (`volt install`, `volt store install`, `/store install`) or updated (`volt update`, `volt store update`; see [Volt Store](packages.md#volt-store)), and when an extension is enabled, and records your acknowledgment in `~/.volt/agent/extension-permissions.json`, bound to the package's name and version (npm), commit (git), or path (local). An update that adds no permission is acknowledged with it; another package with the same id, or a new permission, asks again. Startup never asks or refuses: an extension whose permissions you have not acknowledged still runs at startup, since permissions are advisory (below); acknowledgment gates installing or updating it and enabling it while a session runs, not starting with it.

| Permission | Allows | Enforced |
|------------|--------|----------|
| `exec` | `volt.exec` | Yes: `volt.exec` rejects without it |
| `providers` | `volt.registerProvider`, `volt.unregisterProvider`, and registering or reaching provider implementations through `ctx.modelRegistry` and its `client` | Yes |
| `secrets` | `ctx.modelRegistry.authStorage`, `getApiKeyAndHeaders`, `getApiKeyForProvider`, `login`, and `client.generateImages`; without it, `ctx.modelRegistry.client` requests go only to catalog models as the catalog has them (same `baseUrl` and headers) | Yes |
| `network` | Network access | No: declared and shown only |
| `fs-write` | Writing files | No: declared and shown only |

Permissions are advisory: extensions run in your process and can reach Node's own modules and change shared objects, so a missing permission only stops the volt APIs above. Install only extensions you trust. `volt.setModel` always sets the catalog's model with the given provider and id.

### Enabling and disabling

`extensions.<id>.enabled` in global or (trusted) project settings decides whether an extension runs; it does by default. A disabled extension's factory never runs: a package's entry is not imported until it is enabled, and a single file is evaluated only to read its manifest. Toggle one with `/extensions` (pick it, then Enable or Disable), `/extensions enable <id>`, `/extensions disable <id>`, or the `set_extension_enabled` intent ([rpc.md](rpc.md)); every open conversation follows at once, without `/reload`.

- **Enabling** runs a new instance: its factory, then `activate` (`reason: "enable"`) and `session_start` (`reason: "enable"`). Its tools are offered from the next request. The new instance gets contexts and a `ctx.ui` of its own; a stopped instance's `ctx.ui` stays stopped even when its id runs again. If you have not acknowledged its permissions, the client that enables it asks you to; a paired device cannot enable it until you have. A session runs an extension enabled meanwhile (by another client, conversation, or a settings edit) only once its permissions are acknowledged; until then it is listed as failed.
- **Disabling** stops it at once: no hook, command, intent, shortcut, completion provider, or presenter of it runs again, and its tool calls show the built-in or generic presentation and its custom messages their text. It hears `session_shutdown` (`reason: "disable"`) and `deactivate` (`reason: "disable"`), for at most 10 seconds; then its status items, panels, title, pending dialogs, providers (registered through `volt` or `ctx.modelRegistry`), and managed-services tasks go, and its running work is cancelled (waited for up to 10 seconds, then finished `cancelled`). From then on its `volt` registers nothing and its calls that steer the conversation (`sendMessage`, `sendUserMessage`, `appendEntry`, `setModel`, `ctx.abort()`, `ctx.newSession()`, ...) throw, and its `ctx.ui` shows nothing. Its tools leave at the next turn boundary: a tool call already running finishes first. Then its `volt` and every context it was given throw, and its `volt.events` listeners are removed.
- Skills, prompts, and themes an extension adds through `resources_discover` change on the next `/reload`.

`/store install` and `/store remove` pick up an installed or removed extension the same way; `/reload` reloads every extension (`deactivate` and `activate` with `reason: "reload"`).

### Async factory functions

Use an async factory for one-time startup work such as fetching remote configuration or dynamically discovering available models.

```typescript
import type { ExtensionAPI } from "@hansjm10/volt-coding-agent";

export default async function (volt: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  volt.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

This pattern makes the fetched models available during normal startup and to `volt --list-models`.

### Long-lived resources and shutdown

Extension factories may run in invocations that never start a session. Do not start background resources such as processes, sockets, file watchers, or timers from the factory.

Defer background resource startup until `session_start` or the command/tool/event that needs the resource. Register an idempotent `session_shutdown` handler to close any session-scoped resources you start.

### Extension Styles

**Single file** - simplest, for small extensions. The file exports `manifest`:

```
~/.volt/agent/extensions/
└── my-extension.ts
```

**Directory with index.ts** - for multi-file extensions:

```
~/.volt/agent/extensions/
└── my-extension/
    ├── index.ts        # Entry point (exports manifest and default function)
    ├── tools.ts        # Helper module
    └── utils.ts        # Helper module
```

**Package with dependencies** - for extensions that need npm packages:

```
~/.volt/agent/extensions/
└── my-extension/
    ├── package.json    # Declares dependencies and the manifest
    ├── package-lock.json
    ├── node_modules/   # After npm install
    └── src/
        └── index.ts
```

```json
// package.json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0",
    "chalk": "^5.0.0"
  },
  "volt": {
    "id": "my-extension",
    "displayName": "My Extension",
    "entry": "src/index.ts"
  }
}
```

A package declares one extension. Its version is the package's `version`.

Run `npm install` in the extension directory, then imports from `node_modules/` work automatically.

## JSON Data Boundary

Persisted values and public `AgentSession` events use one lossless JSON data grammar. Accepted values are `null`, booleans, strings, finite numbers other than negative zero, dense arrays, and ordinary plain objects whose own properties are enumerable string-keyed data properties. Optional properties must be omitted when absent.

Volt rejects explicit `undefined`, non-finite numbers, negative zero, bigint, symbols, functions, cycles, sparse arrays, accessors, symbol-keyed or non-enumerable properties, custom or null prototypes, and rich objects such as `Map`, `Set`, `Date`, `Error`, `RegExp`, `Buffer`, typed arrays, `ArrayBuffer`, `SharedArrayBuffer`, and platform objects. Convert rich values to plain JSON representations, such as an ISO string for a date or an array of entries for a map.

Admission errors are path-specific `TypeError`s. Volt validates and owns accepted data before it mutates session state, commits to SQLite, or publishes an event. The session format version is unchanged because every accepted value already round-trips through JSON exactly.

## Events

### Lifecycle Overview

```
volt starts
  │
  ├─► project_trust (user/global and CLI extensions only, before project resources load)
  ├─► session_start { reason: "startup" }
  └─► resources_discover { reason: "startup" }
      │
      ▼
user sends prompt ─────────────────────────────────────────┐
  │                                                        │
  ├─► (extension commands checked first, bypass if found)  │
  ├─► input (can intercept, transform, or handle)          │
  ├─► (skill/template expansion if not handled)            │
  ├─► before_agent_start (can inject message, modify system prompt)
  ├─► agent_start                                          │
  ├─► message_start / message_update / message_end         │
  │                                                        │
  │   ┌─── turn (repeats while LLM calls tools) ───┐       │
  │   │                                            │       │
  │   ├─► turn_start                               │       │
  │   ├─► context (can modify messages)            │       │
  │   ├─► before_provider_request (can inspect or replace payload)
  │   ├─► after_provider_response (status + headers, before stream consume)
  │   │                                            │       │
  │   │   LLM responds, may call tools:            │       │
  │   │     ├─► tool_execution_start               │       │
  │   │     ├─► tool_call (can block)              │       │
  │   │     ├─► tool_execution_update              │       │
  │   │     ├─► tool_result (can modify)           │       │
  │   │     └─► tool_execution_end                 │       │
  │   │                                            │       │
  │   └─► turn_end                                 │       │
  │                                                        │
  └─► agent_end                                            │
                                                           │
user sends another prompt ◄────────────────────────────────┘

/clear (new session) or /resume (switch session) in the TUI
  ├─► session_before_switch (can cancel)            old session
  ├─► session_start { reason: "startup" }           new session, in its worker, as the TUI attaches
  └─► resources_discover { reason: "startup" }      new session
      (the old session stays open in its worker: session_shutdown { reason: "quit" } when the worker closes it)

/fork or /clone in the TUI
  ├─► session_before_fork (can cancel)              old session
  ├─► session_start { reason: "startup" }           new session, in its worker, as the TUI attaches
  └─► resources_discover { reason: "startup" }      new session

new_session, switch_session, fork, or clone from an RPC client (or an SDK client that moves in place)
  ├─► session_before_switch / session_before_fork (can cancel)          old session
  ├─► session_start { reason: "new" | "resume" | "fork", previousSessionRef? }   new session
  ├─► resources_discover { reason: "startup" }      new session
  └─► session_shutdown { targetSessionRef }         old session

/compact or auto-compaction
  ├─► session_before_compact (can cancel or customize)
  └─► session_compact

/tree navigation
  ├─► session_before_tree (can cancel or customize)
  └─► session_tree

/model or Ctrl+P (model selection/cycling)
  ├─► thinking_level_select (if model change changes/clamps thinking level)
  └─► model_select

thinking level changes (settings, keybinding, volt.setThinkingLevel())
  └─► thinking_level_select

print or RPC mode exits (it finished, stdin closed, SIGHUP, SIGTERM)
  └─► session_shutdown

quitting the TUI (Ctrl+C, Ctrl+D)
  └─► nothing yet: the session stays open in its worker; session_shutdown { reason: "quit" } when the worker closes it

extension enabled while the session runs (this extension only)
  ├─► activate { reason: "enable" }
  └─► session_start { reason: "enable" }

extension disabled while the session runs (this extension only)
  ├─► session_shutdown { reason: "disable" }
  └─► deactivate { reason: "disable" }

/reload
  ├─► session_shutdown { reason: "reload" }
  ├─► deactivate { reason: "reload" }
  ├─► activate { reason: "reload" }            reloaded extensions
  └─► session_start { reason: "reload" }       reloaded extensions
```

When a session starts, each extension hears `activate` (`reason: "startup"`) before `session_start`.

An interactive TUI's sessions run in the [daemon's conversation workers](daemon.md#conversation-workers), and the TUI is one of their clients. A session the TUI moves to opens in a worker when the TUI attaches to it, like any session a client opens there, so its `session_start` has `reason: "startup"`; the session the TUI left stays open for its other clients and closes when its worker closes it ([Retention](daemon.md#retention-and-background)). A print, JSON, or RPC run hosts its session in its own process, and an RPC client's session changes move it in place, as the RPC diagram above shows.

### Startup Events

#### project_trust

Fired before volt decides whether to trust a project with dynamic configs (`.volt` or `.agents/skills`). It runs during startup and when a session change (for example `/clear` or `/resume`) enters a cwd whose trust has not been resolved in the current session. An interactive session's conversations run in the [daemon](daemon.md)'s conversation workers, so the handler runs there, and its dialogs show in the TUI that opened the conversation. Only user/global extensions and CLI `-e` extensions participate; project-local extensions are not loaded until after trust is resolved.

```typescript
volt.on("project_trust", async (event, ctx) => {
  // event.cwd - current working directory
  // ctx has a limited trust context: cwd, mode, hasUI, and select/confirm/input/notify UI helpers
  if (await ctx.ui.confirm("Trust project?", event.cwd)) {
    return { trusted: "yes", remember: true };
  }
  return { trusted: "undecided" };
});
```

A `project_trust` handler must return `{ trusted: "yes" | "no" | "undecided" }`. A user/global or CLI extension that returns `"yes"` or `"no"` owns the decision; the first yes/no decision wins and suppresses the built-in trust prompt. Use `remember: true` to persist a yes/no decision; otherwise it applies only to the current session: a print or RPC run's process, or an interactive TUI's conversations of that project in the same worker (never another TUI's). Return `"undecided"` to let later handlers or the built-in trust flow decide. Check `ctx.hasUI` before prompting. If no handler returns yes/no, normal trust resolution continues: saved `trust.json` decisions apply first, then `defaultProjectTrust` controls whether volt asks, trusts, or declines by default. `--approve` and `--no-approve` decide the startup project's trust without running the handler.

### Resource Events

#### resources_discover

Fired after `session_start` so extensions can contribute additional skill, prompt, and theme paths.
The startup path uses `reason: "startup"`. Reload uses `reason: "reload"`.

```typescript
volt.on("resources_discover", async (event, _ctx) => {
  // event.cwd - current working directory
  // event.reason - "startup" | "reload"
  return {
    skillPaths: ["/path/to/skills"],
    promptPaths: ["/path/to/prompts"],
    themePaths: ["/path/to/themes"],
  };
});
```

### Session Events

Persisted sessions live in `sessions.sqlite` and are identified by stable references:

```typescript
interface SessionReference {
  readonly sessionDirectory: string;
  readonly storeId: string;
  readonly sessionId: string;
  readonly sessionGeneration: string;
}
```

Obtain references from `ctx.sessionManager.getSessionRef()` or indexed `SessionManager.list()` results; do not reconstruct them from a session ID. See [Session Format](session-format.md) for storage and the `SessionManager` API.

#### session_start

Fired when a session is started, loaded, or reloaded. It fires once per session, when the first client attaches to it: further clients of the same session (another terminal or a phone on a session a daemon worker hosts, a second RPC client) attach without another `session_start`. See [Clients](#clients).

```typescript
volt.on("session_start", async (event, ctx) => {
  // event.reason - "startup" | "reload" | "new" | "resume" | "fork"
  // event.previousSessionRef - previous persisted session, when one exists
  const ref = ctx.sessionManager.getSessionRef();
  ctx.ui.notify(ref ? `Session: ${ref.sessionId}` : "Ephemeral session", "info");
});
```

#### session_before_switch

Fired before starting a new session (`/clear`) or switching sessions (`/resume`).

```typescript
volt.on("session_before_switch", async (event, ctx) => {
  // event.reason - "new" or "resume"
  // event.targetSessionRef - destination reference (only for "resume")

  if (event.reason === "new") {
    const ok = await ctx.ui.confirm("Clear?", "Delete all messages?");
    if (!ok) return { cancel: true };
  }
});
```

In a host that moves its client in place (RPC mode, the SDK), a switch or new-session action opens the new session before it closes the old one. The new session's extension instance receives `session_start` with `reason: "new" | "resume"` and optional `previousSessionRef`, then the old instance receives `session_shutdown`. If the new session fails to open (its cwd is missing, another process has it open), the current session stays open and receives no `session_shutdown`.

In the interactive TUI, `/clear` writes the new session (`/resume` names a stored one), and the TUI reconnects to it through the [daemon](daemon.md#conversation-workers): it opens in a worker with `session_start` `reason: "startup"`, and the old session stays open in its own worker for its other clients until that worker closes it (`session_shutdown` with `reason: "quit"`). A session runs in one worker at a time and never moves to another process while it runs: another terminal or a phone attaching to it joins the instance already running there, without a new `session_start`.

Do cleanup work in `session_shutdown`, then reestablish any in-memory state in `session_start`. Instances of several sessions coexist in one worker, and the old and new instances of a move briefly coexist: keep state per instance rather than in module-level variables shared between them.

#### session_before_fork

Fired when forking via `/fork` or cloning via `/clone`.

```typescript
volt.on("session_before_fork", async (event, ctx) => {
  // event.entryId - ID of the selected entry
  // event.position - "before" for /fork, "at" for /clone
  return { cancel: true }; // Cancel fork/clone
  // OR
  return { skipConversationRestore: true }; // Reserved for future conversation restore control
});
```

In a host that moves its client in place, a fork or clone opens the new session before it closes the old one: the new extension instance receives `session_start` with `reason: "fork"` and optional `previousSessionRef`, then the old instance receives `session_shutdown`. A failed open leaves the current session open. In the interactive TUI, the fork is written and opens in a worker as the TUI reconnects, as `/clear` does (see [session_before_switch](#session_before_switch)).
Do cleanup work in `session_shutdown`, then reestablish any in-memory state in `session_start`.

#### session_before_compact / session_compact

Fired on compaction. See [compaction.md](compaction.md) for details.

```typescript
volt.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;

  // reason - "manual" (/compact), "threshold", or "overflow"
  // willRetry - whether the interrupted turn resumes after compaction

  // Cancel:
  return { cancel: true };

  // Custom summary:
  return {
    compaction: {
      summary: "...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    }
  };
});

volt.on("session_compact", async (event, ctx) => {
  // event.compactionEntry - the saved compaction
  // event.fromExtension - whether extension provided it
  // event.reason - "manual" (/compact), "threshold", or "overflow"
  // event.willRetry - whether the interrupted turn resumes after compaction
});
```

Custom compaction and tree-summary results are validated and owned before Volt moves the branch leaf or appends an entry. Invalid JSON data fails the operation without creating a summary entry.

#### session_before_tree / session_tree

Fired on `/tree` navigation. See [Sessions](sessions.md) for tree navigation concepts.

```typescript
volt.on("session_before_tree", async (event, ctx) => {
  const { preparation, signal } = event;
  return { cancel: true };
  // OR provide custom summary:
  return { summary: { summary: "...", details: {} } };
});

volt.on("session_tree", async (event, ctx) => {
  // event.newLeafId, oldLeafId, summaryEntry, fromExtension
});
```

#### activate / deactivate

`activate` reaches an extension when it starts running in a conversation, before its `session_start`: `reason` is `"startup"` (the session started), `"enable"` (it was enabled while the session runs), or `"reload"`. `deactivate` reaches it after its `session_shutdown` when it stops: `"disable"` or `"reload"`. Each reaches only the extension starting or stopping. After `deactivate`, everything the extension contributed is removed (see [Enabling and disabling](#enabling-and-disabling)).

```typescript
volt.on("activate", (event) => {
  // event.reason - "startup" | "enable" | "reload"
});
volt.on("deactivate", (event) => {
  // event.reason - "disable" | "reload"
});
```

#### session_shutdown

Fired before a started session closes. Use this to clean up resources opened from `session_start` or other session-scoped hooks. When a client moves to another session (`reason` `"new"`, `"resume"`, or `"fork"`), the new session's `session_start` has already run and the client has left this one: UI calls from this handler reach no client that moved, so they cannot disturb the new session's UI. See [Session changes: lifecycle and footguns](#session-changes-lifecycle-and-footguns).

A session in a daemon worker (every session of the interactive TUI, and every session a phone opens) does not close when a client moves away or quits: it closes when its worker closes it, with `reason: "quit"`. That happens once no client has been attached and nothing has run for the retention period (30 minutes by default), when a session without a session file (`--no-session`) has had no client for about 10 seconds, when a paired device that used it is revoked, its managed worktree is removed, or its workspace is unregistered or replaced, when the worker stops (`volt daemon stop`, `volt update`), or when the session loses its log. See [Retention and background](daemon.md#retention-and-background). A worker that crashes runs no `session_shutdown`.

Session writes from this handler (`volt.appendEntry()`, `volt.setLabel()`, `volt.setSessionName()`) commit like any other: the session is disposed only after the handlers finish. They throw once the session has lost its log because a write could not be confirmed as saved; nothing can be saved after that. Save durable state when it changes rather than only at shutdown, and rebuild in-memory state in `session_start`.

```typescript
volt.on("session_shutdown", async (event, ctx) => {
  // event.reason - "quit" | "reload" | "new" | "resume" | "fork"
  // event.targetSessionRef - the session the client moved to, for "new" | "resume" | "fork"
  // Clean up resources; session writes here throw if the session lost its log (see above)
});
```

### Agent Events

#### before_agent_start

Fired after user submits prompt, before agent loop. Can inject a message and/or modify the system prompt.

```typescript
volt.on("before_agent_start", async (event, ctx) => {
  // event.prompt - user's prompt text
  // event.images - attached images (if any)
  // event.systemPrompt - current chained system prompt for this handler
  //   (includes changes from earlier before_agent_start handlers)
  // event.systemPromptOptions - structured options used to build the system prompt
  //   .customPrompt - any custom system prompt (from --system-prompt, SYSTEM.md, or custom templates)
  //   .selectedTools - tools currently active in the prompt
  //   .toolSnippets - one-line descriptions for each tool
  //   .promptGuidelines - custom guideline bullets
  //   .appendSystemPrompt - text from --append-system-prompt flags
  //   .cwd - working directory
  //   .contextFiles - AGENTS.md files and other loaded context files
  //   .skills - loaded skills

  return {
    // Inject a persistent message (stored in session, sent to LLM)
    message: {
      customType: "my-extension",
      content: "Additional context for the LLM",
      display: true,
    },
    // Replace the system prompt for this turn (chained across extensions)
    systemPrompt: event.systemPrompt + "\n\nExtra instructions for this turn...",
  };
});
```

The `systemPromptOptions` field gives extensions access to the same structured data Volt uses to build the system prompt. This lets you inspect what Volt has loaded — custom prompts, guidelines, tool snippets, context files, skills — without re-discovering resources or re-parsing flags. Use it when your extension needs to make deep, informed changes to the system prompt while respecting user-provided configuration.

Inside `before_agent_start`, `event.systemPrompt` and `ctx.getSystemPrompt()` both reflect the chained system prompt as of the current handler. Later `before_agent_start` handlers can still modify it again. An injected message must satisfy the [JSON data boundary](#json-data-boundary); Volt diagnoses and skips only the invalid optional message while continuing the turn.

#### agent_start / agent_end

Fired once per user prompt.

```typescript
volt.on("agent_start", async (_event, ctx) => {});

volt.on("agent_end", async (event, ctx) => {
  // event.messages - messages from this prompt
});
```

#### turn_start / turn_end

Fired for each turn (one LLM response + tool calls).

```typescript
volt.on("turn_start", async (event, ctx) => {
  // event.turnIndex, event.timestamp
});

volt.on("turn_end", async (event, ctx) => {
  // event.turnIndex, event.message, event.toolResults
});
```

#### message_start / message_update / message_end

Fired for message lifecycle updates.

- `message_start` and `message_end` fire for user, assistant, and toolResult messages.
- `message_update` fires for assistant streaming updates.
- `message_end` handlers can return `{ message }` to replace the finalized message. The replacement must keep the same `role` and satisfy the [JSON data boundary](#json-data-boundary). An invalid replacement fails message preparation before it commits.

```typescript
volt.on("message_start", async (event, ctx) => {
  // event.message
});

volt.on("message_update", async (event, ctx) => {
  // event.message
  // event.assistantMessageEvent (token-by-token stream event)
});

volt.on("message_end", async (event, ctx) => {
  if (event.message.role !== "assistant") return;

  return {
    message: {
      ...event.message,
      usage: {
        ...event.message.usage,
        cost: {
          ...event.message.usage.cost,
          total: 0.123,
        },
      },
    },
  };
});
```

#### tool_execution_start / tool_execution_update / tool_execution_end

Fired for tool execution lifecycle updates.

In parallel tool mode:
- `tool_execution_start` is emitted in assistant source order during the preflight phase
- `tool_execution_update` events may interleave across tools
- `tool_execution_end` is emitted in tool completion order after each tool is finalized
- final `toolResult` message events are still emitted later in assistant source order

```typescript
volt.on("tool_execution_start", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args
});

volt.on("tool_execution_update", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.args, event.partialResult
});

volt.on("tool_execution_end", async (event, ctx) => {
  // event.toolCallId, event.toolName, event.result, event.isError
});
```

#### context

Fired before each LLM call. Modify messages non-destructively. See [Session Format](session-format.md) for message types.

```typescript
volt.on("context", async (event, ctx) => {
  // event.messages - deep copy, safe to modify
  const filtered = event.messages.filter(m => !shouldPrune(m));
  return { messages: filtered };
});
```

#### before_provider_request

Fired after the provider-specific payload is built, right before the request is sent. Handlers run in extension load order. Returning `undefined` keeps the payload unchanged. Returning any other value replaces the payload for later handlers and for the actual request.

This hook can rewrite provider-level system instructions or remove them entirely. Those payload-level changes are not reflected by `ctx.getSystemPrompt()`, which reports Volt's system prompt string rather than the final serialized provider payload.

```typescript
volt.on("before_provider_request", (event, ctx) => {
  console.log(JSON.stringify(event.payload, null, 2));

  // Optional: replace payload
  // return { ...event.payload, temperature: 0 };
});
```

This is mainly useful for debugging provider serialization and cache behavior.

#### after_provider_response

Fired after an HTTP response is received and before its stream body is consumed. Handlers run in extension load order.

```typescript
volt.on("after_provider_response", (event, ctx) => {
  // event.status - HTTP status code
  // event.headers - normalized response headers
  if (event.status === 429) {
    console.log("rate limited", event.headers["retry-after"]);
  }
});
```

Header availability depends on provider and transport. Providers that abstract HTTP responses may not expose headers.

### Model Events

#### model_select

Fired when the model changes via `/model` command, model cycling (`Ctrl+P`), or session restore.

```typescript
volt.on("model_select", async (event, ctx) => {
  // event.model - newly selected model
  // event.previousModel - previous model (undefined if first selection)
  // event.source - "set" | "cycle" | "restore"

  const prev = event.previousModel
    ? `${event.previousModel.provider}/${event.previousModel.id}`
    : "none";
  const next = `${event.model.provider}/${event.model.id}`;

  ctx.ui.notify(`Model changed (${event.source}): ${prev} -> ${next}`, "info");
});
```

Use this to update UI (status items, panels) or perform model-specific initialization when the active model changes.

#### thinking_level_select

Fired when the thinking level changes. This is notification-only; handler return values are ignored.

```typescript
volt.on("thinking_level_select", async (event, ctx) => {
  // event.level - newly selected thinking level
  // event.previousLevel - previous thinking level

  ctx.ui.setStatus("thinking", `thinking: ${event.level}`);
});
```

Use this to update extension UI when `volt.setThinkingLevel()`, model changes, or built-in thinking-level controls change the active thinking level.

### Tool Events

#### tool_call

Fired after `tool_execution_start`, before the tool executes. **Can block.** Use `isToolCallEventType` to narrow and get typed inputs.

Every message commits to the session log before its `message_end` is published, so when `tool_call` runs, `ctx.sessionManager` includes the assistant message that requested the tool.

In the default parallel tool execution mode, sibling tool calls from the same assistant message are preflighted sequentially, then executed concurrently. `tool_call` is not guaranteed to see sibling tool results from that same assistant message in `ctx.sessionManager`.

`event.input` is mutable. Mutate it in place to patch tool arguments before execution.

Behavior guarantees:
- Mutations to `event.input` affect the actual tool execution
- Later `tool_call` handlers see mutations made by earlier handlers
- No re-validation is performed after your mutation
- Return values from `tool_call` only control blocking via `{ block: true, reason?: string }`

```typescript
import { isToolCallEventType } from "@hansjm10/volt-coding-agent";

volt.on("tool_call", async (event, ctx) => {
  // event.toolName - "bash", "read", "write", "edit", etc.
  // event.toolCallId
  // event.input - tool parameters (mutable)

  // Built-in tools: no type params needed
  if (isToolCallEventType("bash", event)) {
    // event.input is { command: string; timeout?: number }
    event.input.command = `source ~/.profile\n${event.input.command}`;

    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Dangerous command" };
    }
  }

  if (isToolCallEventType("read", event)) {
    // event.input is { path: string; offset?: number; limit?: number }
    console.log(`Reading: ${event.input.path}`);
  }
});
```

#### Updating tool policies

`volt.on("tool_call", handler)` and `volt.on("tool_result", handler)` return a host-owned `PolicyRegistration` handle. Call the handle to remove that registration, `handle.update(nextHandler)` to replace its callback without changing order, or `handle.invalidate()` after changing state captured by its callback:

```typescript
let denyReads = false;
const policy = volt.on("tool_call", (event) => {
  if (denyReads && event.toolName === "read") return { block: true };
});

// Change closure state and invalidate synchronously, with no await between them.
denyReads = true;
policy.invalidate();
// policy.update(nextHandler) replaces this registration; policy() removes it.
```

Every registration, update, removal, and explicit invalidation advances host-owned authorization revisions. Replacing a callback and restoring the original still revokes older managed authorization. Closure changes cannot be detected automatically: always invalidate when captured state changes policy behavior. Removed handles cannot update or invalidate, and old runtime handles cannot be used after a reload or session change.

These revisions protect managed reads and optional context, not arbitrary Node access by trusted extensions. Loaded handler lists are host-owned; use registration handles rather than modifying `Extension.handlers`.

#### Typing custom tool input

Custom tools should export their input type:

```typescript
// my-extension.ts
export type MyToolInput = Static<typeof myToolSchema>;
```

Use `isToolCallEventType` with explicit type parameters:

```typescript
import { isToolCallEventType } from "@hansjm10/volt-coding-agent";
import type { MyToolInput } from "my-extension";

volt.on("tool_call", (event) => {
  if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
    event.input.action;  // typed
  }
});
```

#### tool_result

Fired after tool execution finishes and before `tool_execution_end` plus the final tool result message events are emitted. **Can modify result.**

In parallel tool mode, `tool_result` and `tool_execution_end` may interleave in tool completion order, while final `toolResult` message events are still emitted later in assistant source order.

`tool_result` handlers chain like middleware:
- Handlers run in extension load order
- Each handler sees the latest result after previous handler changes
- Handlers can return partial patches (`content`, `details`, or `isError`); omitted fields keep their current values
- Final results, streaming updates, and replacement `details` must satisfy the [JSON data boundary](#json-data-boundary); invalid data becomes an explicit failed tool result instead of disappearing from session observers
- An invalid streaming update aborts the tool through its signal, suppresses later updates, and becomes the tool failure after `execute()` settles

Use `ctx.signal` for nested async work inside the handler. This lets Esc cancel model calls, `fetch()`, and other abort-aware operations started by the extension.

```typescript
import { isBashToolResult } from "@hansjm10/volt-coding-agent";

volt.on("tool_result", async (event, ctx) => {
  // event.toolName, event.toolCallId, event.input
  // event.content, event.details, event.isError

  if (isBashToolResult(event)) {
    // event.details is typed as BashToolDetails
  }

  const response = await fetch("https://example.com/summarize", {
    method: "POST",
    body: JSON.stringify({ content: event.content }),
    signal: ctx.signal,
  });

  // Modify result:
  return { content: [...], details: {...}, isError: false };
});
```

### User Bash Events

#### user_bash

Fired when the user runs a shell command with `!` or `!!`: the TUI's `!` and `!!`, and an RPC client's `bash` intent. It runs in the host, for every client alike (paired devices cannot run shell commands). **Can intercept:** return the result to record it as given, or the operations the command runs with; otherwise it runs in the local shell, and the live `bash` value shows it to clients until its entry commits.

```typescript
import { createLocalBashOperations } from "@hansjm10/volt-coding-agent";

volt.on("user_bash", (event, ctx) => {
  // event.command - the bash command
  // event.excludeFromContext - true if !! prefix
  // event.cwd - working directory

  // Option 1: Provide custom operations (e.g., SSH)
  return { operations: remoteBashOps };

  // Option 2: Wrap volt's built-in local bash backend
  const local = createLocalBashOperations();
  return {
    operations: {
      exec(command, cwd, options) {
        return local.exec(`source ~/.profile\n${command}`, cwd, options);
      }
    }
  };

  // Option 3: Full replacement - return result directly
  return { result: { output: "...", exitCode: 0, cancelled: false, truncated: false } };
});
```

### Input Events

#### input

Fired when user input is received, after extension commands are checked but before skill and template expansion. The event sees the raw input text, so `/skill:foo` and `/template` are not yet expanded.

**Processing order:**
1. Extension commands (`/cmd`) checked first - if found, handler runs and input event is skipped
2. `input` event fires - can intercept, transform, or handle
3. If not handled: skill commands (`/skill:name`) expanded to skill content
4. If not handled: prompt templates (`/template`) expanded to template content
5. Agent processing begins (`before_agent_start`, etc.)

```typescript
volt.on("input", async (event, ctx) => {
  // event.text - raw input (before skill/template expansion)
  // event.images - attached images, if any
  // event.source - "interactive" (typed), "rpc" (API), or "extension" (via sendUserMessage)
  // event.streamingBehavior - "steer" | "followUp" | undefined
  //   undefined when idle, "steer" for mid-stream interrupts,
  //   "followUp" for messages queued until the agent finishes

  // Transform: rewrite input before expansion
  if (event.text.startsWith("?quick "))
    return { action: "transform", text: `Respond briefly: ${event.text.slice(7)}` };

  // Handle: respond without LLM (extension shows its own feedback)
  if (event.text === "ping") {
    ctx.ui.notify("pong", "info");
    return { action: "handled" };
  }

  // Route by source: skip processing for extension-injected messages
  if (event.source === "extension") return { action: "continue" };

  // Intercept skill commands before expansion
  if (event.text.startsWith("/skill:")) {
    // Could transform, block, or let pass through
  }

  return { action: "continue" };  // Default: pass through to expansion
});
```

**Results:**
- `continue` - pass through unchanged (default if handler returns nothing)
- `transform` - modify text/images, then continue to expansion
- `handled` - skip agent entirely (first handler to return this wins)

Transforms chain across handlers. See [input-transform.ts](../examples/extensions/input-transform.ts) and [input-transform-streaming.ts](../examples/extensions/input-transform-streaming.ts) for `streamingBehavior`-aware routing.

## ExtensionContext

All handlers receive `ctx: ExtensionContext`.

### ctx.ui

`ctx.ui` asks dialogs and forms and shows notifications, status items, panels, the title, and editor text, as data every client renders. See [UI as Data](#ui-as-data).

### ctx.mode

Current run mode: `"rpc"`, `"json"`, or `"print"`. It is the mode of the host the session runs in: `"rpc"` wherever clients drive the host (the daemon's conversation workers, which run every interactive TUI session and every session a phone opens, stdio RPC, and subagents), and `"print"` or `"json"` for print runs. It does not change while clients attach and leave. Extension UI is data every client renders, so UI calls need no mode check. To tell whether a user at the host invoked a command, read [`ctx.invokedBy`](#ctxinvokedby) instead.

### ctx.hasUI

`true` in `"rpc"` hosts (the TUI and RPC mode), also while no client that shows UI is attached (dialogs then resolve to their defaults, so `confirm()` returns `false`). `false` in print mode (`-p`) and JSON mode. Use this to guard dialog methods (`select`, `confirm`, `input`, `editor`, `dialog`, `form`), which resolve to their defaults without UI. Fire-and-forget methods (`notify`, `setStatus`, `setPanel`, `setTitle`, `setEditorText`) need no guard: without a client that shows UI, nothing sees them (see [rpc.md](rpc.md#extensions-in-rpc-mode)).

### ctx.cwd

Current working directory.

### ctx.isProjectTrusted()

Returns whether project-local trust is active for the current session context. This includes temporary trust decisions and CLI trust overrides, not just saved decisions in the global trust store.

Use this before reading project-local extension configuration that should only be honored for trusted projects.

### ctx.sessionManager

A read-only view of the session's log. It holds committed entries only: an entry appears after its write commits. It has no write methods; write through `volt.appendEntry()`, `volt.setLabel()`, and `volt.setSessionName()`, which resolve after their entries commit. See [Session Format](session-format.md) for entry types.

For `tool_call`, the view includes the assistant message that requested the tool. In parallel tool execution mode it is still not guaranteed to include sibling tool results from the same assistant message.

```typescript
ctx.sessionManager.getEntries()       // All entries
ctx.sessionManager.getBranch()        // Current branch
ctx.sessionManager.getLeafId()        // Current leaf entry ID
ctx.sessionManager.getEntry(id)       // One entry
ctx.sessionManager.getLabel(id)       // An entry's label
ctx.sessionManager.getTree()          // The session tree
ctx.sessionManager.getSessionName()   // The session's display name
ctx.sessionManager.getSessionRef()    // Persisted reference, or undefined in memory
```

The view also has `getCwd()`, `getSessionDir()`, `getSessionId()`, `getLeafEntry()`, `getBranchWindow()`, and `getHeader()`.

### ctx.modelRegistry / ctx.model

Access to models and API keys. Make model calls through `ctx.modelRegistry.client`, which resolves each request's credentials:

```typescript
const response = await ctx.modelRegistry.client.complete(ctx.model!, {
  messages: [{ role: "user", content: "Summarize this", timestamp: Date.now() }],
}, { signal: ctx.signal });
```

### ctx.signal

The current agent abort signal, or `undefined` when no agent turn is active.

Use this for abort-aware nested work started by extension handlers, for example:
- `fetch(..., { signal: ctx.signal })`
- model calls that accept `signal`
- file or process helpers that accept `AbortSignal`

`ctx.signal` is typically defined during active turn events such as `tool_call`, `tool_result`, `message_update`, and `turn_end`.
It is usually `undefined` in idle or non-turn contexts such as session events and shortcuts fired while volt is idle.

Command handlers get a different, always-defined signal tied to the session rather than the agent turn. See [ExtensionCommandContext](#extensioncommandcontext).

```typescript
volt.on("tool_result", async (event, ctx) => {
  const response = await fetch("https://example.com/api", {
    method: "POST",
    body: JSON.stringify(event),
    signal: ctx.signal,
  });

  const data = await response.json();
  return { details: data };
});
```

### ctx.isIdle() / ctx.abort() / ctx.hasPendingMessages()

Control flow helpers. `ctx.abort()` stops the run. Called from a command that a local client with an editor invoked (the TUI, or an RPC client that answers `editor_text`), it first takes the queued steering and follow-up input back and returns its text to that client's editor, ahead of the draft there; for any other call the run stops and the queue stays.

### ctx.shutdown()

Request a graceful shutdown of the client the call runs for: the client whose command, prompt, or turn is running, or the session's first client for calls outside any client's request (see [Clients](#clients)). For the TUI or an RPC client, the host ends its connection (`fatal{host_shutdown}`). A call for a client that has already left does nothing.

- **Interactive mode:** The TUI the call runs for quits. Its session stays open in its daemon worker for its other clients and follows the worker's [retention](daemon.md#retention-and-background), so no `session_shutdown` fires then.
- **RPC mode:** The connection ends and the process exits; the session closes, and its extensions receive `session_shutdown`.
- **Phones:** No-op.
- **Print mode:** No-op. The process exits automatically when all prompts are processed.

Available in all contexts (event handlers, tools, commands, shortcuts).

```typescript
volt.on("tool_call", (event, ctx) => {
  if (isFatal(event.input)) {
    ctx.shutdown();
  }
});
```

### ctx.getContextUsage()

Returns current context usage for the active model. Uses last assistant usage when available, then estimates tokens for trailing messages.

```typescript
const usage = ctx.getContextUsage();
if (usage && usage.tokens > 100_000) {
  // ...
}
```

### ctx.compact()

Trigger compaction without awaiting completion. Use `onComplete` and `onError` for follow-up actions.

```typescript
ctx.compact({
  customInstructions: "Focus on recent changes",
  onComplete: (result) => {
    ctx.ui.notify("Compaction completed", "info");
  },
  onError: (error) => {
    ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
  },
});
```

### ctx.getSystemPrompt()

Returns Volt's current system prompt string.

- During `before_agent_start`, this reflects chained system-prompt changes made so far for the current turn.
- It does not include later `context` message mutations.
- It does not include `before_provider_request` payload rewrites.
- If later-loaded extensions run after yours, they can still change what is ultimately sent.

```typescript
volt.on("before_agent_start", (event, ctx) => {
  const prompt = ctx.getSystemPrompt();
  console.log(`System prompt length: ${prompt.length}`);
});
```

### ctx.startWork(kind, options, run)

Starts background work of a kind the extension registered with [`volt.registerWorkKind()`](#voltregisterworkkindname-kind). Resolves with `{ workId }` once the work is recorded; `run` then executes in the background. An extension starts only its own kinds: `kind` is the name it registered, and another extension's kind (or a built-in kind such as `job`) is never found. The context of a `ctx.newSession()`/`ctx.fork()`/`ctx.switchSession()` `withSession` callback cannot start work.

## ExtensionCommandContext

Command handlers receive `ExtensionCommandContext`, which extends `ExtensionContext` with session control methods. These are only available in commands because they can deadlock if called from event handlers.

### ctx.invokedBy

Who invoked the command (`CommandInvoker`): `"local"` for a client in the host's trust domain (the TUI, a stdio RPC client, the SDK, a print run), `"remote"` for a paired remote device, or for an invoking client the host no longer knows. A command run from text the model wrote, such as a subagent's task, is not one a user typed: it reads `"remote"` when a client's turn started it, and `"local"` when a run of the host's own did (a print run, the SDK, or queued input the host replays). Gate what only a user at the host may do on `"local"` and a confirmation the user answers (`ctx.hasUI` and `ctx.ui.confirm`). `/swarm-review` gives its verifiers a shell (`--exec`) only this way:

```typescript
if (ctx.invokedBy !== "local") return ctx.ui.notify("--exec is only available from a local client.", "error");
if (!ctx.hasUI || !(await ctx.ui.confirm("Allow commands?", "Verifiers will run commands.", { signal: ctx.signal }))) return;
```

### ctx.signal (commands)

In a command handler, `ctx.signal` is always defined. It is aborted when the command's session is disposed: for example when it closes after `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()` moved its last client away in an RPC or SDK host (a daemon worker keeps it open), or when a reload replaces it. It is also aborted when the session ends because a write could not be confirmed as saved; Volt then stops waiting for the handler. It is not the agent turn's signal, so a command started during a turn is not cancelled when that turn is.

After the session loses its log, volt stops waiting for the command, cancels the session's other work, and ends the session (`session_shutdown` with reason `"quit"`); the user reopens it with `/resume`. Nothing the command does afterwards can be saved. Pass the signal to long-running work and dialogs so the command ends promptly:

```typescript
volt.registerCommand("deploy", {
  handler: async (args, ctx) => {
    const target = await ctx.ui.select("Deploy to", ["staging", "production"], { signal: ctx.signal });
    if (!target) return;
    await fetch(`https://example.com/deploy/${target}`, { method: "POST", signal: ctx.signal });
  },
});
```

After `ctx.newSession()`, `ctx.fork()`, or `ctx.switchSession()`, use the signal of the `ctx` passed to `withSession`, which belongs to the new session.

### ctx.getSystemPromptOptions()

Returns the base inputs Volt currently uses to build the system prompt.

```typescript
const options = ctx.getSystemPromptOptions();
const contextPaths = options.contextFiles?.map((file) => file.path) ?? [];
```

This has the same shape and mutability as `before_agent_start` `event.systemPromptOptions`: custom prompt, active tools, tool snippets, prompt guidelines, appended system prompt text, cwd, loaded context files, and loaded skills. It may include full context file contents, so treat it as sensitive extension-local data and avoid exposing it through command lists, logs, or autocomplete metadata.

This reports the current base prompt inputs. It does not include per-turn `before_agent_start` chained system-prompt changes, later `context` event message mutations, or `before_provider_request` payload rewrites.

### ctx.waitForIdle()

Wait for the agent to finish streaming:

```typescript
volt.registerCommand("my-cmd", {
  handler: async (args, ctx) => {
    await ctx.waitForIdle();
    // Agent is now idle, safe to modify session
  },
});
```

### ctx.newSession(options?)

Create a new session and move the client whose command called it there (see [Session changes: lifecycle and footguns](#session-changes-lifecycle-and-footguns)). The result carries the new session's id:

```typescript
const parentSessionRef = ctx.sessionManager.getSessionRef();
const kickoff = "Continue in the new session";

const result = await ctx.newSession({
  ...(parentSessionRef ? { parentSessionRef } : {}),
  setup: async (writer) => {
    await writer.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Context from previous session..." }],
      timestamp: Date.now(),
    });
  },
  withSession: async (ctx) => {
    // Use only the new session's ctx here.
    await ctx.sendUserMessage(kickoff);
  },
});

if (result.cancelled) {
  // An extension cancelled the new session
} else {
  console.log(`Now in session ${result.sessionId}`);
  if (!result.seeded) {
    // The new session was opened but your withSession callback was skipped
    // (recovered durable client input failed to replay).
  }
}
```

Options:
- `parentSessionRef`: persisted parent identity to record for the new session
- `setup`: write the new session before it opens, through its async `SessionWriter` (`writer.sessionManager` reads it), before `withSession` runs
- `withSession`: run post-switch work against a fresh context of the new session. Do not use captured old `volt` / command `ctx`; see [Session changes: lifecycle and footguns](#session-changes-lifecycle-and-footguns).

Result (`SessionIntentResult`), the same for `fork()` and `switchSession()`:
- `{ cancelled: true }`: the session did not change, because an extension cancelled it or no client handles session changes. No `withSession` callback ran.
- `{ cancelled: false, sessionId, seeded }`: `sessionId` is the session the invoking client is on now; for `switchSession()` to the current session it is the current one. `seeded` is `true` only when a requested `withSession` callback ran to completion. `seeded: false` after passing `withSession` means the callback did not run: the switch was a no-op targeting the current session (`switchSession` only), the callback was skipped because recovered durable client input failed to replay, the new session closed before the invoking client reconnected to it, or the invoking client was sent to a session that was already open (a `switchSession()` to a session a daemon worker already hosts; see [Clients](#clients)). Check `seeded` before assuming your seed landed. Anything `setup` wrote is in the new session either way.

`ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` reject inside a subagent's conversation: a subagent stays in the conversation its parent opened for it.

### ctx.fork(entryId, options?)

Fork from a specific entry, creating a new persisted session:

```typescript
const result = await ctx.fork("entry-id-123", {
  withSession: async (ctx) => {
    // Use only the forked session's ctx here.
    ctx.ui.notify("Now in the forked session", "info");
  },
});
if (result.cancelled) {
  // An extension cancelled the fork
} else {
  console.log(`Forked into session ${result.sessionId}`);
}

const cloneResult = await ctx.fork("entry-id-456", { position: "at" });
if (cloneResult.cancelled) {
  // An extension cancelled the clone
}
```

Options:
- `position`: `"before"` (default) forks before the selected user message, restoring that prompt into the editor
- `position`: `"at"` duplicates the active path through the selected entry without restoring editor text
- `withSession`: run post-switch work against a fresh context of the forked session. Do not use captured old `volt` / command `ctx`; see [Session changes: lifecycle and footguns](#session-changes-lifecycle-and-footguns).

### ctx.navigateTree(targetId, options?)

Navigate to a different point in the session tree:

```typescript
const result = await ctx.navigateTree("entry-id-456", {
  summarize: true,
  customInstructions: "Focus on error handling changes",
  replaceInstructions: false, // true = replace default prompt entirely
  label: "review-checkpoint",
});
```

Options:
- `summarize`: Whether to generate a summary of the abandoned branch
- `customInstructions`: Custom instructions for the summarizer
- `replaceInstructions`: If true, `customInstructions` replaces the default prompt instead of being appended
- `label`: Label to attach to the branch summary entry (or target entry if not summarizing)

Navigating to a user message moves to before it; its text goes into the invoking client's editor when the editor is empty.

### ctx.switchSession(sessionRef, options?)

Switch to a persisted session by `SessionReference`:

```typescript
// Obtain sessionRef from SessionManager.list(), search(), or getSessionRef().
const result = await ctx.switchSession(sessionRef, {
  withSession: async (ctx) => {
    await ctx.sendUserMessage("Resume work in this session");
  },
});
if (result.cancelled) {
  // An extension cancelled the switch via session_before_switch
}
```

Options:
- `withSession`: run post-switch work against a fresh context of the session switched to. Do not use captured old `volt` / command `ctx`; see [Session changes: lifecycle and footguns](#session-changes-lifecycle-and-footguns).

When the session's working directory no longer exists, the invoking client is asked whether to continue in the current one; declining cancels the switch. A session of a daemon-managed worktree whose checkout is gone is never opened in another directory: the switch fails.

`SessionManager.list()` and `listAll()` read materialized SQLite summaries; `search()` scans extracted searchable text one session at a time. All return `SessionInfo` objects whose `ref` field can be passed directly to `ctx.switchSession()`:

```typescript
import { SessionManager } from "@hansjm10/volt-coding-agent";

volt.registerCommand("switch", {
  description: "Switch to another session",
  handler: async (_args, ctx) => {
    const sessions = await SessionManager.list(ctx.cwd);
    if (sessions.length === 0) return;

    const labels = sessions.map((session) =>
      `${session.name ?? session.firstMessage} — ${session.id}`
    );
    const choice = await ctx.ui.select("Pick session:", labels);
    const selected = choice ? sessions[labels.indexOf(choice)] : undefined;
    if (selected) {
      await ctx.switchSession(selected.ref, {
        withSession: async (ctx) => {
          ctx.ui.notify("Switched session", "info");
        },
      });
    }
  },
});
```

### Session changes: lifecycle and footguns

A session serves one log for its whole life. `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` open another session, with its own extension instance, and move the client whose command called them there; the session the command ran in is never replaced in place. A command can change sessions from any client's request, including a stdio RPC `prompt`: the command's own prompt input completes as it leaves the session.

The order of events:

1. `session_before_switch` or `session_before_fork` in the current session's extensions, which may cancel. Nothing has changed yet.
2. The new session opens. If it cannot (another process holds it, its cwd is missing, its extensions fail to start), the call throws and the client stays where it was.
3. `session_start` (`reason` `"new"`, `"resume"`, or `"fork"`, with `previousSessionRef`) and `resources_discover` in the new session's extensions, with the client attached.
4. `session_shutdown` (same `reason`, with `targetSessionRef`) in the old session's extensions, which no longer reach the client that moved. The old session then closes and releases its lock.
5. `withSession`, against the new session.

In a daemon worker (the interactive TUI, phones) the new session opens in the same worker, and the client follows by reconnecting: step 3 runs when the client attaches to the new session, and the old session stays open in its worker instead of step 4, for its other clients and its [retention](daemon.md#retention-and-background); `withSession` runs once the client attached and the new session's queued input was recovered.

A session refuses to be left while it runs a turn, a bash command, a session mutation, or a detached review, or holds queued durable input; wait for it (`ctx.waitForIdle()`) before changing sessions. In a daemon worker, a client may leave a busy session while other clients stay on it.

`withSession` receives a fresh `ReplacedSessionContext`, which extends `ExtensionCommandContext` with async `sendMessage()` and `sendUserMessage()` helpers bound to the new session.

Lifecycle and footguns:
- `withSession` runs only after the new extension instance has received `session_start` and, in an RPC or SDK host, the old session has emitted `session_shutdown` and closed.
- The callback still executes in the original closure, not inside the new extension instance. That means your old extension instance may already have run its shutdown cleanup before `withSession` starts.
- Captured old `volt` / old command `ctx` session-bound objects are stale once the session changed and will throw if used. Use only the `ctx` passed to `withSession` for session-bound work.
- Previously extracted raw objects are still your responsibility. For example, if you capture `const sm = ctx.sessionManager` before the change, `sm` is still the old `SessionManager` object. Do not reuse it afterwards.
- Code in `withSession` should assume any state invalidated by your `session_shutdown` handler is already gone. Only capture plain data that survives shutdown cleanly, such as strings, ids, and serialized config.
- `withSession` is not guaranteed to run even when the operation is not cancelled: if recovered durable client input fails to replay into the new session, the callback is skipped and the result reports `seeded: false`. Check `seeded` whenever your callback delivers state the rest of your flow depends on.

Safe pattern:

```typescript
volt.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const kickoff = "Continue from the new session";
    await ctx.newSession({
      withSession: async (ctx) => {
        await ctx.sendUserMessage(kickoff);
      },
    });
  },
});
```

Unsafe pattern:

```typescript
volt.registerCommand("handoff", {
  handler: async (_args, ctx) => {
    const oldSessionManager = ctx.sessionManager;
    await ctx.newSession({
      withSession: async (_ctx) => {
        // stale old objects: do not do this
        oldSessionManager.getSessionRef();
        volt.sendUserMessage("wrong");
      },
    });
  },
});
```

### ctx.reload()

Run the same reload flow as `/reload`.

```typescript
volt.registerCommand("reload-runtime", {
  description: "Reload extensions, skills, prompts, and themes",
  handler: async (_args, ctx) => {
    await ctx.reload();
    return;
  },
});
```

Important behavior:
- `await ctx.reload()` emits `session_shutdown` for the current extension runtime
- It then reloads resources and emits `session_start` with `reason: "reload"` and `resources_discover` with reason `"reload"`
- The currently running command handler still continues in the old call frame
- Code after `await ctx.reload()` still runs from the pre-reload version
- Code after `await ctx.reload()` must not assume old in-memory extension state is still valid
- After the handler returns, future commands/events/tool calls use the new extension version

For predictable behavior, treat reload as terminal for that handler (`await ctx.reload(); return;`).

Tools run with `ExtensionContext`, so they cannot call `ctx.reload()` directly. Use a command as the reload entrypoint, then expose a tool that queues that command as a follow-up user message.

Example tool the LLM can call to trigger reload:

```typescript
import type { ExtensionAPI } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";

export default function (volt: ExtensionAPI) {
  volt.registerCommand("reload-runtime", {
    description: "Reload extensions, skills, prompts, and themes",
    handler: async (_args, ctx) => {
      await ctx.reload();
      return;
    },
  });

  volt.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description: "Reload extensions, skills, prompts, and themes",
    parameters: Type.Object({}),
    async execute() {
      volt.sendUserMessage("/reload-runtime", { deliverAs: "followUp" });
      return {
        content: [{ type: "text", text: "Queued /reload-runtime as a follow-up command." }],
      };
    },
  });
}
```

## ExtensionAPI Methods

### volt.on(event, handler)

Subscribe to events. See [Events](#events) for event types and return values. An event name Volt does not define throws, so a misspelled subscription fails the extension's load instead of never running.

### volt.registerTool(definition)

Register a custom tool callable by the LLM. See [Custom Tools](#custom-tools) for full details.

`volt.registerTool()` works both during extension load and after startup. You can call it inside `session_start`, command handlers, or other event handlers. New tools are refreshed immediately in the same session, so they appear in `volt.getAllTools()` and are callable by the LLM without `/reload`.

Use `volt.setActiveTools()` to enable or disable tools (including dynamically added tools) at runtime.

Use `promptSnippet` to opt a custom tool into a one-line entry in `Available tools`, and `promptGuidelines` to append tool-specific bullets to the default `Guidelines` section when the tool is active.

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

See [dynamic-tools.ts](../examples/extensions/dynamic-tools.ts) for a full example.

```typescript
import { Type } from "typebox";
import { StringEnum } from "@hansjm10/volt-ai";

volt.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does",
  promptSnippet: "Summarize or transform text according to action",
  promptGuidelines: ["Use my_tool when the user asks to summarize previously generated text."],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    // Optional compatibility shim. Runs before schema validation.
    // Return the current schema shape, for example to fold legacy fields
    // into the modern parameter object.
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Stream progress
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });

    return {
      content: [{ type: "text", text: "Done" }],
      details: { result: "..." },
    };
  },

  // Optional: how a call looks on every client
  present({ args, state }) {
    return { title: `my_tool ${args.action ?? ""}`, ...(state === "done" ? {} : { activity: "Working…" }) };
  },
});
```

### volt.sendMessage(message, options?)

Inject a custom message into the session. `details` must satisfy the [JSON data boundary](#json-data-boundary). Invalid data is rejected before the message enters agent state, persistence, or publication.

```typescript
volt.sendMessage({
  customType: "my-extension",
  content: "Message text",
  display: true,
  details: { ... },
}, {
  triggerTurn: true,
  deliverAs: "steer",
});
```

**Options:**
- `deliverAs` - Delivery mode:
  - `"steer"` (default) - Queues the message while streaming. Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
  - `"followUp"` - Waits for agent to finish. Delivered only when agent has no more tool calls.
  - `"nextTurn"` - Queued for next user prompt. Does not interrupt or trigger anything.
- `triggerTurn: true` - If agent is idle, trigger an LLM response immediately. Only applies to `"steer"` and `"followUp"` modes (ignored for `"nextTurn"`).

A message queued with `"steer"` or `"followUp"` while the agent streams, or sent with `triggerTurn` while it is idle, is saved to the session log before it is delivered and is recovered when the session is reopened. It counts toward the session's queue limit. A `"nextTurn"` message is held in memory until the next prompt. An idle message without `triggerTurn` is appended to the session immediately.

### volt.sendUserMessage(content, options?)

Send a user message to the agent. Unlike `sendMessage()` which sends custom messages, this sends an actual user message that appears as if typed by the user. Always triggers a turn.

```typescript
// Simple text message
volt.sendUserMessage("What is 2+2?");

// With content array (text + images)
volt.sendUserMessage([
  { type: "text", text: "Describe this image:" },
  { type: "image", source: { type: "base64", mediaType: "image/png", data: "..." } },
]);

// During streaming - must specify delivery mode
volt.sendUserMessage("Focus on error handling", { deliverAs: "steer" });
volt.sendUserMessage("And then summarize", { deliverAs: "followUp" });
```

**Options:**
- `deliverAs` - Required when agent is streaming:
  - `"steer"` - Queues the message for delivery after the current assistant turn finishes executing its tool calls
  - `"followUp"` - Waits for agent to finish all tools

When not streaming, the message is sent immediately and triggers a new turn. When streaming without `deliverAs`, throws an error.

See [send-user-message.ts](../examples/extensions/send-user-message.ts) for a complete example.

### volt.appendEntry(customType, data?)

Persist extension state (does NOT participate in LLM context). Resolves after the entry commits.

```typescript
await volt.appendEntry("my-state", { count: 42 }); // Plain JSON data; omit absent properties

// Restore on reload
volt.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "my-state") {
      // Reconstruct from entry.data
    }
  }
});
```

### volt.setSessionName(name)

Set the session display name (shown in session selector instead of first message). Resolves after the name commits.

```typescript
await volt.setSessionName("Refactor auth module");
```

### volt.getSessionName()

Get the current session name, if set.

```typescript
const name = volt.getSessionName();
if (name) {
  console.log(`Session: ${name}`);
}
```

### volt.setLabel(entryId, label)

Set or clear a label on an entry. Labels are user-defined markers for bookmarking and navigation (shown in `/tree` selector). Resolves after the label commits.

```typescript
// Set a label
await volt.setLabel(entryId, "checkpoint-before-refactor");

// Clear a label
await volt.setLabel(entryId, undefined);

// Read labels via sessionManager
const label = ctx.sessionManager.getLabel(entryId);
```

Labels persist in the session and survive restarts. Use them to mark important points (turns, checkpoints) in the conversation tree.

### volt.registerCommand(name, options)

Register a command. `name` is the slash-command token without the leading `/`: a letter or digit, then at most 63 letters, digits, `_`, and `-`. Invalid names are rejected while the extension loads. For example, use `deploy`, not `/deploy` or `deploy now`.

Clients invoke the command as the intent `extension.command.<id>.<name>`, where `<id>` is the extension's manifest id. When an extension loaded earlier registered the same name, the command is `/<id>:<name>` instead, and volt reports the conflict.

Commands are local-only by default. Set `remoteSafe: true` only after auditing the handler and its argument-completion callback for invocation by a paired remote client:

```typescript
volt.registerCommand("status", {
  description: "Show sanitized project status",
  remoteSafe: true,
  handler: async (_args, ctx) => {
    ctx.ui.notify("Ready", "info");
  },
});
```

`remoteSafe: true` lets paired remote clients invoke the command's intent and send its slash text; it is a security classification, not a sandbox. The handler still runs on the host with the extension's full process permissions. Do not mark commands remote-safe if remote-controlled arguments can read secrets, mutate host configuration, execute arbitrary commands, or trigger UI flows that the remote client cannot safely answer. The default is `false`/omitted.

If multiple extensions register the same command name, volt keeps them all: the first in load order is `/review`, and each later one is `/<id>:review` under its extension's manifest id.

```typescript
volt.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, ctx) => {
    const count = ctx.sessionManager.getEntries().length;
    ctx.ui.notify(`${count} entries`, "info");
  }
});
```

Optional: add argument auto-completion for `/command ...`. `getArgumentCompletions` returns items `{ value, label?, description? }` (`ExtensionCompletionItem`), or `null` for none, and may be async:

```typescript
volt.registerCommand("deploy", {
  description: "Deploy to an environment",
  getArgumentCompletions: (prefix) => {
    const envs = ["dev", "staging", "prod"].filter((env) => env.startsWith(prefix));
    return envs.length > 0 ? envs.map((env) => ({ value: env, label: env })) : null;
  },
  handler: async (args, ctx) => {
    ctx.ui.notify(`Deploying: ${args}`, "info");
  },
});
```

Intents: protocol clients see each extension command as a dynamic intent named `extension.command.<id>.<name>`, where `<id>` is the extension's manifest id (see [rpc.md](rpc.md#dynamic-intents)). The `intents` query lists it with the command's label and description, `presentation.kind: "palette"`, its slash alias, and the input `{arguments?, streamingBehavior?}`. If the command defines `getArgumentCompletions`, the descriptor lists `completions: ["arguments"]`, and clients read the same completions with the `intent_completions` query.

The intent is a presentation layer over the command handler:

- Clients invoke the intent by name; they should not synthesize `/<command>` when the intent is listed. Invoking it sends the command's slash text as a prompt.
- The command still runs in the host and may finish without starting an agent turn.
- `ctx.ui` dialogs reach clients as host requests on the protocol's live lane (see [Clients](#clients)).
- Descriptors expose only bounded labels and source scope/origin metadata. They do not expose extension source paths or raw `sourceInfo`.
- Paired remote clients see only commands registered with `remoteSafe: true`.
- Project-local extension commands appear only after the same project-trust/resource-loading path that exposes them locally.

For an operation with typed input that UI actions, forms, and shortcuts invoke, register an intent with [`volt.registerIntent()`](#voltregisterintentname-options).

### volt.getCommands()

Get the slash commands available for invocation via `prompt` in the current session. Includes extension commands, prompt templates, and skill commands.
The list has the order of the dynamic intents the `intents` query lists: extensions first, then templates, then skills.

```typescript
const commands = volt.getCommands();
const bySource = commands.filter((command) => command.source === "extension");
const userScoped = commands.filter((command) => command.sourceInfo.scope === "user");
```

Each entry has this shape:

```typescript
{
  name: string; // Invokable command name without the leading slash. May be suffixed like "review:1"
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}
```

Use `sourceInfo` as the canonical provenance field. Do not infer ownership from command names or from ad hoc path parsing.

Built-in interactive commands (like `/model` and `/settings`) are not included here. They are handled only in interactive
mode and would not execute if sent via `prompt`.

### volt.registerWorkKind(name, kind?)

Register a kind of background work. Its work is recorded in the conversation log, so every client (the TUI, RPC, and paired devices) sees it with its title, progress, and outcome, and can cancel it. Start work with [`ctx.startWork()`](#ctxstartworkkind-options-run):

```typescript
volt.registerWorkKind("scan", { delivery: "message" });

volt.registerCommand("scan", {
  handler: async (_args, ctx) => {
    await ctx.startWork("scan", { title: "Scan dependencies", input: { root: "." } }, async (work) => {
      work.checkpoint({ text: "Resolving", steps: [{ key: "resolve", label: "Resolve", status: "active" }] });
      const found = await scan(work.signal); // stop when the signal aborts
      work.output(found.join("\n"));
      return {
        outcome: "completed",
        result: { summary: `${found.length} outdated packages` },
        notice: `Outdated packages:\n${found.join("\n")}`,
      };
    });
  },
});
```

The kind's id is `ext:<id>/<name>`, where `<id>` is the extension's manifest id. `name` is at most 64 lowercase letters, digits, `-`, and `_`, starting with a letter or digit. An extension registers at most 16 kinds.

The declaration (all optional):

| Field | Default | Meaning |
|---|---|---|
| `delivery` | `"none"` | What a completed or failed result does: `"message"` queues a notice the model sees with its next turn, without starting one; `"wake"` also starts a turn when the conversation is idle. |
| `cancellable` | `true` | Whether a client may cancel the work (`cancel_work`). |
| `cancelOnAbort` | (cancels) | `false` keeps the work running when the conversation's run stops (Escape, the `abort` intent). |
| `maxActive` | `1` | Most items of the kind open at once, at most 8. |
| `requires` | `[]` | Remote capabilities a paired device needs, beyond the intent's own, to cancel the work or read its output. A kind that requires any keeps its work running when the run stops. |
| `detail` | (none) | A presenter of the `UiNode` data every client shows with a running item; see [Work Detail](#work-detail). |

`run` receives only the work's context: `workId`, `signal` (aborted when the work is cancelled, the extensions reload, or the conversation closes), `progress(progress)` for live progress, `checkpoint(progress)` for a phase that is also recorded in the log (at most every 10 seconds), and `output(text)` (the newest 50 KB are kept). Progress is `{ text?, value?, max?, steps? }`, with steps `{ key, label, status }` and status `pending`, `active`, `done`, `failed`, or `skipped`; text is shown without control sequences.

`run` returns `{ outcome, result?, error?, notice? }` with outcome `completed`, `failed`, or `cancelled`; a run that throws fails, or is cancelled when its signal aborted. `result` keeps a `summary` (at most 2,000 characters), an `output` that replaces the reported output, and JSON `data` (at most 64 KB). `notice` is the notice text (at most 20,000 characters) the model sees after the line naming the work, instead of the summary; paired devices see the title and summary, and read the output with `work_output`. Paired devices act only on work of kinds the host knows: once an extension is gone, they can no longer read its work's output. The title is one line of at most 200 characters, and the input is JSON of at most 16 KB.

In the TUI, open work shows in the footer's work line and in `/work` (Alt+J), which lists its progress, steps, result, and output and cancels it; a finished item that delivers no notice says how it ended in a status line. A notice's own text renders as Markdown, after the line naming the work; a `message` notice shows above the editor until the next turn takes it. Work notices are the host's: `volt.sendMessage()` refuses the `work_notice` custom type.

Reloading the extensions removes their kinds: `/reload` is refused while work runs, and work still running when the kinds are removed (for example, started by a `session_shutdown` handler) ends `interrupted`; whatever its `run` reports or returns afterwards is ignored. Extension work does not survive a restart: work open when the conversation reopens ends `interrupted`.

### volt.registerMessagePresenter(customType, present)

Register how custom messages of `customType` look on every client: a pure, synchronous function from the message to `UiNode` data. See [Message Presentation](#message-presentation).

### volt.registerIntent(name, options)

Register an intent: an operation every client can invoke by name, from a panel's actions and forms, a shortcut, or a protocol frame. `name` is a letter or digit, then at most 63 letters, digits, `_`, and `-`; the call returns the intent's full name, `extension.intent.<manifest id>.<name>`. An extension registers at most 64 intents.

```typescript
import { Type } from "typebox";

const deploy = volt.registerIntent("deploy", {
  label: "Deploy",
  description: "Deploy the current branch",
  input: Type.Object({ target: Type.String(), dryRun: Type.Optional(Type.Boolean()) }),
  handler: async (input, ctx) => {
    ctx.ui.notify(`Deploying to ${input.target}`);
  },
});
```

The host checks the input against `input` (an object schema; no fields when omitted) before `handler` runs, in the extension's command context. A handler that throws rejects the intent as `failed` and reports an extension error. Intents are local-only by default: set `remote: true` to let a paired device invoke one, which also needs `conversation.control.v1` and every capability in `requires`. The `intents` query lists an extension's intents with their input schema (see [rpc.md](rpc.md#dynamic-intents)).

### volt.registerShortcut(shortcut, options)

Map a key to one of the extension's intents or commands: a name `registerIntent` returned, an `extension.command.<manifest id>.<name>`, or the bare name of one of its intents. Pressing the key invokes the intent with no input. See [keybindings.md](keybindings.md) for the key format.

```typescript
volt.registerShortcut("ctrl+shift+f", { description: "Deploy", intent: deploy });
```

The key is a default: the TUI adds an entry named after the intent to its keybinding table, so users rebind it in `keybindings.json` (`"extension.intent.my-ext.deploy": "ctrl+alt+d"`). A key reserved by a built-in action is skipped with a warning.

### volt.registerCompletionProvider(name, provider)

Complete editor tokens that start with `trigger` (1 to 8 characters without whitespace). Every client asks for completions with the `editor_completions` query; the first provider whose trigger starts the token before the cursor and answers with items wins. The host waits at most one second for the providers, keeps at most 50 items, and removes terminal controls from their text. Providers are local-only by default; `remote: true` lets paired devices ask. An extension registers at most 8.

```typescript
volt.registerCompletionProvider("issues", {
  trigger: "#",
  complete: async ({ query, signal }) => {
    const issues = await searchIssues(query, signal);
    return issues.map((issue) => ({ value: `#${issue.number}`, description: issue.title }));
  },
});
```

### volt.registerFlag(name, options)

Register a CLI flag.

```typescript
volt.registerFlag("focus-mode", {
  description: "Start in focus mode",
  type: "boolean",
  default: false,
});

// Check value
if (volt.getFlag("focus-mode")) {
  // Focus mode enabled
}
```

An interactive TUI passes its flag values to the daemon worker that runs its session, with its other startup options; a TUI that attaches to a session already running in a worker keeps that worker's values and is told which options it did not apply. A session a phone opens sees the defaults.

### volt.exec(command, args, options?)

Execute a shell command. Needs the `exec` [permission](#permissions).

```typescript
const result = await volt.exec("git", ["status"], { signal, timeout: 5000 });
// result.stdout, result.stderr, result.code, result.killed
```

### volt.getActiveTools() / volt.getAllTools() / volt.setActiveTools(names)

Manage active tools. This works for both built-in tools and dynamically registered tools. `volt.getActiveTools()` returns the active tool names as `string[]`; `volt.getAllTools()` returns metadata for all configured tools.

```typescript
const active = volt.getActiveTools(); // ["read", "bash", ...]
const all = volt.getAllTools();
// all = [{
//   name: "read",
//   description: "Read file contents...",
//   parameters: ...,
//   promptGuidelines: ["Use read to examine files instead of cat or sed."],
//   sourceInfo: { path: "<builtin:read>", source: "builtin", scope: "temporary", origin: "top-level" }
// }, ...]
const builtinTools = all.filter((t) => t.sourceInfo.source === "builtin");
const extensionTools = all.filter((t) => t.sourceInfo.source !== "builtin" && t.sourceInfo.source !== "sdk");
volt.setActiveTools([...new Set([...active, "my_custom_tool"])]); // Keep current tools and enable my_custom_tool
volt.setActiveTools(["read", "bash"]); // Switch to read-only
```

`volt.getAllTools()` returns `name`, `description`, `parameters`, `promptGuidelines`, and `sourceInfo`.

Typical `sourceInfo.source` values:
- `builtin` for built-in tools
- `sdk` for tools passed via `createAgentSession({ customTools })`
- extension source metadata for tools registered by extensions

### volt.setModel(model)

Set the current model. Returns `false` if no API key is available for the model. See [models.md](models.md) for configuring custom models.

```typescript
const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");
if (model) {
  const success = await volt.setModel(model);
  if (!success) {
    ctx.ui.notify("No API key for this model", "error");
  }
}
```

### volt.getThinkingLevel() / volt.setThinkingLevel(level)

Get or set the thinking level. Level is clamped to model capabilities (non-reasoning models always use "off"). Changes emit `thinking_level_select`.

```typescript
const current = volt.getThinkingLevel();  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
volt.setThinkingLevel("high");
```

### volt.events

Shared event bus for communication between extensions:

```typescript
volt.events.on("my:event", (data) => { ... });
volt.events.emit("my:event", { ... });
```

### volt.registerProvider(name, config)

Register or override a model provider dynamically. Useful for proxies, custom endpoints, or team-wide model configurations. Needs the `providers` [permission](#permissions).

Calls made during the extension factory function are queued and applied once the runner initialises. Calls made after that — for example from a command handler following a user setup flow — take effect immediately without requiring a `/reload`.

If you need to discover models from a remote endpoint, prefer an async extension factory over deferring the fetch to `session_start`. volt waits for the factory before startup continues, so the registered models are available immediately, including to `volt --list-models`.

```typescript
// Register a new provider with custom models
volt.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY",  // env var reference
  api: "anthropic-messages",
  models: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude 4 Sonnet (proxy)",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// Override baseUrl for an existing provider (keeps all models)
volt.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Register provider with OAuth support for /login
volt.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",
    async login(callbacks) {
      // Custom OAuth flow
      callbacks.onAuth({ url: "https://sso.corp.com/..." });
      const code = await callbacks.onPrompt({ message: "Enter code:" });
      return { refresh: code, access: code, expires: Date.now() + 3600000 };
    },
    async refreshToken(credentials) {
      // Refresh logic
      return credentials;
    },
    getApiKey(credentials) {
      return credentials.access;
    },
    async fetchSubscriptionUsage(credentials, options) {
      return fetchCorporateUsage(credentials.access, options?.signal);
    }
  }
});
```

**Config options:**
- `name` - Display name for the provider in UI such as `/login`.
- `baseUrl` - API endpoint URL. Required when defining models.
- `apiKey` - API key literal, environment interpolation (`$ENV_VAR` or `${ENV_VAR}`), or leading `!command`. Required when defining models (unless `oauth` provided). `$$` escapes `$`, and `$!` escapes a literal `!` without triggering command execution.
- `api` - API type: `"anthropic-messages"`, `"openai-completions"`, `"openai-responses"`, etc.
- `headers` - Custom headers to include in requests.
- `authHeader` - If true, adds `Authorization: Bearer` header automatically.
- `models` - Array of model definitions. If provided, replaces all existing models for this provider. Model definitions can set `baseUrl` to override the provider endpoint for that model.
- `oauth` - OAuth provider config for `/login` support. When provided, the provider appears in the login menu. Add `fetchSubscriptionUsage(credentials, options)` to expose normalized quota windows through `/usage`; return `SubscriptionUsageResult` and omit raw payloads and identity fields.
- `streamSimple` - Custom streaming implementation for non-standard APIs.

See [custom-provider.md](custom-provider.md) for advanced topics: custom streaming APIs, OAuth details, model definition reference.

### volt.unregisterProvider(name)

Remove a previously registered provider and its models. Built-in models that were overridden by the provider are restored. Has no effect if the provider was not registered.

Like `registerProvider`, this takes effect immediately when called after the initial load phase, so a `/reload` is not required.

```typescript
volt.registerCommand("my-setup-teardown", {
  description: "Remove the custom proxy provider",
  handler: async (_args, _ctx) => {
    volt.unregisterProvider("my-proxy");
  },
});
```

## Managed context preparation

Extensions can prepare optional repository context without running another agent or changing the selected model. Nothing runs automatically: an extension must subscribe and start a task. This API ships no classifier or preparation extension.

### Request boundaries and ownership

`request_boundary` is a notification-only event before conversational model requests, after committed user delivery and normal context processing. It provides `attemptId`, `cause` (`input`, `tools`, `continuation`, or `retry`), `first` for the request scope, and `waitAvailableMs` for the host's first-boundary allowance. Returned promises do not delay the model; exceptions are contained.

`ctx.services` captures the current request scope and a detached snapshot: runtime/branch/scope identity, `revision` (the log ordinal the request builds on), cwd, mode, model identity, committed input text and delivery class, available read services, and a bounded loaded skill catalog (`skills`, `skillsTruncated`). It is available to request-boundary and eligible foreground `tool_execution_end` handlers, not idle commands, raw input, compaction, or policy/diagnostic handlers. Keeping a facade does not let it follow a later request.

Queued messages start no preparation until delivered. Accepted steering cancels current preparation; queued follow-ups do not cancel it until delivery. Tasks are revoked on abort, foreground settlement, tree navigation, reload, a session change, and when the session ends because a write could not be confirmed as saved. Retries/tool turns share a scope. Compaction and tree-summary inference do not collect preparation context. Completion never wakes the model or queues a message.

```typescript
// Illustrative API use, not a built-in extension or default behavior.
volt.on("request_boundary", (event, ctx) => {
  if (!event.first || !ctx.services) return;
  ctx.services.tasks.start({ key: "readme", label: "Read project overview" }, async (task) => {
    const result = await task.repository.readText({ path: "README.md", limit: 40 });
    if (result.status !== "ok") return;
    task.context.put({
      key: "overview",
      text: result.text,
      dependency: "sources",
      evidenceIds: [result.evidence.id],
    });
  });
});
```

### Tasks and repository services

`tasks.start({ key, label, timeoutMs? }, callback)` returns `{ status: "started" | "already_running", task }` or a typed failure. A live key deduplicates only this extension's task in this scope. It is not a cache of equivalent tool calls.

The handle has `id`, `status()`, `cancel()`, and `wait({ signal? })`. Cancelling a wait does not cancel its task. The callback receives a fixed `snapshot`, `signal`, absolute `deadline`, `repository`, and `context`. Pass its signal to nested async operations. Nested managed task starts and managed execution from policy/diagnostic callbacks are prohibited, including asynchronous continuations through captured facades.

| Service | Arguments | Successful result |
| --- | --- | --- |
| `readText` | `path`, optional `offset`/`limit` | `text`, `truncated`, and an `evidence` handle with path/range/observation time |
| `findPaths` | `pattern`, optional `path`/`limit` | `paths`, `truncated` |
| `searchText` | `pattern`, optional `path`, `glob`, `literal`, `ignoreCase`, `context`, `limit` | `matches` with path/line/text, `truncated` |
| `symbols` | `path`, optional `symbol` for a workspace query | Flattened `symbols` with name, LSP kind and source range; `truncated`, `coverage`, `observedAt` |
| `definition` / `references` | `path`, `symbol`, optional `line` | `locations` with source ranges; `truncated`, `coverage`, `observedAt` |
| `readSkill` | `resourceId`, optional `offset`/`limit` | Text-read result with the resource ID also attached to its evidence |

Results discriminate on `status`: `ok`, `denied`, `unavailable`, `unsupported`, `invalidated`, `cancelled`, `deadline_exceeded`, `limit_exceeded`, or `failed`. Failures include a bounded host reason code. An empty successful search is not an execution failure. Discovery paths are absolute and can be passed directly to `readText`, including searches below a nested directory. Discovery matches are hints, not freshness-verified source evidence; use `readText` before citing their contents.

Workspace services require the corresponding active, trusted native `read`, `find`, `grep`, or `lsp` tool. They do not enable tools, fall back through Bash/local files around an override, or download missing search executables. SDK/custom/extension overrides without a trusted structured implementation are unavailable. Text reads do not convert or return images.

Managed calls honor applicable tool-call and host policy gates. Arguments are revalidated after hooks. `tool_call` and `tool_result` receive host `origin` attribution for managed operations; absent origin on an ordinary call means agent work. Result reducers run before structured data is exposed: if they change the result, the service withholds the raw observations (`transformed_result`); managed reducer errors fail closed. No-op reducers can coexist. Managed reads do not count as the main agent's Plan-mode research or create synthetic assistant tool calls.

Semantic locations have canonical absolute paths and 1-based `startLine`, `startColumn`, `endLine`, and `endColumn`; columns use LSP UTF-16 units. Coverage is `unknown`, even for a successful query: the server may not have indexed everything. Managed queries reuse the configured LSP manager, may start configured servers, and never offer or run an installation. On the shared transport, server-initiated edits are rejected while managed reads remain outstanding, including unresolved timed-out requests. An overlapping command-based foreground fix can therefore fail explicitly; acknowledged completion or server restart restores ordinary edit handling.

### Loaded skill resources

`task.snapshot.skills` contains opaque `resourceId`, name, description, scope, and origin for native-loaded, model-invocable skills. User-only (`disable-model-invocation`) skills and metadata-only SDK overrides receive no managed read handles. The catalog holds at most 128 descriptors within 64 KiB; `skillsTruncated` reports omissions. It does not expose paths or bodies automatically.

`readSkill` authorizes only the issued file, not adjacent files or referenced scripts. It requires current catalog membership and a registered trusted native read implementation, but does not require general `read` to be active. Excluded or overridden read implementations are not bypassed. Existing read-shaped call/result policies still run; a hook cannot redirect the target. The host checks the opened descriptor against the file identity captured during skill loading. Replaced or retargeted files require a resource reload; removal and reload revoke old handles. Source validation also rechecks current membership and bytes. Skill contributions remain untrusted data and cannot suppress explicitly invoked skills or project instructions.

### Optional first-request waiting

Ready-only remains the default. A host may configure SDK `extensionServicesLimits.firstRequestWaitMs` from 0 to 100. During the synchronous first `request_boundary` callback, an extension may call `ctx.services.context.requestWait(milliseconds)`, which returns the shared effective allowance. Requests combine by maximum, not sum, and cannot exceed the host ceiling. Requests after an await, from policy/task lineage, or at later/final-response boundaries return zero.

The first collection waits for the tasks admitted at that boundary, only until they settle, the allowance expires, or the scope is revoked. Timeout does not cancel useful ongoing preparation. Retries and later turns receive no renewed wait; late contributions cannot enter an already collected request. CPU-bound trusted extension code is not preempted, but results beyond the deadline are excluded from that attempt.

### Context admission

`task.context.put({ key, text, evidenceIds?, dependency? })` proposes context; `remove(key)` retracts it. Keys are extension-local. The default dependency is `snapshot`: conversation changes make it ineligible until refreshed. `sources` permits direct source evidence to survive ordinary appends, but requires valid evidence handles and never survives a new request scope. Suggestions without source handles are labeled unverified.

Volt collects already-ready contributions at eligible conversational boundaries, validates source identity/content and current authorization, and appends a bounded untrusted suffix to the request-local projection. One captured authorization revision set covers the entire collection and remains attached through the final Harness admission await. A mismatch omits the whole optional suffix with `authority_changed`, continues mandatory context, and does not retry validation or extend preparation/collection deadlines. Contributions remain `ready` until final admission; rejected contributions report `omitted`. It does not modify canonical history or mandatory instructions. Late, stale, unauthorized, oversized, or uncheckable contributions are omitted. No compaction is triggered to fit optional context.

Even with an opted-in wait, first-call improvement is not guaranteed. Source validation has a separate bounded collection deadline; ready-only is not a zero-latency promise. Sources that could not be revalidated before that deadline are omitted with `validation_deadline`; changed, deleted, or retargeted sources report `source_unverified`. A validated file is a checked-at observation, not an atomic repository snapshot or proof that tests passed. `admitted` means included by this API, not that later trusted payload hooks preserved it or the model used it.

### Limits, diagnostics, and disable behavior

Defaults allow two unsettled tasks per extension, four per runtime, and eight process-wide. Task deadlines default to 10 seconds with a 30-second ceiling. Each task can make 16 managed calls and return 256 KiB of source data; the scope shares 64 calls and 1 MiB including validation. Contributions are capped at 4 KiB each, 8 KiB per extension, and a 16 KiB request suffix. Source collection is bounded to 100 ms. A host can tighten limits through SDK `extensionServicesLimits`.

Task completion includes draining owned operations. Return, throw, or cancellation does not release capacity while an unawaited host operation remains active. Non-cooperative callbacks remain fenced and charged; arbitrary in-process code is not forcibly terminated.

`volt.getServicesStatus()` returns this extension's bounded task summaries and contribution states/reasons, including while idle. `extension_operation` provides content-free operation metadata. It is diagnostic-only, suppresses the initiating extension's own observations, and grants no reactive execution. Use foreground `tool_execution_end` for triage instead of scheduling managed tasks from a result reducer.

Use the existing extension resource configuration and reload/restart to disable an extension. Excluded modules do not run their factories; reload revokes old managed tasks. Explicit CLI `-e` and SDK-injected factories remain explicit loads.

**Trust boundary:** extensions remain trusted code with full process permissions. These services do not sandbox Node filesystem/HTTP access, existing `volt.exec`, or captured messaging APIs. Auxiliary-provider data export must be explicitly configured by that extension. There is no auxiliary inference, network upload, or transparent tool-result cache built into this API.

Maintainer contracts: [foundation design](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/extension-services-design.md), [first-PR scope](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/extension-services-implementation-plan-design.md), and [completion scope](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/extension-services-completion-design.md).

## State Management

Extensions with state should store it in tool result `details` for proper branching support:

```typescript
export default function (volt: ExtensionAPI) {
  let items: string[] = [];

  // Reconstruct state from session
  volt.on("session_start", async (_event, ctx) => {
    items = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        if (entry.message.toolName === "my_tool") {
          items = entry.message.details?.items ?? [];
        }
      }
    }
  });

  volt.registerTool({
    name: "my_tool",
    // ...
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      items.push("new item");
      return {
        content: [{ type: "text", text: "Added" }],
        details: { items: [...items] },  // Store for reconstruction
      };
    },
  });
}
```

## Custom Tools

Register tools the LLM can call via `volt.registerTool()`. Tools appear in the system prompt, and their [`present()`](#tool-presentation) says how their calls look.

Use `promptSnippet` for a short one-line entry in the `Available tools` section in the default system prompt. If omitted, custom tools are left out of that section.

Use `promptGuidelines` to add tool-specific bullets to the default system prompt `Guidelines` section. These bullets are included only while the tool is active (for example, after `volt.setActiveTools([...])`).

**Important:** `promptGuidelines` bullets are appended flat to the `Guidelines` section with no tool name prefix or grouping. Each guideline must name the tool it refers to — avoid "Use this tool when..." because the LLM cannot tell which tool "this" means. Write "Use my_tool when..." instead.

Note: Some models are idiots and include the @ prefix in tool path arguments. Built-in tools strip a leading @ before resolving paths. If your custom tool accepts a path, normalize a leading @ as well.

If your custom tool mutates files, use `withFileMutationQueue()` so it participates in the same per-file queue as built-in `edit` and `write`. This matters because tool calls run in parallel by default. Without the queue, two tools can read the same old file contents, compute different updates, and then whichever write lands last overwrites the other.

Example failure case: your custom tool edits `foo.ts` while built-in `edit` also changes `foo.ts` in the same assistant turn. If your tool does not participate in the queue, both can read the original `foo.ts`, apply separate changes, and one of those changes is lost.

Pass the real target file path to `withFileMutationQueue()`, not the raw user argument. Resolve it to an absolute path first, relative to `ctx.cwd` or your tool's working directory. For existing files, the helper canonicalizes through `realpath()`, so symlink aliases for the same file share one queue. For new files, it falls back to the resolved absolute path because there is nothing to `realpath()` yet.

Queue the entire mutation window on that target path. That includes read-modify-write logic, not just the final write.

```typescript
import { withFileMutationQueue } from "@hansjm10/volt-coding-agent";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  const absolutePath = resolve(ctx.cwd, params.path);

  return withFileMutationQueue(absolutePath, async () => {
    await mkdir(dirname(absolutePath), { recursive: true });
    const current = await readFile(absolutePath, "utf8");
    const next = current.replace(params.oldText, params.newText);
    await writeFile(absolutePath, next, "utf8");

    return {
      content: [{ type: "text", text: `Updated ${params.path}` }],
      details: {},
    };
  });
}
```

### Tool Definition

```typescript
import { Type } from "typebox";
import { StringEnum } from "@hansjm10/volt-ai";

volt.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  promptSnippet: "List or add items in the project todo list",
  promptGuidelines: [
    "Use my_tool for todo planning instead of direct file edits when the user asks for a task list."
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "add"] as const),  // Use StringEnum for Google compatibility
    text: Type.Optional(Type.String()),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as { action?: string; oldAction?: string };
    if (typeof input.oldAction === "string" && input.action === undefined) {
      return { ...input, action: input.oldAction };
    }
    return args;
  },

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Check for cancellation
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }

    // Stream progress updates
    onUpdate?.({
      content: [{ type: "text", text: "Working..." }],
      details: { progress: 50 },
    });

    // Run commands via volt.exec (captured from extension closure)
    const result = await volt.exec("some-command", [], { signal });

    // Return result
    return {
      content: [{ type: "text", text: "Done" }],  // Sent to LLM
      details: { data: result },                   // For presentation & state
      // Optional: stop after this tool batch when every finalized tool result
      // in the batch also requests the stop disposition.
      disposition: "stop",
    };
  },

  // Optional: how a call looks on every client (see Tool Presentation)
  present({ args, state, result }) { ... },
});
```

**Signaling errors:** Throw from `execute` when a failure has no structured result. The agent catches the error, sets `isError: true`, and reports it to the LLM. When a protocol supplies useful failure content or details, return them with `isError: true`; the flag propagates through tool-result hooks, events, and the model-visible result.

**JSON-safe results:** Every final result, `onUpdate` payload, and `tool_result` patch must satisfy the [JSON data boundary](#json-data-boundary). Invalid final results and patches become explicit tool failures. An invalid streaming update aborts the linked execution signal, suppresses later updates, waits for `execute()` to settle, and then reports the validation failure. Calls to `onUpdate` after `execute()` settles are ignored.

**Tool disposition:** Return `disposition: "stop"` from `execute()` to skip the automatic follow-up LLM call when every finalized result in the batch requests it. Return `disposition: "final_response"` to authorize one additional tool-free response; a successful final-response result takes precedence over other batch results. See [examples/extensions/structured-output.ts](../examples/extensions/structured-output.ts) for a minimal stop-disposition example.

```typescript
async execute(toolCallId, params) {
  const result = await callProtocol(params.input);
  if (!result.ok) {
    return {
      content: [{ type: "text", text: result.message }],
      details: result,
      isError: true,
    };
  }
  return { content: [{ type: "text", text: "OK" }], details: result };
}
```

**Important:** Use `StringEnum` from `@hansjm10/volt-ai` for string enums. `Type.Union`/`Type.Literal` doesn't work with Google's API.

**Argument preparation:** `prepareArguments(args)` is optional. If defined, it runs before schema validation and before `execute()`. Use it to mimic an older accepted input shape when volt resumes an older session whose stored tool call arguments no longer match the current schema. Return the object you want validated against `parameters`. Keep the public schema strict. Do not add deprecated compatibility fields to `parameters` just to keep old resumed sessions working.

Example: an older session may contain an `edit` tool call with top-level `oldText` and `newText`, while the current schema only accepts `edits: [{ oldText, newText }]`.

```typescript
volt.registerTool({
  name: "edit",
  label: "Edit",
  description: "Edit a single file using exact text replacement",
  parameters: Type.Object({
    path: Type.String(),
    edits: Type.Array(
      Type.Object({
        oldText: Type.String(),
        newText: Type.String(),
      }),
    ),
  }),
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;

    const input = args as {
      path?: string;
      edits?: Array<{ oldText: string; newText: string }>;
      oldText?: unknown;
      newText?: unknown;
    };

    if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
      return args;
    }

    return {
      ...input,
      edits: [...(input.edits ?? []), { oldText: input.oldText, newText: input.newText }],
    };
  },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // params now matches the current schema
    return {
      content: [{ type: "text", text: `Applying ${params.edits.length} edit block(s)` }],
      details: {},
    };
  },
});
```

### Overriding Built-in Tools

Extensions can override built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) by registering a tool with the same name. Interactive mode displays a warning when this happens.

```bash
# Extension's read tool replaces built-in read
volt -e ./tool-override.ts
```

Alternatively, use `--no-builtin-tools` to start without any built-in tools while keeping extension tools enabled:
```bash
# No built-in tools, only extension tools
volt --no-builtin-tools -e ./my-extension.ts
```

See [examples/extensions/tool-override.ts](../examples/extensions/tool-override.ts) for a complete example that overrides `read` with logging and access control.

**Presentation:** An override without `present()` presents with the built-in tool's presenter (diffs, highlighted code, terminal output), so you can wrap a built-in tool for logging or access control without reimplementing how it looks. Define `present()` on the override to change it; see [tool-presentation.ts](../examples/extensions/tool-presentation.ts).

**Prompt metadata:** `promptSnippet` and `promptGuidelines` are not inherited from the built-in tool. If your override should keep those prompt instructions, define them on the override explicitly.

**Your implementation must match the exact result shape**, including the `details` type. The built-in presenters and session logic depend on these shapes for presentation and state tracking.

Built-in tool implementations:
- [read.ts](../src/core/tools/read.ts) - `ReadToolDetails`
- [bash.ts](../src/core/tools/bash.ts) - `BashToolDetails`
- [edit.ts](../src/core/tools/edit.ts)
- [write.ts](../src/core/tools/write.ts)
- [grep.ts](../src/core/tools/grep.ts) - `GrepToolDetails`
- [find.ts](../src/core/tools/find.ts) - `FindToolDetails`
- [ls.ts](../src/core/tools/ls.ts) - `LsToolDetails`

### Remote Execution

Built-in tools support pluggable operations for delegating to remote systems (SSH, containers, etc.):

```typescript
import { createReadTool, createBashTool, type ReadOperations } from "@hansjm10/volt-coding-agent";

// Create tool with custom operations
const remoteRead = createReadTool(cwd, {
  operations: {
    readFile: (path) => sshExec(remote, `cat ${path}`),
    access: (path) => sshExec(remote, `test -r ${path}`).then(() => {}),
  }
});

// Register, checking flag at execution time
volt.registerTool({
  ...remoteRead,
  async execute(id, params, signal, onUpdate, _ctx) {
    const ssh = getSshConfig();
    if (ssh) {
      const tool = createReadTool(cwd, { operations: createRemoteOps(ssh) });
      return tool.execute(id, params, signal, onUpdate);
    }
    return localRead.execute(id, params, signal, onUpdate);
  },
});
```

**Operations interfaces:** `ReadOperations`, `WriteOperations`, `EditOperations`, `BashOperations`, `LsOperations`, `GrepOperations`, `FindOperations`

For `user_bash`, extensions can reuse volt's local shell backend via `createLocalBashOperations()` instead of reimplementing local process spawning, shell resolution, and process-tree termination.

The bash tool also supports a spawn hook to adjust the command, cwd, or env before execution:

```typescript
import { createBashTool } from "@hansjm10/volt-coding-agent";

const bashTool = createBashTool(cwd, {
  spawnHook: ({ command, cwd, env }) => ({
    command: `source ~/.profile\n${command}`,
    cwd: `/mnt/sandbox${cwd}`,
    env: { ...env, CI: "1" },
  }),
});
```

See [examples/extensions/ssh.ts](../examples/extensions/ssh.ts) for a complete SSH example with `--ssh` flag.

### Output Truncation

**Tools MUST truncate their output** to avoid overwhelming the LLM context. Large outputs can cause:
- Context overflow errors (prompt too long)
- Compaction failures
- Degraded model performance

The built-in limit is **50KB** (~10k tokens) and **2000 lines**, whichever is hit first. Use the exported truncation utilities:

```typescript
import {
  truncateHead,      // Keep first N lines/bytes (good for file reads, search results)
  truncateTail,      // Keep last N lines/bytes (good for logs, command output)
  truncateLine,      // Truncate a single line to maxBytes with ellipsis
  formatSize,        // Human-readable size (e.g., "50KB", "1.5MB")
  DEFAULT_MAX_BYTES, // 50KB
  DEFAULT_MAX_LINES, // 2000
} from "@hansjm10/volt-coding-agent";

async execute(toolCallId, params, signal, onUpdate, ctx) {
  const output = await runCommand();

  // Apply truncation
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  let result = truncation.content;

  if (truncation.truncated) {
    // Write full output to temp file
    const tempFile = writeTempFile(output);

    // Inform the LLM where to find complete output
    result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
    result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
    result += ` Full output saved to: ${tempFile}]`;
  }

  return { content: [{ type: "text", text: result }] };
}
```

**Key points:**
- Use `truncateHead` for content where the beginning matters (search results, file reads)
- Use `truncateTail` for content where the end matters (logs, command output)
- Always inform the LLM when output is truncated and where to find the full version
- Document the truncation limits in your tool's description

See [examples/extensions/truncated-tool.ts](../examples/extensions/truncated-tool.ts) for a complete example wrapping `rg` (ripgrep) with proper truncation.

### Multiple Tools

One extension can register multiple tools with shared state:

```typescript
export default function (volt: ExtensionAPI) {
  let connection = null;

  volt.registerTool({ name: "db_connect", ... });
  volt.registerTool({ name: "db_query", ... });
  volt.registerTool({ name: "db_close", ... });

  volt.on("session_shutdown", async () => {
    connection?.close();
  });
}
```

### Tool Presentation

How a tool call looks is data: the tool's `present(input)` returns a `ToolPresentation`, which every client (the TUI, RPC clients, paired phones, and the HTML export) renders the same way. The host runs it; clients never run extension code.

```typescript
import { StringEnum } from "@hansjm10/volt-ai";
import type { UiNode, UiNodeStyledText } from "@hansjm10/volt-protocol";
import { Type } from "typebox";

volt.registerTool({
  name: "deploy",
  label: "Deploy",
  description: "Deploy a service",
  parameters: Type.Object({ service: Type.String(), env: StringEnum(["staging", "prod"] as const) }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // ...
    return { content: [{ type: "text", text: "Deployed" }], details: {} };
  },

  present({ args, state, result }) {
    const title: UiNodeStyledText = [
      { text: "deploy ", bold: true },
      { text: args.service ?? "…", token: "accent" },
      ...(args.env ? [{ text: ` to ${args.env}`, token: "muted" as const }] : []),
    ];
    if (state !== "done" || !result) return { title, activity: "Deploying…", showsDuration: true };
    const status: UiNode = result.isError
      ? { type: "text", key: "status", text: "Failed", token: "error" }
      : { type: "text", key: "status", text: "Deployed", token: "success" };
    const log = result.content.flatMap((part) => (part.type === "text" ? part.text.split("\n") : []));
    return {
      title,
      summary: [status],
      body: [status, { type: "terminal", key: "log", lines: log }],
      showsDuration: true,
    };
  },
});
```

`present` receives a `ToolPresentInput`:

| Field | Meaning |
|---|---|
| `args` | The arguments parsed so far. While `argsComplete` is `false` they may be incomplete or of the wrong type: check what you read. |
| `argsComplete` | Whether the model finished streaming the arguments. |
| `state` | `pending` (the arguments still stream), `running`, or `done`. |
| `result` | `{ content, details?, isError, partial }`: the final result, or while the tool runs the latest partial result it reported through `onUpdate` (`partial: true`). |
| `cwd` | The conversation's working directory, for showing paths relative to it. |

It returns a `ToolPresentation`:

| Field | Meaning |
|---|---|
| `title` | One line of [styled text](#styled-text) naming the call, such as `$ npm test`. |
| `activity` | Styled text saying what the call does while it runs. |
| `summary` | `UiNode[]` shown while the call is collapsed. |
| `body` | `UiNode[]` shown while it is expanded; clients show `summary` when there is no body. |
| `actions` | [Actions](#actions) shown with the call. |
| `hidden` | Clients do not show the call. |
| `showsDuration` | Clients show the call's elapsed time. |

- **Pure, synchronous, and stateless.** The same input gives the same presentation. The host presents a call when it starts, at most every 100 ms while partial results arrive, and when it ends, and presents calls in the log again whenever it shows them to a client; it never stores presentations. It passes the presenter a copy of the input, and refuses a returned promise.
- **Fallbacks.** A tool without `present()` presents with the built-in presenter of its name, if it has one (an override of `read` keeps `read`'s look), else with the generic presentation: the tool's name, its arguments as JSON, and its output. A presenter that throws or returns invalid data gets the generic presentation too, and so do the calls of a disabled extension's tool.
- **Chrome.** Clients draw the rest: the call's state, its elapsed time, collapsing and expanding (Ctrl+O, `app.tools.expand`, in the TUI), the result's images, and the work the call started.
- **Normalized and bounded.** The host converts ANSI styling to tokens, checks the data against the [`UiNode` schema](ui-nodes.md), and drops actions the extension may not bind. A presentation holds at most 64 KB of JSON for local clients and 16 KB for paired devices: the oldest lines of terminal nodes and the ends of code and diff nodes are cut first, and a presentation that still does not fit is replaced by the generic one (for a paired device, the tool's name).
- **Keyed updates.** While a call runs, clients receive patches of its `summary` and `body`, and a terminal node that only gained lines is sent as the new lines. Give nodes stable `key`s so updates stay small.

`present` is typed by the tool: `ToolPresentInput<Static<TParams>, TDetails>`. [tool-presentation.ts](../examples/extensions/tool-presentation.ts) gives the built-in `read`, `bash`, `edit`, and `write` tools compact presenters; [todo.ts](../examples/extensions/todo.ts) and [questionnaire.ts](../examples/extensions/questionnaire.ts) present their own tools.

## UI as Data

Extension UI is data: [styled text](#styled-text) and [`UiNode`](ui-nodes.md) trees. The host checks and normalizes it, holds it per conversation, and sends it to every client, which renders it with its own components: the TUI with terminal components, RPC clients and paired phones from the protocol's live lane and projected entries, and the HTML export as HTML. No extension code runs in a client. [UI Nodes](ui-nodes.md) is the reference for node types, styled text, actions, patches, and limits.

| Contribution | API | Clients receive (see [rpc.md](rpc.md#live-lane)) |
|---|---|---|
| Notifications | `ctx.ui.notify(text, level?)` | a `notice` |
| Dialogs and forms | `ctx.ui.select`, `confirm`, `input`, `editor`, `dialog`, `form` | a host request |
| Status items | `ctx.ui.setStatus(key, text)` | `ext_status/<id>/<key>` |
| Panels | `ctx.ui.setPanel(name, panel)` | `ext_panel/<id>/<name>` |
| Window title | `ctx.ui.setTitle(title)` | `ext_title` |
| Editor text | `ctx.ui.setEditorText`, `pasteToEditor`, `getEditorText` | `directive` items and an `editor_text` host request |
| Theme | `ctx.ui.setTheme(name)` | a `set_theme` directive (local clients only) |
| Tool presentation | a tool's [`present()`](#tool-presentation) | a tool call's `presentation` |
| Message presentation | [`volt.registerMessagePresenter()`](#message-presentation) | a custom message's `presentation` |
| Work detail | a work kind's [`detail`](#work-detail) | `work/<workId>` `detail` |
| Intents, shortcuts, and completions | [`volt.registerIntent()`](#voltregisterintentname-options), [`registerShortcut()`](#voltregistershortcutshortcut-options), [`registerCompletionProvider()`](#voltregistercompletionprovidername-provider) | intent descriptors, keybindings, `editor_completions` |

### Clients

A session's extensions are bound once, when the first client attaches: the stdio RPC client, print mode, or the first TUI or phone of a session a daemon worker hosts. They bind in the mode of the host the session runs in (`ctx.mode`), and `session_start` fires. The host attaches each client's surface whenever the client joins a session, including the session a session change moves it to. Later clients attach their own surface:

- **UI** (`ctx.ui`): dialogs (`select`, `confirm`, `input`, `editor`, `dialog`, `form`), `notify`, `setStatus`, `setPanel`, `setTitle`, `setEditorText`, and `pasteToEditor` belong to the conversation and reach every attached client that shows UI. Status items and panels are the extension's own, keyed by its manifest id. A dialog is asked of every attached client that can answer it, and the first answer wins. It stays pending until it is answered, its `signal` aborts, its `timeout` passes, the extensions reload, or the conversation closes, and it outlives the clients that saw it: a client that attaches, or reconnects, while it is pending is asked again, and receives the latest status, panels, and title too. A phone is asked only the dialogs its access can answer (`conversation.control.v1`), also in a session a TUI is attached to; notifications, status, panels, and title reach every phone. `getEditorText()` asks only the client whose request is running (outside any client's request, the first attached client). `getAllThemes()` lists the host's themes; `setTheme()` asks every attached local client to show one, and a TUI whose user picked a theme keeps it.
- **The `request_user_input` tool** is offered to the model only while an attached client answers its questions (`user_input` host requests): the TUI, an RPC client that accepts them, or a phone that accepts them and is granted conversation control. Its questions go to every such client, and the first answer wins. Subagents and print runs never offer it.
- **Errors** reach every attached client.
- **Session control** (`ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, `ctx.navigateTree()`, `ctx.reload()`, `ctx.waitForIdle()`), `ctx.abort()`, and `ctx.shutdown()` act for the client whose request is running (its command, prompt, or the turn it started). Calls outside any client's request, such as from `session_start`, act for the first attached client. Calls for a client that has left do nothing; `ctx.abort()` then stops the session's work.
- In a daemon worker, each client (a TUI or a phone) changes sessions alone, and other clients stay on the source, which sees `session_before_switch` or `session_before_fork` but no `session_shutdown` until its worker closes it. `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` for a client open the new session in the same worker (`setup` runs), the client reconnects to it, its extensions start then, and `withSession` runs; the call resolves once it ran, or with `seeded: false` when the new session closed before the client came back, or when `switchSession()` sent the client to a session a worker already hosts. A client's own session changes (`/clear`, `/resume`, `/fork`, ...) write the new session or name a stored one, which opens wherever the client reconnects through the daemon, with `session_start` `reason: "startup"` (a `--no-session` TUI's open in its own worker, since they are kept only in its memory).

How each client renders the data:

- **TUI**: terminal components in the active theme's colors, in both screen modes. Status items show in the footer; panels above or below the editor, and `sidebar` panels in fullscreen mode's sidebar (above the editor in regular mode); dialogs and forms in place of the editor; tool calls as cards and custom messages under their label. A panel shows at most 12 rows, its title included, and a terminal node in a panel its newest 12 lines. The TUI is a protocol client of its host on the local profile: it renders the presentations the host's presenters returned, as RPC clients receive them.
- **RPC, JSON, and SDK clients** receive the data as live-lane items and in projected entries ([rpc.md](rpc.md#extension-ui)); [rpc-extension-ui.ts](../examples/rpc-extension-ui.ts) renders it as plain lines.
- **Paired phones** render the same `UiNode` data. On the remote profile a presentation holds at most 16 KB, without image data, host paths are redacted from every frame, and a live work value holds at most 8 KB (its detail goes first). A phone invokes an extension's command, intent, or completion provider only when the extension opted it in (`remoteSafe: true` or `remote: true`) and the device's grant allows it.
- **HTML export** (`/export`) renders presentations as HTML.

### Styled Text

Text an extension shows (notifications, status items, titles of presentations and panels, and most text in nodes) is styled text: a string, or an array of spans `{ text, token?, bold?, italic?, underline?, code? }`. The type is `UiNodeStyledText` from `@hansjm10/volt-protocol`. Tokens are semantic, and each client maps them to its theme: `text`, `muted`, `accent`, `success`, `warning`, `error`, and `info`.

```typescript
ctx.ui.notify([{ text: "Deployed", token: "success", bold: true }, { text: " in 3s", token: "muted" }]);
```

Clients never receive ANSI. The host converts ANSI styling in a string to tokens: red is `error`, green `success`, yellow `warning`, blue and cyan `info`, magenta `accent`, and bright black and dim `muted`; bold, italic, and underline stay. It removes every other escape sequence and control character (tab and line feed excepted), so `"\x1b[32mok\x1b[0m"` arrives as `[{ text: "ok", token: "success" }]`.

### Notifications

```typescript
ctx.ui.notify("Done!");             // "info" by default
ctx.ui.notify("Disk almost full", "warning");
ctx.ui.notify([{ text: "Build failed", token: "error" }], "error");
```

A notification holds at most 16 KB of JSON; longer plain text is cut. It leaves no state: a client that attaches later does not see it.

### Dialogs and Forms

```typescript
// Select from options
const choice = await ctx.ui.select("Pick one:", ["A", "B", "C"]);

// Confirm dialog
const ok = await ctx.ui.confirm("Delete?", "This cannot be undone");

// Text input
const name = await ctx.ui.input("Name:", "placeholder");

// Multi-line editor
const text = await ctx.ui.editor("Edit:", "prefilled text");

// A dialog of UI data: resolves with the id of the action chosen, or undefined
const action = await ctx.ui.dialog({
  title: "Deploy to production?",
  body: [{ type: "markdown", markdown: "This deploys **main**." }],
  actions: [
    { id: "deploy", label: "Deploy", destructive: true },
    { id: "cancel", label: "Cancel" },
  ],
});

// A form: resolves with the values by field id, or undefined
const values = await ctx.ui.form({
  title: "Release",
  fields: [
    { kind: "string", id: "tag", label: "Tag", required: true, pattern: "v[0-9]+" },
    { kind: "enum", id: "channel", label: "Channel", options: [{ value: "beta" }, { value: "stable" }], value: "beta" },
    { kind: "integer", id: "retries", label: "Retries", min: 0, max: 5, value: 1 },
    { kind: "boolean", id: "notes", label: "Write notes" },
  ],
});
```

- A dialog has a one-line title, a `body` of `UiNode` data, and 1 to 8 buttons `{ id, label, token?, destructive? }`; choosing one answers with its id. Actions and forms inside the body follow the [action rules](#actions).
- A form's fields are `string` (`placeholder`, `required`, `minLength`, `maxLength`, `pattern`, `multiline`), `boolean`, `enum` (`options` of `{ value, label?, description? }`), and `integer` (`min`, `max`), each with an `id`, a `label`, an optional `description`, and an optional initial `value`. Every client validates the answer against the fields; fields left empty are absent from the values. A `pattern` must be safe to test (no backreferences, lookarounds, or nested repetition).
- Without an answer (dismissed, timed out, or asked while no client can answer), `select()`, `input()`, `editor()`, `dialog()`, and `form()` resolve `undefined`, and `confirm()` resolves `false`.

See [questionnaire.ts](../examples/extensions/questionnaire.ts) for a form a tool asks, and [summarize.ts](../examples/extensions/summarize.ts) for a dialog.

#### Timed Dialogs with Countdown

Dialogs other than `editor()` take a `timeout` option that dismisses them with a live countdown:

```typescript
// Dialog shows "Title (5s)" → "Title (4s)" → ... → auto-dismisses at 0
const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { timeout: 5000 }
);

if (confirmed) {
  // User confirmed
} else {
  // User cancelled or timed out
}
```

#### Host Dismissal

Volt dismisses pending dialogs when it tears down extension UI: when the extensions reload (including `/reload`), when the extension is disabled, and when the conversation closes, also because a write could not be confirmed as saved. A dialog asked while no attached client can answer it is dismissed at once. Dismissed dialogs return the same values as a cancel.

#### Manual Dismissal with AbortSignal

For more control (e.g., to distinguish timeout from user cancel), use `AbortSignal`:

```typescript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 5000);

const confirmed = await ctx.ui.confirm(
  "Timed Confirmation",
  "This dialog will auto-cancel in 5 seconds. Confirm?",
  { signal: controller.signal }
);

clearTimeout(timeoutId);

if (confirmed) {
  // User confirmed
} else if (controller.signal.aborted) {
  // Dialog timed out
} else {
  // User cancelled (pressed Escape or selected "No")
}
```

See [examples/extensions/timed-confirm.ts](../examples/extensions/timed-confirm.ts) for complete examples.

### Status Items

```typescript
ctx.ui.setStatus("my-ext", "Processing...");
ctx.ui.setStatus("my-ext", [{ text: "3 ", token: "accent" }, { text: "jobs" }]);
ctx.ui.setStatus("my-ext", undefined);  // Clear
```

A status item persists until the extension clears it, stops, or reloads. Its key is 1 to 128 characters, its text at most 1 KB of JSON, and an extension sets at most 32. The TUI shows status items in the footer. See [status-line.ts](../examples/extensions/status-line.ts).

### Panels

A panel is one named `UiNode` the extension shows beside the conversation:

```typescript
ctx.ui.setPanel("build", {
  title: "Build",
  placement: "belowEditor",  // "aboveEditor" (default) | "belowEditor" | "sidebar"
  node: { type: "terminal", key: "log", lines: ["compiling...", "done"] },
});
ctx.ui.setPanel("build", undefined);  // Remove
```

An interactive panel binds actions to the extension's intents:

```typescript
const rerun = volt.registerIntent("rerun", {
  label: "Rerun CI",
  handler: async (_input, ctx) => {
    ctx.ui.notify("Rerunning CI");
  },
});

ctx.ui.setPanel("ci", {
  node: {
    type: "card",
    key: "ci",
    title: "CI for main",
    badges: [{ label: "passing", token: "success" }],
    sections: [{
      key: "jobs",
      children: [{
        type: "table",
        key: "jobs",
        columns: [{ header: "Job" }, { header: "Status" }],
        rows: [{ key: "build", cells: ["build", [{ text: "ok", token: "success" }]] }],
      }],
    }],
    actions: [{ id: "rerun", label: "Rerun", intent: { type: rerun } }],
  },
});
```

- **Placement** is a hint: clients without a sidebar show `sidebar` panels above the editor.
- **Limits**: a panel name is 1 to 128 characters, its node at most 32 KB of JSON, and an extension shows at most 16 panels. Data that is invalid or too large throws.
- **Updates**: calling `setPanel` again with a changed node sends clients a patch of the node they hold, so give children stable `key`s. A panel whose node the [action rules](#actions) leave empty is removed.

See [widget-placement.ts](../examples/extensions/widget-placement.ts) for each placement, and [todo.ts](../examples/extensions/todo.ts) for a panel a command toggles.

### Actions

Actions `{ id, label, token?, disabled?, destructive?, intent: { type, input? } }` in panels, dialog bodies, presentations, and work detail send their intent when pressed. A `form` node sends its `submit` intent with the field values merged over its `input`, keyed by field id. The host checks the input like any other intent's. An extension's UI may send only:

- its own commands, `extension.command.<id>.<command>`;
- its own intents, `extension.intent.<id>.<name>`, which [`volt.registerIntent()`](#voltregisterintentname-options) returns;
- `open_work` and `cancel_work` with an `input.workId` of work its own kinds run.

The host leaves out every other action, and a form whose `submit` it may not send, before any client sees them; in panels and dialogs it also reports an extension error.

### Title, Editor Text, and Themes

```typescript
// Window title: one line, at most 256 characters
ctx.ui.setTitle("volt - my-project");

// Replace the editor text of every interactive client
ctx.ui.setEditorText("Prefill text");

// Paste at the cursor (large content collapses as a paste does)
ctx.ui.pasteToEditor("pasted content");

// The editor text of the client the call runs for; undefined when it has no editor or does not answer within 2 s
const current = await ctx.ui.getEditorText();

// The host's themes: built-in, the user's, and the ones the conversation loaded (see themes.md)
const themes = ctx.ui.getAllThemes();  // [{ name: "dark", path: "/..." | undefined }, ...]
const result = ctx.ui.setTheme("light");  // asks the attached terminals to show it; not saved as the user's theme
if (!result.success) {
  ctx.ui.notify(`Failed: ${result.error}`, "error");
}
```

`getEditorText()` sends an `editor_text` host request to the client whose request is running (outside any client's request, the conversation's first client), which answers without asking the user. `setTheme()` fails for a theme the host does not know; a TUI whose user picked a theme in it keeps that theme, and phones never receive it. See [qna.ts](../examples/extensions/qna.ts) and [mac-system-theme.ts](../examples/extensions/mac-system-theme.ts).

### Intents, Shortcuts, and Completions

Interaction an extension offers beyond its commands is data too:

- **Intents** ([`volt.registerIntent()`](#voltregisterintentname-options)) are operations with a checked input schema that every client invokes by name: from panel and presentation actions, forms, shortcuts, or protocol frames. They are local-only unless registered `remote: true`.
- **Shortcuts** ([`volt.registerShortcut()`](#voltregistershortcutshortcut-options)) map a key to one of the extension's intents or commands. The TUI adds the key to its keybinding table under the intent's name, so users rebind it in `keybindings.json`.
- **Completion providers** ([`volt.registerCompletionProvider()`](#voltregistercompletionprovidername-provider)) return editor completions for tokens that start with their trigger; every client asks with the `editor_completions` query. They are local-only unless registered `remote: true`.

See [preset.ts](../examples/extensions/preset.ts) for an intent with a shortcut and [github-issue-autocomplete.ts](../examples/extensions/github-issue-autocomplete.ts) for a completion provider.

### Message Presentation

`volt.registerMessagePresenter(customType, present)` decides how the custom messages of a type, sent with [`volt.sendMessage()`](#voltsendmessagemessage-options), look on every client:

```typescript
volt.registerMessagePresenter<{ level: string }>("status-update", (message) => {
  const token = message.details?.level === "error" ? "error" : "success";
  const text = typeof message.content === "string" ? message.content : "";
  return {
    title: [{ text: "[status]", token, bold: true }],
    summary: [{ type: "text", key: "text", text }],
    body: [
      { type: "text", key: "text", text },
      { type: "code", key: "details", language: "json", code: JSON.stringify(message.details ?? {}, null, 2) },
    ],
  };
});

volt.sendMessage({ customType: "status-update", content: "Deployed", display: true, details: { level: "info" } });
```

The presenter receives `{ customType, content, details? }` and returns `{ title?, summary?, body }`: clients show `summary` while the message is collapsed and `body` while it is expanded. The rules of [tool presentation](#tool-presentation) apply: the presenter is pure, synchronous, and stateless, and what it returns is normalized and bounded on the host. A message of a type without a presenter, or one its presenter throws for, shows its text. The host's own message types (`work_notice`, `review`, `subagent_recovery`, `volt-plan-checkpoint`, and `volt-plan-execution`) are not an extension's: `registerMessagePresenter()` throws for them, and `volt.sendMessage()` refuses them. See [message-presenter.ts](../examples/extensions/message-presenter.ts).

### Work Detail

A work kind may declare `detail`, a presenter of the UI data every client shows with each running item of the kind (in the TUI, in `/work` and under the tool call that started it):

```typescript
volt.registerWorkKind("scan", {
  delivery: "message",
  detail: (work) => ({
    type: "card",
    key: "scan",
    title: work.title,
    sections: [{
      key: "output",
      children: [{ type: "terminal", key: "log", lines: work.output.text.split("\n").slice(-5) }],
    }],
    actions: [{ id: "stop", label: "Stop", destructive: true, intent: { type: "cancel_work", input: { workId: work.workId } } }],
  }),
});
```

`detail` receives `{ workId, title, input, state, progress?, output: { text, truncated, bytes } }`, where `state` is `running` or `cancelling` and `output.text` is the newest output, and returns one `UiNode`, or `undefined` for none. The host presents it again when the item's progress or output changes (at most every 100 ms) and sends clients a patch of the node they hold. Like a tool presenter it is pure, synchronous, and stateless, and [its actions](#actions) may send only what the extension's UI may; an item it throws for shows its progress only. A detail holds at most 7 KB of JSON. Every client sees it, so a kind that `requires` remote capabilities is presented without its input (`null`) and output text (empty).

## Error Handling

- Extension errors are logged, agent continues
- Invalid optional `before_agent_start` messages are diagnosed and skipped
- Invalid `message_end`, compaction, and tree-summary replacements fail before their delivery or session mutation commits
- `tool_call` errors block the tool (fail-safe)
- Tool `execute` errors can be thrown or returned as structured results with `isError: true`; both are reported to the LLM as failures and execution continues

## Mode Behavior

| Mode | `ctx.mode` | `ctx.hasUI` | Notes |
|------|------------|-------------|-------|
| Interactive | `"rpc"` | `true` | The session runs in a [daemon worker](daemon.md#conversation-workers); the TUI is a local protocol client of it and renders extension UI with terminal components. Phones on the same session are clients too |
| RPC (`--mode rpc`) | `"rpc"` | `true` | Dialogs as host requests; notifications, status items, panels, and title on the protocol's live lane. See [rpc.md](rpc.md#extensions-in-rpc-mode) |
| JSON (`--mode json`) | `"json"` | `false` | Protocol frames to stdout, extension status and notices included; dialogs resolve to their defaults |
| Print (`-p`) | `"print"` | `false` | Extensions run but can't prompt |

Use `ctx.hasUI` before dialog methods: without UI they resolve to their defaults. Every other UI call is data and needs no mode check.

## Examples Reference

All examples in [examples/extensions/](../examples/extensions/).

| Example | Description | Key APIs |
|---------|-------------|----------|
| **Tools** |||
| `hello.ts` | Minimal tool registration | `registerTool` |
| `questionnaire.ts` | Tool that asks one or more questions in a form | `registerTool`, `ui.form`, `present` |
| `todo.ts` | Stateful tool with persistence and a `/todos` panel | `registerTool`, `present`, `setPanel`, session events |
| `dynamic-tools.ts` | Register tools after startup and during commands | `registerTool`, `session_start`, `registerCommand` |
| `structured-output.ts` | Final structured-output tool with `disposition: "stop"` | `registerTool`, tool dispositions |
| `truncated-tool.ts` | Output truncation example | `registerTool`, `truncateHead` |
| `tool-override.ts` | Override built-in read tool | `registerTool` (same name as built-in) |
| `tool-presentation.ts` | Compact presentation for the built-in read, bash, edit, and write tools | `registerTool`, `present` |
| **Commands** |||
| `commands.ts` | List the session's slash commands | `registerCommand`, `getArgumentCompletions`, `getCommands` |
| `summarize.ts` | Conversation summary command | `registerCommand`, `ui.dialog` |
| `handoff.ts` | Cross-provider model handoff | `registerCommand`, `ui.editor` |
| `qna.ts` | Extract questions into the editor | `registerCommand`, `setEditorText` |
| `send-user-message.ts` | Inject user messages | `registerCommand`, `sendUserMessage` |
| `reload-runtime.ts` | Reload command and LLM tool handoff | `registerCommand`, `ctx.reload()`, `sendUserMessage` |
| `shutdown-command.ts` | Graceful shutdown command | `registerCommand`, `shutdown()` |
| **Events & Gates** |||
| `permission-gate.ts` | Block dangerous commands | `on("tool_call")`, `ui.confirm` |
| `project-trust.ts` | Decide or defer project trust from a user/global or CLI extension | `on("project_trust")`, trust UI, required trust result |
| `protected-paths.ts` | Block writes to specific paths | `on("tool_call")` |
| `confirm-destructive.ts` | Confirm session changes | `on("session_before_switch")`, `on("session_before_fork")` |
| `dirty-repo-guard.ts` | Warn on dirty git repo | `on("session_before_*")`, `exec` |
| `input-transform.ts` | Transform user input | `on("input")` |
| `input-transform-streaming.ts` | Streaming-aware input transform | `on("input")`, `streamingBehavior` |
| `model-status.ts` | React to model changes | `on("model_select")`, `setStatus` |
| `provider-payload.ts` | Inspect payloads and provider response headers | `on("before_provider_request")`, `on("after_provider_response")` |
| `system-prompt-header.ts` | Display system prompt info | `on("agent_start")`, `getSystemPrompt` |
| `claude-rules.ts` | Load rules from files | `on("session_start")`, `on("before_agent_start")` |
| `prompt-customizer.ts` | Add context-aware tool guidance using `systemPromptOptions` | `on("before_agent_start")`, `BuildSystemPromptOptions` |
| `file-trigger.ts` | File watcher triggers messages | `sendMessage` |
| **Compaction & Sessions** |||
| `custom-compaction.ts` | Custom compaction summary | `on("session_before_compact")` |
| `trigger-compact.ts` | Trigger compaction manually | `compact()` |
| `git-checkpoint.ts` | Git stash on turns | `on("turn_start")`, `on("session_before_fork")`, `exec` |
| `auto-commit-on-exit.ts` | Commit on shutdown | `on("session_shutdown")`, `exec` |
| **UI as Data** |||
| `status-line.ts` | Turn progress as a status item styled with tokens | `setStatus`, session events |
| `widget-placement.ts` | Panels above and below the editor and in the sidebar | `setPanel` |
| `github-issue-autocomplete.ts` | `#1234` issue completions from recent open issues (`gh issue list`) | `registerCompletionProvider`, `on("session_start")`, `exec` |
| `rpc-demo.ts` | Every dialog, form, panel, status, and editor-text call, for an RPC client | `ui.select`, `ui.form`, `ui.dialog`, `setPanel`, `getEditorText` |
| `notify.ts` | Desktop notification when the agent finishes | `on("agent_end")` |
| `titlebar-spinner.ts` | Spinner in the terminal title while the agent works | `setTitle` |
| `timed-confirm.ts` | Dialogs with timeout | `ui.confirm` with timeout/signal |
| `mac-system-theme.ts` | Auto-switch theme | `setTheme` |
| **Settings & Complex Extensions** |||
| `settings.ts` | Typed settings declared in the manifest | `defineManifest` settings, `settings_changed`, `updateSettings` |
| `preset.ts` | Saveable presets (model, tools, thinking) | `registerCommand`, `registerIntent`, `registerShortcut`, `registerFlag`, `ui.form`, `setModel`, `setActiveTools`, `setThinkingLevel`, `appendEntry` |
| `tools.ts` | Enable and disable tools from a form | `registerCommand`, `ui.form`, `setActiveTools`, session events |
| **Remote & Sandbox** |||
| `ssh.ts` | SSH remote execution | `registerFlag`, `on("user_bash")`, `on("before_agent_start")`, tool operations |
| `sandbox/` | Sandboxed tool execution | Tool operations |
| `gondolin/` | Route built-in tools and `!` commands into a Gondolin micro-VM | Tool operations, built-in tool overrides, `on("user_bash")` |
| **Providers** |||
| `custom-provider-anthropic/` | Custom Anthropic proxy | `registerProvider` |
| `custom-provider-gitlab-duo/` | GitLab Duo integration | `registerProvider` with OAuth |
| **Messages & Communication** |||
| `message-presenter.ts` | Custom message presentation | `registerMessagePresenter`, `sendMessage` |
| `event-bus.ts` | Inter-extension events | `volt.events` |
| **Session Metadata** |||
| `session-name.ts` | Name sessions for selector | `setSessionName`, `getSessionName` |
| `bookmark.ts` | Bookmark entries for /tree | `setLabel` |
| **Misc** |||
| `inline-bash.ts` | Expand `!{command}` in prompts | `on("input")` |
| `bash-spawn-hook.ts` | Adjust bash command, cwd, and env before execution | `createBashTool`, `spawnHook` |
| `context-preparation.ts` | Opt-in skill and source excerpts through managed services | `on("request_boundary")`, `ctx.services` |
| `dynamic-resources/` | Skills, prompts, and themes from `resources_discover` | `on("resources_discover")` |
| `with-deps/` | Extension with npm dependencies | Package structure with `package.json` |

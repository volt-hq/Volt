# @hansjm10/volt-protocol

The schemas Volt hosts and clients share:

- **Conversation log entries.** The entry envelope (`ordinal`, `id`, `parentId`, `type`, `timestamp`, `visibility`, `payload`) and the core entry types a conversation folds: messages, model, thinking, fast mode, and plan changes, compaction and branch summaries, labels, session info, the active-branch leaf, client input receipts and state, subagent spawn edges, fork lineage, and work items (started, checkpointed, finished).
- **Wire frames.** Protocol 1 (`ClientFrame`, `HostFrame`): subscriptions by log ordinal, projected entries, the live lane, intents, queries, and host requests, with the pure client fold (`clientFold`, `clientSnapshot`, `clientRestore`) a client keeps its conversation state with.
- **Daemon control and the Iroh handshake.** Every voltd control-socket message (hellos, requests, responses, events, and the relay preamble), the phone's Iroh hello and the host's handshake response, and the remote access grants, push notification intents, and workspace catalog they carry.
- **`UiNode`.** Declarative UI as data: text, markdown, lists, tables, key-value lists, progress, forms, actions, cards, diffs, terminal output, code, images, and trees. Styling uses semantic tokens only; text never carries terminal escape sequences. Keyed patches (`diffUiTree`, `applyUiPatch`) update a tree a client holds, and tool and message presentations describe tool calls and custom messages as `UiNode` data.
- **Extensions.** The extension manifest (id, display name, entry, settings, and permissions), the settings subset every client renders as a form, and the extension summaries clients list and toggle.
- **The contract artifact.** `contract/protocol-schema.json` is a JSON Schema (draft 2020-12) document with every named definition under `$defs` and the numeric limits clients mirror under `x-volt-limits`. Clients in other languages generate or validate against it.

Every schema is a [TypeBox](https://github.com/sinclairzx81/typebox) schema, so the same definition yields the TypeScript type, runtime validation, and the artifact.

Maintained and distributed as part of Volt by [Jordan Hans](https://github.com/hansjm10).
Volt is derived from [Mario Zechner's Pi project](https://github.com/badlogic/pi-mono)
under the MIT License.

## Installation

```sh
npm install @hansjm10/volt-protocol
```

## Usage

```ts
import { CORE_LOG_ENTRY_TYPES, ClientFrameSchema, UiNodeSchema } from "@hansjm10/volt-protocol";
import { Check } from "typebox/value";

Check(ClientFrameSchema, { type: "prompt", intentId: "c-1", input: { message: "hello" } }); // true
Check(CORE_LOG_ENTRY_TYPES.model_change.schema, {
	ordinal: 3,
	id: "e3",
	parentId: "e2",
	type: "model_change",
	timestamp: "2026-10-03T12:00:00.000Z",
	visibility: "public",
	payload: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
}); // true
Check(UiNodeSchema, { type: "text", text: [{ text: "done", token: "success", bold: true }] }); // true
```

The contract artifact resolves as `@hansjm10/volt-protocol/contract/protocol-schema.json`.

Light subpaths load only what they name: `@hansjm10/volt-protocol/entries` (log entries), `/git-context`, `/wire-limits`, `/daemon-control` (the voltd control socket), `/remote-handshake` (the Iroh hello and handshake response), `/remote-access` (capabilities and grants), `/push` (notification intents), `/workspace` (workspace names and catalog), and `/work` (work kinds, states, outcomes, and entry bounds).

## Compatibility

Protocol 1 only grows. Hosts and clients update independently (a host through npm, the iOS app through the App Store), so a client often talks to a newer host than the contract it was built with, and sometimes to an older one.

### Receiving host frames

A client checks host frames against the contract's types, required fields, bounds, and byte budgets, and tolerates what a newer host adds:

- It ignores object fields it does not know. `additionalProperties: false` describes what this contract's host sends, not what a later host may send.
- A closed enum (`enum` in the artifact) does not change within protocol 1. An open enum (`x-volt-known-values` in the artifact, a string in TypeScript) may gain values.
- It falls back on a value it does not know:

| Position | Fallback |
| --- | --- |
| Host frame `type` | Ignore the frame. |
| Projected entry `type` | Skip the entry; its ordinal still advances the client's position, as `head` does. |
| Live item `type`, or live value `kind` | Drop the item. |
| `UiNode` `type` | Render a placeholder. |
| Rejection or query error `code` | Treat it as `failed`. |
| Fatal `code` | The connection still ends; report a generic failure. |
| `changed` catalog | Ignore the frame. |
| Intent name, `category`, or `source` | Hide the intent. |

### Sending client frames

A host checks client frames strictly. An intent or query it does not have, or input that fails its schema, is answered per call (`unknown_intent`, `unknown_query`, `invalid_input`), so a client can detect an older host and fall back. A fixed frame (`hello`, `subscribe`, `unsubscribe`, `host_response`) that fails its schema ends the connection with `invalid_frame`, except that a host ignores host request kinds it does not know in `hello.accepts.hostRequests`.

### Changes within protocol 1

A host may add fields to what it sends, values to open enums, and new host frame types, projected entry types, live item types, live value kinds, `UiNode` types, intents, queries, and catalogs. A new host request kind reaches only clients that name it in `hello`. A client frame may gain optional fields only.

Everything else needs a new protocol version: removing or renaming a field, changing a field's type or meaning, adding a value to a closed enum, making a client frame field required, or tightening what a host accepts from clients.

## License

MIT

# @hansjm10/volt-protocol

The schemas Volt hosts and clients share:

- **Conversation log entries.** The entry envelope (`ordinal`, `id`, `parentId`, `type`, `timestamp`, `visibility`, `payload`) and the core entry types a conversation folds: messages, model, thinking, fast mode, and plan changes, compaction and branch summaries, labels, session info, the active-branch leaf, client input receipts and state, subagent spawn edges, and fork lineage.
- **Wire frames.** RPC commands, responses, events, conversation projections, and the payloads they carry.
- **`UiNode`.** Declarative UI as data: text, markdown, lists, tables, key-value lists, progress, forms, actions, cards, diffs, terminal output, code, images, and trees. Styling uses semantic tokens only; text never carries terminal escape sequences.
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
import { CORE_LOG_ENTRY_TYPES, RPC_COMMAND_SCHEMAS, UiNodeSchema } from "@hansjm10/volt-protocol";
import { Check } from "typebox/value";

Check(RPC_COMMAND_SCHEMAS.prompt, { type: "prompt", clientMessageId: "c-1", message: "hello" }); // true
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

Light subpaths load only what they name: `@hansjm10/volt-protocol/entries` (log entries), `@hansjm10/volt-protocol/git-context`, and `@hansjm10/volt-protocol/wire-limits`.

## License

MIT

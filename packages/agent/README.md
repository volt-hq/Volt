# @hansjm10/volt-agent-core

A product-agnostic conversation kernel over an append-only conversation log, and the stateless agent loop it runs. Built on `@hansjm10/volt-ai` and `@hansjm10/volt-protocol`.

Maintained and distributed as part of Volt by [Jordan Hans](https://github.com/hansjm10).
Volt is derived from [Mario Zechner's Pi project](https://github.com/badlogic/pi-mono) under the MIT License.

## Installation

```bash
npm install @hansjm10/volt-agent-core
```

## Overview

- `Conversation` is the kernel. It is bound to one `ConversationLog` for its whole life and owns the agent loop, the delivery queue, the single busy state, and the fold over the log. Hosts add product behavior through a `ConversationPolicy` and an injected summarizer.
- `ConversationLog` is the storage contract: one ordered, append-only log per conversation. The ordinal of an entry is the only position and fence. `InMemoryConversationLog` is the reference implementation.
- `fold` turns log entries into `ConversationState`; `buildContext` turns a state into provider messages. There is one fold and one context builder.
- `agentLoop` and `runAgentLoop` are the stateless loop the kernel runs. Use them directly only when the host owns persistence, queueing, and lifecycle itself.

The design is described in the [architecture rewrite RFC](https://github.com/volt-hq/Volt/blob/main/packages/coding-agent/docs/architecture-rewrite-design.md). Hook contracts are in [Policy](docs/policy.md) and events in [Events](docs/events.md).

## Quick start

```typescript
import { Conversation, InMemoryConversationLog } from "@hansjm10/volt-agent-core";
import { builtInModels, builtInProviders, createAiClient } from "@hansjm10/volt-ai";

const client = createAiClient({
  providers: builtInProviders(),
  models: builtInModels(),
  credentials: { resolve: async () => ({ apiKey: process.env.ANTHROPIC_API_KEY }) },
});

const conversation = await Conversation.open({
  log: new InMemoryConversationLog("conversation-1"),
  stream: client.streamSimple,
  resolveModel: client.getModel,
  promptCacheRefresh: client,
  systemPrompt: "You are a helpful assistant.",
  tools: [readFileTool],
});

const model = client.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Unknown model");
await conversation.setModel(model);

conversation.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

const admission = await conversation.prompt({ message: "Hello!" });
const outcome = await admission.completion; // { state: "completed", entryId, ordinal }

await conversation.close();
```

`Conversation.open` reads and folds the whole log before it returns. The model is part of the log: `setModel` commits a `model_change` entry, and `conversation.model` resolves the model the active branch names through `resolveModel`. A turn needs a resolvable model.

`systemPrompt` is a string, or a function of the operation's `AbortSignal` resolved before every request.

## The log

```typescript
interface ConversationLog {
  readonly conversationId: string;
  head(): number;
  append(batch: ConversationLogAppend): Promise<ConversationLogAppendResult>;
  read(afterOrdinal: number, limit: number): Promise<ConversationLogPage>;
  readonly lost: Promise<ConversationLogLostError>;
  close(): Promise<void>;
}
```

- Entries use the envelope from `@hansjm10/volt-protocol/entries`: ordinal, id, parent id, type, timestamp, visibility (`public` or `host`), and payload. The log assigns ordinals, contiguous from 1.
- `append({ expectedOrdinal, commitId, entries })` commits one batch atomically. `expectedOrdinal` must equal the head; a mismatch loses the log with reason `fence_conflict`. `commitId` makes a retried commit idempotent.
- `committed` means durable. `rolled_back` means the batch definitely did not commit and the log is still writable. A rejection with `ConversationLogLostError` means the outcome is unknown and the log accepts no more work; `lost` resolves with the reason (`fence_conflict`, `uncertain_commit`, `storage`, or `closed`).
- Commit, then publish: the kernel folds and publishes a batch only after `append` resolves `committed`.

`InMemoryConversationLog` implements the contract in memory, including the fence, `commitId` idempotency, and reads of at most `CONVERSATION_LOG_READ_LIMIT_MAX` entries. A durable host supplies its own implementation.

Hosts register product entry types with `entryTypes` (definitions from `defineLogEntryType` in `@hansjm10/volt-protocol/entries`). The fold indexes product entries in the tree and carries them through without reading their payloads.

## State

`conversation.state` is the fold of every committed entry:

- `ordinal`, `tree`, `leafId`, and `branch` (entry ids from the root to the leaf);
- `context`: the branch messages with the latest compaction and branch summaries applied, plus `model`, `thinkingLevel`, and `fastMode`;
- `planning`, `labels`, `name`;
- `clientInputs`: every durable input with its state, and the queued and started sets used for recovery;
- `branchOrdinal`, `branchSwitchOrdinal`, and `contextOrdinal` for staleness checks.

The same functions are available without a kernel:

```typescript
import { buildContext, clientInputRecovery, convertToLlm, fold } from "@hansjm10/volt-agent-core";

const state = fold(entries);
const messages = await buildContext(state, { convertToLlm });
const recovery = clientInputRecovery(state); // idle | replay | blocked
```

`fold(entries, initial)` folds onto an earlier state, and `apply(state, entry)` folds one entry. States are frozen values. `snapshot(state)` and `restore(snapshot)` serialize a state. The fold throws `ConversationFoldError` for a log that breaks its structural invariants.

## Input

Every prompt, steer, and follow-up is a durable client input: the input (and, for queued input, its queue intent) commits to the log before the call resolves.

```typescript
const admission = await conversation.prompt({ clientMessageId, message, images });
admission.completion; // completed | failed | withdrawn
```

- `prompt(input)` starts a turn when no operation runs. While one runs, a prompt needs `streamingBehavior: "steer" | "followUp"` and is queued with it; without one it is rejected with `ConversationError("busy")`.
- `steer(input)` and `followUp(input)` queue input and start a turn when nothing will deliver it.
- Resubmitting a `clientMessageId` with the same input writes nothing; its `completion` settles with the input's recorded or pending outcome. The same id with different input is rejected with `client_input_conflict`.
- `input.prepared` is delivered instead of `message` (templates, input hooks). `input.attachments` are delivered right after the user message, in the same batch.
- `reserve()` claims the idle conversation for one turn while the host prepares input. Pass it as `prompt(input, { reservation })`, or call `reservation.cancel()`.
- `admitInput(command, input, { deliver: false })` records input the host runs itself. Call `markInputStarted(id)` before running it, then `settleClientInput(id, outcome)`. A started input without an outcome is never run again.
- `queueMessages(kind, messages)` queues host messages as one durable input with a host origin.
- `clearQueue()` withdraws every queued steer and follow-up and returns them.
- `continue()` runs a turn over pending input, a paused continuation, or a context that ends with input.

Queued input a previous runtime left behind is queued again on open; `continue()` delivers it. A started input without an outcome blocks that replay (`clientInputRecovery(state).kind === "blocked"`) until the host settles it.

Steering and follow-up queues drain `"one-at-a-time"` by default; change them with `setQueueModes({ steer, followUp })`.

## Settings and host entries

Durable settings are log entries:

- `setModel(model)`, `setThinkingLevel(level)`, `setFastMode(enabled)`, `setPlanning(snapshot)`, `setName(name)`, `setLabel(targetId, label?)`;
- `append(entries)` commits host entries in one batch: registered product types, or core `custom`, `custom_message`, `message`, and `subagent_spawn`;
- `runHostOperation(operation)` runs exclusive host work that may append entries;
- `beginActivity(kind)` counts non-exclusive host work (`bash`, `extension_command`, `background`) toward `busy` until the returned release runs.

Runtime configuration is not logged: `setTools(tools)`, `setStreamOptions(options)`, and `setQueueModes(modes)` apply to later requests.

`compact({ instructions })` and `navigate(targetId, options)` are the structural intents; see [Policy](docs/policy.md#compaction-and-navigation).

## Messages

`AgentMessage` is a provider `Message` (`user`, `assistant`, `toolResult`) or an application message added through declaration merging:

```typescript
declare module "@hansjm10/volt-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}
```

The package registers four application roles: `bashExecution`, `custom`, `branchSummary`, and `compactionSummary`, with the constructors `createCustomMessage`, `createBranchSummaryMessage`, and `createCompactionSummaryMessage`. `convertToLlm` converts them to user messages and drops roles it does not know.

The kernel converts messages with `convertToLlm` unless `ConversationOptions.convertToLlm` is supplied. A replacement must drop each user message's `clientMessageId`.

## Tools

```typescript
import { readFile } from "node:fs/promises";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { Type } from "typebox";

const readFileTool = {
  name: "read_file",
  label: "Read file",
  description: "Read a UTF-8 file",
  parameters: Type.Object({ path: Type.String() }),
  executionMode: "sequential",
  async execute(_toolCallId, params, signal, onUpdate) {
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });
    const text = await readFile(params.path, { encoding: "utf8", signal });
    return { content: [{ type: "text", text }], details: { path: params.path } };
  },
} satisfies AgentTool;
```

`setTools(tools)` replaces the tool list; names must be unique. Thrown tool errors become failed tool results. Return `isError: true` to keep structured failure details. A result may request `disposition: "stop"` or one tool-free `disposition: "final_response"`.

## Lifecycle

- `abort(source?)` aborts the active operation and revokes a held reservation. It returns an `AgentAbortAcceptance`; the first accepted source is kept and recorded as a `runtime_abort` diagnostic on the aborted assistant message. Queued input stays queued.
- `close()` aborts work, waits for it to settle, and closes the log. It is idempotent.
- `ended` resolves once, when the conversation is closed or its log is lost. After that every intent throws `ConversationError("ended")` and pending input completions reject with it.

`ConversationError.code` is one of `busy`, `ended`, `invalid_state`, `invalid_argument`, `client_input_conflict`, or `commit_rolled_back`.

## Admission gate

`AdmissionGate` is a host-owned admission fence that a conversation (`ConversationOptions.admissionGate`) and the host's detached work can share. `suspend()` closes it until the returned release runs and revokes reservations made before it; started work is never interrupted. `assertOpen()` throws `ConversationError("busy")` while it is suspended.

## Prompt-cache refresh

With `promptCacheRefresh` (an `AiClient` implements it), `refreshPromptCache(signal?)` replays the latest turn request without generating output, so the provider renews its cached prefix. It reports `unavailable` when the branch or configuration changed since that request. `canRefreshPromptCache()` checks without sending.

## Low-level loop

```typescript
import { agentLoop, convertToLlm } from "@hansjm10/volt-agent-core";

const stream = agentLoop(
  [{ role: "user", content: "Hello!", timestamp: Date.now() }],
  { systemPrompt: "You are helpful.", messages: [], tools: [readFileTool] },
  { model, convertToLlm },
  undefined,
  client.streamSimple,
);
for await (const event of stream) console.log(event.type);
const newMessages = await stream.result();
```

`agentLoop(prompts, context, config, signal, streamFn)` and `agentLoopContinue(context, config, signal, streamFn)` return an event stream; `runAgentLoop` and `runAgentLoopContinue` take an event sink instead. The loop keeps nothing: it does not persist messages, queue input, retry, or compact. `config.nextAction` decides at each dispatch boundary, and `beginDelivery` settles each attached delivery before it enters the context.

## Other exports

- `streamProxy(model, context, { proxyUrl, authToken })` streams through a server that holds the provider credentials.
- `uuidv7()` returns a time-ordered UUIDv7; `createSessionId()` returns one for a new conversation.
- `OperationCoordinator` is the coordinator the kernel uses for its operations and busy state.

## License

MIT

# Conversation policy

A host adds product behavior to a `Conversation` through `ConversationOptions.policy` (a `ConversationPolicy`), the injected `summarizer` (a `ConversationSummarizer`), and the `prepare` callback of `navigate`. The kernel owns when each runs, what it commits, and the log. This document lists the hooks in the order a turn reaches them.

Every hook is optional. Treat arguments as read-only and return changes instead of mutating them. A hook that throws during a turn fails the turn: the kernel commits an error assistant message (an aborted one when the turn was aborted) and ends the turn's loop. Deliveries the turn had prepared but not committed stay queued. The tool hooks are the exception: a throwing `beforeToolCall` or `afterToolCall` produces an error tool result and the turn goes on.

## Order within a turn

1. `nextAction` decides at the dispatch boundary. At the turn's first decision, `compaction` may run first when the context ends with an assistant message.
2. Each delivery: `messageEnd` (origin `"delivery"`) on each message, then `prepareDelivery`, then one commit.
3. Each request: `transformContext`, conversion, `requestBoundary`, `beforeProviderPayload`, the provider, `afterProviderResponse`.
4. The response: `messageEnd` (origin `"loop"`), then its commit.
5. Each tool call: `beforeToolCall`, execution, `afterToolCall`, then `messageEnd` (origin `"loop"`) and the commit of its result.
6. After a completed request the turn returns to step 1. Before `nextAction`, `compaction` runs when the turn would continue.
7. After the turn's final message: `retry` when it failed, otherwise `compaction` (also for a failure that overflowed the context).

## nextAction

```ts
nextAction?: (
  context: AgentLoopNextActionContext,
  signal: AbortSignal,
) => AgentLoopNextAction | undefined | Promise<AgentLoopNextAction | undefined>;
```

Runs before the first request of a turn and after every completed request. `context.defaultAction` is the kernel's suggestion:

- `request` with reason `delivery` when it selected queued input, or `continuation` when the turn continues (tool results, a pending provider request);
- `stop` when there is nothing to request;
- `pause` when threshold compaction is due between requests (see [compaction](#compaction)).

At each decision the kernel selects every pending prompt, then steering input by the steer queue mode. Follow-ups are selected, by their queue mode, only when nothing else is, and only when the turn would otherwise stop (or at the first decision of a turn whose context ends with an assistant message).

Return `undefined` to keep the suggestion. Any returned action is an explicit override:

- `request` may attach `deliveries`. Each runs through `messageEnd` and `prepareDelivery` with kind `"policy"` and commits like queued input.
- `pause` ends the loop and keeps the continuation: `continue()` resumes it with the same request authority (or `action.requestAuthority`).
- `stop` ends the turn; `next_action_resolved` reports `stopReason: "policy"`.

Under `final_response` request authority only `pause` is honored; any other result becomes the final-response request. A synchronous result is copied before the kernel yields, so later changes to it have no effect.

## messageEnd

```ts
messageEnd?: (
  message: AgentMessage,
  signal: AbortSignal,
  origin: "delivery" | "loop",
) => AgentMessage | undefined | Promise<AgentMessage | undefined>;
```

Runs on every message before it commits:

- `"delivery"`: each message of a delivery, before `prepareDelivery`;
- `"loop"`: each message the loop finalizes: assistant responses, tool results, and the error or abort messages the kernel records.

Return a replacement or `undefined`. A replacement must keep the role; otherwise the turn fails with `ConversationError("invalid_argument")`. A client input's user message keeps its `clientMessageId` through replacement. The `message_end` event carries the committed message.

## prepareDelivery

```ts
prepareDelivery?: (
  delivery: ConversationDelivery,
  signal: AbortSignal,
) => ConversationPreparedDelivery | undefined | Promise<ConversationPreparedDelivery | undefined>;
```

Runs for each delivery, after `messageEnd`, with `{ kind, clientMessageId?, origin?, messages }`. `kind` is `prompt`, `steer`, `followUp`, or `policy`; `origin` is `client` or `host` for a durable input. Return `undefined` to commit the messages as they are, or `{ messages, entries? }`:

- `messages` must not be empty and must keep the client input's user message.
- `entries` are committed in the delivery's batch before its messages: registered product types, or core `custom`, `custom_message`, `message`, `subagent_spawn`, or `planning_state_change`. Payloads are checked against their types.

The delivery commits as one batch: a client input's `started` transition, the prepared entries, then the messages. A host-origin input, which has no user message of its own, also records `completed`. A batch that rolls back leaves the delivery queued.

## transformContext

```ts
transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
```

Rewrites a copy of the branch messages before conversion, for one request. The result is never committed. When the log changes between request preparation and admission, the kernel rebuilds the context with `buildContext`, which applies this hook again.

## requestBoundary

```ts
requestBoundary?: (
  boundary: ConversationRequestBoundary,
  context: Context,
  signal?: AbortSignal,
) => Promise<ConversationRequestContext | undefined>;
```

Runs immediately before a turn request is sent, after its input committed and its context was converted. Summary and host-operation requests never reach it. `boundary` carries:

- `cause`: `input`, `tools`, `continuation`, or `retry`;
- `batch`: the newest committed batch of client-input deliveries, with their `clientMessageId`s, never inferred from transcript text; `newInput` is true for the first request after it;
- `requestAuthority`, `basisOrdinal` (the ordinal the request builds on), and a fresh `attemptId`.

Return request-local `messages` with an `authorization`. The kernel appends the messages to this request only, never to the log, and only when `authorization.isCurrent()` still holds after the hook's last await and the input batch is unchanged. It calls `authorization.settle(included)` exactly once. If the context or configuration changes while the hook runs, its result is settled as not included and the hook runs again on the rebuilt context. Both callbacks must be synchronous.

## beforeProviderPayload and afterProviderResponse

```ts
beforeProviderPayload?: (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>;
afterProviderResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
```

`beforeProviderPayload` inspects or replaces the provider payload; return `undefined` to keep it. `afterProviderResponse` observes the HTTP status and headers before the body is read. Both apply to turn requests, summary requests, and host-operation requests. Prompt-cache refresh runs `beforeProviderPayload` only.

## beforeToolCall and afterToolCall

These are `AgentLoopConfig["beforeToolCall"]` and `["afterToolCall"]`.

- `beforeToolCall(context, signal)` runs after argument validation with `{ assistantMessage, toolCall, args, context }`. Return `{ block: true, reason }` to skip execution; the tool result is an error with `reason`. An abort during the hook also produces an error result.
- `afterToolCall(context, signal)` runs after execution with the result and `isError`. Return a partial override of `content`, `details`, `isError`, or `disposition`; omitted fields keep their values, with no deep merge.

A throwing tool hook produces an error tool result with the thrown message.

## retry

```ts
retry?: (error: ProviderError, attempt: number, message: AssistantMessage) => number | undefined;
```

Consulted when a turn's final assistant message failed (`stopReason: "error"` with a typed `error`). Return a backoff in milliseconds to retry, or `undefined` to stop. `attempt` counts from 1 within one turn operation. The backoff runs inside the turn operation, so no other operation is admitted between the failure and the retry; an abort during the backoff ends the turn. The kernel publishes `retry_start` before the backoff and `retry_end` when the retries end.

A context overflow on the current model goes to `compaction` instead, once per turn operation, when the conversation has a summarizer and a `compaction` hook. If the hook declines, the turn ends without a retry.

## compaction

```ts
compaction?: (
  usage: Usage,
  cause: "overflow" | "threshold",
  check: ConversationCompactionCheck,
) => ConversationCompactionDecision | undefined | Promise<ConversationCompactionDecision | undefined>;
```

Consulted only when the conversation has a `summarizer`. `check` carries the assistant `message`, the `model`, the `state`, and `continuing` (whether the turn would otherwise make another request). Return `undefined` to skip, or `{ resume?, instructions? }` to compact now inside the turn operation. The hook runs:

- At a turn's first decision, when the context ends with an assistant message (an earlier overflow, abort, or large response). The cause is `overflow` when that message overflowed the current model, otherwise `threshold`.
- Between requests, when the turn would continue after a completed request from the current model (`threshold`, `continuing: true`). A decision makes `pause` the default action, so `nextAction` can still act first (for example, ask for a final report). If the resolved action is `pause`, the kernel compacts and resumes.
- After the turn's final message: an overflow error on the current model (`overflow`), or any message from the current model that did not fail or abort (`threshold`).
- When a turn stops right after a tool batch (a `stop` disposition or a policy stop), measured with its tool results (`threshold`, `continuing: false`).

After a successful compaction the turn resumes as `resume` decides:

- `retry`: re-request the request that produced `check.message`, before a pending prompt is delivered. A tool-free length-stopped message is left out of the turn's requests; a failed or aborted one is dropped by the replay policy. Any other message cannot be retried, so the turn continues.
- `continue`: continue the turn with its pending input.
- absent: a threshold compaction at the end of a turn ends it, and one before or between requests continues it.

An overflow compaction always resumes with `retry`.

A compaction that is skipped or fails before the turn's first request lets the turn proceed without it; elsewhere it ends the turn. An abort ends the turn.

## Summarizer

```ts
interface ConversationSummarizer {
  compact(request: ConversationCompactionRequest): Promise<ConversationCompactionSummary | undefined>;
  summarizeBranch(request: ConversationBranchSummaryRequest): Promise<ConversationBranchSummary | undefined>;
}
```

The summarizer produces summaries; the kernel decides when they run and commits them. Each request carries the `state`, the resolved `model`, the `thinkingLevel`, optional `instructions`, the operation `signal`, and a `stream` that sends requests with the conversation's stream options and provider hooks.

- `compact` also receives the `cause` (`manual`, `overflow`, or `threshold`). Return `{ summary, firstKeptEntryId, tokensBefore, details?, fromHook?, messages? }` or `undefined` to skip. The kernel commits the `compaction` entry and then `messages` in one batch.
- `summarizeBranch` also receives `fromLeafId`, `targetId`, `commonAncestorId`, and the abandoned `entries`, oldest first. Return `{ summary, details?, fromHook? }` or `undefined` for no summary.

A throwing `compact` reports `compaction_end` with status `failed`; `compact()` rethrows the error, and inside a turn it counts as skipped. A throwing `summarizeBranch` rejects `navigate()`.

## Compaction and navigation

`compact({ instructions? })` compacts the active branch now. It needs a summarizer. An active turn, compaction, or navigation is aborted with source `host_action` and the compaction runs after it; an active host operation rejects it with `busy`. It resolves `{ status: "compacted" | "skipped" | "aborted", entryId? }`.

`navigate(targetId, options)` moves the active branch to a public entry, or to `null` (before the first entry):

```ts
interface ConversationNavigationOptions {
  summarize?: boolean;
  instructions?: string;
  label?: string;
  prepare?: (preparation: ConversationNavigationPreparation) =>
    ConversationNavigationPlan | undefined | Promise<ConversationNavigationPlan | undefined>;
}
```

- Navigation aborts an active compaction, or a turn that has not yet committed a delivery or started a request, and runs after it. It is rejected with `busy` while a navigation, a host operation, or a turn past that point runs.
- `prepare` runs inside the navigation operation before the summarizer, with the `state`, `fromLeafId`, `targetId`, `commonAncestorId`, abandoned `entries`, `summarize`, `instructions`, `label`, and `signal`. Return `{ cancel: true }` to cancel (status `cancelled`), or `{ summary?, label?, instructions? }`: a summary to commit instead of running the summarizer, and overrides.
- With `summarize: true` and no summary from `prepare`, the summarizer's `summarizeBranch` runs when the leaf moves. A model is required only then. `summarize` needs a summarizer unless `prepare` is given.
- The move commits as one batch: a `leaf` entry when the leaf changes, the `branch_summary` entry, and a `label` on the summary entry, or on the target when nothing is summarized.

It resolves `{ status: "navigated" | "cancelled" | "aborted", leafId, summaryEntryId? }`.

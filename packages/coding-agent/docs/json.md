# JSON Event Stream Mode

```bash
volt --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating volt into other tools or custom UIs.

## Event Types

Events are defined in [`AgentSessionEvent`](../src/core/agent-session.ts#L102):

```typescript
type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `compaction_start` and `compaction_end` cover both manual and automatic compaction. Each low-level agent run emits `agent_end`; retries and compaction or queued-message continuations can produce additional runs. `agent_settled` is emitted once after all such work finishes and is the terminal event for the prompt.

Base events from [`AgentEvent`](../../agent/src/types.ts#L179):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages from [`packages/ai/src/types.ts`](../../ai/src/types.ts#L134):
- `UserMessage` (line 134)
- `AssistantMessage` (line 140)
- `ToolResultMessage` (line 152)

Extended messages from [`packages/coding-agent/src/core/messages.ts`](../src/core/messages.ts#L29):
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","stream":{"epoch":1,"seq":0},"message":{"role":"assistant","content":[],...}}
{"type":"message_update","stream":{"epoch":1,"seq":1},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","stream":{"epoch":1,"seq":2},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","stream":{"epoch":1,"seq":2},"message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...],"willRetry":false}
{"type":"agent_settled"}
```

Assistant streaming frames carry a `stream` position. Most `message_update` frames are compact deltas; recovery frames also include a full `message` snapshot and, for resumable open tool calls, `toolState`. In-process events use immutable `snapshot`, `seq`, and `toolState` fields, which are reconstructed by the bundled RPC client but omitted from compact wire deltas. See the position and reconstruction rules in [rpc.md](rpc.md#message_update-streaming).

When `agent_end.willRetry` is true, another agent run will follow. Even when it is false, use `agent_settled` rather than `agent_end` as the prompt-completion signal.

## Example

```bash
volt --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```

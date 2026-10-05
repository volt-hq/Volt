# JSON Event Stream Mode

```bash
volt --mode json "Your prompt"
```

Runs the prompts and writes the conversation to stdout as Volt protocol frames, one JSON object per line: what an [RPC mode](rpc.md) client subscribed from a snapshot receives, on the local profile. Use it to integrate volt into other tools or custom UIs without a two-way connection.

## Output

The stream is one subscription (`subscriptionId: "json-1"`) of the conversation the run is on:

1. `snapshot{ordinal, state}`: the conversation before the run, as a client fold snapshot (`state.entries` holds every entry);
2. `entry{entry}` for each entry the run commits, in log order, and `head{ordinal}` when the last entries of a batch are hidden;
3. `live{basedOn, seq, reset?, items}` for the live lane: the first is a reset; then the run phase, token use, the streaming assistant message (`assistant_start`, `assistant_delta`, `assistant_end`), running tools (`tool`, with their `presentation` or a `patch` of it), work (`work/<id>`), extension status items, panels, and title (`ext_status/…`, `ext_panel/…`, `ext_title`, and `patch` items for panels), and notices;
4. `ended{reason: "closed"}` once the run ends.

When an extension command moves the run to another conversation (`ctx.newSession()` and the like), the subscription ends with `ended{reason: "moved", target}` and a new one (`json-2`, ...) starts from that conversation's snapshot.

```json
{"type":"snapshot","subscriptionId":"json-1","conversation":"01990f6e-…","ordinal":2,"state":{"leafId":null,"entries":[…],"earlier":false,"model":{"provider":"anthropic","modelId":"claude-sonnet-4-5"},…}}
{"type":"live","subscriptionId":"json-1","basedOn":2,"seq":1,"reset":true,"items":[{"type":"set","key":"phase","value":{"kind":"phase","busy":false,"operation":null}},…]}
{"type":"entry","subscriptionId":"json-1","entry":{"ordinal":3,"id":"9f2c…","parentId":null,"type":"message","timestamp":"…","payload":{"message":{"role":"user",…}},"view":{"role":"user","text":"List files","truncated":false}}}
{"type":"live","subscriptionId":"json-1","basedOn":3,"seq":2,"items":[{"type":"set","key":"phase","value":{"kind":"phase","busy":true,"operation":"turn","run":{"startedAt":1790000000000}}}]}
{"type":"live","subscriptionId":"json-1","basedOn":3,"seq":3,"items":[{"type":"assistant_start","message":{"role":"assistant","content":[],…}}]}
{"type":"live","subscriptionId":"json-1","basedOn":3,"seq":4,"items":[{"type":"assistant_delta","event":{"type":"text_delta","contentIndex":0,"delta":"Here"}}]}
{"type":"entry","subscriptionId":"json-1","entry":{"ordinal":4,"type":"message","payload":{"message":{"role":"assistant",…}},"view":{"role":"assistant","text":"Here are the files…",…},…}}
{"type":"live","subscriptionId":"json-1","basedOn":4,"seq":5,"items":[{"type":"set","key":"phase","value":{"kind":"phase","busy":false,"operation":null}}]}
{"type":"ended","subscriptionId":"json-1","reason":"closed"}
```

Entries carry their whole payload (a message entry's `payload.message` is the stored message) and, for message-like entries, a bounded transcript `view`; a tool call's view, and a custom message's whose type has a presenter, carries its `presentation` as [`UiNode` data](ui-nodes.md). The frame shapes, the live lane's rules, and the client fold are described in [RPC mode](rpc.md#subscriptions); the JSON Schemas are in the `@hansjm10/volt-protocol` contract artifact.

JSON mode answers no host requests: extension dialogs resolve to their defaults, and `ctx.hasUI` is `false`. Extension errors are `notice` items with `level: "error"` and the extension's manifest id as `source`.

## Example

```bash
# The final assistant text of each message the run committed
volt --mode json "List files" 2>/dev/null \
  | jq -r 'select(.type == "entry" and .entry.view.role == "assistant") | .entry.view.text'

# Streamed text as it arrives
volt --mode json "Explain this repo" 2>/dev/null \
  | jq -rj 'select(.type == "live") | .items[] | select(.type == "assistant_delta" and .event.type == "text_delta") | .event.delta'
```

# Design: Streaming projection — immutable snapshots and an explicit state machine

> **Status: implemented (2026-07-16), revised twice after independent adversarial
> reviews (one solo review, then two parallel independent reviews).**
> Implements issue #72. Decisions locked in review: providers become pure
> fragment emitters (no provider-owned accumulator), the client decoder
> mirrors the producer state machine, and volt-app's decoder breaks until its
> own refactor (tracking issue on that repo, per the no-legacy policy). See
> "Review outcomes" at the end for what each round corrected.

## Problem

The streaming pipeline threads one mutable `AssistantMessage` from provider to
every consumer. Each layer copes with that differently, and the recovery logic
has accreted PR by PR (#44, #58, #63, #65, #68, #70, #73):

- Providers mutate a single `output` object in place and push
  `AssistantMessageEvent`s carrying that same reference
  (`packages/ai/src/providers/anthropic.ts`, same pattern in all providers).
  The `EventStream` queue never clones, and extension emits are awaited, so a
  queued `text_delta` can be observed after its own message advanced. The
  agent loop's `{ ...partialMessage }` spread shares the mutable `content`
  array.
- `RpcSessionEventEncoder` therefore cannot trust event deltas and re-derives
  them by diffing successive accumulated states (`deriveAppendedDelta`), with
  snapshot fallbacks at every ambiguous case (~13 call sites).
- Tool-call resumability is inferred from provider-private scratch
  (`getToolCallArgsText` reads `partialJson` ?? `partialArgs`), coupling the
  wire codec to provider internals. Providers that expose neither (google)
  force replacement-snapshot loops (`snapshotOnlyToolCallIndexes`).
- Iroh runs two sanitizers that must agree; when they didn't, we added
  `preSanitizedMessageDeltas` + `restorePreSanitizedMessageUpdateDelta`
  (restore the encoder's delta after the whole-frame filter over-redacts it).
- Sync state is ad-hoc flags (`deltaBaseSent`, `emittedText`,
  `resumableToolArgsText`, `snapshotOnlyToolCallIndexes`); the viewer feed's
  universal recovery is "recreate the encoder".

## Shape of the fix

Three layers replace the scatter. Data flows:

```
provider fragments → AssistantStreamNormalizer → immutable events
                                                       │
                     (in-process consumers: hooks, TUI, subagent manager)
                                                       │
                        StreamProjector (per boundary stream)
                                                       │
                    wire frames {epoch, seq} → StreamProjectionDecoder
```

### Layer 1: providers emit fragments

Providers stop owning an accumulator. They emit pure data fragments; the
`partialJson` / `partialArgs` scratch fields cease to exist as an
architectural concept (a temporary compat bridge survives until phase 3, see
Phasing).

```ts
// packages/ai/src/stream/fragments.ts
export type AssistantStreamFragment =
	| { type: "start"; init: AssistantMessageInit } // api, provider, model, timestamp
	| { type: "meta"; patch: AssistantMessageMetaPatch } // responseId, responseModel, usage, diagnostics (append); folded silently
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content?: string; textSignature?: string }
	| { type: "thinking_start"; contentIndex: number; content?: string; thinkingSignature?: string; redacted?: boolean }
	| { type: "thinking_delta"; contentIndex: number; delta: string; signatureDelta?: string }
	| { type: "thinking_end"; contentIndex: number; content?: string; thinkingSignature?: string; redacted?: boolean }
	| { type: "toolcall_start"; contentIndex: number; id?: string; name?: string }
	| { type: "toolcall_delta"; contentIndex: number; argsTextDelta: string; id?: string; name?: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall?: ToolCall } // authoritative; may replace (non-append) the accumulation
	| { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; usage?: Usage }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; errorMessage: string; diagnostics?: AssistantMessageDiagnostic[] };
```

Contract notes, each grounded in a real provider behavior:

- **`contentIndex` is dense** (contiguous positions in the output content
  array). Providers keep their existing API-index → dense-index mapping as
  provider state (`anthropic.ts` `findIndex`, bedrock block maps,
  completions' `streamIndex`/id maps) — that mapping is legitimately
  provider-private; raw API indexes never cross the fragment boundary.
- **Tool-call identity may arrive late, and is best-effort at the end.**
  openai-completions opens tool calls with empty `id`/`name` that later
  chunks patch — and if no chunk ever patches them, `toolcall_end` ships the
  block with empty identity as today. `toolcall_start` therefore has optional
  identity, and `toolcall_delta` may carry `id`/`name` to patch it. Consumers
  must tolerate an identity-less stub window.
- **Pre-seeded arguments are an immediate first delta.** Providers that
  receive initial argument text at tool-call open (openai-responses
  `item.arguments` at `output_item.added`, anthropic `content_block.input`)
  emit `toolcall_start` followed by a synthetic first `toolcall_delta`
  carrying the seed text.
- **`*_end` fields are authoritative and may be non-append.**
  openai-responses replaces accumulated argument text at
  `function_call_arguments.done` and rewrites thinking/text from
  `output_item.done` items. Providers must not rewrite an *open* block's
  accumulation mid-stream; they defer authoritative rewrites to the `*_end` /
  `toolcall_end` fragment. The normalizer treats an `*_end` override as the
  new accumulated value (see invariant 2's scope). The deferral rule is
  enforced, not assumed: a `*_delta` addressed to a block already closed by
  its `*_end` is a contract violation — the normalizer drops the fragment and
  records an `AssistantMessageDiagnostic` on the message (which must describe
  the violation without embedding the dropped fragment's raw content — it
  crosses privacy boundaries) instead of silently reopening the block — so a
  future provider that breaks the rule fails loudly in tests rather than
  corrupting accumulations.
- **Redacted thinking arrives fully formed.** Anthropic delivers
  `redacted_thinking` complete at block start; `thinking_start` carries the
  placeholder content, opaque `thinkingSignature`, and `redacted` in that
  case.
- **Thinking signatures stream; other signatures land at block end.**
  Anthropic `signature_delta` / bedrock `reasoningContent.signature`
  accumulate via `signatureDelta` on `thinking_delta`, so the normalizer (not
  the provider) holds the partial signature and an abort mid-block preserves
  it on the error message. Signatures on *open* text and tool-call blocks
  (google `textSignature`, completions `reasoning_details` →
  `thoughtSignature`) have no delta fragment and land via `*_end` /
  `toolcall_end`; an abort before block end loses them — a deliberate,
  slightly narrower guarantee than today's error path, accepted because these
  signatures are only consumed on completed blocks in multi-turn replay.
- **Diagnostics are meta.** openai-codex-responses appends transport-fallback
  diagnostics mid-stream; they ride `meta.patch.diagnostics` (append
  semantics) and `error.diagnostics`, never a scratch field.
- Providers that receive whole argument payloads per chunk (google; mistral's
  object form) emit one `toolcall_delta` with the full text, or rely on
  `toolcall_end`'s authoritative block.

### Layer 1b: the normalizer owns the only accumulator

`AssistantStreamNormalizer` (packages/ai) converts fragments into the public
event type. Every event is internally consistent and immutable:

```ts
// packages/ai/src/types.ts (revised)
export type AssistantMessageEvent =
	| { type: "start"; seq: number; snapshot: AssistantMessage }
	| { type: "text_start"; seq: number; contentIndex: number; snapshot: AssistantMessage }
	| { type: "text_delta"; seq: number; contentIndex: number; delta: string; snapshot: AssistantMessage }
	| { type: "text_end"; seq: number; contentIndex: number; content: string; snapshot: AssistantMessage }
	| { type: "thinking_start" | "thinking_delta" | "thinking_end"; /* same shape as text_* */ }
	| { type: "toolcall_start"; seq: number; contentIndex: number; id: string; name: string; snapshot: AssistantMessage; toolState: readonly ActiveToolCallState[] }
	| { type: "toolcall_delta"; seq: number; contentIndex: number; argsTextDelta: string; id?: string; name?: string; snapshot: AssistantMessage; toolState: readonly ActiveToolCallState[] }
	| { type: "toolcall_end"; seq: number; contentIndex: number; toolCall: ToolCall; snapshot: AssistantMessage; toolState: readonly ActiveToolCallState[] }
	| { type: "done"; seq: number; reason: ...; message: AssistantMessage }
	| { type: "error"; seq: number; reason: ...; error: AssistantMessage };

/** Typed resumable state for an in-flight tool call. Replaces partialJson/partialArgs. */
export interface ActiveToolCallState {
	contentIndex: number;
	/** Raw streamed argument text accumulated so far. */
	argsText: string;
}
```

Identity (`id`/`name`) on `toolcall_start` / `toolcall_delta` events exists
precisely because these events cross the wire on delta frames with no
snapshot attached — it replaces today's `attachToolCallStub`. On sanitized
boundaries, `id` is opaque-preserved and `name` is text-sanitized, matching
the whole-frame filter's current rules.

Invariants the normalizer guarantees (property-tested):

1. `seq` is contiguous per message, starting at 0 (`start`).
2. **Content equivalence, scoped.** For `*_delta` events, applying `delta` to
   `snapshot(seq−1)` yields `snapshot(seq)`'s block content and argument text
   exactly. `*_end` events carry authoritative content that may replace the
   accumulation (non-append); the event's `content` / `toolCall` **is** the
   block's value in `snapshot(seq)`. Snapshots may additionally differ by
   silently folded meta (usage, responseId, responseModel, diagnostics) and
   by signature fields, which have no per-delta wire representation — a
   wire consumer's rebuilt state is guaranteed equivalent *modulo meta and
   signatures*, which re-synchronize on every `base` / `snapshot` / `final`
   frame. Projectors treat `*_end` as a trusted replacement, not an appended
   delta.
3. **Incremental immutability.** Snapshots are structurally shared: each
   fragment allocates a new content block, a new content array, a new message
   shell, plus whatever nested values that fragment introduced (the freshly
   parsed `arguments` graph, a patched `usage` / `diagnostics`), and freezes
   **exactly the newly created objects** at creation. Unchanged subtrees are
   shared and **never re-walked or re-frozen**. Per-event cost is O(blocks)
   pointer copies plus O(new values) — the same order as the
   `parseStreamingJson` cost invariant 4 already pays. This preserves the
   #43/#44 perf wins; a deep clone or deep re-freeze per token would
   reintroduce O(updates × length). (Consequence: every retained event pins
   its own parsed-args graph — bounded by the EventStream queue depth and the
   subagent activity buffer's caps.)
4. `toolState` lists every open tool call with its full raw argument text, so
   any consumer can attach mid-call and resume delta framing without provider
   scratch. Parsed `arguments` on the snapshot block are updated per delta via
   `parseStreamingJson` (same cost as today).
5. Malformed provider streams normalize deterministically: a delta for an
   unopened block synthesizes the block start; a delta for a block already
   closed by its `*_end` is dropped with a diagnostic (the withhold-and-defer
   rule made loud); a duplicate `start` fragment is dropped with a
   diagnostic; `done`/`error` auto-closes open blocks, preserving accumulated
   text, argument text, and buffered partial thinking signatures (missing
   `*_end` and abort-mid-block recovery); fragments after `done`/`error` are
   dropped; and a fragment stream that ends with no terminal fragment at all
   synthesizes an `error` event (today `proxy.ts` can end a stream
   result-less, which would hang the agent loop's `result()`). The normalizer
   is the single place malformedness is absorbed. Note the observable
   in-process change: consumers now see synthesized `*_end` events for blocks
   open at abort.

The `EventStream` queue is unchanged; it becomes safe because payloads are
immutable. Hooks can await arbitrarily long. `AgentEvent.message_update`
keeps its `message` field as the same reference as
`assistantMessageEvent.snapshot` (zero cost, avoids touching every in-process
consumer); the wire still omits it per delta.

### Layer 2: `StreamProjector` — the producer state machine

One projector per ordered outbound stream (session subscription, subagent
handle, viewer feed). It is a pure transition function; all effects are in the
returned frames:

```ts
// packages/coding-agent/src/core/rpc/stream-projection.ts (replaces message-deltas.ts)
export type ProjectionPhase = "idle" | "needs_snapshot" | "synchronized" | "desynchronized" | "terminal";

export interface ProjectionState {
	phase: ProjectionPhase;
	epoch: number;
	lastSeq: number;
	/** Per-content-index emitted accumulation (raw, or sanitized in sanitizer mode). */
	emitted: ReadonlyMap<number, string>;
	/** Blocks that must ship as replacement snapshots until their toolcall_end. */
	replaceOnly: ReadonlySet<number>;
}

export type ProjectionInput =
	| { kind: "message_start"; message: AssistantMessage }
	| { kind: "event"; event: AssistantMessageEvent }
	| { kind: "message_end"; message: AssistantMessage }
	| { kind: "discontinuity" }   // buffer truncation, unserializable-event drop, unsubscribe gap — anything that invalidated delivery
	| { kind: "run_end" }         // agent_end / agent_settled / abort: the run is over, the stream is not
	| { kind: "stream_end" };     // unsubscribe-forever / subagent_end / subagent_disposed: the stream itself is torn down

export interface ProjectionResult {
	state: ProjectionState;
	frames: WireFrame[];
	/** Dropped/anomalous input descriptions, surfaced to the boundary's logger. */
	diagnostics: ProjectionDiagnostic[];
}

export function project(state: ProjectionState, input: ProjectionInput, cfg: ProjectionConfig): ProjectionResult;
```

**Scope: assistant messages only.** `message_start` / `message_update` /
`message_end` frames on a session stream also carry user, toolResult, custom,
and bashExecution messages. Those frames **bypass the projector entirely** —
passed through untouched, no `stream` field, no state effect — exactly as the
current encoder passes non-assistant updates through. Only frames whose
`message.role === "assistant"` enter the state machine. (See Layer 3 for the
privacy consequence: non-assistant frames remain the whole-frame filter's
responsibility.)

**`run_end` vs `stream_end` (review blocker S1).** A session subscription's
projector lives across many runs: `agent_end` fires per prompt *and between
auto-retry attempts within one interaction*
(`agent-session-retry-events.test.ts` observes multiple `agent_end`s on one
subscription), and a session continues after abort. `run_end` therefore
resets to `idle` (defensively dropping any half-open message state — the
agent loop always emits `message_end`, even on error/abort, so half-open
should not occur). Only genuine stream teardown reaches `terminal`.

Wire frames carry explicit position; the decoder validates instead of
guessing:

```ts
export interface StreamPos { epoch: number; seq: number; }

export type WireFrame =
	| { kind: "base"; pos: StreamPos; message: AssistantMessage }                    // message_start
	| { kind: "delta"; pos: StreamPos; event: SlimAssistantEvent }                   // no message, no snapshot
	| { kind: "snapshot"; pos: StreamPos; event: SlimAssistantEvent; message: AssistantMessage; toolState?: ActiveToolCallState[] }
	| { kind: "final"; pos: StreamPos; message: AssistantMessage };                  // message_end
```

(On the RPC protocol these stay `message_start` / `message_update` /
`message_end` shapes with a `stream: StreamPos` field added; `snapshot` vs
`delta` is distinguished by the presence of `message`, as today.)

**Position semantics.** `pos.seq` is the normalizer's per-message seq (the
`base` frame carries seq 0; a snapshot frame carries the seq of the event
that triggered it). `epoch` is projector-local, **monotonic for the
projector's lifetime, and never resets** — not on `run_end`, not between
messages; it bumps on every snapshot emission. The decoder's continuity check
is: same epoch ⇒ expect `seq = lastSeq + 1`; on adopting a base/snapshot, set
`(epoch, lastSeq) := frame.pos`. Message boundaries are delimited by `base` /
`final` frames, so per-message seq restart is unambiguous. Because a projector
can be *recreated* on the same wire (session rebind after
`new_session`/`switch_session`/`fork`/`reload` — `rpc-mode.ts` builds a fresh
encoder per rebind today), the decoder must never treat a lower epoch as
stale on adoptable frames: **`base`/`snapshot`/`final` frames are adopted
unconditionally in every state**; epoch/seq gate *delta* frames only.

A snapshot carries `toolState` when the raw argument text is shippable
(always, unsanitized; sanitization-invariant only, on Iroh), which lets the
decoder resume argument deltas after mid-call attach — eliminating the
unconditional replacement-snapshot loop that `snapshotOnlyToolCallIndexes`
implemented.

#### Transition table (producer)

| State | Input | Frames out | Next state |
|---|---|---|---|
| idle | message_start | base(epoch+1, 0) | synchronized |
| idle | event (attach raced ahead of start) | snapshot(epoch+1) | synchronized or desynchronized¹ |
| idle | message_end | final | idle |
| idle | discontinuity | — | idle (nothing in flight was lost) |
| needs_snapshot | message_start | base(epoch+1, 0) | synchronized |
| needs_snapshot | event | snapshot(epoch+1, +toolState¹) | synchronized or desynchronized¹ |
| needs_snapshot | message_end | final | idle |
| needs_snapshot | discontinuity | — | needs_snapshot |
| synchronized | message_start (duplicate: missing message_end) | base(epoch+1, 0) + diagnostic | synchronized |
| synchronized | event, delta consistent² | delta(epoch, seq) | synchronized |
| synchronized | event, seq gap or non-append accumulation² | snapshot(epoch+1) | synchronized or desynchronized¹ |
| synchronized | event, sanitizer rewrote shipped text³ | snapshot(epoch+1) | synchronized or desynchronized¹ |
| synchronized | event, block enters replace-only³ | snapshot(epoch+1) | desynchronized |
| synchronized | message_end | final | idle |
| synchronized | discontinuity | — | needs_snapshot |
| desynchronized | message_start (duplicate) | base(epoch+1, 0) + diagnostic | synchronized |
| desynchronized | toolcall_end for a replace-only block | `*_end` frame (field-aware sanitized³), remove index | synchronized if `replaceOnly` now empty, else desynchronized |
| desynchronized | other event touching a replace-only block | snapshot(epoch+1) | desynchronized |
| desynchronized | event on clean block, delta consistent | delta(epoch, seq) | desynchronized |
| desynchronized | message_end | final | idle |
| desynchronized | discontinuity | — | needs_snapshot |
| any non-terminal | run_end | — (reset message state; epoch is retained) | idle |
| any non-terminal | stream_end | — | terminal |
| terminal | any | — (drop, diagnostic) | terminal |

¹ `desynchronized` iff any open tool call's args text is unshippable: absent
(should not happen with the normalizer) or, in sanitizer mode, not
sanitization-invariant. The offending indexes populate `replaceOnly`. Exit
from `desynchronized` is by **cardinality**: only when the last replace-only
block closes does the stream return to `synchronized` (concurrent tool calls
can hold multiple indexes).
² With immutable events, `*_delta` events are trusted; "non-append" arises
from `*_end` authoritative overrides (openai-responses rewrites accumulated
args/thinking/text at block end — a normal, unsanitized case), in sanitizer
mode, and on normalizer seq gaps (defensive; should not occur in-process).
The `*_end` override case ships the trusted replacement value in the `*_end`
frame itself — same as today's authoritative `toolcall_end` — and only forces
a snapshot when the client-held prefix is not a prefix of the final value.
³ Sanitizer mode only.

`desynchronized` is exactly the old `snapshotOnlyToolCallIndexes` loop and the
Iroh unsanitizable-args loop, now a named state with named entry/exit
transitions. `needs_snapshot` is the old "fresh encoder snapshots first"
behavior, now an explicit initial state for mid-stream attach — a projector
constructed while a message is in flight starts in `needs_snapshot`, not
`idle`. A duplicate `message_start` is the one malformed input where
drop-with-diagnostic would be wrong (the new message's base would be lost),
so it is treated as an implicit `message_end` + `message_start`.

### Layer 2b: `StreamProjectionDecoder` — the mirrored consumer machine

Same phases, consumer semantics, per stream key (`session`,
`subagent:<id>`), from a shared module so both sides are tested against one
transition table. Dropped-frame decisions surface through a diagnostics hook
(logged/telemetered by the owning client), never thrown:

| State | Frame | Action | Next |
|---|---|---|---|
| idle | base / snapshot | adopt accumulator, seed toolState, emit rebuilt event | synchronized |
| idle | final | adopt final message, emit | idle |
| idle | delta | drop + diagnostic (server is snapshot-first; this is malformed) | desynchronized |
| synchronized | delta (epoch = cur, seq = last+1) | apply, emit rebuilt event | synchronized |
| synchronized | delta (stale epoch or seq gap) | drop + diagnostic | desynchronized |
| synchronized | base / snapshot (any epoch) | adopt, emit | synchronized |
| synchronized | final | adopt final message, emit | idle |
| desynchronized | base / snapshot (any epoch) | adopt, emit | synchronized |
| desynchronized | delta | drop | desynchronized |
| desynchronized | final | adopt final message, emit | idle |
| any | run-reset events (`agent_start`, `agent_end`, `agent_settled`) | reset stream state | idle |
| any | stream teardown (`subagent_end` / `subagent_disposed`, dispose) | delete keyed stream state | (state deleted) |

Two deliberate asymmetries with the producer:

- **Adoption is unconditional.** `base` / `snapshot` / `final` re-seed in
  every state regardless of epoch — a projector recreated by a mid-run
  session rebind restarts at epoch 1, and a decoder that compared epochs
  would drop the entire first post-rebind message. Epoch/seq gate deltas
  only. (`agent_start` is also a run-reset input so a rebind that swallowed
  the previous run's tail still fences the stream.)
- **Teardown deletes rather than tombstones.** The decoder has no absorbing
  `terminal`: deleting the keyed state means a late frame for that key
  re-seeds from `idle` (today's behavior — safer for a `subagent_event`
  arriving after `subagent_end` from a retained child runtime) instead of
  being black-holed.

Today's defensive heuristics become validations — with one deliberate
exception: the delta-application **bounds check on `contentIndex` stays** as
an independent defense. Position fields arrive from the same (potentially
buggy or hostile) producer as the index; a frame with self-consistent
`epoch`/`seq` and `contentIndex: 50_000_000` would otherwise be a
memory-amplification attack. Seq/epoch validation is complementary (delivery
continuity), not a replacement for input validation. Delta application stays
copy-on-write, as the current decoder already does.

### Layer 3: sanitization is a projection stage, not a transport wrapper

`ProjectionConfig` takes an optional sanitizer. In sanitizer mode the
projector tracks **raw and sanitized accumulators as distinct state**:
`emitted` holds sanitized accumulations, and deltas are derived between
successive sanitized values.

**The shared rule module (review blocker Z1).** A text/args-only sanitizer
interface is insufficient. Define the shared module as **the whole-frame
filter's full recursive `sanitizeValue`, minus frame-level classification** —
not an enumerated subset. That carries over, exactly: `errorMessage`
(provider errors embed host paths), `diagnostics[].error.message/stack` and
`diagnostics[].details`, path-field suffix semantics
(`STRICT_REMOTE_PATH_FIELDS`, `*Dir`/`*File`/`*Path`), **omission** fields
(`fullOutputPath`, `sessionFile` — omitted, not path-mapped, and they can
appear inside tool-call arguments), tool-argument **object keys** including
duplicate-key uniquing after sanitization, and **opaque preservation** of
`textSignature` / `thinkingSignature` / `thoughtSignature` / `id` / image
`data` (a naive sanitize-every-string pass would corrupt signatures, e.g.
openai-responses' JSON-stringified reasoning items, and break multi-turn
replay).

**Where the rules apply.** Sanitizer-mode projection sanitizes *everything it
emits*, on every frame kind:

- `base` / `snapshot` / `final` frames: the full field-aware pass over the
  carried message (`sanitizeAssistantSnapshot`) and over `toolState`.
- **`delta` frames too**: per-delta text goes through the sanitized-
  accumulation diff as described, and — critically — the event's own payload
  fields get the field-aware pass: `text_end` / `thinking_end` `content`,
  `toolcall_end`'s full `toolCall` (argument values *and keys*, opaque
  `id`/`thoughtSignature`), `toolcall_start`/`toolcall_delta` identity
  (`id` opaque, `name` sanitized), and the visible-text shim if it survives
  deletion. Today those fields are redacted by the whole-frame transport
  filter; once the filter skips message frames, a projector that only
  sanitized snapshots would ship the entire accumulated text raw in a
  `text_end` delta frame.

Consequences for the Iroh boundary:

- Projector output is wire-final. The whole-frame outbound filter's
  classification is **role-based, not type-based**: it skips a
  `message_start` / `message_update` / `message_end` frame (or the message
  event nested inside `subagent_event`) only when `message.role ===
  "assistant"` — i.e. only frames the projector actually produced.
  Non-assistant message frames (user prompts, **toolResult frames — the
  highest-volume host-path carriers on the wire**, custom messages,
  bashExecution) bypass the projector and **remain the whole-frame filter's
  responsibility**, as do all non-message frames (transcripts, tool outputs,
  session metadata) and the `subagent_event` wrapper's own fields.
- `preSanitizedMessageDeltas` and `restorePreSanitizedMessageUpdateDelta` are
  deleted, not fixed. There is one sanitizer pass per field, in one place,
  with one accumulator — the "two sanitizers must agree" contract disappears.
- Raw argument text ships only when `sanitizeText(argsText) === argsText` and
  the parsed args are sanitization-invariant (both gates kept — the
  parsed-args check alone is bypassable because `parseStreamingJson` drops
  incomplete keys). Otherwise the block enters `replaceOnly` and replacement
  snapshots continue until `toolcall_end` delivers the sanitized block:
  the explicit `desynchronized` path.
- A sanitizer rewrite of already-shipped text (a redactable path completing
  across deltas) is the named `synchronized → snapshot(epoch+1)` transition.

### Boundary configurations

All boundaries instantiate the same projector:

| Boundary | Config |
|---|---|
| RPC (stdio / loopback) | no sanitizer |
| JSON print mode | no sanitizer, one-way |
| Iroh remote | sanitizer = shared iroh field-aware rules |
| Subagents | **inherits the hosting transport's config** (sanitized on Iroh — subagent frames cross the same privacy boundary); one projector per subagent handle, frames wrapped in `subagent_event`; decoder keys `subagent:<id>` |
| Daemon viewer feed | no sanitizer; all four current encoder-recreation triggers — buffer truncation, unserializable-event drop, and unsubscribe/resubscribe gaps — feed `discontinuity`. **Events whose frames are not delivered (dropped while truncated/unsubscribed) must not advance the projector**: feed `discontinuity` when delivery resumes, rather than projecting into the void and leaving the projector believing the client is synchronized. |

The subagent manager's activity coalescing (merge consecutive
`message_update`s) becomes trivially safe: dropping an earlier immutable event
in favor of a later one can never tear state.

## What gets deleted

- `partialJson` / `partialArgs` on tool-call blocks, in every provider, and
  `packages/ai/test/openai-responses-partial-json-cleanup.test.ts` (nothing to
  clean up anymore). A normalizer-maintained bridge copy survives until phase
  3 (see Phasing).
- `AssistantMessageEvent.partial` (mutable) → `snapshot` (frozen); the
  duplicated `partial` never had a wire form anyway.
- `stripAssistantMessageEventPartial`, `deriveAppendedDelta`,
  `getToolCallArgsText`, `snapshotOnlyToolCallIndexes`,
  `attachToolCallStub` (subsumed by identity on the `toolcall_start` /
  `toolcall_delta` **events** — which cross the wire — plus `toolState` on
  snapshot frames).
- `RpcSessionEventEncoder` / `RpcMessageDeltaDecoder` → `StreamProjector` /
  `StreamProjectionDecoder` (`message-deltas.ts` deleted in phase 3, once the
  viewer feed — its last consumer — is ported).
- `preSanitizedMessageDeltas` + `restorePreSanitizedMessageUpdateDelta` +
  `getDeltaOnlyMessageUpdateEvent` in `outbound-filter.ts`.
- Viewer feed encoder recreation at all four sites; replaced by the
  `discontinuity` input.
- `packages/agent/src/proxy.ts`'s private mutable accumulator and scratch
  handling — it rebuilds `partial`-carrying events today and is reworked to
  reuse `AssistantStreamNormalizer` (its proxy events are near-fragments
  already, and its `toolcall_start` already carries id/name).
- Candidate: the `text_end` visible-text shim (`slimEvent.message =
  extractVisibleTextContent(...)`), kept "from the pre-delta protocol" —
  delete unless a current consumer is found during implementation (note:
  `44-*` regression tests assert it today and are rewritten either way).

## Acceptance criteria mapping (issue #72)

| Criterion | Where satisfied |
|---|---|
| Delta and snapshot represent the same logical position | Normalizer invariant 2 (scoped: `*_delta` append-exact on content; `*_end` authoritative; meta/signatures sync on full frames), frozen events |
| Mid-attach, concurrent calls, rewrites, aborts, missing terminals recover deterministically | `needs_snapshot` / `desynchronized` transitions; `run_end` reset; normalizer invariant 5; per-index `emitted` / `replaceOnly` with cardinality-based exit handle concurrent tool calls |
| All boundaries use one projector contract | Boundary table above |
| No provider scratch across layers | Fragments + `ActiveToolCallState`; scratch fields deleted (bridge until phase 3) |
| Transition-table and property-based coverage | Test plan below |

## Test plan

- `packages/ai/test/stream-normalizer.test.ts`: fragment → event unit
  coverage plus property tests (invariants 1–5) over generated fragment
  streams, whose generators must include: orphan deltas, missing ends,
  post-terminal fragments, duplicate `start` fragments, streams ending with
  no terminal fragment, several concurrently-open blocks with out-of-order
  `*_end` (completions keeps a text block open across the whole stream while
  tool calls open/close), `*_end` overrides that differ from the
  accumulation, empty-string deltas, `toolcall_start` with empty identity
  patched by later deltas (and never patched), pre-seeded args at tool start
  (synthetic first delta), streamed signature deltas, mid-stream meta folds
  interleaved with content, and abort mid-block (signature/args
  preservation).
- `packages/coding-agent/test/stream-projection.test.ts`: exhaustive
  transition-table enumeration for producer and mirrored decoder — every
  (phase × input) pair asserted, including the impossible-by-construction
  ones (assert they drop with a diagnostic, never emit, never throw) and the
  cardinality cases exhaustive enumeration alone misses: **staggered
  `toolcall_end` across two concurrent replace-only blocks** (exit only when
  the set drains).
- Property-based round trips (add `fast-check` as a pinned dev dependency):
  1. Unsanitized: decoder-rebuilt snapshots ≡ normalizer snapshots at every
     seq **modulo meta and signature fields**, which must be exactly equal on
     every base/snapshot/final adoption; final message exact.
  2. Sanitized: decoder text ≡ `sanitizeText(raw accumulation)` at every
     point; **no raw workspace path substring ever appears in any wire
     frame** — with generators that plant paths in text, tool-argument
     values, tool-argument **keys**, incomplete JSON prefixes, `errorMessage`,
     `diagnostics[].error.stack`, **a block ending exactly on a redactable
     path (the `*_end`-on-delta-frame case)**, and **non-assistant message
     frames (user / toolResult / custom) with planted paths**, asserting the
     whole-frame filter still covers what the projector bypasses; plus:
     signature and image fields survive byte-identical (opaque preservation).
  3. Attach at a random event index → convergence by `message_end`.
  4. Random `discontinuity` injection → recovery via snapshot; stale-epoch
     *delta* frames provably dropped; **mid-run projector recreation (session
     rebind) against a live decoder** → the fresh epoch-1 base is adopted and
     streaming continues.
  5. Multi-run streams: prompt → `agent_end` → prompt, and auto-retry
     sequences (multiple `agent_end`s with `willRetry` on one subscription) —
     the stream stays live across runs; abort → continue works.
  6. Decoder total: never throws on arbitrary malformed frames, **and never
     allocates unboundedly** (self-consistent positions with huge
     `contentIndex` — the memory-amplification case).
- Viewer feed: dropped-while-truncated/unsubscribed events must not advance
  the projector (delivery-resume `discontinuity` test).
- Extension `message_end` replacement exercised against frozen final messages
  **including a replacement that rewrites tool calls** — asserting the
  current run executes the replacement's tool calls and `willRetry`
  classification sees the replacement (see Phasing, phase 1).
- Existing suites are the behavioral acceptance floor:
  `rpc-message-deltas.test.ts`, `suite/regressions/44-*`, `viewer-feed`, and
  `drain-viewer` tests are **rewritten against the new API preserving their
  scenarios** (they hand-build `partialJson` events and assert `partial`
  absence, so they cannot pass unmodified); `daemon-worktree-sanitizer` stays
  green as-is.
- Follow-up candidate: a TLA+ spec of the projector pair under `docs/tla/`
  (the transition tables above are already the model skeleton; the existing
  LeaseBroker spec sets the precedent).

## Phasing

Three PRs, re-scoped after review so shared infrastructure outlives its last
consumer and no phase reopens a fixed regression. Each lands green with
changesets (`internal` unless noted):

1. **`feat(ai): fragment-emitting providers and stream normalizer.`**
   Fragment contract, normalizer, immutable `AssistantMessageEvent`
   (`partial` → `snapshot`, `seq`, `toolState`, tool-call identity); all
   providers converted (including `faux.ts`, which drives most coding-agent
   suites); `packages/agent` loop passes events through unchanged (drops its
   shallow copy); `packages/agent/src/proxy.ts` reworked onto the normalizer.
   **Bridge:** the normalizer additionally writes `argsText` onto streaming
   tool-call blocks as `partialJson` **at block construction time, before
   freezing** (removed at `toolcall_end`), so the legacy encoder/decoder's
   resumability inference keeps working until phase 3 — without this, every
   mid-stream attach between phases regresses to replacement-snapshot loops
   on all providers. **Legacy-codec strip fix:** the untyped legacy encoder
   destructures `partial` off events; after the rename it must strip
   `snapshot` and `toolState` instead (`stripAssistantMessageEventPartial`
   and the `encodeMessageUpdate` destructure), and the rewritten `44-*`
   suite must assert their absence on delta frames — otherwise every delta
   frame silently re-ships the full accumulated message and the #44
   quadratic cost returns unnoticed through phase 3. **API redesign:**
   `agent-session.ts`'s `_replaceMessageInPlace` (extension `message_end`
   replacement) mutates the finalized message in place and would throw on
   frozen messages; it becomes a functional replacement whose result **the
   agent loop consumes**: the `message_end` emit path returns the final
   (possibly replaced) message to `streamAssistantResponse`, which swaps its
   local slot, `currentContext.messages`, and `newMessages` before tool
   execution — preserving today's semantics, where a replacement's rewritten
   tool calls are what actually execute, the same-run LLM context sees the
   replacement, and `agent_end` / `willRetry` classification agree with it.
   (In-place mutation gave this coherence for free; a swap that only touched
   session state and persistence would silently execute stale tool calls.)
   Mechanical `partial` → `snapshot` fallout across TUI/extensions/subagent
   manager.
2. **`feat(coding-agent): stream projector state machine.`** Producer +
   mirrored decoder with epoch/seq framing, **sanitizer config native from
   day one**; RPC, JSON print, subagent, **and Iroh** boundaries cut over
   together (Iroh cannot be deferred: its encoder is created by the same
   rpc-mode factory, and wire-final projector output requires the whole-frame
   filter to stop touching assistant-message frames in the same change —
   deferring either piece resurrects the over-redaction bug the restore hack
   papered over). Shared sanitizer-rule module extracted from
   `outbound-filter.ts`; role-based frame classification;
   `preSanitizedMessageDeltas` machinery deleted; the sanitizer-mode portions
   of `rpc-message-deltas.test.ts` rewritten here. `message-deltas.ts`
   remains only for the viewer feed pair. File the volt-app tracking issue
   here (wire format change: `stream` field, `toolState` on snapshots,
   `partial` gone; tracked as
   [volt-app#26](https://github.com/volt-hq/volt-app/issues/26)). Note: the wire may in practice remain
   decodable by volt-app's current decoder until phase 3 (full frames still
   carry `message`, `stream`/`toolState` are additive) — verify against the
   app before scheduling its adoption, rather than assuming a hard break at
   phase 2.
3. **`feat(coding-agent): viewer feed on the shared projector.`**
   `discontinuity` input replaces encoder recreation (all four sites: buffer
   truncation, unserializable-event drops, unsubscribe/resubscribe); drain
   viewer adopts `StreamProjectionDecoder`; delete `message-deltas.ts` and
   the phase-1 `partialJson` bridge; buffer caps unchanged.

Property suites land with the layer they test (normalizer in 1, projector +
round trips in 2); the transition-table suite lands in 2 and the viewer-feed
discontinuity coverage in 3.

## Out of scope

- `tool_execution_*` events and non-assistant-message streaming (unchanged;
  non-assistant message frames pass through the projector untouched and keep
  their existing whole-frame sanitization).
- volt-app's decoder (its own refactor adopts the mirrored machine later).
- Delta frames for the transcript/history RPCs (not streamed).

## Open questions

- ~~Always freeze vs dev-only?~~ Resolved: always freeze, incrementally
  (invariant 3); the one API that relied on mutating a finalized message
  (`_replaceMessageInPlace`) is redesigned in phase 1 with the agent loop
  consuming the replacement.
- Does `message_start` remain a distinct RPC frame, or become
  `base`-kind `message_update`? Recommendation: keep the existing three frame
  types with the added `stream` field; less churn for volt-app's later
  adoption.

## Review outcomes

### Round 1 (solo adversarial review, 2026-07-16)

Verified the doc's claims against the code; architecture survived. Corrected:

- **Blocker S1:** `agent_end`/abort originally mapped to `terminal`, which
  would kill every session stream after its first run (auto-retry made it
  immediately reachable). Split into `run_end` (→ `idle`) vs `stream_end`
  (→ `terminal`).
- **Blocker Z1/Z2:** the sanitizer interface couldn't cover
  errorMessage/diagnostics/argument-keys/opaque-signature preservation, and
  "subagents: no sanitizer" would have leaked host paths over Iroh. Fixed via
  the shared field-aware rule module and transport-inherited subagent config.
- **Contract gaps C1–C6:** diagnostics channel, late tool-call identity
  (openai-completions), `*_end` authoritative non-append overrides
  (openai-responses), fully-formed redacted thinking, streamed signatures,
  dense-index semantics. All folded into the fragment contract notes.
- **Missing transitions S2–S4:** `needs_snapshot × message_start`,
  `idle × discontinuity`, decoder `idle × final` and `synchronized × base`,
  run-end resets, epoch/seq semantics spelled out.
- **Phasing M1–M3, P3:** four PRs collapsed to three (Iroh cannot trail the
  projector cutover; `message-deltas.ts` outlives phase 2 for the viewer
  pair); `proxy.ts`, `_replaceMessageInPlace`, and `faux.ts` fallout owned in
  phase 1; the `partialJson` bridge closes the mid-attach regression window.

### Round 2 (two parallel independent reviews, 2026-07-16)

Both reviewers independently converged on the top finding; corrected:

- **Blocker (both reviewers): non-assistant message frames.** The projector
  is assistant-only, but `message_start`/`message_end` frames also carry
  user/toolResult/custom messages — a type-based "skip message frames" filter
  rule would have shipped tool outputs (the highest-volume host-path
  carriers) raw over Iroh. Fixed: role-based classification, explicit
  bypass-projection rule, non-assistant generators in the property suite.
- **Both reviewers: `*_end` payloads on delta frames** were assigned to
  neither sanitization pass. Fixed: sanitizer-mode projection applies the
  field-aware rules to delta-frame event payloads too.
- **Both reviewers: tool-call identity never reached the wire** (it was on
  fragments, which don't cross it). Fixed: identity on the
  `toolcall_start`/`toolcall_delta` events; `attachToolCallStub`'s
  subsumption corrected.
- **Both reviewers: freeze-scope contradiction** ("deeply frozen" vs "three
  objects"): parsed-args graphs and folded meta would have stayed mutable and
  shared. Fixed: freeze exactly the newly created objects, including nested
  graphs; never re-walk.
- **Both reviewers: missing `message_start` rows** — a duplicate start would
  have been dropped under the blanket drop-with-diagnostic rule, losing the
  base. Fixed: implicit-end + base transition; duplicate-`start` normalizer
  rule.
- **Reviewer A: decoder epoch rule stranded rebind clients** — a fresh
  projector (session rebind mid-run) restarts at epoch 1; `epoch < cur →
  drop` would discard the entire first post-rebind message. Fixed: adoption
  is unconditional; epoch gates deltas only; epoch never resets on `run_end`;
  `agent_start` added to decoder run-resets.
- **Reviewer A: bounds check is NOT subsumed** by position validation
  (positions are attacker-supplied; it's a memory-amplification defense).
  Retained, with a property test.
- **Reviewer A: legacy codec silently stops stripping** the renamed
  `snapshot` field in phase 1 (untyped destructure) — quadratic wire cost
  returns invisibly. Fixed: phase-1 work item + `44-*` assertion.
- **Reviewer A: `_replaceMessageInPlace` redesign changed run semantics**
  (the loop's stale references drive tool execution, context, and retry
  classification). Fixed: the loop consumes the replacement.
- **Reviewer A: replace-only exit by cardinality**; decoder teardown
  deletes (re-seeds) rather than tombstones; adopt rows emit.
- **Reviewer B: invariant 2 / round-trip property 1 were unsatisfiable**
  (silent meta folds and signatures break exactness at intermediate seqs).
  Fixed: scoped to content/args modulo meta+signatures, which sync on full
  frames.
- **Reviewer B: shared rule module re-specified** as the filter's full
  recursive `sanitizeValue` minus frame classification (omission fields,
  duplicate-key uniquing, `diagnostics[].details`); violation diagnostics
  must not embed raw fragment content.
- **Reviewer B: contract-note corrections** — `toolcall_end` identity is
  best-effort; open-block text/tool signatures land at `*_end` only (abort
  narrows, documented); pre-seeded args are a synthetic first delta; the
  `partialJson` bridge writes pre-freeze.
- **Both (minor): viewer feed** — unsubscribe gaps are `discontinuity` too,
  and undelivered events must not advance the projector.
- **Reviewer A (note): phase 2 may not actually break volt-app** — the wire
  plausibly stays decodable until phase 3; verify instead of assuming.

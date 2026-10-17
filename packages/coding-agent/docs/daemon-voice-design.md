# Daemon-owned voice

Status: milestones 1 to 3 and the TUI half of milestone 4 landed,
2026-10-16; app audio (volt-app) open.
Development-facing; not a supported feature or a wire contract. This replaces
the extension/browser prototype direction.

## Decision

Build voice as a capability of a daemon-hosted **conversation**, independent
of its clients. Its conversation worker owns the voice provider connection
and the bridge to the existing Volt agent. The daemon authorizes and routes
media, but neither runs the agent nor accesses an audio device.

A future TUI or app captures the microphone and plays received audio. Neither
owns subscription credentials, provider signaling, task state, or tool
execution. A headless fixture client can exercise exactly the same service
before either user interface exists.

Enabling voice enables automatic speech-to-agent dispatch. There is no
per-task submit button, editable-transcript gate, or separate auto-submit
setting. Existing tool restrictions, approvals, Build/Plan mode, and model
selection remain authoritative.

## Evidence and unresolved gates

The initial subscription probe established:

- Volt's existing Pro OAuth could authenticate an isolated Codex app-server
  (`codex-cli 0.161.0`) without a new login or API key.
- A `gpt-live-1-codex` V3 WebRTC session accepted prerecorded speech and
  returned both a transcript and non-silent spoken audio. The complete
  expected phrase, not connection success or a nearly silent track, was
  required for success. Saved Volt auth was unchanged.
- Chromium supplied the WebRTC endpoint. This did **not** establish native,
  browser-free media support, delegation into Volt, cross-model execution,
  entitlement for other subscriptions, or startup reliability.

Volt currently has no native audio/WebRTC engine. Iroh provides a usable
transport primitive, not an implemented voice feature: the installed native
wrapper exposes bidirectional byte streams, while current admitted stream
modes and worker consumers are JSONL protocols. Native throughput, audio
latency, and datagram behavior have not been measured.

Public GPT-Live documentation and the tested Codex V3 protocol have different
event names and payloads. For example, Codex parses `input_transcript.added`
from `item.text` and a completed user transcript from
`turn.done { turn: { role: "user", transcript } }`. Public documentation uses
`session.input_transcript.delta` and `session.delegation.created`; its
delegation event does not itself contain task text. Do not combine these
contracts or assume public API billing/access rules apply to subscription
access.

**Implementation gate:** prove a native, daemon-side subscription session,
completed-user-turn dispatch, assistant-text injection, interruption, and
cleanup before building product/client integrations. A primary subscription
WebSocket is not an assumed alternative to the proven WebRTC path.

**Gate result, 2026-10-16:** passed natively by the repo-only spike in
[`scripts/voice-spike`](../../../scripts/voice-spike/README.md)
(Node v22.23.3, `werift` 0.25.0 for ICE/DTLS/SRTP/RTP in TypeScript,
`opusscript` 0.1.1 for Opus in WASM; no native build, no lifecycle scripts).
With Volt's saved `openai-codex` OAuth and no browser or Codex CLI, it
created a `gpt-live-1-codex` V3 call through
`chatgpt.com/backend-api/codex/realtime/calls` (HTTP 201, `rtc_` call id,
ICE/DTLS up in about 350 ms), joined the `api.openai.com/v1/live/{callId}`
sideband, received the complete expected phrase as one `turn.done{user}`
about 1.7 s after the end of speech, received non-silent spoken replies,
heard a `speakable` `session.context.append` spoken verbatim about 0.7 s
after its 75 ms acknowledgement, closed in about 2 s with a natural process
exit, and left `auth.json` unchanged. Findings that bind the design:

- The V3 sideband has no cancel operation. Speech over provider speech is
  transcribed completely and `turn.created{role: user}` marks its onset,
  but whether the provider stops its own speech afterwards varied run to
  run. Barge-in is therefore a client-side playback-epoch drop keyed on the
  onset; provider speech stopping is at the model's discretion.
- `speakable` appends were spoken verbatim every run; `commentary` appends
  were voiced in one run of five (paraphrased) and silent otherwise.
- The sideband mirrors the caller's own input audio back as base64
  `session.input_audio.append` events (about 60 KB/s). The adapter must
  discard them and the media budget must include them.
- `session.usage.updated{usage{audio_duration_ms, backend_model_usage},
  usage_limit{status, reset_seconds}}` exists; cumulative-vs-delta semantics
  are still unverified.
- The delegation path was not exercised: a non-request utterance is answered
  conversationally. It needs a recorded request-like utterance; the spike's
  correlated-injection step runs whenever `delegation.created` arrives.
- The same `codex` tag ships a private `codex-voice-host` helper (private
  pipe IPC with length-prefixed frames, `webrtc` 0.20.3, 20 ms Opus,
  epoch-invalidated playback queues) that is structurally the worker-owned
  helper this design proposes; it is not enabled in the Codex TUI.

## Ownership

```text
future app / TUI / headless fixture client
  microphone capture, echo cancellation, playback, device permissions
          | control: ordinary Volt protocol
          | media: separate authenticated binary stream
          v
voltd
  authenticated identity, workspace/session admission, media routing,
  revocation, resource budgets, worker supervision
          |
          v
conversation worker
  HostedConversation
    VoiceSession: lifecycle, media lease, transcripts, usage
      VoiceProvider adapter <-> provider signaling + WebRTC/media engine
      Agent bridge          <-> existing prompt admission + AgentSession
                                       |
                                       v
                          selected /model + existing tools
```

- Attach one `VoiceSession` to one top-level `HostedConversation`, not to a
  terminal, extension runtime, worker-global singleton, or subagent. Workers
  can host several conversations; their audio and provider state must not mix.
- The supervisor routes opaque media to the hosting worker. It does not load
  extensions, resolve voice prompts, or hold a second agent runtime.
- Keep provider-specific signaling and event parsing behind the voice
  adapter. It normalizes audio, completed utterances, delegation metadata,
  spoken transcripts, usage snapshots, and failures. Clients see none of the
  provider protocol, call IDs, SDP, account identity, or credentials.
- A worker-owned native helper is the preferred isolation boundary if an
  engine is needed: bounded private IPC, a minimal environment, explicit
  lifetime, and no direct tool authority. This is failure/dependency isolation,
  not a sandbox. Engine/library selection requires a separate feasibility,
  licensing, platform, packaging, and dependency decision.
- The existing Codex app-server can remain a reference implementation during
  the spike, with isolated state and no agent/tool turns. Neither an installed
  Codex CLI nor Chromium becomes a permanent architectural requirement.

## Automatic agent bridge

### Input

1. The active media owner supplies microphone frames. Transcript fragments
   update a bounded ephemeral voice transcript; they do not start work.
2. A completed **user** turn produces one host-assigned utterance identity
   within the current voice epoch. Its final transcript is automatically
   admitted as ordinary user input to the bound conversation.
3. Use normal input admission, durable `clientMessageId` receipts, extension
   input hooks, branch fences, and prompt execution. Treat recognized speech
   as literal user text, not an executable shell/slash command or prompt
   template. Implement that literal-input policy at the existing admission
   seam rather than copying the agent loop or bypassing remote policy.
4. While a run is active, deliver new utterances through normal steering at
   the existing safe boundaries. This does not automatically abort tool calls
   or create a parallel agent. Structural operations retain their existing
   admission rules; rejected speech is reported, not silently retried later.
5. Let the current session choose its execution model and tools. Voice does
   not override `/model`, thinking, Fast mode, tool grants, or Build/Plan mode.

The first implementation uses completed user turns as the dispatch source.
Provider delegation notifications may associate subsequent results with a
provider request, but never independently submit the same utterance. Do not
send both a final transcript and its delegation summary as two prompts.
There is no timer-based guess that a partial transcript has finished.

Keep a mapping of voice epoch, utterance identity, canonical input receipt,
conversation generation, and any **verified** provider delegation association.
Deduplicate event identity, not text: saying the same words twice is two
requests. Never match a delegation to an utterance by fuzzy text, an arbitrary
last event, or an unverified timestamp convention. If a provider lacks a safe
association, use its verified session-level speech injection path; otherwise
report the unsupported operation. Establish this behavior in the spike.

The live frontend handles listening, turn-taking, and spoken delivery; it has
no independent Volt tools or managed Responses backend. Prompt it to defer
substantive task answers to Volt. Its natural-language output is not an
authoritative task record, and provider compliance is not an execution guard.

### Output and settlement

- Observe committed assistant messages for the current conversation/generation.
  Forward completed assistant **text** blocks, including useful commentary
  between tool rounds and final answers. Do not forward streaming text,
  thinking blocks, signatures, tool calls, arguments, raw tool results,
  private review output, or arbitrary work notices.
- Deduplicate by canonical entry/block identity within the voice epoch, not
  message text or provider response IDs. Do not rescan and speak historical
  messages each time a client attaches.
- Use the existing transcript/profile projection for the media owner's
  authorized view **before** sending text for synthesis. A remote owner must
  not hear unredacted workspace paths or host-only messages that its ordinary
  transcript could not show. Do not attempt to redact already encoded audio.
- Attach results to a verified provider delegation when available; otherwise
  use verified session-level injection. Provider event names, append channels,
  acknowledgements, and chunk limits remain adapter-specific. In Codex V3,
  `speakable` and `commentary` are distinct channels; the names must not be
  mapped to public GPT-Live names by analogy.
- Finish the logical task on `agent_settled`, not `agent_end` or `turn_end`.
  `agent_end` can precede automatic retries, compaction, and queued-message
  continuations. Already completed commentary may be spoken while work runs;
  failed/aborted partial assistant messages are not successful replies.
- Settlement alone carries no request/result identity. Track admitted inputs
  and committed messages explicitly; concurrent typed input and steering must
  not cause an unrelated settlement to complete an arbitrary delegation.
- A settled foreground operation does not mean detached jobs or reviews have
  completed. Those remain ordinary Volt work; only later user-visible
  assistant messages are eligible for speech, not their raw completion data.
- Maintain a serial, bounded speech queue independent of agent execution.
  Provider injection or a slow listener must never delay tools or commits.
  If speech cannot keep up, stop voice with a clear error rather than silently
  dropping assistant text or replaying a long backlog after reconnect.

Live may paraphrase appended text. The canonical answer is Volt's assistant
message; the actual spoken transcript is separately labeled. Injection
acknowledgement, generated audio, received audio, and completed client playback
are different milestones. Do not report that a user heard a reply merely
because the provider accepted text.

### Interruptions and approvals

Barge-in stops local playback immediately and advances a playback epoch.
The worker drops stale queued/output audio and interrupts provider speech
where supported. That stops **speech**, not backend work. New completed speech
steers the existing run; explicit task cancellation uses the existing
authorized `abort`/work controls. Never claim a task was cancelled solely
because audio stopped.

Voice activation is not approval of every future action. Pending tool
approvals, Plan execution, MCP authorization, and host dialogs keep their
existing permission and request-ID checks. A spoken "yes" is ordinary input,
not a response to an arbitrary pending approval. Initially a request needing
such a response waits for an authorized ordinary client; voice-only approval
needs its own explicit design, not inference by the Live model.

## Control and media planes

Control remains in the normal conversation protocol. Proposed operations are
`voice_start`, `voice_stop`, and `voice_interrupt`; proposed live state is
`voice` (availability, lifecycle, current owner, safe error, and usage
availability). These names are design placeholders, not existing intents.
A client may stop voice without cancelling the agent. Start is branch-fenced
and idempotent by intent identity; stop and speech interruption target the
exact voice epoch. A late stop must not close its replacement.

Availability reports missing native media support, unavailable auth, provider
access denial, and unavailable remote transport distinctly. It does not open
a billed provider session just to populate a catalog.

### Media attachment

Use a separate bidirectional binary stream for duplex audio. Prefer Iroh for
paired devices, reusing the authenticated endpoint and opaque daemon-to-worker
relay. Local clients use the existing authenticated local control/relay
mechanism with a distinct media preamble. Never base64 audio into conversation
entries, the JSONL live lane, intent queues, or audit logs.

Media attachment requires an already-authorized conversation control
attachment and a short-lived, single-use media offer. Bind it server-side to
the authoritative client identity, control attachment, grant revision,
workspace generation, conversation identity/generation, hosting worker,
voice epoch, and negotiated format. An opaque media identifier is not a
bearer grant. Consume offers atomically and bound pending offers.

Iroh needs a **new stream purpose**, not another ordinary `conversation`
hello: the latter currently rejects a duplicate device/conversation stream
on the same connection. Admit the new purpose explicitly, preserve bytes
following its handshake, and route to a worker media consumer rather than
the existing JSONL server. Keep conversation-duplicate protection intact.

The native wrapper exposes datagrams, but Volt's daemon-facing abstraction
currently uses `acceptBi`. Start with independent reliable streams and measure
congestion latency; do not assume datagrams, uni streams, stream priority, or
a generic relay guarantee realtime behavior. Add a different media transport
only when measurements justify it, behind the same session/media boundary.

### Initial framing and bounds

The headless/local baseline is PCM signed 16-bit little-endian, 24 kHz mono,
20 ms per audio frame: 960 payload bytes, about 48 KB/s per direction. This is
an application boundary, not an assertion about negotiated WebRTC RTP formats;
the native engine resamples/encodes as required. Evaluate Opus for remote
mobile use before calling it production-ready. Codec choice is not exposed
to the agent bridge.

Specify a length-prefixed binary envelope with kind, media/playback epoch,
sequence, and sample offset, followed by payload. The attachment fixes its
format. Validate length before allocation; reject unknown kinds, invalid
sequences, wrong epochs, malformed sample counts, and format changes.

Initial engineering budgets, to be verified rather than treated as measured:

- One media owner and one provider session per conversation; four active
  voice sessions per daemon for the initial pilot.
- A 4 KiB hard envelope limit and format-derived byte/frame-rate limits.
- At most 200 ms of application-queued audio per direction. Separately bound
  every socket/native/provider queue; the current relay's 1 MiB unread
  threshold is not a whole-pipeline audio memory or latency guarantee.
- Detect a stalled input stream and fail voice rather than dispatch a
  transcript from silently truncated speech. Never replay stale microphone
  buffers on reconnect. Stale playback is discarded by epoch.
- Bound the pending speech queue to 32 completed blocks and 32 KiB of UTF-8
  text, and the ephemeral transcript to 256 segments and 64 KiB per session.
  Overflow stops voice visibly; it must not silently cut a user request or
  pretend an omitted answer was spoken.
- Per-device and daemon-wide budgets include pending handshakes, helper
  processes, transcript windows, speech text, and cleanup tasks. Reject new
  sessions when capacity is exhausted; do not evict unrelated conversations.

Authorization is not a per-20-ms disk read. The daemon owns an authoritative
revocable media lease, invalidated on control detach, grant changes,
revocation, workspace removal, worker replacement, or conversation/generation
change. Both pumps and worker admission fence on that lease before consuming
or writing another frame, and after awaited operations. Revalidate persisted
authority for control effects and renewals. Existing RPC per-frame checks do
not automatically protect an opaque media pump.

## Authority and privacy

Add an explicit remote voice capability (proposed `voice.stream.v1`) alongside
existing conversation observation/control requirements. No current grant
contains it. Existing paired devices do not silently acquire microphone/media
access when Volt upgrades; access requires an explicit host grant update.
Device permission and deliberate client activation remain necessary even for
a broadly privileged pairing. Retain existing tool-policy asymmetry: voice
uses the tools of the conversation it joins, not a new or wider grant.

An authenticated microphone is not speaker authentication. Anyone audible to
it, including background speech or playback, may supply a prompt with that
conversation's tool authority. Disclose this with automatic dispatch; require
client echo cancellation and visible mute/stop controls. This design does not
promise voice biometrics or safety for unattended sensitive work.

Only the media owner receives generated audio; transcript-only observers do
not become listeners. A competing start returns an owner-conflict state.
Transfer requires explicit authorization, invalidates the old lease, clears
old buffers, and creates a fresh provider session/epoch with the new owner's
projection. It must not leak the previous owner's retained provider context.

Resolve `openai-codex` auth on the host through Volt's auth machinery. Voice
consumes valid in-memory credentials; it does not write auth files or run a
second refresh/login loop. A helper receives only the token material needed
for its call through private IPC, never arguments, environment variables,
project files, client frames, or logs. The initial spike must preserve saved
auth and fail if renewal would be required.

Enabling voice must disclose that microphone audio and the selected assistant
text go to the **voice provider**, even when `/model` uses a different provider.
Do not send full history, tools, raw workspace content, or private reasoning
as automatic startup context. Restore only bounded, owner-visible conversation
context when explicitly starting a replacement session.

Persist normal finalized user messages and Volt assistant replies once, using
the existing conversation store. Keep raw audio, partial transcripts, Live
spoken paraphrases, provider payloads, media credentials, and signaling
in-memory and bounded by default. Spoken transcripts are ephemeral labeled
voice state, not duplicate canonical assistant messages. Any future recording
or transcript-only conversation feature needs a separate retention policy.

Audit lifecycle and safe failure codes only. Diagnostics may include opaque
IDs, durations, queue sizes, frame counts, and usage availability, never tokens,
auth headers, SDP, transcripts, audio, or provider error payloads.

## Lifecycle and accounting

Use separate state axes rather than one misleading "busy" flag:

- Lifecycle: `off -> starting -> active -> stopping -> off`, with a safe error
  retained when startup or an active session fails.
- Input: muted/listening; output: idle/speaking; backend phase: the existing
  conversation phase. Listening and backend execution may coexist.

Starting waits for the media attachment before opening the provider call.
There is no indefinitely billed/listening session without a media owner.
A valid media attachment counts as an attached client for retention, even if
its text UI is hidden. It must be scoped to the existing worker/conversation
lifetime; an unresolved teardown promise must not deadlock conversation close.
Any registry-semantics changes update the WorkerRegistry TLA+ model first.

| Event | Voice behavior | Agent behavior |
| --- | --- | --- |
| Text UI hidden/detached, valid control/media client remains | Continue | Continue |
| Media or owning control connection lost | Fence input/output immediately; close provider after bounded cleanup | Already admitted work continues under normal detach semantics |
| Voice stopped | Retire epoch, discard buffers, join bounded teardown | Do not cancel the task |
| Branch/generation changes or owner moves conversations | Stop; no implicit retarget | Existing session-change rules |
| Owner grant/revocation/workspace authority lost | Fence media immediately; close call and offers | Preserve existing authority-loss behavior, including immediate worker/run cancellation where required |
| Provider/helper fails | Stop voice with a safe reason; preserve text operation | Do not repeat submitted work |
| Worker exits or daemon stops | Close media/provider/helper; no automatic recording restart | Existing crash/shutdown rules |

On reconnect, create a new media/provider epoch. Replay neither old microphone
audio nor stale spoken replies, and never reconstruct a second task from a
transcript tail. Already accepted inputs use the existing durable receipt and
ambiguous-dispatch recovery rules. This is at-most-once admission within those
rules, **not** an exactly-once guarantee for external tool side effects.

Track voice usage separately from selected-model token usage. Public Live
seconds snapshots are cumulative, not deltas to add repeatedly; use the
adapter's verified semantics. A close may not yield final usage, so report
partial/unavailable rather than zero. Do not convert seconds into subscription
quota or a price without provider evidence, or promise a "free" voice session.
Muting microphone input or stopping playback does not close the provider
session or establish that billing stopped. Provider/helper teardown must be
observed and bounded, including after a client is lost.

## Delivery sequence and acceptance

1. **Native feasibility spike, no UI or protocol expansion.** Use an isolated
   headless media engine and prerecorded synthetic/public speech with the
   already-authorized subscription path. Prove a complete user-turn event,
   non-silent return audio, standalone/correlated assistant-text injection,
   interruption, and process/network cleanup. Record versions and safe
   metrics, not credentials or speech payloads. Confirm platform/license and
   distribution costs before choosing or adding a dependency. If native
   subscription access fails, stop here; do not silently switch to API billing.
2. **Worker service and local fixture client.** Implement the lifecycle,
   literal automatic prompt bridge, scoped projection, speech queue, native
   adapter, and authenticated local media attachment. Keep disabled by default.
   Exercise the real daemon/worker with a faux text provider and fake voice
   adapter before an explicitly authorized provider smoke test. No microphone,
   browser, TUI UI, or mobile app is needed for this milestone.

   **Landed, 2026-10-16.** `packages/coding-agent/src/core/voice/` holds the
   provider adapter boundary (`provider.ts`), the media envelope codec, the
   bounded speech queue and transcript window, `VoiceSession` (lifecycle,
   epochs, media lease, input and output bridges), and `VoiceService` (one
   session per hosted conversation, gated by the `voice` setting:
   `{ enabled, provider }`, off by default). The intents are `voice_start`,
   `voice_stop`, and `voice_interrupt`; the live value is `voice`; a local
   media attachment is `voice_media_open` on the TUI's control connection,
   answered with a relay whose `media` preamble the worker hands to the
   session, admitted only against the pending offer of the same client key.
   The `openai-codex` adapter (`codex-live/`) reproduces the spike's
   signaling over `werift`/`opusscript`, which ship as optional dependencies
   behind `src/remote/voice-native-adapter.cjs`. Spoken turns reach
   extensions' `input` hooks with `source: "voice"` and are admitted with
   `expandPromptTemplates: false`, within the owner's client scope.
   Fixtures: `test/suite/voice-session.test.ts` (bridge, bounds, media),
   `test/daemon-voice.test.ts` (real daemon and worker with the fake
   adapter), and the opt-in `test/daemon-voice-smoke.test.ts` (real
   provider; `VOLT_VOICE_SMOKE_WAV`, `VOLT_VOICE_SMOKE_EXPECT`).
   Deliberate limits of this milestone: the per-host session budget is per
   worker, not daemon-wide; the engine runs in the worker process rather
   than a helper; the ephemeral transcript is kept but not yet projected to
   clients as captions; the codex adapter's `interrupt` is a no-op (V3 has
   no cancel), so barge-in is the playback-epoch drop; a delegation is
   correlated only when the provider names its turn, which no run has shown
   yet, so replies go through session-level `speakable` injection.
3. **Iroh media routing and authorization.** Add the explicit stream purpose,
   voice grant, binary consumer, budgets, ownership/retention, and revocation
   fences. Test native loopback and network-loss/congestion behavior. Change
   protocol schemas/contracts in place; do not add old-client fallback wire
   formats. Coordinate dependent client changes with a `volt-app` issue when
   implementation reaches that boundary, not a compatibility branch.

   **Landed, 2026-10-16.** The capability is `voice.stream.v1`: the voice
   intents require it with conversation control and are remote-safe, only
   the `full` preset includes it, and stored grants are explicit lists, so
   an existing pairing gains it only through an access update. The Iroh
   stream mode is `voiceMedia: {sessionId, offerId}` (never a pairing
   secret), with the handshake outcome `voice_media_unavailable`. The daemon
   (`runVoiceMediaStream` in `iroh-service.ts`) admits it only on the
   connection of the device's live conversation stream of that session, to
   the worker serving that stream, with the grant revision that stream was
   admitted with, one per conversation stream, and mints a `media` relay
   bound to the stream's key (`irohVoiceClientKey`). Registered beside the
   phone relays, it inherits their fences (revocation, access update,
   workspace removal, worker exit, and the 2 s authority close); it also
   ends with its conversation stream and counts as the device attached for
   retention. The worker admits it against the pending offer and writes
   the handshake answer in the same turn the offer is consumed, then hands
   the bytes after the hello to the session. A remote owner hears assistant
   text through its own stream's projection, so synthesis carries the same
   path redaction as its transcript. `VoiceMediaBudget` (four by default,
   `voiceMediaSessions` in the daemon config) bounds the media attachments
   of TUIs and devices together, and with them the billed provider sessions
   of the daemon: the per-worker limit of milestone 2 is now daemon-wide.
   The wire contract is in [the Iroh protocol](iroh-remote-protocol.md#voice).

   Fixtures: `test/daemon-voice-iroh.test.ts` over native Iroh loopback
   (relay disabled): the full path with redacted synthesis, the capability
   and its grant update, the binding (another connection, another device, a
   wrong or replayed offer, a second media stream), revocation, connection
   loss, a device that stops reading (voice ends `slow_reader` while the
   conversation stream on the same connection still answers), and the
   shared budget. Measured on that loopback, with the daemon, an in-process
   worker, and the device in one process, 250 frames each way at 20 ms
   concurrently: uplink p50 0.34 ms, p95 0.56 ms, max 1.6 ms; downlink p50
   0.30 ms, p95 0.46 ms, max 1.25 ms. Independent reliable streams are
   therefore kept; loss, jitter, and congestion on real mobile networks are
   unmeasured and belong to the client milestone, behind the same
   session/media boundary.
4. **Client integrations.** Add TUI capture/playback and app audio independently.
   Both use the same control/media contract, local device permission, visible
   listening state, echo cancellation, interruption, and reconnect policy.
   Native capture, OS audio-session behavior, Bluetooth, mobile suspension,
   and acoustic echo handling are client work, not daemon responsibilities.

   **TUI landed, 2026-10-16.** No audio dependency: an installed tool in a
   child process captures and plays raw PCM in the media format
   (`src/client/voice/audio-tools.ts`): PulseAudio's `parec`/`pacat` (also
   served by PipeWire), SoX, or ALSA's `arecord`/`aplay`, picked by
   `voice.audio` (`auto` tries them in that order on Linux; elsewhere it
   needs SoX). A tool that exits on its own ends voice with what it printed.
   `VoiceClient` (`src/client/voice/voice-client.ts`) is the client half of
   the contract: `voice_start`, the media attachment through the connector
   (`openVoiceMedia`, the daemon's `voice_media_open` with the TUI
   process's client key), envelopes up and down, and one end per start
   with its reason: stopped here, a local audio failure (which also stops
   the host's epoch), the host's `voice` value ending the epoch, the media
   stream ending, or the TUI leaving the conversation. Nothing restarts
   it. Mute stops the capture process, so the OS microphone indicator goes
   off, and the host hears `unmute` with the new capture's first frame, so
   a microphone that is slow to open (a Bluetooth profile switch) does not
   read as stalled input. Microphone frames beyond real time plus 100 ms,
   half the host's allowance, are dropped as stale. Interruption kills the
   playback tool at once and discards audio of the interrupted playback
   epoch until the host announces the next one. The tools cancel no echo,
   so `voice.duplex` defaults to `half`: the client sends silence instead of
   the microphone while its speaker plays and for 400 ms after, and
   barge-in is a key (`app.voice.interrupt`, `alt+s`). `full` is for
   headphones or OS echo cancellation, such as PipeWire's or PulseAudio's
   `module-echo-cancel` as the default source. The TUI (`voice-control.ts`)
   adds `/voice [on|off|mute|unmute]`, `app.voice.toggle`/`mute`/`interrupt`,
   the disclosure on every start, the footer state (listening, muted,
   speaking, or another client's voice), and the availability reasons.

   Fixtures: `test/daemon-voice-tui.test.ts` runs the TUI's connector,
   store, and voice against the real daemon and an in-process worker with
   stand-in audio: both directions, the half-duplex gate, interruption with
   a stale frame in flight, mute and the deferred unmute, a capture burst,
   each way voice ends, another client's voice, and the refusals.
   `test/voice-audio-tools.test.ts` covers tool lookup and the spawned
   processes with stand-in tools. Checked by hand against a real
   PulseAudio 16.1 server with a null sink: a 440 Hz tone played through
   `pacat` came back through `parec` at 435 Hz, capture started in about
   20 ms and ran at exactly real time (bursts of at most two frames), a
   flush was silent within one frame, and playback restarted about 40 ms
   later. Not verified here: SoX and ALSA against devices (their command
   lines only parse), macOS and Windows, and a real microphone and
   speaker with the real provider. App audio waits for a `volt-app` issue
   once this branch merges.

Required fixture scenarios before calling the worker service complete:

- Two speech turns, including identical words twice, produce two canonical
  user inputs; duplicate events and a delegation notification produce no
  duplicate prompts. Partial or output transcripts start no work.
- The selected non-voice model executes an allowed fixture tool and its
  completed commentary/final text reaches voice; thinking, tool data, private
  messages, and raw signatures do not. No hidden managed provider agent runs.
- Steering, simultaneous typed input, retry/compaction continuations, errors,
  and detached jobs preserve correct input/message/settlement association.
- Speech containing a slash command remains literal; a spoken "yes" cannot
  approve a host request. Plan mode and denied tools remain denied.
- Remote synthesis receives the same permitted text projection as the owner;
  another device cannot listen, steal/replay an offer, attach to a sibling
  conversation, or use a stale worker/generation/epoch.
- Revocation/detach during every awaited attach/write/dispatch boundary fences
  effects; stop/start races and worker shutdown join cleanup without hanging.
- Oversized, malformed, too-fast, stalled, and slow-reader media stay bounded
  without blocking conversation control or submitting corrupted partial
  speech. Barge-in discards old audio without falsely cancelling tools.
- Synthetic credentials never reach clients, arguments, environment, logs,
  errors, or persisted media state; initial auth files remain unchanged.
- Cumulative usage replaces snapshots; missing close usage remains partial.

Use the existing daemon harness, faux provider, and fake media/provider
adapters for automated tests. Real-provider/audio smoke tests are opt-in and
separate from CI. Successful signaling or transcript text alone is not voice
verification: require non-silent returned samples and the expected complete
spoken transcript. File playback demonstrates the daemon service; microphone
capture/playback requires a later real client test.

## Source map

Current repository seams:

- [Daemon ownership and lifecycle](daemon.md) and
  [security boundaries](security.md).
- [HostedConversation](../src/core/host/hosted-conversation.ts),
  [worker host](../src/daemon/worker/host.ts), and
  [worker conversation groups](../src/daemon/worker/hosted.ts).
- [Input/intent admission](../src/core/protocol/intents/conversation.ts),
  [prompt preprocessing](../src/core/session/prompting.ts), and
  [session settlement](../src/core/session/events.ts).
- [Current Iroh wire contract](iroh-remote-protocol.md),
  [handshake schemas](../../protocol/src/remote-handshake.ts),
  [capability grants](../../protocol/src/remote-access.ts),
  [native daemon surface](../src/daemon/iroh-native.ts), and
  [opaque relay pumps](../src/daemon/relay-stream.ts).
- [Daemon/faux-provider test guidance](development.md#daemon-and-conversation-workers).

Provider references (source/API evidence, not a subscription access guarantee):

- [Codex V3 event parser, rust-v0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi.rs).
- [Codex V3 context append/session configuration, rust-v0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs).
- [Codex transport selection and speech injection, rust-v0.161.0](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core/src/realtime_conversation.rs).
- [Public Live delegation and context ownership](https://developers.openai.com/api/docs/guides/live-delegation).

# Daemon-voice native feasibility spike

Repo-only tooling for milestone 1 of
[`daemon-voice-design.md`](../../packages/coding-agent/docs/daemon-voice-design.md).
It is not a workspace package, is never shipped, and adds nothing to any
`@hansjm10/*` package. Its dependencies live only in this directory.

## What it proves

Without a browser or the Codex CLI, one Node process using Volt's saved
`openai-codex` OAuth:

1. creates a `gpt-live-1-codex` V3 WebRTC call and connects natively
   (ICE/DTLS/SRTP/Opus via `werift` + `opusscript`),
2. joins the call's sideband WebSocket,
3. streams a prerecorded utterance and receives a completed user turn whose
   transcript carries the complete expected phrase,
4. receives non-silent spoken audio back,
5. injects assistant text on the `speakable` channel and hears it spoken
   (and, when the provider delegates, on the delegation item),
6. speaks over provider speech and observes the onset signal a client would
   key its playback-epoch drop on,
7. closes the session, socket, and peer, and exits with no lingering handles,
8. leaves `auth.json` byte-for-byte unchanged (it never refreshes a token).

The report records versions, durations, counts, loudness, and booleans. It
never records credentials, headers, SDP, audio, or transcript text.
`--show-transcripts` prints transcripts to stderr for the operator only.

## Run

```bash
cd scripts/voice-spike
npm install --ignore-scripts          # werift + opusscript, no lifecycle scripts
../../node_modules/.bin/tsc -p tsconfig.json   # optional typecheck

# Local loopback (no provider): two engines in one process, WAV in, loudness out.
node --conditions=volt-source src/selftest.ts --wav /path/to/speech.wav

# The gate. Uses the saved openai-codex credential; a billed Live session.
node --conditions=volt-source src/spike.ts \
  --wav /path/to/speech.wav --expect "the words in the clip" [--wav-end-ms 3400] \
  [--wav2 /path/to/other.wav --expect2 "its words"] \
  --report /tmp/voice-spike-report.json [--show-transcripts] [--skip-interrupt]
```

`--wav` must be 16-bit PCM WAV (any rate/channels; resampled to 24 kHz mono).
`--wav2` is the barge-in utterance (defaults to the first clip). Use a clip of
continuous speech: a clip with pauses between words is split into one user
turn per word by the provider's turn detection.

Clips used for the recorded runs (not committed; download at run time):
the first Harvard sentence of the Open Speech Repository's
`OSR_us_000_0010_8k.wav` (`--wav-end-ms 3400`, expect
"the birch canoe slid on the smooth planks").

Exit code 0 means every gate check passed; 1 means a check failed (see
`outcome.failedChecks`); 3 means the process did not exit within 5 s of
cleanup (see `cleanup.activeResources`).

## Signaling reproduced (codex rust-v0.161.0)

- `POST https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`,
  JSON `{sdp, session}`, headers `Authorization: Bearer`, `chatgpt-account-id`,
  `originator`, `openai-alpha: quicksilver=v2`, `x-session-id`, `session-id`,
  `thread-id`. Response `201`, body = SDP answer, `Location` carries the
  `rtc_…` call id. Session JSON: `model`, `instructions`,
  `audio.output.voice` (default `cove`), `delegation.type: "client"`.
- Sideband `wss://api.openai.com/v1/live/{callId}` with the same headers.
- Outbound: `session.context.append {channel, content:[{type:"input_text",text}]}`
  chunked at 500 bytes, `delegation.context.append {delegation_item_id, …}`,
  `session.close`.
- Inbound handled by Codex: `session.started|updated`, `input_transcript.added
  {item.text}`, `output_transcript.added {item.text}`, `turn.done {turn.role,
  turn.transcript}`, `delegation.created {item{id,type,target,content}}`, `error`.
- Inbound Codex ignores, observed here: `turn.created {turn{id,role,start_ms,
  end_ms,transcript}}` (a user one marks speech onset), `turn.delta {turn_id,
  delta,start_ms,end_ms}`, `session.context.appended {start_ms,end_ms}`
  (append acknowledgement), `session.usage.updated {usage{audio_duration_ms,
  backend_model_usage}, usage_limit{status,reset_seconds}}`, and
  `session.input_audio.append` carrying the caller's own input audio back as
  base64 (about 60 KB/s; an adapter must discard it, and budget for it).

## Findings from the recorded runs (2026-10-16, seven sessions, five complete)

Versions: Node v22.23.3, werift 0.25.0, opusscript 0.1.1, model
`gpt-live-1-codex`, voice `cove`.

| Measure | Observed |
| --- | --- |
| Call creation | HTTP 201 in 400–660 ms; `rtc_` call id |
| ICE/DTLS connected | 320–360 ms after answer; local host+srflx, remote host; Opus/48000/2 pt 111 |
| Sideband connect → `session.started` | 250–285 ms |
| User `turn.done` after end of speech | about 1.7 s (turn-detection silence) |
| Transcript of the expected phrase | complete, 8/8 tokens in order, every run |
| Spoken reply to the utterance | 53–134 non-silent 20 ms frames, peak −17 to −20 dBFS |
| `speakable` append → `session.context.appended` | 74–77 ms |
| `speakable` append → first audible audio | 640–810 ms; spoken verbatim, marker present every run |
| `commentary` append | voiced in 1 of 5 runs (paraphrased), silent otherwise: model-discretionary |
| Barge-in: user speech during provider speech | transcribed in full in 3 of 4 runs (7/8 tokens once, overlapped speech); `turn.created role=user` about 1.6 s after speech start (clip has 0.5 s lead-in) |
| Barge-in: provider speech stops server-side | 1 of 4 runs; otherwise the appended text keeps playing across the user turn. V3 has no cancel operation |
| Cleanup (`session.close`, WS 1000, peer close) | about 2.0 s; process exits naturally |
| `auth.json` | unchanged (size and mtime) every run |

Consequences for the design:

- Native, browser-free subscription access is established; the engine needs
  no native build (`werift` is TypeScript; `opusscript` is WASM). An
  `@discordjs/opus`-style native codec would need a lifecycle-script
  allowlist entry and prebuilds; not required for feasibility.
- Interruption must be a client-side playback-epoch drop keyed on the user
  turn onset; provider speech cancellation is not available and provider
  behaviour after a barge-in is at the model's discretion.
- `speakable` is the reliable injection channel; `commentary` is advisory.
- The delegation path (`delegation.created` → `delegation.context.append`)
  was not exercised: a non-request utterance is answered conversationally.
  Exercising it needs a recorded request-like utterance; the code path is in
  place (`inject_delegated` step) and runs whenever the provider delegates.
- Usage snapshots exist (`session.usage.updated`); their semantics
  (cumulative vs. delta) remain to be verified before the adapter reports
  them.

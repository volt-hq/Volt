---
"@hansjm10/volt-ai": minor
---

breaking(sdk): Assistant streams now deliver the deltas queued for one block as one event, so `seq` no longer increases by exactly one. ([#1067](https://github.com/volt-hq/Volt/issues/1067))

A consumer that reads more slowly than the provider produces receives consecutive `text_delta`, `thinking_delta`, or `toolcall_delta` events for one block combined into one event with the newest `seq`, `snapshot`, and `toolState`. Treat `seq` as strictly increasing rather than contiguous, and append each delta as it arrives instead of counting delta events. Start, end, `done`, and `error` events are delivered as before.

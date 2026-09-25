---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-agent-core": minor
---

breaking(extensions): Omit prepared context when tool policy changes before provider admission, without retrying validation. ([#433](https://github.com/volt-hq/Volt/issues/433))

Host turn policies now snapshot callbacks: replace mutation of a registered policy object with `registration.update(nextPolicy)`. After changing callback closure state, call `registration.invalidate()` synchronously. Extension `tool_call` and `tool_result` registrations return the same update/invalidate/removal handle; loaded handler lists are host-owned rather than mutable maps.

Custom Harness request-boundary callbacks must return `{ messages, authorization: { isCurrent, settle } }` instead of a message array. Both authorization callbacks are synchronous; `settle` reports final provider-handoff inclusion or omission, not provider success. Do not change authority or invoke extension code from these callbacks.

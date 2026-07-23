---
"@hansjm10/volt-coding-agent": minor
---

breaking(daemon): UI action invocations now require a correlation ID that the daemon echoes in every response.

Clients must add a unique, trimmed, non-empty `id` of at most 256 UTF-8 bytes to every `invoke_ui_action` command and correlate the result using the identical response `id`. Invocations without a usable id now receive an uncorrelated `command: "invalid"` failure instead of an id-less `invoke_ui_action` response.

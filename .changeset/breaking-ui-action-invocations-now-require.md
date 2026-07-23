---
"@hansjm10/volt-coding-agent": minor
---

breaking(daemon): UI action invocations now require a correlation ID that the daemon echoes in every response.

Clients must add a unique string `id` to every `invoke_ui_action` command and correlate the result using the identical response `id`.

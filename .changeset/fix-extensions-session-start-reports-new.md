---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

internal(extensions): `session_start` reports `new`, `resume`, or `fork` and the previous session again for the interactive TUI's session changes.

After `/clear`, `/resume`, `/fork`, `/clone`, or `/import`, the new session's extensions see the change's reason instead of `startup`, with `previousSessionRef` naming the session you left when it is stored in the same workspace. A session another terminal or a phone already has open starts nothing new as you join it. Startup, `-c`, and `-r` still report `startup`, and a phone's own session changes still start with `startup`.

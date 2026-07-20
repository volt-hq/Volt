---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed warm TUI lease handoffs leaving a conversation permanently unreachable from paired phones with "conversation owner changed; retry" until the TUI released the session. ([#81](https://github.com/volt-hq/Volt/issues/81))

After a warm daemon-to-TUI handoff the conversation authority kept its retired runtime lifecycle and rejected every subsequent phone relay attach. Relay attaches now succeed while the TUI owns the session, a daemon reservation racing relay closure reports the accurate transient reason, and rejected relay handshakes record the underlying error in the daemon audit log.

---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(sessions): A session can be open for writing in only one Volt process at a time; opening it again from another TUI, `volt -p`, `--mode rpc`, an SDK embedding, or a phone conversation is refused with a `conversation_locked` error that names the session.

To migrate, quit the session in the process that has it open, or switch that process to another session, then retry. Listing, searching, exporting, and forking from a session still work while it is open elsewhere. SDK code that opened the same session twice in one process must close the first `SessionManager` before calling `SessionManager.open` again, or read it with the new `SessionManager.openReadOnly`. RPC clients receive `errorCode: "conversation_locked"`, and phones receive the `conversation_locked` handshake outcome.

The TUI now takes the daemon's conversation lease before it opens a session the daemon may be hosting for a phone, printing a waiting line while the phone's turn finishes; the interrupt key (Escape by default) stops that turn and Ctrl+C cancels the open. A session whose saved state can no longer be confirmed now ends instead of reloading in place: the TUI exits with an error that suggests `/resume`, print and RPC runs exit with an error, and the daemon closes the conversation.

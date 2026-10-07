---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(sessions): A session can be open for writing in only one Volt process at a time; opening it from `volt -p`, `--mode json`, `--mode rpc`, or an SDK embedding while another process has it open is refused with a `conversation_locked` error that names the session.

To migrate, quit the session in the process that has it open, or switch that process to another session, then retry. Listing, searching, exporting, and forking from a session still work while it is open elsewhere. SDK code that opened the same session twice in one process must close the first `SessionManager` before calling `SessionManager.open` again, or read it with the new `SessionManager.openReadOnly`. Protocol clients get the intent rejected with reason `locked`, and phones receive the `conversation_locked` handshake outcome. Interactive Volt and phones attach to a session a conversation worker has open instead of opening it again.

A session whose saved state can no longer be confirmed now ends instead of reloading in place: the TUI exits with an error that suggests `/resume`, print and RPC runs exit with an error, and the conversation's worker closes it.

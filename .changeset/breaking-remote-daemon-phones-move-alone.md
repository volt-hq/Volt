---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(remote): A phone that starts a new session, forks, or switches now moves alone, and the other clients of its session stay on it. ([#585](https://github.com/volt-hq/Volt/issues/585))

The phone gets its intent's `accepted{conversation}`, then its stream ends with `ended{moved}` naming the new session. The new session is recorded as the phone's last session, so `target: "last"` lands there, and it opens in a conversation worker when the phone reconnects. The session left behind stays open for its other clients, or detached until retention closes it, and keeps running a turn in progress. Executing a plan in a new session from a phone now works: the plan's execution is queued in the new session and starts when the phone reconnects. A session id no longer stands for another session.

Migration: phone clients reconnect with `target: "session"` and the new session's id after `ended{moved}`. The handshake selection `session_rekeyed` and its `conversation.requestedSessionId`, and the `conversation_bootstrap` reason `session_rebind`, are removed; drop any handling of them. Restart a running daemon (`volt daemon restart`) after upgrading so it matches the TUI.

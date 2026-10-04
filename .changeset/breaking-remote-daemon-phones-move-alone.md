---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(remote): A phone on a daemon-hosted session that starts a new session, forks, or switches now moves alone, and other phones stay on their session. ([#585](https://github.com/volt-hq/Volt/issues/585))

The phone gets its command's response, then `remote_terminal` reason `conversation_moved` with `targetSessionId`, and its stream ends. The daemon opens the new session right away, with the tool set and worktree of the session the phone left, and records it as the phone's last session, so `target: "last"` lands there. The session left behind keeps running a turn in progress and closes once it is idle when no phone remains. Executing a plan in a new session from a phone, daemon-hosted or relayed through the desktop TUI, now works: the plan's execution is queued in the new session and starts when the phone reconnects. A session id no longer stands for another session.

Migration: phone clients reconnect with `target: "session"` and the frame's `targetSessionId` after `conversation_moved`. The handshake selection `session_rekeyed` and its `conversation.requestedSessionId`, and the `conversation_bootstrap` reason `session_rebind`, are removed; drop any handling of them. The daemon control protocol is now version 2: restart a running daemon (`volt daemon restart`) after upgrading so it matches the TUI.

---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(tui): The TUI's session commands (`/clear`, `/resume`, `/fork`, `/clone`, `/tree`, `/name`, `/session`, `/copy`, `/share`, `/export`, `/import`, `/compact`, `/reload`, `/worktree`, and `/quit`) go to its host as a client. ([#585](https://github.com/volt-hq/Volt/issues/585))

The `/resume` picker lists and searches sessions through the host and deletes only sessions of the current folder; it says so for a session of another folder in the All scope. A session resumed or imported whose folder is gone still asks to continue in the current one, and so does an extension command's `ctx.switchSession()`. Messages sent during `/compact` wait in the conversation's queue without waiting for the compaction to answer. `/reload` shows the errors the reloaded setup reports, such as a `models.json` the host could not read. A `/worktree` session is stored where the session it leaves is, and is bound to its worktree once the TUI moved to it.

Protocol clients: a `compact` intent runs in the same lane of its own as `bash`, so the intents and queries sent after it (input, `withdraw_queued`) no longer wait for the compaction. `sessions` items carry a local-only `sessionDir`. An extension command's `ctx.fork()` sends the invoking local client a `set_editor_text` directive with the text it forked before once the client shows the fork, and `ctx.navigateTree()` one with the message it navigated before when the client's editor is empty.

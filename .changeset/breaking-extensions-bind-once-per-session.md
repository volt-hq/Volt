---
"@hansjm10/volt-coding-agent": minor
---

breaking(extensions): A session's extensions now start once, however many clients attach: `session_start` fires once, a phone relayed through the desktop TUI no longer takes over `ctx.mode` or the TUI's dialogs, and every client receives extension errors. ([#585](https://github.com/volt-hq/Volt/issues/585))

The first client to attach a session binds its extensions and fixes `ctx.mode`. Further clients (a second RPC client, phones on a daemon-hosted conversation, a phone relayed through the TUI) attach without another `session_start`. Extension UI goes to the most recently attached client that shows UI, which receives the latest status, widget, and title values when it starts showing UI; a relayed phone, or a phone whose access cannot answer dialogs, shows no extension UI. Extension errors reach every client. `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, `ctx.navigateTree()`, `ctx.reload()`, `ctx.abort()`, and `ctx.shutdown()` act for the client whose request is running, or for the first attached client outside any client's request; calls for a client that has left do nothing.

Migration: extensions that counted on one `session_start` per connected RPC client or phone must track clients another way; keep `session_start` handlers idempotent per session. SDK hosts replace `await session.bindExtensions(bindings)` with `await session.attachExtensionClient({ id, mode, ui, commandContextActions, abortHandler, shutdownHandler, onError }).ready`; the returned `detach()` removes the client. Attach again to the new `runtime.session` after a replacement.

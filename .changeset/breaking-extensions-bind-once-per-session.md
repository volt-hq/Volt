---
"@hansjm10/volt-coding-agent": minor
---

breaking(extensions): A session's extensions now start once, however many clients attach: `session_start` fires once, and every attached client sees extension UI and errors. ([#585](https://github.com/volt-hq/Volt/issues/585))

The first client to attach a session binds its extensions and fixes `ctx.mode`. Further clients (a second RPC client, a second terminal, a phone) attach without another `session_start`. Dialogs, notifications, status, widgets, and the title go to every attached client that accepts them, and the first answer to a dialog wins. Extension errors reach every client. `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, `ctx.navigateTree()`, `ctx.reload()`, `ctx.abort()`, and `ctx.shutdown()` act for the client whose request is running, or for the oldest attached client outside any client's request; calls for a client that has left do nothing.

Migration: extensions that counted on one `session_start` per connected client must track clients another way; keep `session_start` handlers idempotent per session. SDK hosts replace `await session.bindExtensions(bindings)` with `await session.attachExtensionClient({ id, mode, remote, commandContextActions, abortHandler, shutdownHandler, onError }).ready`; the returned `detach()` removes the client.

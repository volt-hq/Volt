---
"@hansjm10/volt-coding-agent": patch
---

improvement(extensions): Extension command handlers now get a `ctx.signal` that aborts when the session loses conversation authority or is disposed, and pending extension dialogs settle when Volt tears down extension UI, with `ctx.ui.custom()` rejecting with `ExtensionUIDismissedError`. ([#525](https://github.com/volt-hq/Volt/issues/525))

---
"@hansjm10/volt-coding-agent": patch
---

internal(extensions): Run extension shutdown cleanup when replacing or closing a session after a revision conflict or uncertain write. ([#527](https://github.com/volt-hq/Volt/issues/527))

After conversation authority is lost, shutdown handlers can close resources they already own, including awaited process cleanup through `volt.exec` using `ctx.cwd`. Session and UI access stay revoked, including cached UI, model-registry, and credential-service methods, and cleanup access expires when each handler finishes. Captured event buses cannot emit or register listeners after revocation, and old listeners remain inert even when the host shares the bus with a replacement session. Unsubscribe callbacks remain usable for cleanup. Normal shutdown writes are unchanged while authority remains available.

---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Run extension shutdown cleanup when replacing or closing a session after a revision conflict or uncertain write. ([#527](https://github.com/volt-hq/Volt/issues/527))

After conversation authority is lost, shutdown handlers can close resources they already own, but the old extension API and contexts remain revoked. Normal shutdown writes are unchanged while authority remains available.

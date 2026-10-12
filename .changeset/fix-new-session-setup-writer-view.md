---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Changing an entry or header read through `writer.sessionManager` in a `ctx.newSession()` setup callback no longer changes the new session, and the view no longer exposes host-only session manager methods. ([#858](https://github.com/volt-hq/Volt/issues/858))

---
"@hansjm10/volt-coding-agent": patch
---

fix(update): `volt update` no longer breaks an npm installation while other volt processes, such as a daemon for another agent directory or an open session, have its native modules loaded. ([#555](https://github.com/volt-hq/Volt/issues/555))

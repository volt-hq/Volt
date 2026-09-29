---
"@hansjm10/volt-coding-agent": patch
---

fix(tui): Fixed volt exiting when a session's saved state could not be confirmed; it now reloads the session from the store and keeps unsent input in the editor. ([#525](https://github.com/volt-hq/Volt/issues/525))

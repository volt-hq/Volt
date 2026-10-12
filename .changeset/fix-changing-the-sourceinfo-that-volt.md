---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Changing the `sourceInfo` that `volt.getAllTools()` or `volt.getCommands()` returns no longer changes the session, so an extension tool that overrides a built-in can no longer pass as the trusted built-in. ([#789](https://github.com/volt-hq/Volt/issues/789))

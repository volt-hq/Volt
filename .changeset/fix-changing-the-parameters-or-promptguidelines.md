---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Changing the `parameters` or `promptGuidelines` that `volt.getAllTools()` returns no longer changes the schema the model is offered and tool arguments are validated against, or the system prompt, in that session or, for built-in tools, in any other session. ([#794](https://github.com/volt-hq/Volt/issues/794))

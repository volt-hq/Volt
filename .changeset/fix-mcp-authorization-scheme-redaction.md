---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP error and argument redaction of `Authorization: Bearer <token>` (and the `Basic` and `token` schemes), which hid the scheme but kept the token and wrote it to the MCP audit log. ([#884](https://github.com/volt-hq/Volt/issues/884))

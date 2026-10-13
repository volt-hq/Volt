---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP error and argument redaction of `Authorization` values such as `Bearer <token>`, `Bot <token>`, or a quoted `"Bearer <token>"`, which hid the scheme but kept the credential and wrote it to the MCP audit log. ([#884](https://github.com/volt-hq/Volt/issues/884))

The `Bearer`, `Basic`, and `token` schemes stay visible. With any other scheme, or none, the whole value is redacted up to the next `,`, `;`, quote, or line end.

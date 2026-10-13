---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP error and argument redaction of secret values such as `password: "correct horse battery"`, `--password 'a b c'`, or `token: Bot <token>`, which redacted only the first word and wrote the rest to the MCP audit log. ([#904](https://github.com/volt-hq/Volt/issues/904))

A quoted value is redacted up to its closing quote, or the line end when the quote is not closed. A credential after an unknown scheme is redacted with the scheme. Values of quoted key names, as in JSON or dict text (`{"api_key": "sk-live-123"}`), are redacted, and so is a Base64 credential in `Authorization Basic <credential>` without a separator.

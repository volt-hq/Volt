---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP error and audit-log redaction of `Authorization` values with auth-params, such as Digest `response`/`nonce`/`cnonce` or OAuth 1.0 `oauth_signature`, and of `Authorization <scheme> <credential>` without a separator, which left credentials in clear text. ([#900](https://github.com/volt-hq/Volt/issues/900))

Every auth-param is redacted, including quoted values that contain commas. The `Bearer`, `Basic`, and `token` schemes stay visible.

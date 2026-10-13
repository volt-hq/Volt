---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP error and audit-log redaction of `Authorization` values with auth-params, such as Digest `response`/`nonce`/`cnonce` or OAuth 1.0 `oauth_signature`, and of `Authorization <scheme> <credential>` without a separator, which left credentials in clear text. ([#900](https://github.com/volt-hq/Volt/issues/900))

The whole `Authorization` value, scheme included, is now redacted, so `Authorization: Bearer abc` is logged as `Authorization: [redacted]`.

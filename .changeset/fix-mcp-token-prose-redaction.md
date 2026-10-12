---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Kept MCP OAuth error messages such as "token endpoint must use HTTPS" readable while still redacting `token: value`, `token=value`, `--token value`, and credential-like values such as `invalid token ghp_abc123`. ([#876](https://github.com/volt-hq/Volt/issues/876))

---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Kept MCP error messages that mention a token, secret, password, credential, or private key readable instead of redacting the following word, while still redacting key-value credentials and credential-like values such as `--password hunter2`. ([#879](https://github.com/volt-hq/Volt/issues/879))

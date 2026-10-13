---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP error and argument redaction leaving secrets in clear text after a quoted key such as JSON's `"access_token"` or after `API key:`, including in the MCP audit log. ([#881](https://github.com/volt-hq/Volt/issues/881))

A quoted string value is now redacted through its closing quote, also inside JSON-encoded text, and an object or array value under a secret key is redacted whole.

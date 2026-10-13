---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP connections forgetting the OAuth client registered during browser sign-in, which forced a new sign-in once the access token expired. ([#878](https://github.com/volt-hq/Volt/issues/878))

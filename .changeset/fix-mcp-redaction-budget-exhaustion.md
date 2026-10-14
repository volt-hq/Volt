---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Prevented adversarial text from exposing earlier secrets when MCP redaction reaches its parsing limit.

When the parsing limit is reached, the entire error or string argument is redacted, including in the MCP audit log.

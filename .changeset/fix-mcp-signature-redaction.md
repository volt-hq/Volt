---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP error and argument redaction keeping request signatures such as a presigned URL's `X-Amz-Signature`, an Azure SAS `sig`, or an OAuth 1.0 `oauth_signature` in clear text, including in the MCP audit log. ([#902](https://github.com/volt-hq/Volt/issues/902))

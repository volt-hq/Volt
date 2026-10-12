---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Redacted the credential after an auth scheme such as `Authorization: Bearer <token>`, and the values of quoted keys such as `{"access_token":"..."}`, in MCP audit logs and error messages. ([#886](https://github.com/volt-hq/Volt/issues/886))

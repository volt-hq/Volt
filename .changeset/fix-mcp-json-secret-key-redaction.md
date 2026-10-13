---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP error and argument redaction of secrets in JSON text, such as `{"password":"correct horse"}`, `{"access_token":"abc123"}`, or the same JSON with backslash-escaped quotes, which kept the value in clear text in MCP errors and the MCP audit log. ([#906](https://github.com/volt-hq/Volt/issues/906))

A quoted value after a secret key is now redacted up to its closing quote, so values with spaces or separators (`password: "correct horse battery"`, `client_secret="abc,def"`) are fully hidden and the rest of the text stays readable.

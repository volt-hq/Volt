---
"@hansjm10/volt-coding-agent": patch
---

fix(mcp): Fixed MCP error and argument redaction leaving parts of secrets in clear text, including in the MCP audit log: quoted values with spaces after any key, a scheme other than Bearer or Basic, a quoted value that starts with a line break, and keys such as `cookie`, `passphrase`, `pwd`, and `auth`. ([#904](https://github.com/volt-hq/Volt/issues/904), [#907](https://github.com/volt-hq/Volt/issues/907), [#908](https://github.com/volt-hq/Volt/issues/908), [#910](https://github.com/volt-hq/Volt/issues/910))

A quoted value after a key is now redacted through its closing quote, keeping the quotes, and an object or array after a key is redacted whole.

Quoted credential-like values after whitespace alone are also detected when their content starts with whitespace. Quoted credentials after unknown schemes and all Cookie header pairs are redacted; Set-Cookie attributes stay readable.

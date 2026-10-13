---
"@hansjm10/volt-coding-agent": minor
---

breaking(mcp): OAuth credentials for HTTP MCP servers are now bound to the authorization server that issued them and are never sent to a different one named by the MCP server, fixing GHSA-6qxp-vccf-f47h. ([#843](https://github.com/volt-hq/Volt/issues/843))

Migration: stored MCP OAuth tokens and client registrations saved by earlier versions carry no authorization server binding and are discarded, so authenticate each affected server again with `volt mcp auth <server>` or `volt mcp auth-device <server>`. A server configured with a pre-registered `auth.clientId` must also set `auth.issuer` to the authorization server URL that client is registered with; without it, authentication fails. If a Volt client may have connected to an untrusted MCP server while holding OAuth credentials, rotate the affected client secrets and revoke their tokens.

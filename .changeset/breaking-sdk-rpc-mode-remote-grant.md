---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(rpc): Every RPC command, remote host command, and TUI slash command now runs through one intent and query registry, and a paired device reaches each one only within the capabilities its grant holds. ([#585](https://github.com/volt-hq/Volt/issues/585))

The protocol gains the workspace and push intents and queries (`register_push_target`, `unregister_workspace`, `create_worktree`, `remove_worktree`, `prepare_pr_review`, `worktrees`, `workspace_directories`, `agent_options`, `session_contexts`, `pr_review`), `web_search_status` beside `host_status`, and `set_default_model`, `set_default_thinking_level`, and the MCP device and browser sign-in (`mcp.auth_start_device`, `mcp.auth_start_browser`) as intents. A malformed grant holds no capabilities. `set_model` and `set_thinking_level` with the default persisted save that default after the conversation's model or thinking level changes and its events are published, not before. `mcp.auth_start_browser` without a `redirectUrl` starts the server's configured sign-in instead of failing. Malformed input that the intent schemas catch is rejected as `invalid_input`.

Migration: `runRpcMode` no longer takes `requireRemoteSafeUiActions`; serve a paired device's stream with `serveIrohRemoteConnection` (see the paired-device protocol entry). `registerPushTarget` now receives the typed `RpcRegisterPushTargetArgs`.

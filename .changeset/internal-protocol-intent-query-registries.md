---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

internal(protocol): Route every RPC command, UI action, remote host command, and TUI slash command through one intent and query registry.

Each intent and query declares its remote safety and required remote capabilities; a parity test proves remote access decisions are unchanged. The protocol gains the workspace and push intents and queries (`register_push_target`, `unregister_workspace`, `create_worktree`, `remove_worktree`, `prepare_pr_review`, `worktrees`, `workspace_directories`, `agent_options`, `session_contexts`, `pr_review`), `web_search_status` beside `host_status`, and `set_default_model`/`set_default_thinking_level` and the MCP device/browser sign-in split as intents.

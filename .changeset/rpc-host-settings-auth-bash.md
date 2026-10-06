---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(rpc): RPC clients' `!` commands now go through extensions' `user_bash` hooks and show as they run, and opening a session in another project asks that client the project trust question.

Protocol clients can also change the settings the host reads (`set_settings`), switch settings profiles (`set_profile`), choose the models the model-cycle control steps through (`set_model_scope`), inspect, restart, and trace language servers (`lsp.status`, `lsp.restart`, `lsp.set_trace`), save a debug report (`debug_report`), and sign in to or out of providers (`auth.providers`, `auth.login`, `auth.logout`). Sign-in pages, device codes, and API key entry reach only the client that started the sign-in, never a paired device, and the key never appears in a frame the host sends. MCP audit records now name the caller as `model`, `local`, `remote`, or `cli`.

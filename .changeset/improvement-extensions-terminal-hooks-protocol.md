---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(extensions): The `request_user_input` tool's questions and an extension's `ctx.ui.setTheme` now reach clients through the protocol, so RPC clients and paired phones can answer the tool's questions too. ([#585](https://github.com/volt-hq/Volt/issues/585))

The model is offered `request_user_input` while an attached client accepts `user_input` host requests: the TUI, an RPC client, or a phone granted conversation control. The questions go to every such client, the first answer wins, and they wait for a client while none is attached. `ctx.ui.getAllThemes()` lists the host's themes in every mode, and `ctx.ui.setTheme(name)` sends local clients a `set_theme` directive instead of saving the theme as the user's: a TUI whose user picked a theme keeps it, and phones never receive it. SDK hosts answer `user_input` host requests through a client's `live` view; `ExtensionClient.themes`, `ExtensionClient.userInput`, and the `ExtensionClientThemes` type are removed.

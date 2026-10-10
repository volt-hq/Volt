---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(tui): The TUI runs `/model`, `/scoped-models`, `/settings`, `/profile`, `/login`, `/logout`, `/lsp`, `/mcp`, `/extensions`, `/usage`, `/debug`, `/review`, `/plan`, `/build`, and `/fast` through its host as a client, and masks API keys as you type them. ([#585](https://github.com/volt-hq/Volt/issues/585))

Settings the host reads (personality, transport, review model, images, timeouts, warnings, compaction, queue modes) change through the host; the TUI's own display settings are written by the TUI. A subscription sign-in shows its page in the sign-in dialog and opens it only when it is an http or https address; the code it asks for is entered in the same dialog. An API key shows as bullets and never enters the editor or its history.

An extension's `ctx.reload()` reloads the TUI's keybindings and theme too.

`/store` installs, updates, and removes packages as the TUI and offers to reload the conversation, which loads the change; an installed extension starts with the reload instead of at once.

Protocol clients can pin the pull request a `review` with target `pr` reviews with `url` (the `url` completions offer the current branch's pull request; local clients only), and `set_settings` and the `settings` query carry `warnings`.

---
"@hansjm10/volt-coding-agent": minor
---

breaking(extensions): Extensions see `ctx.mode` as `"rpc"` in the interactive TUI, as in every host clients drive; `ExtensionMode` no longer has `"tui"`, and command handlers see who invoked them as `ctx.invokedBy`. ([#585](https://github.com/volt-hq/Volt/issues/585))

To migrate, replace each `ctx.mode === "tui"` check. For UI, check `ctx.hasUI` (true in every `"rpc"` host; a dialog no client answers resolves to its default). To allow something only a user at the host may do, such as running commands, check `ctx.invokedBy === "local"` together with `ctx.hasUI` in the command handler: `"local"` is the TUI, a stdio RPC client, or the SDK; a paired remote device, or a client the host no longer knows, is `"remote"`. The startup project trust prompt's `project_trust` context also reports `"rpc"`. `/swarm-review --exec` now runs only when a local client invoked it, which includes local RPC clients.

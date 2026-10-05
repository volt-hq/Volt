---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
"@hansjm10/volt-agent-core": patch
---

feature(extensions): Extensions can be enabled and disabled while a session runs, from `/extensions`, `/extensions enable|disable <id>`, or the `set_extension_enabled` intent, and every open conversation follows without `/reload`. ([#585](https://github.com/volt-hq/Volt/issues/585))

`extensions.<id>.enabled` in global or trusted project settings decides whether an extension runs; a disabled extension's factory never runs. Disabling one removes everything it contributed (hooks, commands, intents, shortcuts, completion providers, providers, status items, panels, its title, pending dialogs, and terminal UI), cancels its running work, and removes its tools at the next turn boundary once its running tool calls finish. Enabling one whose permissions are not acknowledged asks the client that enables it to acknowledge them; a paired device with `host.manage.v1` may disable extensions but enables only acknowledged ones. Extensions hear `activate` and `deactivate` (`startup`, `enable`, `disable`, `reload`), `session_start` gains reason `enable` and `session_shutdown` reason `disable`. The `extensions` query lists every extension with its state and permissions, `/store install` and `/store remove` load or unload the extension at once, and work records keep the remote capabilities their kind required.

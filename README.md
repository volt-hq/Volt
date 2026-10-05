# Volt RTK Extension

Rewrites bash tool calls through `rtk rewrite` so Volt receives token-optimized command output from supported commands.

## Requirements

Install RTK and ensure `rtk` is on `PATH` before enabling this extension.

## Settings

Edit the settings from `/extensions` (or `volt config`), or in `settings.json` under `extensions.rtk.settings`:

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Rewrite bash commands through rtk. Off: commands run unchanged. Replaces `RTK_DISABLED=1`. |
| `rewriteTimeoutMs` | `2000` | How long one rewrite may take, 100 to 30000 ms; a command whose rewrite takes longer runs unchanged. |

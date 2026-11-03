---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

feature(remote): Paired devices such as the phone app can now run extension commands you allow in `/extensions` (Remote commands) or the global setting [`extensions.<id>.remoteSafeCommands`](https://volt-cli.dev/docs/settings/#extensions), even when the extension did not mark them remote-safe.

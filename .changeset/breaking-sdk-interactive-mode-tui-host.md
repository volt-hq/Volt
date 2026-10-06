---
"@hansjm10/volt-coding-agent": minor
---

breaking(sdk): `InteractiveMode` runs on a `TuiHost`, which owns the TUI's daemon leases and the phones relayed into its sessions. ([#585](https://github.com/volt-hq/Volt/issues/585))

Migration: replace `new InteractiveMode(host, conversation, options)` with `new InteractiveMode(TuiHost.start({ host, conversation }), options)`. The `daemonAttach` option is gone. A TUI the SDK starts this way runs without the daemon: it takes no conversation leases and serves no relayed phones.

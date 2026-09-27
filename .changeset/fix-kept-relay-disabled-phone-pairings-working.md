---
"@hansjm10/volt-coding-agent": patch
---

fix(daemon): Fixed relay-disabled phone pairings failing to reconnect after a daemon restart. ([#487](https://github.com/volt-hq/Volt/issues/487))

Existing relay-disabled pairings need to pair once more after upgrading; later restarts keep them working. A change of the host's LAN IP address still requires pairing again.

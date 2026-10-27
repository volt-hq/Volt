---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

feature(daemon): Added experimental peer agents: pair with a coworker's Volt over the local network, choose one of their open conversations, read its context, and send messages or steers with its existing tools and replies returned to your agent.

Enable `remote.peers` in global settings and pair with `volt remote peer add`. Sends can wait for a reply or return immediately; cancelling a wait on an existing conversation leaves its work running.

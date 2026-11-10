---
"@hansjm10/volt-coding-agent": patch
---

improvement(tui): Added a full-screen loading animation of the Volt bolt snapping together, shown at startup, on /clear, and during /reload.

At startup it stays until the daemon has finished starting, including its phone transport, for at most 10 seconds.

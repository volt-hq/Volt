---
"@hansjm10/volt-coding-agent": patch
---

feature(tui): Refreshed the TUI's look: tool cards and replies use distinct colors by role instead of purple throughout, the startup logo draws the Volt bolt and wordmark with half-block characters, and a full-screen animation of the bolt snapping together plays at startup, on /clear, and during /reload.

File paths and patterns in tool titles, inline code, and list bullets each have their own color, and bash tool titles show the command with shell syntax highlighting. At startup the animation stays until the daemon has finished starting, including its phone transport, for at most 10 seconds.

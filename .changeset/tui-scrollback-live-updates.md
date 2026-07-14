---
"@hansjm10/volt-tui": patch
"@hansjm10/volt-coding-agent": patch
---

fix(tui): Fixed terminal scrollback being corrupted during live transcript updates; offscreen rows keep their last painted content until re-exposed, and the bottom anchor survives terminal height shrinks. ([#30](https://github.com/hansjm10/Volt/pull/30))

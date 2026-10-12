---
"@hansjm10/volt-coding-agent": patch
---

fix(tui): Durations past a minute now show as minutes, hours, and days (`47m 12s`, `1h 2m`) in `/work`, tool cards, bash output, and subagent status instead of raw seconds. ([#836](https://github.com/volt-hq/Volt/issues/836))

The working indicator and `/remote` use the same format, so `/remote` now shows seconds past a minute and days past a day.

---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): A paired client attaching after a turn completes now receives the full text of the latest assistant message instead of a permanent 12,000-character truncation. ([#85](https://github.com/volt-hq/Volt/issues/85))

The branch-latest assistant message is served complete (up to the 256 KiB live assistant content budget) in conversation bootstraps, resync checkpoints, `get_transcript` head pages, and its own transcript commit frame. Older or over-budget entries keep the previous bounded truncation.

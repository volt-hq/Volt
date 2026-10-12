---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Paired devices keep receiving streaming tool call arguments past a JSON escape such as `\n` instead of only the finished call. ([#824](https://github.com/volt-hq/Volt/issues/824))

Streaming text no longer resends the whole message, with the start of an unfinished path in it, when a delta ends inside a word the device already shows part of.

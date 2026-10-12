---
"@hansjm10/volt-coding-agent": patch
---

improvement(remote): Reduced the host CPU each paired device costs while a long answer or tool call streams: path redaction now processes only the newly streamed text instead of the whole message on every token. ([#820](https://github.com/volt-hq/Volt/issues/820))

Arguments that stream on one long line, such as a file a tool call writes, now reach the device in larger steps.

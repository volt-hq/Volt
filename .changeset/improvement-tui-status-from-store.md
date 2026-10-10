---
"@hansjm10/volt-coding-agent": patch
---

improvement(tui): The TUI's footer, working, retry, and compaction indicators, alerts, plan, work inspector, and extension panels follow the conversation as a client of its host. ([#585](https://github.com/volt-hq/Volt/issues/585))

The host's own notices (a compaction cancelled or failed, retries that gave up, an Anthropic subscription login billing extra usage) show as they arrive; the subscription warning also shows at startup with the other notices the host keeps. In `/work`, a subagent's conversation lists its own work, so the conversations it started open read-only too, closed ones included. Tab from an empty editor moves to the actions, forms, and trees of extension panels; Tab past the last one or Esc returns to the editor.

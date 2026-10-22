---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
"@hansjm10/volt-agent-core": minor
---

breaking(compaction): Compaction and branch summaries now keep every file the session read or modified, including files from before an extension's compaction, files recorded by branch summaries, and files in a long abandoned branch. ([#953](https://github.com/volt-hq/Volt/issues/953))

Every `branch_summary` entry now records the abandoned branch's files in required `readFiles` and `modifiedFiles` fields, whether Volt or an extension wrote the summary; built-in branch summaries no longer store them in `details`, and `BranchSummaryDetails` is removed. Sessions saved before this release that contain a branch summary no longer open; start a new session, or fork it from an entry before its first branch summary with an earlier release.

SDK callers: a `ConversationSummarizer.summarizeBranch` result and a navigation `prepare` summary must include `readFiles` and `modifiedFiles`. Protocol clients receive both fields on `branch_summary` entries.

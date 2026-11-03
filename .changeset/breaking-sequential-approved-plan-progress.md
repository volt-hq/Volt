---
"@hansjm10/volt-coding-agent": minor
---

breaking(planning): Approved-plan checklists now execute sequentially, with one current item and a committed start before completion.

SDK callers and model tools must start the earliest unfinished executable leaf with `in_progress` in one committed update before completing it. An update may complete the current leaf and start the next, but cannot skip items, start parallel work, complete multiple leaves, or reopen completed work. Same-status evidence edits and current-item pauses remain supported.

Use `request_replan` and obtain fresh approval to revisit completed work; returning to draft preserves completed leaves and evidence and resets active leaves to `pending`. Historical snapshots remain readable, but nonsequential current active plans require replanning, and nonsequential ready plans require Change Plan or feedback before reapproval.

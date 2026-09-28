---
"@hansjm10/volt-coding-agent": patch
---

improvement(plan): Ready plans now wait at an explicit approval checkpoint with a persistent PLAN READY cue and next-step key hints. ([#330](https://github.com/volt-hq/Volt/issues/330))

The plan chooser opens once the planning run settles, and the approval cue stays in the plan status line, plan pane, and composer border until you decide. Turn-done notifications say the plan is ready for approval.

Text typed or pasted while the chooser is focused goes to the composer instead of being dropped, so Enter sends feedback rather than executing the plan. The chooser no longer takes focus mid-run or from a composer holding a draft, and Change Plan keeps any draft already in the composer.

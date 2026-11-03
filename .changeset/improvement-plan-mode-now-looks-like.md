---
"@hansjm10/volt-coding-agent": patch
---

feature(tui): [Plan mode](https://volt-cli.dev/docs/quickstart/#switch-models) now looks like a first-class mode: the composer's border takes the Plan mode color, the transcript marks each switch between Build and Plan mode, a ready plan shows one cue with its actions as buttons at every width, and an approved plan's execution shows as a card with its checklist instead of the model's instructions and step ids.

The plan pane, Plan Details, and the plan status above the editor share one look with the planning tools' transcript cards: a ◆ PLAN · PHASE badge, checklist items drawn as the cards draw them, a progress bar, and a pane divider that lights up while the pane is focused.

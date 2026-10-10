---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(review): Extensions can register a review engine with `volt.registerReviewEngine`, and `/review --engine <name>` runs a review on it with the engine's own options as flags, completions, and a usage line.

The host runs the engine as review work, validates what the engine submits, and records the run. The `/review` launcher asks which engine reviews when an extension offers one for the target and adds the engine's options to the options form, and the `reviewEngine` setting makes an engine the default. Protocol clients pass `engine` and `engineParams` to the `review` intent.

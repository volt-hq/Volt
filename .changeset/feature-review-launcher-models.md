---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
"@hansjm10/volt-tui": patch
---

feature(review): The `/review` launcher lets you pick the review and verifier models from your model list, and opens with the options you last started a review with.

The models you pick are saved to the `reviewModel` and `reviewVerifierModel` settings; the effort, optional findings, scope mode, and an engine's own options are remembered per engine. Typing on a choice field in a form now searches its options.

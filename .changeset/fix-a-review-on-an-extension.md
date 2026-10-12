---
"@hansjm10/volt-coding-agent": patch
---

fix(review): A review on an extension engine that follows an earlier run now decides every earlier finding, so a review loop on any engine can come back clean.

The host verifies, with the review verifier model, each earlier finding the engine neither decided nor reported again. Before, such a finding stayed open in every later round, so the review never came back clean.

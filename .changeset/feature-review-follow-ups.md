---
"@hansjm10/volt-coding-agent": patch
---

feature(extensions): A review an extension starts can also collect follow-ups: verified defects it notices outside the change, kept apart from the findings with a fingerprint that identifies the same defect across reviews.

A defect on a line the change touches is never a follow-up, even one that predates the change: such a review reports it as a finding, for the change to fix.

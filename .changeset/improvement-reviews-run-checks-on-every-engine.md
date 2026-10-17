---
"@hansjm10/volt-coding-agent": patch
---

improvement(review): Reviews on every engine can run the project's checks and tests: the reviewTools setting and the tools of ctx.reviews.start now apply to extension engines, and the reviewSetup setting or the setup of ctx.reviews.start first runs a command, such as installing dependencies, in each review checkout.

A review an extension starts can also follow the previous round of a review loop: it reviews everything again, keeps the id of each finding still open, and closes the ones it finds fixed where they were found. It can also collect follow-ups: verified defects it notices outside the change, kept apart from the findings with a fingerprint that identifies the same defect across reviews.

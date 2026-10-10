---
"@hansjm10/volt-coding-agent": patch
"@hansjm10/volt-protocol": patch
---

improvement(review): `/review` starts the review as work and opens the work list on it instead of replacing the editor with a loader, so several reviews can run at once; a review that completes there opens its findings.

`/review` reads its command line, usage, and completions from the host's declaration of the review command, shows one options form after you pick a target, and echoes the equivalent command.

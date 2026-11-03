---
"@hansjm10/volt-coding-agent": patch
---

improvement(jobs): A foreground bash command that produces no output for its silence timeout now keeps running as a [background job](https://volt-cli.dev/docs/usage/#background-jobs) instead of being killed, and the model gets the job ID to collect its output with `jobs wait`.

The silence timeout is still 300 seconds by default. Without the jobs tool, or while the conversation already runs 8 jobs, the command is killed as hung. The bash tool description now also tells the model not to pipe output through `tail`, `head`, or `sort` just to shorten it, since those hide progress until the command exits.

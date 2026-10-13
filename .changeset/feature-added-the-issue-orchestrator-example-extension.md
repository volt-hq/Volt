---
"@hansjm10/volt-coding-agent": patch
---

feature(extensions): Added the issue-orchestrator example extension: /orchestrate works a repository's labeled GitHub issues with agents in managed worktrees, reviews each pull request until clean, and merges it or hands it to a human.

Its reviews can run on one of /review's review engines (`review.engine`): the orchestrator posts each complete review to the pull request, each round follows the previous one and closes the findings it finds fixed, and the fixer gets the open findings.

What an issue's agents and reviews find outside its scope is worked too, recorded once each by a deterministic check: agents report such problems instead of filing issues, and the orchestrator adds each to an open issue about the same code as a comment, or files it as an issue of its own. One found while working an agent-filed issue waits for a human to label it.

A pull request that does not converge, because a fix introduced new defects or its review rounds ran out, gets a triage agent that decides whether it gets another fix, restarts from the base branch with new guidance, or goes to a human. From the second round on, findings that predate the change no longer block it and are listed for the human who merges. Pull requests are brought up to date before a review or fix when the base branch changed their files, and an issue waits while another issue's work changes the code it names.

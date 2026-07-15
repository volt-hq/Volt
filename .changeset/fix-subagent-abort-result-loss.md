---
"@hansjm10/volt-coding-agent": patch
---

fix(subagents): Internal aborts (tree budget crossed, run timeout) that land while a child is being cleaned up no longer discard the child's already-computed result or a parallel run's per-task failure details.

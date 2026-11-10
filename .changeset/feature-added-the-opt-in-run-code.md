---
"@hansjm10/volt-coding-agent": patch
---

feature(code-mode): Added the opt-in [run_code](https://volt-cli.dev/docs/code-mode/) tool, which runs a sandboxed script that calls Volt's tools and returns only what it prints; enable it with [`codeMode.enabled`](https://volt-cli.dev/docs/code-mode/#enabling-code-mode). ([#1027](https://github.com/volt-hq/Volt/issues/1027))

A run_code call shows a live card with the script, its nested tool calls as they run, and its newest output. Scripts can keep small JSON values across scripts with `store()` and `load()`; the values follow the conversation's branches and survive reopening it. Compaction and branch summaries list the files scripts read, wrote, or edited, and MCP audit entries of a script's calls name the run_code call.

Volt guides the model to script tool-call batches, pagination, deterministic read workflows, and filtering of large results, and to keep small, readable results as direct calls. While run_code is active, MCP search and describe results show how a script calls each tool. ([#1056](https://github.com/volt-hq/Volt/issues/1056), [#1058](https://github.com/volt-hq/Volt/issues/1058))

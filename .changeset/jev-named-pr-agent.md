---
"@hansjm10/volt-coding-agent": patch
---

improvement(subagents): Jev PR routing now targets a dedicated project agent with its own pinned model, thinking level, and workflow instructions.

The repository experiment uses `.volt/agents/pr.md`, configured for `openai-codex/gpt-5.6-luna` with max thinking. Enable with `/jev route`; change the agent definition instead of passing a model argument or `--jev-pr-model`. The same configuration applies to direct delegation, without changing the primary session.

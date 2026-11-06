---
"@hansjm10/volt-coding-agent": patch
---

fix(remote): Phone pull request reviews load project extensions, settings, skills, MCP servers, and AGENTS.md from the repository in your workspace instead of the pull request's head, so a pull request cannot add configuration that runs on the host. ([#1034](https://github.com/volt-hq/Volt/issues/1034))

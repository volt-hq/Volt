---
"@hansjm10/volt-coding-agent": patch
---

fix(extensions): Extensions can no longer commit the host's custom message types (review, work_notice, plan, and subagent recovery messages) through a before_agent_start message or a message_end replacement. ([#865](https://github.com/volt-hq/Volt/issues/865))

---
"@hansjm10/volt-agent-core": patch
"@hansjm10/volt-coding-agent": patch
---

fix(agent): Prevented new turns and pending operations from starting while session cancellation drains background work. ([#380](https://github.com/volt-hq/Volt/pull/380))

Hosts can share an `AgentHarnessAdmissionGate` across foreground and detached work. Cancellation preserves queued context and job inspection, and admission resumes after cleanup unless the session was disposed.

---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(lsp): Language server install prompts are now host actions kept in the conversation: an approved install shows as a work item with its progress and output, a client granted host management can cancel it, and a prompt still open when Volt stops ends interrupted instead of running later. ([#585](https://github.com/volt-hq/Volt/issues/585))

An install is offered only while a client that accepts approvals is attached; denying, dismissing, or letting the prompt time out records the action as cancelled without running it. Aborting a run no longer affects an install the user already approved.

Protocol clients see a host action as `host_action` work (the client fold's `work`, and the live `work/<workId>` value while it runs): its `approval` host request uses the work id as its `requestId`. The live `host_action/<id>` value is removed; read progress from `work/<workId>` and the outcome from the `work_finished` entry. `cancel_work` on a host action needs `host.manage.v1` on the remote profile. The `action_completed` push notification kind is removed; it was never sent.

SDK callers answer approvals by attaching a client that accepts `approval` to `session.liveState` instead of passing `hostInteraction` to `createAgentSession` or calling `session.setHostInteraction()`. The `HostInteraction`, `HostActionDecision`, `HostActionUpdate`, and related exports are removed; `session.hostActions.run(request, executor)` runs a host action, and `LspManager` takes `hostActions` instead of `hostInteraction`.

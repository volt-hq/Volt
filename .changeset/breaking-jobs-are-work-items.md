---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(jobs): Background jobs are now work items kept in the conversation: a finished job's output stays readable after a restart, a job running when Volt stops ends interrupted, and a completed or failed job wakes the conversation with a notice. ([#585](https://github.com/volt-hq/Volt/issues/585))

A job that finishes while a `jobs wait` watches it, or that the model already read, queues no notice, and a turn that ends on a final response, a policy, or a tool stop no longer wakes the conversation for the jobs it started. Job ids are work ids, and `jobs read` of a job from an earlier session or runtime returns its recorded result instead of failing.

Protocol clients see jobs as `job` work items (the client fold's `work`, and the live `work/<workId>` value while one runs): replace the `cancel_job{jobId}` intent with `cancel_work{workId}`, the `job_output{jobId}` query with `work_output{workId}`, and the live `jobs` value with `work/<workId>`. Completion notices are `work_notice` custom messages instead of `background_job_notification`. `@hansjm10/volt-protocol` no longer exports the `RpcBackgroundJob*` schemas or `LiveJobsValueSchema`.

SDK callers read jobs through `session.jobs` and running work through `session.hasRunningWork` and `session.work.waitForIdle()` instead of `session.backgroundJobs`, `session.hasBackgroundJobs`, and `session.waitForBackgroundJobs()`; `HostedConversation.work` is the session's `work` registry.

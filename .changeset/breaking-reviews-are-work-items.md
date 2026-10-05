---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(review): Reviews now run as work items kept in the conversation: every client sees a running review's progress and can cancel it, a review running when Volt stops ends interrupted instead of staying unfinished, and opening a finished review opens a session seeded with its findings. ([#585](https://github.com/volt-hq/Volt/issues/585))

A review's work id is its run id. Aborting the conversation's run leaves a review running. Reviews no longer write `unfinished` run records or `volt.review.usage` entries: a running review's accounting is its work item's detail, written once per pass, and the finished run's `volt.review.run` record keeps the final accounting. Runs and usage entries written by earlier versions with status `unfinished` are ignored.

Protocol clients follow a review as a `review` work item (the client fold's `work`, and the live `work/<workId>` value while it runs): the review start intents answer `{workId}` instead of `{workflowId}`, replace the `review_cancel_workflow{workflowId}` intent with `cancel_work{workId}`, open a finished review's findings with `open_work{workId}` (or `review_open_session`), and replace the live `workflow/<workflowId>` value with `work/<workId>`. The `review.workflows` query no longer returns `activeWorkflows`, and its runs always carry `endedAt`. Review completion pushes are `work_finished` notifications with `workId` and `workKind` instead of `review_completed` with `workflowId`; a push relay must accept the new kind and fields (the example Firebase relay does). `@hansjm10/volt-protocol` no longer exports the `RpcWorkflow*`, `RpcReviewWorkflowDescriptor`, `RpcReviewWorkflowLifecycleStatus`, `RpcProjectionTruncation`, or `LiveWorkflowValueSchema` schemas, and `ReviewWorkflowStartedSchema` is now `ReviewStartedSchema`.

SDK callers start and observe reviews through the conversation's `work` registry instead of `HostedConversation.reviewWorkflows`; `runReviewWorkflow` takes the registry as `work`, and its hooks and `executeReviewWorkflow` no longer emit workflow events.

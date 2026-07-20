---
"@hansjm10/volt-coding-agent": patch
---

feature(remote): Reviews invoked over RPC now run detached: invoke_ui_action returns immediately with a workflowId, other commands keep working while the review runs, progress streams as workflow events, and findings are fetched (get_review_result), listed (list_review_workflows), cancelled (cancel_workflow), or opened in a fresh session (open_review_session) on demand instead of force-switching the client's session. ([#66](https://github.com/volt-hq/Volt/issues/66))

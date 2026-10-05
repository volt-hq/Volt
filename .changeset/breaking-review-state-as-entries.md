---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(review): Review anchors, handoff aliases, the General discussion, and finding discussions are now kept in the conversations' own logs instead of separate store tables. ([#585](https://github.com/volt-hq/Volt/issues/585))

Opening a session store from an earlier version upgrades it to schema v5, which drops the review anchor, alias, discussion, and discussion-child tables without carrying their rows over. Reviews run before the upgrade stay readable and actionable in each conversation that holds them, as unanchored reports: they no longer link handoff copies to their source, their finding discussions are no longer linked to their source review, and starting discussions or moving the General for them needs a new review run. Older Volt versions cannot open an upgraded store.

A review run is anchored by the conversation that ran it, from the moment it starts. Fork, clone, and import never carry review or work records, so a copy of a review stays a local report.

Protocol clients: the `review.general` query result no longer has `generalRevision`; a General moves when its source records the move, and of two concurrent moves from the same General one fails.

SDK callers: `SessionManager.getReviewDiscussion()` returns the discussion link a child's log records (`discussionId`, `runId`, `findingId`, `source`, `contextSnapshot`) instead of a store lookup, and `SessionManager.getReviewState()` returns a conversation's review state. The session store no longer has review anchor, alias, or discussion operations; `SQLiteSessionStoreClient.findReviewRun`, `findReviewDiscussion`, and `findReviewDiscussionChild` read its derived review indexes.

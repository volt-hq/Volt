# Review finding discussions (#341)

> **Superseded in part.** The [architecture rewrite](architecture-rewrite-design.md) (§7, §14 Q7) runs reviews as `review` work items and keeps review state as log entries; a discussion start or reset holds its conversation open for daemon retention instead of a separate pending-work check. Where this document describes review workflows, `unfinished` runs, side tables, or their counters, the [session format](session-format.md#review-state-entries-host-only) and [RPC mode](rpc.md#work) describe the current behavior. The rest of this document is a historical record.

Developer design for independent, host-owned finding conversations. iOS integration is tracked in volt-app #249.

## Ownership and persistence

Review state is log entries (architecture rewrite RFC §14 Q7; [session-format.md](session-format.md#review-state-entries-host-only)). A run's source anchors it with the `work_started` of its review work. Approved handoff/clear-context paths write a `review_alias` into the new session; importing or forking a transcript copies no host records and grants no membership. The source records each finding's discussion (`review_discussion`) and resets (`review_discussion_reset`), and each child's first entry links it (`review_discussion_link`). Normal unanchored reports, including runs from before store v5, remain readable and locally actionable; rerunning a review establishes current discussion authority.

Canonical outcome reads, rerun planning, publishing and feedback resolve the original source rather than stale alias snapshots. A live canonical writer uses its session actor. An unloaded source is written under a short provisional broker reservation (`withSourceWrite`) until the write and manager close settle, then rolls back that reservation without publishing a provider runtime. Competing TUI/phone openers cannot open the same source during that write. An already-owned unavailable source fails explicitly. Every write to a source re-reads its log first, under its single writer.

Source and child references are exact session identities (ID and generation). The store's derived `review_run_index` and `review_discussion_index` answer cross-session lookups and enforce how logs relate; they grant no authority. Runtime lookup is additionally scoped to the requester's registered workspace name and generation. Client projections never include store paths or generations as caller-granted authority.

## Current General destination

A run's General is its source until the source records a `review_general` moving it; the latest one is current. `get_review_general` is a read-only lookup available to exact source/alias members and current or historical finding children of that same run. It returns required `runId`, `sourceSessionId`, `generalSessionId`, `generalSessionGeneration` and `generalAvailable`; an unavailable destination is never replaced by the canonical source.

`new_session` accepts `replaceReviewGeneral: true` only with `preserveReviewRunId`. The initiating session must be the exact current General. The new session carries the run as an alias like any handoff; the move itself is the last durable step, after successful replacement callbacks and the final structural check, and re-reads the source's log: it records the move only if the initiating session is still the current General, so of competing replacements one wins. Failed setup, ownership publication, rebinding or seeding cannot move the General. Ordinary handoffs, aliases and history opens never promote. Canonical source ownership, finding links, reset history and outcome-writing rules are unchanged.

## Sibling admission

The daemon's review service creates siblings without rekeying the source. Broker/coordinator producer admission is acquired before opening the child manager or seeding context. Cold-open competitors either reuse an admitted runtime or retry without modifying its persistence. Registry publication, worktree binding, broker finalization and cleanup retain exact ownership; failed initialization is fully quiescent before provisional ownership is released.

Client revocation, access changes and workspace removal synchronously fence pending review effects before waiting for stream retirement. Ordinary app detach does not revoke that fence. Pending source control work pins normal detached-runtime retention until it settles.

Each child inherits authorized placement and effective model/thinking/Fast configuration. Tool permissions come from normal runtime grants, not the source's temporary Plan-mode filter. Its context contains only the selected immutable finding, target revision and evidence. It does not own mutable finding outcomes.

Finding discussions are normal coding sessions: requested fixes can use Build tools, shell commands, LSP mutations, granted MCP operations, extensions and subagents. Current SDK/host/client grants and exclusions apply; obsolete tool lists in saved finding context do not impose an additional ceiling. Plan mode retains its ordinary research profile, research-before-submit gate, authoring and approval rules; approved plans execute in the current discussion context. MCP startup, supplied managers, direct tools and LSP installation follow ordinary session policy.

Source-linked identity/reset and canonical outcome authority are domain lifecycle boundaries, not read-only permissions. Generic replacement, fork/clone and clear-context plan handoff remain unavailable to avoid orphaning the discussion. Review lifecycle actions and canonical outcome recording belong to the source review; they do not prevent applying or testing code fixes here.

The initial kickoff requests analysis and possible fixes, not automatic editing. Later explicit fix requests are actionable. On every runtime construction and prompt-policy refresh, trusted host policy supersedes obsolete persisted read-only context, kickoff guidance or compaction summaries. Transcripts and stored context snapshots are not rewritten, and no wire compatibility fallback is used.

## RPC contract

Ordinary transport correlation `id` is separate from semantic `requestId`. Mutations require current remote `conversationAuthority`.

```ts
{ type: "start_review_discussions", runId, findingIds, requestId }
{ type: "list_review_discussions", runId, cursor?, limit? }
{ type: "reset_review_discussion", discussionId, expectedSessionId, requestId }
{ type: "get_review_discussion_source" }
```

Start accepts 1–50 unique finding IDs and returns independent `created | existing | failed` outcomes. List pages are bounded to 50. Reset returns `reset | conflict | busy` with the current discussion descriptor. A host without the sibling backend returns `review_discussions_unavailable`; unavailable source authority returns `review_source_unavailable`. Both are registered stable errors.

```ts
type Link = {
  discussionId: string;
  runId: string;
  findingId: string;
  sourceSessionId: string;
  sessionId: string;
};
type Discussion = Link & {
  currentSessionId: string;
  sourceAvailable: boolean;
  available: boolean;
  status: "idle" | "running" | "pending" | "completed" |
          "failed" | "cancelled" | "interrupted" | "unavailable";
};
```

State/bootstrap/session-list metadata has optional `reviewDiscussion: Link`. `sessionId` identifies the described child; `currentSessionId` identifies the current reset generation. Linkage makes no permission claim. Older children remain linked and retain normal coding permissions, and their ordinary session-list metadata permits history discovery. Source lookup on a historical child preserves its requested `sessionId` while returning the group's current pointer. List/source status is a snapshot; live conversation events remain authoritative for an attached turn.

## Retry and reset

An initial kickoff has a persisted `clientMessageId`. Start retries reuse the same child and never resend an existing receipt. Partial failures retain successful siblings and recoverable IDs.

Idle reset is serialized with source starts and guarded by the old child's session actor; the source records it only if the expected child is still current in its log. It retains previous child IDs, prepares a new bound idle runtime under producer admission, and does not start inference. Replayed reset requests resolve their recorded history instead of clearing the latest context again.

Recovered finding inputs are terminalized as failed, with an interrupted explanation, instead of automatically replaying accepted/started/queued work. A user retries through a new explicitly submitted child prompt. Completion status follows the latest assistant turn, not merely the initial input receipt.

## Validation and rollout

Use the faux-provider suite harness and disposable stores. Regression coverage includes four overlapping discussions, canonical aliases, independent cancellation, duplicate starts/resets, exact-generation lookup, cold-source writes, TUI/phone competitors, publication rollback, revocation, detach retention, interrupted input recovery, actual persisted-session writes/shell execution, normal tool grants, and Plan-mode research restrictions.

`test.sh` temporarily moves `$HOME/.volt/agent/auth.json`; run it with an isolated HOME when a developer daemon/session is active. Fresh worktrees need ignored local package compiler outputs for package-level typechecks/browser smoke; no dependency changes are required.

See `session-format.md` for the transactional store upgrades; v5 drops the v2 review tables without backfill. Do not open real stores with new code until older CLI/daemon owners have been shut down. Implementation verification uses isolated daemons/stores, never an implicit developer-daemon restart.

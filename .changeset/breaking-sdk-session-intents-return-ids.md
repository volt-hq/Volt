---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(sdk): Extension session control and the RPC session commands now return the id of the session the client moved to. ([#585](https://github.com/volt-hq/Volt/issues/585))

`ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` resolve with `{ cancelled: true }` or `{ cancelled: false, sessionId, seeded }` (`SessionIntentResult`). The RPC commands `new_session`, `switch_session`, `switch_session_by_id`, `clone`, and `open_review_session` respond with `{ cancelled: true }` or `{ cancelled: false, sessionId }`, and `fork` with `{ cancelled: true }` or `{ cancelled: false, sessionId, text }`; `RpcClient` returns the same shapes. Executing a plan in a new session records the hand-off in the source session, and a review fix of every finding acknowledges the run in the source session, before the source closes; a failure there keeps you in the source session.

Migration: read the new session's id from `sessionId` instead of calling `get_state` or reading `ctx.sessionManager` after the switch. A cancelled result no longer carries `seeded` (and a cancelled `fork` no longer carries `text`); check `cancelled` before reading the other fields. An intent that no client handles now reports `{ cancelled: true }` instead of `{ cancelled: false, seeded: false }`. `open_review_session` and the review fix no longer fail with "opened without findings": the findings are written into the new session before it opens. SDK callers use `SessionIntentResult` in place of the removed `AgentSessionReplacementResult`.

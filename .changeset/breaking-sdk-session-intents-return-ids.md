---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(extensions): `ctx.newSession()`, `ctx.fork()`, and `ctx.switchSession()` now resolve with the id of the session the client moved to. ([#585](https://github.com/volt-hq/Volt/issues/585))

They resolve with `{ cancelled: true }` or `{ cancelled: false, sessionId, seeded }` (`SessionIntentResult`). Executing a plan in a new session records the hand-off in the source session, and a review fix of every finding acknowledges the run in the source session, before the source closes; a failure there keeps you in the source session. Opening a review's findings no longer fails with "opened without findings": the findings are written into the new session before it opens.

Migration: read the new session's id from `sessionId` instead of reading `ctx.sessionManager` after the switch. A cancelled result no longer carries `seeded`; check `cancelled` before reading the other fields. A call that no client handles now reports `{ cancelled: true }` instead of `{ cancelled: false, seeded: false }`. SDK callers use `SessionIntentResult` in place of the removed `AgentSessionReplacementResult`.

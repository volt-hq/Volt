---
"@hansjm10/volt-coding-agent": minor
"@hansjm10/volt-protocol": minor
---

breaking(sessions): Forked, cloned, and imported sessions now start with a `forked_from` entry that records their source, followed by a copy of only the source's branch up to that point, and imports get a new session ID.

`/fork`, `/clone`, `--fork <id>`, and imports (`/import`, or a path to `--session` or `--fork`) copy the branch from the root to the fork point, then its labels; other branches stay in the source. `--fork <id>` and imports previously copied every branch. An imported session gets a new ID instead of the snapshot's; pass `--session-id` with `--fork <path>` to choose it. The snapshot header's parent locator is no longer restored on import. SDK code reads the lineage with `SessionManager.getForkedFrom()`, and `SessionManager.createBranched(source, null)` creates a fork of an empty branch. In `@hansjm10/volt-protocol`, `forked_from.entryId` is `null` for an empty branch.

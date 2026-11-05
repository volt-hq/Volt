---
"@hansjm10/volt-coding-agent": minor
---

breaking(review): Review engines get a checkout from `ctx.checkout()` as `{ path, release() }` instead of a path, and the host resets and reuses released checkouts, so an engine no longer runs Git to reuse them.

Use `checkout.path` where you used the returned path, and call `checkout.release()` when a pass is done with it instead of running `git reset --hard` and `git clean` yourself; a later `ctx.checkout()` then gets it back reset, without running the setup again. `ctx.target.commonDirectory` gives the repository's Git common directory, which identifies it across worktrees.

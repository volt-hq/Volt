# Extension services: remaining foundation

- Tracking: [#435](https://github.com/volt-hq/Volt/issues/435), following [#432](https://github.com/volt-hq/Volt/pull/432).
- Scope: bounded first-request waiting, structured LSP discovery, and exact loaded-skill reads.
- The [extension guide](extensions.md#managed-context-preparation) is the public API contract. The [foundation design](extension-services-design.md) records the broader design intent.

## First-request allowance

`extensionWorkLimits.firstRequestWaitMs` defaults to zero and permits at most 100 ms. Only a synchronous first-boundary notification may request a wait through `ctx.work.context.requestWait(ms)`. Host-clamped requests combine by maximum across extensions, not sum. An async observer's returned promise remains observational, not a wait request.

The allowance is consumed by the first collection even if context headroom is absent. Collection snapshots admitted tasks, waits until they settle/revocation/the shared deadline, and then performs the existing separately bounded source validation. Retries and later turns cannot renew the allowance. A monotonic publication cutoff excludes contributions that finish after the deadline even if timer delivery is delayed. Timeout leaves otherwise valid tasks running for later turns; completion still has no wake authority.

## Structured semantic discovery

`symbols`, `definition`, and `references` require the current active trusted native LSP tool and traverse the same managed policy/reducer path as text reads. Hook-patched actions cannot expand this finite service into rename/fix or another operation. Results contain canonical paths, 1-based UTF-16 source ranges, bounded symbol/location arrays, an observation time, truncation, and explicitly unknown index coverage. Discovery does not mint source evidence: callers must read relevant ranges before citing their contents.

`lsp/managed-observation.ts` captures data during native response decoding; display text is never parsed back into authority. Operation-local context forbids installation and keeps ordinary foreground calls free of speculative install policy. Configured servers may start lazily. Missing, unsupported, cancelled, timed-out and failed operations remain distinct machine-readable outcomes.

Shared LSP transports do not correlate server-initiated edits to a parent request. A managed-read lease therefore rejects such edits while read work is outstanding. Cancelled requests drain until a server response, exit, or bounded request timeout. An unresolved timeout retains a bounded write prohibition until terminal acknowledgement or client replacement. Foreground command-based fixes rejected by this rule must report failure, not successful empty edits. No background query executes a command or grants mutation authority.

## Exact skill grants

Native skill loading records canonical path/device/inode from the descriptor whose bytes supplied the loaded metadata. An internal weak identity map follows native ResourceLoader metadata projections; it adds no storage fields or public Skill metadata. Metadata-only SDK overrides do not silently acquire local-file authority.

A runtime-local catalog issues opaque IDs for already loaded, model-invocable skills, capped at 128 entries and 64 KiB. Snapshot descriptors contain only ID, name, description, scope and origin, with an omission flag. No automatic body read or provider lookup occurs. User-only skills remain outside automatic selection.

`readSkill({ resourceId, offset?, limit? })` requires current membership and the registered trusted native read implementation. General read need not be active, but excluded/overridden implementations are unavailable. Read-shaped call/result hooks run unchanged. Target patching, catalog removal, reload, or retargeting cannot widen the grant. Native reads compare opened-descriptor identity before reading any content, preventing a same-path replacement from exposing adjacent data to reducers. Replaced files require resource reload; in-place changes are checked through normal whole-buffer revision evidence.

Evidence remembers whether it came from a workspace read or a skill resource. Collection revalidates through that original service, including current catalog membership and policies. Skill bodies remain untrusted optional context, never implicit instruction authority or permission to read sibling assets.

## Verification and exclusions

Tests use deterministic task barriers/clocks, faux model providers, native temporary skill files and fake LSP transports/processes. Coverage includes first-call/default behavior, maximum versus summed waits, retry/headroom/revocation, late timer delivery, resource identity and metadata projection, redaction and source invalidation, semantic action patching, shared startup/install races, and truthful foreground failures during managed-read contention.

Required gates: targeted changed tests, `npm run check`, and repository-root `./test.sh` before PR submission. No real helper model, network/install call, full build, or daemon restart is required.

No preparation extension, auxiliary provider, transparent cache/single-flight, repository index, autonomous workflow, native UI, RPC, or persisted task state ships in this PR. A deterministic consumer and provider evaluation remain separate follow-up work.

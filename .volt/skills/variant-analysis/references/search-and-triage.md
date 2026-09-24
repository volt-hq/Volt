# Search and triage techniques

Adapted from Trail of Bits; attribution and license are in the skill's `SOURCES.md`.

## Turn the seed into an invariant

Record these before searching:

| Field | Example for an async ownership bug |
|---|---|
| Operation | Publish a completed result to a session |
| State/value | Captured owner and generation |
| Required protection | Result still belongs to the current owner/generation |
| Trigger | Owner changes while an operation is awaiting |
| Consequence | Stale work is published to the replacement owner |

This is more useful than “missing generation check,” which presupposes a particular implementation. A different synchronization mechanism might enforce the same invariant correctly.

For data-flow defects, record source, transformations, sink, missing protection, and caller authority. For pure logic defects, state the input and output relationship that fails.

## Walk an abstraction ladder

1. **Literal calibration:** find the known expression or caller. If it was removed by a fix, inspect its historical revision without switching the worktree.
2. **Identifier generalization:** search real sibling names or references to the same API. Confirm that the names have the same meaning.
3. **Structural generalization:** identify equivalent sequences such as capture, await, mutate, regardless of variable names. A multiline regex can nominate candidates but cannot establish semantic order across functions.
4. **Semantic tracing:** follow values and ownership through callees, event handlers, retries, and error paths. Use supported LSP navigation or inspect the full source manually.

Change one search element at a time. Record the query, directory/revision, newly inspected candidates, confirmed matches, and false-positive reasons. Stop widening when matches stop teaching you about the root cause; a smaller grounded query is better than an untriaged report of hundreds of hits.

Search only the authorized scope. Do not ignore a requested cross-package hunt by searching just the seed directory, and do not turn a local repair into a cross-package audit without approval.

## Refute a candidate

Read the surrounding code and callers. Ask:

- Is the path reachable under the stated conditions?
- Can the caller control the relevant input or scheduling?
- Does a trusted earlier guard establish the invariant, and can it become stale?
- Is there another mechanism such as a lock, lease, immutable snapshot, cancellation fence, parameterized API, or constrained parser?
- Are apparent matches examples/tests intentionally constructing invalid states rather than production paths?
- Does a type constraint truly make the case impossible at runtime, or is external data merely asserted to have that type?

Classify each useful candidate as confirmed, refuted, or unresolved. An unreachable unsafe-looking helper may be a design concern, but is not automatically a current exploitable vulnerability. Say what would make it reachable.

## Reproductions that distinguish variants

Keep the seed's critical preconditions while changing the implementation path. For an async bug, control the pause and release points instead of relying on scheduler luck. For parser failures, preserve the malformed value through all transformations. For authorization, exercise the host entry point rather than calling an internal helper with assumptions the caller cannot satisfy.

Use the actual harness and public contract. Do not weaken validation or bypass the protecting layer simply to reproduce a candidate. A reproduction that bypasses a trusted guard has not proved the normal path vulnerable.

## Report compactly

- Original root cause and seed evidence.
- Scope, revisions, queries, and stopping reason.
- Confirmed variants: file/line, preconditions, impact, severity, confidence, reproduction.
- Refuted groups: what mechanism makes them safe.
- Unresolved candidates and validation gaps.
- Smallest proposed follow-up, including a focused regression or scanner rule if useful.

Do not create an issue, CI rule, dependency, or fix automatically. Do not infer complete absence of variants from a search returning no matches.

# Async and cross-component tracing

Adapted from Superpowers' root-cause tracing and condition-based waiting techniques; attribution and license are in the skill's `SOURCES.md`.

## Identify the first bad transition

Write an event timeline rather than relying only on the final stack trace:

| Order | Component | Owner/generation | Event | Expected invariant |
|---|---|---|---|---|
| 1 | Runtime | A / 1 | Start work | Work belongs to A / 1 |
| 2 | Store | A / 1 | Begin persistence | Publication waits for the required commit |
| 3 | Host | B / 2 | Replace runtime | Old work loses authority to publish to B |
| 4 | Callback | A / 1 | Finish old work | Completion cannot mutate B / 2 |

This is an illustrative hypothesis, not a description of a specific Volt implementation. Populate the real timeline from source and observations.

Trace backward from the failing event. Ask who created the value, who last mutated it, which branch owns it, and which callback retained it. Event-driven systems often lack a useful synchronous stack across the boundary; safe correlation IDs and explicit barriers are more informative than logging every payload.

## Instrument the boundary, not the secret

Record only what distinguishes competing hypotheses: stage, outcome, synthetic ID, monotonic sequence, generation, safe counts, and elapsed time. Check both sides of a handoff to identify the first divergence. A wall-clock timestamp alone does not prove ordering across processes.

Do not dump process environment, request objects, conversation text, credentials, authorization headers, or pairing tickets. Error messages and paths can also contain secrets; redact before sharing. Keep diagnostic output separate from machine-readable stdout and remove temporary probes after use.

## Control ordering

Prefer a promise/event that marks “entered the critical stage,” then explicitly release the blocked operation. Assert the intermediate state before release and the terminal state after all work has settled. Existing harness helpers should own the lifecycle; do not add a new scheduler architecture to fix one test.

For a bounded assertion wait in Vitest:

```typescript
import { expect, test, vi } from "vitest";

test("waits for an assertion, not a truthy callback", async () => {
  let ready = false;
  queueMicrotask(() => { ready = true; });
  await vi.waitFor(() => {
    expect(ready).toBe(true);
  }, { timeout: 1000, interval: 10 });
});
```

`vi.waitFor(() => ready)` is wrong for this purpose: returning false does not throw, so it can succeed immediately. Prefer an existing completion promise when available; bounded polling is a fallback for test observables, not a replacement for Volt's `jobs` wait tool.

For deadlines, debounce, or backoff, use a controlled clock and assert just before and at the boundary. Advancing time does not automatically settle external I/O. A test timeout reports a failure; explicitly abort and dispose any work that could continue afterward.

## Diagnose pollution separately from product behavior

If a test passes alone and fails after another:

1. Re-run the smallest known failing file pair in a controlled environment.
2. Compare retained mocks, environment changes, module-level state, clocks, listeners, file paths, ports, stores, and outstanding tasks.
3. Vary only the suspected predecessor/order within an explicit filtered test set. Do not expand into the live-provider suite.
4. Fix the missing ownership or cleanup, not the symptom with a global delay, blanket retry, or disabled isolation.

Use unique temporary resources and restore only the state owned by the test. Do not delete broad directories, reset the repository, or run an unreviewed upstream “find polluter” script.

## Distinguish repair from hardening

An entry guard, an execution-time authorization check, and a cleanup invariant can defend different threats. Add checks only where the evidence shows they are necessary for the requested outcome. “Validate every layer” can introduce inconsistent semantics and unnecessary scope. A fix should explain which invariant it restores and why the original path cannot bypass it.

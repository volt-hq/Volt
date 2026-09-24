# Mocking and time in Vitest 3

Adapted from Anthony Fu's Vitest skill; attribution and license are in the skill's `SOURCES.md`.

## Choose a narrow seam

Prefer an existing injected dependency or a spy on an owned object. Keep orchestration and state transitions real when those are the behavior under test. For coding-agent suite tests, use the faux provider and existing harness rather than mocking the session internals.

Give mocks concrete parameter and return types. `vi.mocked` is a TypeScript helper; it does not turn a real function into a runtime mock.

## Hoisting without inline imports

`vi.mock` factories run before normal module initialization. A factory cannot safely close over a later ordinary variable. Use `vi.hoisted` for the minimal state it needs, with top-level static imports and string module paths:

```typescript
import { beforeEach, expect, test, vi } from "vitest";
import { readLabel } from "./label-source.ts";

const mocks = vi.hoisted(() => ({
  readLabel: vi.fn<(id: string) => Promise<string>>(),
}));

vi.mock("./label-source.ts", () => ({ readLabel: mocks.readLabel }));

beforeEach(() => {
  mocks.readLabel.mockReset();
});

test("configures the imported seam", async () => {
  mocks.readLabel.mockResolvedValue("ready");
  await expect(readLabel("job-1")).resolves.toBe("ready");
  expect(mocks.readLabel).toHaveBeenCalledWith("job-1");
});
```

`./label-source.ts` is an illustrative module, not a Volt file. In real tests call the consumer being tested rather than only asserting the mock's configured behavior. Type-only imports may describe mock signatures because they erase; do not access runtime imports inside `vi.hoisted`.

Do not use upstream recipes based on `vi.doMock` plus dynamic imports, `import("...")` type arguments, or `vi.mock(import("..."))`: they conflict with Volt's top-level import rule. `vi.resetModules()` also does not re-evaluate an already-bound top-level import. Find an existing reset/injection seam instead of inventing a module-reload workaround.

## Clear, reset, and restore differ

| Operation | Effect |
|---|---|
| `mockClear` | Clear call history; retain behavior |
| `mockReset` | Clear history and one-time behavior; restore the initial mock implementation |
| `mockRestore` | Also restore an object's original property descriptor when spying |
| `vi.unstubAllEnvs` / `vi.unstubAllGlobals` | Undo values changed by the corresponding stub APIs |

For Vitest 3, resetting `vi.fn(implementation)` restores that implementation; resetting a bare `vi.fn()` returns it to an empty function. Do not assume all resets produce `undefined` or that restoring spies un-mocks module factories. Read the installed declarations when exact behavior matters.

Use cleanup for resources the test actually owns. Environment stubs, globals, module mocks, and clocks are shared within a worker context; do not mutate them from concurrent tests.

## Control time deliberately

```typescript
import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

test("does not fire before the deadline", async () => {
  vi.useFakeTimers();
  const fired = vi.fn();
  setTimeout(() => { fired(); }, 100);

  await vi.advanceTimersByTimeAsync(99);
  expect(fired).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fired).toHaveBeenCalledTimes(1);
});
```

This demonstrates clock semantics; replace the raw timer with the production deadline/debounce operation in a real test. Prefer async timer advancement when callbacks schedule promise work. Avoid `runAllTimers` on recurring timers or retry loops; advance only the interval being tested. Dispose the production object before clearing remaining timers so blanket cleanup cannot hide a missing production cancellation path.

Await promise assertions and reject paths. For `vi.waitFor`, throw/assert until the condition holds; returning false is not a failed assertion. Fake timers do not complete sockets, child processes, or arbitrary promises, so use explicit completion signals for those boundaries.

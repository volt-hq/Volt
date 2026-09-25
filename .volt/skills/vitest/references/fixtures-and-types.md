# Fixtures, concurrency, and type assertions

Adapted from Anthony Fu's Vitest skill; attribution and license are in the skill's `SOURCES.md`.

## Resource ownership

Prefer existing Volt fixtures. When a new local fixture is genuinely needed, acquire per test, await its use, and release in `finally`. Keep temporary paths unique and cleanup restricted to the directory created by that fixture.

```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "vitest";

const test = base.extend<{ directory: string }>({
  directory: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "volt-skill-example-"));
    try {
      await use(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test("gets an isolated directory", async ({ directory, expect }) => {
  expect(directory).toContain("volt-skill-example-");
});
```

This is a fixture demonstration, not a test of Volt behavior. In production tests assert the file/store/session contract the directory supports. If teardown has multiple independent resources, ensure one cleanup failure does not prevent the rest from being released.

Fixtures are lazy unless configured otherwise. Destructure the fixtures a test consumes. Use broader file/worker scopes only when sharing is safe; an expensive resource is not automatically safe to share. Per-test fixtures do not reset state between fast-check examples inside the same test.

## Concurrency is a contract

Vitest can run files in workers and tests within a file concurrently; these are distinct mechanisms. Before adding `.concurrent`, check:

- No shared mutations of environment, fake timers, globals, spies, module factories, or singleton stores.
- Each test owns its path, port, database, session, and output sink.
- Cleanup cannot dispose a resource another test still uses.
- Assertions use the test context's `expect` when running concurrently.

Do not enable concurrency globally or disable isolation as an incidental speed improvement. A sequential annotation is appropriate only when sharing is intentional and documented, not as a way to conceal a leak. Diagnose scheduling failures with a bounded filtered test set; never run unfiltered Vitest for convenience.

## Type assertions need a compiler

`expectTypeOf` and `assertType` express compile-time contracts. Normal Vitest execution transpiles TypeScript and does not establish that those contracts passed a type checker.

```typescript
import { expectTypeOf, test } from "vitest";

type Result<T> = { ok: true; value: T } | { ok: false; error: Error };

test("success payload retains its type", () => {
  expectTypeOf<Extract<Result<string>, { ok: true }>["value"]>().toEqualTypeOf<string>();
});
```

Keep type assertions in files covered by the actual compiler configuration, or use an existing dedicated type-test setup. Root `npm run check` checks root-included test sources; confirm inclusion when working outside that set. Do not add `.test-d.ts` files and assume either Vitest or root checks will discover them automatically.

Use `@ts-expect-error` only for deliberate negative type tests, with an explanation of the rejected contract. Do not execute intentionally invalid calls in a runtime test merely to prove a type error. Place such checks in an appropriate non-executed type-test context.

Exact type equality and assignability answer different questions. Test the relation the public API promises, including inference at the call site, rather than asserting a convenient alias. For branded IDs, verify non-assignability where that distinction matters; type inequality alone does not establish every desired assignment restriction.

## Snapshot discipline

Snapshots should represent stable user-observable output. Inspect a changed snapshot against the intended behavior before updating it. Do not snapshot volatile IDs, timestamps, secrets, or the entire internal state simply because it is convenient. Prefer targeted assertions for lifecycle and authorization behavior. A passing snapshot is not a substitute for checking the missing error or cancellation path.

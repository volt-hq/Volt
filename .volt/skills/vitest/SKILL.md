---
name: vitest
description: Write and diagnose Volt's Vitest 3 tests using typed mocks, hoisting, fake timers, fixtures, concurrency isolation, and type assertions. Use for unit or harness testing and targeted test execution; not live-provider e2e testing or dependency upgrades.
license: MIT
metadata:
  upstream: antfu/skills
  upstream-commit: 5cae97ca87e0dcfb5a192cd2cbf8b83a9f769e8f
  baseline: Vitest 3.2.6
---

# Vitest for Volt

Adapted from Anthony Fu's Vitest 3.x skill revision; see [provenance and license](SOURCES.md). The upstream head targets a newer release. Treat the installed types and owning test configuration as authoritative, even for examples labeled 3.x.

## Start with the owning suite

1. Read the package manifest, Vitest configuration, nearby tests, and the observable contract under test.
2. Reuse existing fixtures. In `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` and the faux provider; do not create a competing harness or use real provider APIs, keys, or paid tokens.
3. Put issue regressions under `packages/coding-agent/test/suite/regressions/<issue-number>-<short-slug>.test.ts` when applicable.
4. Test public behavior, not private layout or source text. Text-content assertions are appropriate only when the output itself is a textual artifact.

## Choose the mechanism

| Need | Prefer | Avoid |
|---|---|---|
| Dependency behavior | Existing injection seam, typed `vi.fn`, targeted spy | Mocking the very logic being tested |
| Imported module replacement | Top-level string-path `vi.mock` with `vi.hoisted` state | Dynamic imports and import-expression type arguments |
| Async completion | Existing event/promise, then bounded assertion waiting | Arbitrary sleeps |
| Debounce/deadline behavior | Fake timers with deliberate advancement | Running every recurring timer blindly |
| Resource lifecycle | Per-test fixture with awaited cleanup | Shared global resources and leaked handles |
| Type contract | Compiler-checked positive and negative assertions | Treating transpiled test execution as a type check |
| Large input domain | The `property-based-testing` skill | Huge lists of redundant examples |

Read [mocking and time](references/mocking-and-time.md) or [fixtures, concurrency, and types](references/fixtures-and-types.md) as needed.

## Execution rules

All command paths below are relative to the repository root unless a `cd` is shown. From the owning package, use its installed CLI and an explicit file filter, for example:

```bash
cd packages/coding-agent
node node_modules/vitest/dist/cli.js --run test/skills.test.ts
```

Replace the example file with the actual changed test. Verify the CLI exists first. Vitest is installed under `packages/coding-agent/node_modules` and `packages/ai/node_modules`; for another package, resolve an existing installed CLI without reinstalling dependencies or changing the test's working directory assumptions.

- Run every created or modified test and iterate until it passes.
- Never run an unfiltered Vitest command: the full suite can activate live-provider e2e tests when credentials or endpoints are present.
- Use root `./test.sh` for broader non-e2e validation when justified. Do not run `npm test` or `npm run build` unless requested.
- Run root `npm run check` with full output after code changes. It does not run tests; an ordinary Vitest run does not establish type correctness.
- Do not upgrade Vitest, install coverage providers, replace configuration, or update snapshots merely to make an example work. Inspect the mismatch and stay in scope.

## Handoff

Give the focused command, actual result, behavior covered, and material gaps. Distinguish a test failure caused by the change from an environmental or pre-existing failure. Do not claim a full-suite pass from a filtered run.

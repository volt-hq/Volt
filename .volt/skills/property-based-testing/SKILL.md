---
name: property-based-testing
description: Design, review, and debug fast-check property tests for TypeScript codecs, parsers, normalization, and state machines. Use when testing invariants across an input domain or interpreting a shrunk counterexample, not for benchmarks or end-to-end UI tests.
license: CC-BY-SA-4.0
metadata:
  upstream: trailofbits/skills
  upstream-commit: 123037ec8aed26f0d86327cc39137ee5043e5deb
---

# Property-Based Testing

Adapted from Trail of Bits; see [provenance and license](SOURCES.md).

An example checks one input. A property expresses a contract over a domain and lets a generator search for counterexamples. Choose this technique when there is an invariant, inverse, independent oracle, or useful metamorphic relation; ordinary example tests remain appropriate elsewhere.

## Volt boundaries

- Follow `AGENTS.md` and the requested phase: a test review does not authorize implementation or refactoring.
- Reuse the package's installed `fast-check`; inspect its types rather than borrowing APIs from another version. Do not add dependencies without approval.
- Use existing public seams and fixtures. Do not redesign production APIs just to expose a property.
- For `packages/coding-agent/test/suite/`, use its harness and faux provider, never real provider calls or credentials.
- Read [fast-check techniques](references/fast-check.md) for generators, shrinking, async isolation, and model-based tests.

## Workflow

1. **Ground the property.** Read the implementation, callers, specification, and existing tests. State the promised input domain and observable guarantee. Type declarations alone do not validate external input.
2. **Choose complementary assertions.** Prefer meaningful behavior over only checking that nothing throws.

   | Property | Example target | Important limitation |
   |---|---|---|
   | Round-trip | Decode an encoded message | Encoder and decoder can share a bug; also test known wire fixtures |
   | Idempotence | Normalize twice, get the same result | A constant function is idempotent; assert semantic preservation too |
   | Invariant | A terminal job cannot become running again | Generate sequences that actually reach the state |
   | Independent oracle | Compare an optimized parser with a trusted reference | Do not duplicate the implementation in the test |
   | Metamorphic relation | Rechunk a byte stream without changing parsed records | Preserve framing and encoding semantics |

3. **Construct the domain.** Generate valid inputs directly. Add a separate invalid-input property for documented rejection behavior. Bound lengths, depth, and sequence counts so failures remain diagnosable.
4. **Isolate each run.** Create fresh state for every generated example, not just every Vitest test. Await async properties and clean up resources even when shrinking finds a failure.
5. **Review test strength.** Look for tautologies, discarded inputs, assertions inside unreachable branches, swallowed exceptions, and mocks that bypass the code being tested. Name a plausible defect the property would detect.
6. **Triage failures.** Separate a real contract violation from an invalid generator, incorrect property, ambiguous specification, or environmental failure. Keep the shrunk input, seed, and replay path. Do not weaken the contract just to get green tests.
7. **Validate narrowly.** Run the changed test from its package root with the installed Vitest CLI. After code changes, run root `npm run check` with full output. Do not run `npm test`, `npm run build`, or unrestricted Vitest; use root `./test.sh` only when broader non-e2e coverage is justified.

For Volt, likely targets include JSONL framing, session serialization, streaming chunk boundaries, permission-set composition, and lifecycle transitions. These are candidate properties, not claims about guarantees those modules currently make.

## Handoff

Report the contract tested, generator boundaries, seed/path for failures, focused command and result, and any uncovered domain. If no useful property exists within scope, say so rather than manufacturing one.

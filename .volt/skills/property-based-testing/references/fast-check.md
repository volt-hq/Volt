# fast-check techniques for Volt

Adapted from Trail of Bits; attribution and license are in the skill's `SOURCES.md`.

## Generate the contract's domain

Construct constrained inputs rather than discarding almost every example with `.filter` or `fc.pre`. Use `fc.record`, bounded arrays, and `.chain` for dependent fields. Constraints must remain valid during shrinking.

```typescript
import fc from "fast-check";
import { expect, test } from "vitest";

const arrayAndIndex = fc.array(fc.integer(), { minLength: 1, maxLength: 32 }).chain((values) =>
  fc.record({
    values: fc.constant(values),
    index: fc.integer({ min: 0, max: values.length - 1 }),
  }),
);

test("generated indices remain in range", () => {
  fc.assert(fc.property(arrayAndIndex, ({ values, index }) => {
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(values.length);
  }));
});
```

This checks the example generator, not production behavior. In a real regression, use the generated pair to exercise the public operation and assert its promised result.

Do not assume default `fc.string()` covers all JavaScript strings. In fast-check 4.9 its default unit is printable ASCII. Select the domain deliberately:

- `fc.string({ unit: "grapheme", maxLength: 32 })` for printable graphemes, not a strict bound on UTF-16 code units or bytes.
- `fc.string({ unit: "binary", maxLength: 32 })` for arbitrary Unicode scalar values, including controls, but not lone surrogates.
- Bounded arrays of integers from `0` to `0xffff`, mapped through `String.fromCharCode`, when arbitrary UTF-16 code units are part of the contract.
- `fc.uint8Array` for raw byte parsers; valid text generators alone cannot exercise malformed byte sequences.

Pin known boundaries in ordinary regression tests or fast-check's `examples` option. Include empty input, embedded LF/CR, null bytes, Unicode separators, and lone surrogates only when relevant. Specify whether equality is byte identity, code-unit identity, normalized text, or semantic equality.

## Assert independent behavior

For a streaming parser, a useful relation is that every legal chunking of the same encoded input yields the same records. Also compare against explicit expected records: two broken paths agreeing is not enough. If the parser works on bytes, split encoded bytes rather than JavaScript characters so tests include splits inside multibyte sequences.

For normalization, assert idempotence plus preservation of meaningful information. For permission composition, a candidate invariant is that a restriction cannot add authority; establish the intended inheritance and override rules first.

Do not rank properties mechanically: a round-trip can be weaker than an independently specified invariant. Ask which realistic defect could survive all the assertions.

## Async state and cleanup

Use `await fc.assert(fc.asyncProperty(...))`. Each predicate invocation, including shrink attempts, must get a fresh harness, store, clock, and resource identity where needed. A Vitest `beforeEach` runs once per test, not once per generated example. Clean up in `finally`, and await both the operation and disposal.

A fast-check time limit or Vitest timeout does not necessarily cancel the underlying task. Use a real abort/disposal path and bound operation counts. Do not let a timed-out candidate keep writing while the next candidate starts.

## State-machine testing

Use installed `fc.commands` and `fc.asyncModelRun` when sequences matter:

1. Model only the public state and the invariant, not a copy of the implementation.
2. Generate commands such as start, cancel, complete, replace, and read, with relevant parameters.
3. Use command preconditions for legal operations. Test rejected operations explicitly where rejection is itself part of the contract; do not silently skip the interesting invalid sequence.
4. Execute against a fresh real harness and compare observable results with the model after each command.
5. Bound sequence length, ensure important states are reached, and retain the shrunk sequence.

Sequential model commands do not prove concurrent correctness. For races, control the ordering with explicit barriers or a suitable existing scheduler fixture. Do not assume arbitrary async work is controlled merely because fast-check generated the commands.

## Reproduce and classify

Record the failing seed, shrink path, shrunk input, library version, and property revision. Replay with the same property and generator using `seed` and `path`; changed generators can invalidate a saved path. Keep a small deterministic example of a confirmed bug so future generator edits cannot lose it.

Distinguish:

- **Implementation bug:** in-domain input violates a promised guarantee.
- **Generator/property bug:** input is out of domain or the assertion invents a guarantee.
- **Ambiguous contract:** an edge case needs a maintainer decision.
- **Isolation failure:** retained state, timers, or external I/O makes the result order-dependent.

Do not catch every exception and return success. Assert the documented rejection outcome and let unexpected errors fail. State the tested bounds; finite randomized runs do not prove the entire domain correct.

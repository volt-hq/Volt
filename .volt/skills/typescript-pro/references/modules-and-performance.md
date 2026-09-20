# Module boundaries and compiler cost

Adapted from Jeffallan's TypeScript Pro; attribution and license are in the skill's `SOURCES.md`.

## Diagnose the actual resolver

Separate four questions:

1. Which source does the editor/compiler resolve?
2. Which source does Node's source launcher execute?
3. Which entry does a bundler select?
4. Which JavaScript and declarations will a package consumer resolve?

A successful workspace import proves only that particular resolution path. Inspect `type`, `exports`, export conditions, declared types, relative suffixes, tsconfig inheritance, and source-launcher conventions. Root `paths` mappings can hide a missing package export; they do not rewrite runtime import specifiers.

In Volt, follow the existing `.ts` source import conventions and export tooling rather than substituting generic NodeNext or bundler recipes. Keep type-only imports at the top level. When investigating a resolution failure, inspect the precise package subpath and installed declaration, then use a narrow no-emit resolution trace only if needed. Do not change module mode, add aliases, emit build artifacts, or add fallback exports just to silence the error.

## Keep strip-only execution valid

Code checked by the root config must use erasable TypeScript. Replace proposed enums with const objects/unions, use explicit fields and constructor assignments instead of parameter properties, and avoid namespaces, import assignments, and dynamic imports. A syntax choice that compiles through an emitting transpiler can still fail in Node's strip-only source path.

Package boundaries also involve side effects. Replacing a type-only import with a runtime barrel import may eagerly load providers or native dependencies. Inspect imports and the owning package's lazy-loading contract before editing; do not refactor those boundaries opportunistically.

## Measure compiler work before optimizing

For a reproducible type-check slowdown:

- Establish the exact compiler version, tsconfig, input set, and comparable cold/warm conditions.
- Use the installed compiler in no-emit mode with `--extendedDiagnostics` for the owning project. Capture total time, memory, instantiation counts, and check time.
- Reduce the implicated type expression in a temporary fixture. Preserve the failing union sizes, recursion depth, and call-site inference that trigger the cost.
- Common causes include distributive conditionals over large unions, template-literal cross products, repeated anonymous intersections, and unbounded recursive mapped types.
- Try naming reusable intermediate types, preserving existing discriminants, bounding recursion where the domain permits, or simplifying an unnecessary generic layer. Compare measurements and type-contract tests after one change.
- Use compiler tracing only if the smaller evidence is insufficient. Keep generated traces outside the repository and do not upload them; they can contain project paths and source details.

Do not toggle `skipLibCheck`, strictness, project references, or dependencies as a speculative optimization. Ask before a material build/configuration change. Tool or compiler incompatibility is a blocker to report, not justification for weakening code.

## Verify both kinds of contract

Use compile-time assertions for inferred return types, correlations, invalid arguments, and exhaustive unions. Use runtime tests for validation, mutation, serialization, error behavior, and authorization. A type assertion can pass while runtime validation is absent; a runtime Vitest test can pass while its source has a type error.

Run the repository's required checks after implementation, without invoking an unrequested build. If a published-package behavior cannot be established without a build or release fixture, state that validation gap and ask for the needed workflow rather than claiming workspace checks prove it.

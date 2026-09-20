---
name: typescript-pro
description: Design and diagnose advanced TypeScript types, discriminated state unions, generic inference, runtime guards, ESM package boundaries, and compiler performance. Use for difficult type errors or type/API design, not to impose new compiler flags or redesign unrelated code.
license: MIT
metadata:
  upstream: Jeffallan/claude-skills
  upstream-commit: 882ef55e377dbf9a4dbe496bb41ac6ccd0e555cf
---

# TypeScript Pro

Adapted from Jeffallan's TypeScript Pro; see [provenance and license](SOURCES.md).

Use types to express real invariants and preserve useful inference. Prefer a small, readable type model over an elaborate abstraction that merely moves assertions around.

## Establish the environment

1. Read the owning package manifest, effective tsconfig chain, relevant source, and tests. Distinguish source execution, bundling, declaration generation, and consumer resolution.
2. Inspect installed dependency declarations before using external APIs. A documentation example targeting a different release is not sufficient evidence.
3. Use available LSP status, definitions, references, and hover for semantic navigation. Confirm diagnostics with the owning compiler check; stale LSP output is not proof of correctness.
4. Classify the failure: runtime validation, incorrect state model, inference loss, variance, module resolution, declaration boundary, or compiler cost.

## Type-design workflow

- Start from valid and invalid values and transitions. Use discriminated unions when fields depend on lifecycle state; keep the discriminator and payload correlated.
- Accept `unknown` at untrusted boundaries, then parse or validate into the domain model. A cast, brand, generic parameter, or `satisfies` expression is not runtime validation.
- Introduce a generic only when it preserves a relationship between inputs and outputs. Prefer indexed access and built-in utilities over custom recursive machinery.
- Use brands selectively when structurally identical identifiers cause real mistakes. Validate at construction; do not cast strings to brands throughout the codebase.
- Preserve inference with appropriate constraints and `satisfies`. Use explicit return contracts at meaningful public boundaries without forcing annotations on every local expression.
- Make union handling exhaustive. Include negative type tests for invalid combinations and runtime tests for external data and behavioral contracts.

Read [type design and narrowing](references/type-design.md) for examples and pitfalls.
Read [module boundaries and compiler cost](references/modules-and-performance.md) for resolution and performance investigations.

## Volt constraints

- Keep the active objective fixed. Ask before changing public APIs, protocol shapes, architecture, dependencies, or unrelated compiler configuration.
- Use erasable TypeScript syntax in root-checked code: no enums, namespaces, parameter properties, or import/export assignments. Use explicit fields and constructor assignments.
- Use top-level imports, including `import type`; no inline type imports or dynamic imports. Follow existing relative import suffixes and package export conventions.
- Do not introduce `any`, blanket suppressions, double casts, fallback compatibility layers, or weakened compiler settings to hide a mismatch. Explain a genuinely unavoidable assertion at the boundary that justifies it.
- Do not replace Volt's Biome/npm tooling or add type-coverage, tRPC, or build tooling because upstream examples use them.
- A request for advice or review is not authorization to edit. Implement only the requested change and its directly necessary support.

## Verification

Run each changed test using the owning package's installed Vitest CLI. After code changes run root `npm run check` with full output; it checks types but does not run tests. Never run `npm test` or `npm run build` unless requested. Do not use an unrestricted Vitest run; root `./test.sh` is the broader non-e2e path when needed.

Report the invariant or type error addressed, the boundary still requiring runtime validation, and actual validation results. Distinguish an environmental or pre-existing dependency mismatch from a regression in the change.

---
name: variant-analysis
description: Find other instances of one confirmed bug or violated invariant using calibrated search and caller-level verification. Use when asked whether a known bug exists elsewhere, including after a fix; not for initial vulnerability discovery or automatic expansion of a narrow repair.
license: CC-BY-SA-4.0
metadata:
  upstream: trailofbits/skills
  upstream-commit: 123037ec8aed26f0d86327cc39137ee5043e5deb
---

# Variant Analysis

Adapted from Trail of Bits; see [provenance and license](SOURCES.md).

Find manifestations of one root cause, not everything that looks imperfect nearby. A match is a candidate, not a finding.

## Scope

A confirmed bug is the starting evidence, not permission for a repository-wide audit or repair. Use the user's requested search boundary. If they ask for a repository-wide hunt, search across relevant packages; if they ask only for a local fix, report the broader opportunity and ask before expanding. Discovery does not authorize fixes, CI rules, dependency installs, commits, or external reports.

## Five steps

1. **Extract the root cause.** Reproduce or otherwise verify the known instance. State either an input-to-operation failure (untrusted data reaches an operation without a required check) or a violated invariant (a cancelled operation can still publish results). List the necessary preconditions and the protection that should have applied.
2. **Calibrate an exact search.** Confirm that the first pattern finds the known instance. For an already-fixed bug, inspect the pre-fix revision without changing branches, or calibrate against a minimal fixture. A pattern that never matches the seed is not validated.
3. **Choose grounded expansion axes.** Look for real sibling implementations, callers of the same API, alternate names for the same authority, error/fallback paths, and async continuations. Do not invent identifiers or widen to unrelated vulnerability classes.
4. **Generalize one element at a time.** Use LSP references/callers when supported, and `rg` for lexical patterns. Read new matches after each expansion. Track queries and coverage; narrow or switch axes when noise dominates. Use Semgrep or CodeQL only if available and warranted; do not install them or treat scanner output as proof.
5. **Refute before confirming.** Read candidate functions and their callers, identify control over the relevant values, and look for validation, unreachable paths, or distinct semantics that make the case safe. Reproduce the violated invariant through a public seam when feasible.

Read [search and triage techniques](references/search-and-triage.md) when constructing a hunt.

## Volt-specific axes

Only when relevant to the seed bug, consider:

- Provider adapters implementing the same stream or cancellation contract.
- Local, RPC, and remote paths for the same operation, without assuming they have identical authorization policies.
- Parent/child sessions, branch ownership, stale generation checks, and background job completion.
- Validation before versus after extension hooks, repair/retry transformations, or resource replacement.
- Equivalent parsers, path handling, and serialization boundaries in the approved packages.

These are search leads, not assertions that bugs exist.

## Handoff and stopping rule

Return the original root cause; scope and revisions inspected; queries tried, including unsuccessful ones; confirmed variants with file/line evidence, severity, confidence, and reproduction; grouped false positives; and unexamined paths or tool limitations.

Separate reachable failures from latent design concerns. If no variant is verified, say **no confirmed variants within the searched scope**, not that the codebase is bug-free. Stop when the grounded axes have been examined or the agreed search budget is exhausted. Recommend follow-up tests or rules without adding them unless requested.

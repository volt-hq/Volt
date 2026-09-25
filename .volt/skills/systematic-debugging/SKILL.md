---
name: systematic-debugging
description: Investigate reproducible bugs, flaky tests, streaming failures, cancellation races, and cross-component failures through evidence, root-cause tracing, and minimal experiments. Use before proposing speculative fixes, especially after an unsuccessful attempt.
license: MIT
metadata:
  upstream: obra/superpowers
  upstream-commit: 5bf4e78011075bcfc0dc295f0724994cd123ee71
---

# Systematic Debugging

Adapted from Jesse Vincent's Superpowers; see [provenance and license](SOURCES.md).

Understand the failing contract before changing code. Scale the process to the problem: a clear one-line defect does not need a lengthy ceremony; an intermittent race needs more than a plausible story.

## 1. Gather evidence

- State expected versus observed behavior and the affected boundary.
- Read the full error, relevant source, callers, tests, and applicable project instructions. Check `git status` for concurrent work; do not reset or stash other changes.
- Reproduce with the narrowest existing test or a controlled fixture. Record the command, environment assumptions, input, and result.
- Use LSP definitions/references when supported. Trace backward from the bad value or event to the first point where the invariant fails.
- Check relevant recent changes without switching branches. Treat correlation as a lead, not proof of causation.

When instrumentation is necessary, capture event names, safe correlation IDs, ownership/generation, and state transitions. Never dump environment variables, auth headers, tokens, pairing tickets, prompts, or entire request payloads. Keep diagnostic output off protocol stdout. Use synthetic data and remove temporary instrumentation after the investigation.

## 2. Compare and hypothesize

Find a working path with the same contract. Compare validation, state ownership, ordering, cleanup, and dependencies. State one falsifiable hypothesis:

> When X happens before Y, state Z is stale, so operation W violates invariant I.

Design an observation that distinguishes it from the next-best explanation. Do not make several speculative changes together or invent an external cause that has not been measured.

Read [async and cross-component tracing](references/async-tracing.md) for lifecycle and test-isolation investigations.

## 3. Run the smallest experiment

Prefer deterministic events, latches, injected clocks, and existing fixtures over sleeps. A test timeout bounds failure; it is not synchronization. If the issue cannot be reproduced, report that limit and gather evidence rather than presenting a guess as a diagnosis.

For session-owned tool jobs, use `jobs` to collect results and await completion; do not poll with sleeps. Do not spawn agents merely because debugging is difficult. Load the existing `view-cli` skill when actual TUI rendering is part of the reproduction.

## 4. Fix only when authorized

A debugging or review request may be investigation-only. Once implementation is authorized:

1. Capture the failure with an observable regression test or the smallest reliable reproduction.
2. Fix the responsible invariant at the owning boundary. Do not add catch-all retries, longer sleeps, silent defaults, or redundant validation layers to conceal the cause.
3. Verify the original path and directly affected behavior. Use the coding-agent suite harness and faux provider where required.
4. Run modified focused tests and root `npm run check` after code changes. Do not run `npm test`, `npm run build`, or unrestricted Vitest. Use root `./test.sh` only when broader non-e2e validation is justified.
5. Remove temporary diagnostics and report any unresolved coverage.

## When an attempt fails

Return to the hypothesis and record what the experiment disproved. After repeated failures, stop stacking patches: summarize evidence, missing observations, and whether the scope or architecture needs discussion. Repeated failure is not itself proof that the architecture must change.

Classify validation failures as caused by the change, directly blocking the objective, or unrelated/pre-existing/environmental. Fix the first, handle direct blockers minimally, and report the others without opportunistic repairs.

## Handoff

Report the cause and supporting evidence, what changed (if anything), exact validation results, and remaining uncertainty. Do not claim success from a command that was not run or a background job that has not completed.

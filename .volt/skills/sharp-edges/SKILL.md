---
name: sharp-edges
description: Review security-sensitive APIs and configuration for misuse, dangerous defaults, ambiguous values, and fail-open behavior. Use for Volt tool grants, project trust, MCP, remote authorization, and extension boundaries; not a generic performance or style review.
license: CC-BY-SA-4.0
metadata:
  upstream: trailofbits/skills
  upstream-commit: 123037ec8aed26f0d86327cc39137ee5043e5deb
---

# Sharp Edges

Adapted from Trail of Bits; see [provenance and license](SOURCES.md).

Ask whether ordinary callers can use an API safely without remembering hidden rules. Documentation helps, but does not replace enforcement of a promised security boundary.

## Scope and authority

- This is an analysis workflow, not automatic authorization to harden or remove functionality.
- Establish the intended threat model. A deliberately powerful local tool is not a vulnerability merely because it can modify files; a restricted caller reaching it without the required grant may be.
- Use Volt's available `read`, semantic LSP queries, and scoped repository searches. This skill does not install an agent, grant tools, or require delegation.
- Use local fixtures and synthetic credentials for reproductions. Do not contact live services, expose secrets, or execute attacker-supplied payloads outside a controlled test.

## Four-stage review

### 1. Map the surface

Within the requested scope, identify entry points, callers, trust levels, defaults, configuration precedence, authorization decisions, and side-effecting operations. Trace how input reaches the actual enforcement point, including extension hooks and asynchronous continuations.

Record the security promise explicitly: who may request what operation on which resource, and which host-owned fact grants that authority?

### 2. Probe ambiguous cases

| Category | Questions |
|---|---|
| Defaults | Does omission deny, inherit, or grant? What happens after parsing fails? |
| Empty values | Are `undefined`, `null`, `""`, `[]`, `0`, and `false` deliberately distinct? |
| Bounds | Are numbers finite, integral where required, and bounded? What do negative values mean? |
| Configuration | Are strings such as `"false"` rejected rather than coerced? Which override wins? |
| Semantic identity | Can session IDs, workspace IDs, device IDs, or grant types be accidentally interchanged? |
| Error handling | Can a caught error, timeout, stale cache, or fallback bypass authorization? |
| Lifetime | Can revocation, reconnect, reload, or resource replacement invalidate an earlier check? |
| Mutation | Can data change between validation and execution, including through hooks or shared references? |

Read [TypeScript trust-boundary patterns](references/trust-boundaries.md) for concrete probes.

### 3. Test realistic misuse

Consider a caller following the first example, one misunderstanding configuration, and an attacker controlling only the stated untrusted inputs. Keep these cases separate: a trusted administrator deliberately disabling a control is different from an untrusted caller silently disabling it.

Trace the complete path and seek counterevidence. A suspicious snippet may be protected by a trusted upstream guard; a TypeScript annotation alone is not that guard.

### 4. Validate and report

For each finding establish the precondition, observable behavior, violated promise, reachability, and impact. Prefer a small host-level reproduction demonstrating the actual misuse. Label hypothetical future callers as design concerns, not confirmed exploits.

Report severity and confidence separately, with file/line evidence and the smallest suggested mitigation. Do not assign severity solely from a pattern name. Record material safe cases and validation limits.

## If implementation is requested

Ask before changing APIs, protocols, defaults with intentional behavior, dependencies, or architecture beyond the approved objective. Enforce at the authoritative boundary; add further checks only when they defend a distinct bypass path. Do not add legacy compatibility branches.

Use the existing test harness and faux provider for coding-agent suite tests. Run changed focused tests and root `npm run check` after code changes. Do not invoke builds, `npm test`, or unrestricted Vitest as part of this review.

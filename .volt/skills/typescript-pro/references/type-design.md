# Type design and narrowing

Adapted from Jeffallan's TypeScript Pro; attribution and license are in the skill's `SOURCES.md`.

## Preserve state/payload correlation

A flat object with optional fields admits contradictory states. A discriminated union makes the intended combinations explicit:

```typescript
type Operation<T> =
  | { status: "running"; startedAt: number }
  | { status: "completed"; value: T }
  | { status: "failed"; error: Error }
  | { status: "cancelled"; reason: string };

function describeOperation<T>(operation: Operation<T>): string {
  switch (operation.status) {
    case "running": return `Started at ${operation.startedAt}`;
    case "completed": return "Completed";
    case "failed": return operation.error.message;
    case "cancelled": return operation.reason;
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unexpected operation: ${exhaustive}`);
    }
  }
}
```

This models values, not allowed transitions. The owner still needs runtime enforcement of cancellation, generation, and lifecycle rules. An exhaustive switch does not validate malformed external input.

When a generic request kind selects its payload, keep the pair correlated. A signature taking `kind: K` and `payload: Payloads[K]` may admit mismatched combinations if `K` is inferred as a union. A mapped discriminated union can carry both fields together:

```typescript
type Payloads = {
  read: { path: string };
  cancel: { jobId: string };
};

type Request = {
  [K in keyof Payloads]: { kind: K; payload: Payloads[K] };
}[keyof Payloads];

const example = { kind: "cancel", payload: { jobId: "job-1" } } satisfies Request;
```

Apply this pattern only when changing the relevant type contract is in scope.

## Guards must prove the promised shape

TypeScript trusts explicit predicates and assertion functions; it does not prove their bodies are sound. Checking only a discriminator cannot establish all fields of an object received from JSON.

```typescript
interface RetryConfig {
  attempts: number;
  enabled: boolean;
}

function isRetryConfig(value: unknown): value is RetryConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.hasOwn(value, "attempts")
    && "attempts" in value && typeof value.attempts === "number"
    && Number.isSafeInteger(value.attempts) && value.attempts >= 0
    && Object.hasOwn(value, "enabled")
    && "enabled" in value && typeof value.enabled === "boolean";
}
```

This illustrative guard accepts extra properties and assumes ordinary data objects. For a boundary accepting arbitrary in-process objects, getters and proxies can execute during inspection; use the boundary's actual threat model. Reuse the project's established schema validator rather than adding a parallel framework.

Test missing fields, null, arrays, inherited fields, wrong discriminators, non-finite numbers, and nested invalid values as relevant. Do not confuse valid shape with authorization. Ownership and freshness must be checked against trusted state.

## Inference and conditional types

- `K extends keyof T` with return type `T[K]` preserves a key/value relationship; returning `unknown` loses it.
- `T extends U ? X : Y` distributes when `T` is a naked type parameter. `[T] extends [U] ? X : Y` checks the union as a whole. Test unions and `never`, not just one concrete type.
- Prefer `Awaited`, `ReturnType`, `Parameters`, `Pick`, `Omit`, and `Extract` before inventing equivalents.
- `satisfies` checks assignability without replacing the expression's type with the target type; contextual typing can still affect inference. It does not freeze values or validate them at runtime.
- `as const` preserves literal/readonly information, but is not a deep runtime freeze. Avoid leaking mutable aliases from supposedly immutable snapshots.
- Recursive mapped types need a defined treatment of arrays, functions, maps, sets, depth, and unions. A universal `DeepReadonly<T>` is not automatically a safe public contract.

## Brands and variance

A brand separates otherwise identical representations at compile time. Introduce one where ID mix-ups are a real risk, construct it at a validated boundary, and keep unavoidable assertions there. A brand is erased during serialization and proves neither ownership nor current validity.

For a subtype `Dog extends Animal`, a producer of `Dog` can be used as a producer of `Animal`. A callback accepting every `Animal` can serve where one accepting `Dog` is required, not vice versa. Under strict function checking, function-valued properties give stronger parameter checks than the method-syntax bivariance exception. Mutable generic containers and event handlers deserve explicit positive and negative type tests; do not infer soundness from a single assignment that compiles.

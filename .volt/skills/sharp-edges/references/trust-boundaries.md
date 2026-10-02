# TypeScript trust-boundary patterns

Adapted from Trail of Bits' sharp-edges guidance; attribution and license are in the skill's `SOURCES.md`.

## Parsing is not validation, and validation is not authority

Follow the sequence from raw input to parsed shape, normalized values, authorization, and execution. A TypeScript cast after `JSON.parse` does not validate fields. A valid identifier does not prove access to the corresponding object. A remote tool's self-reported read-only annotation is evidence to evaluate, not host authorization.

Questions for an operation:

- Which caller can influence each field? Is the source local configuration, a trusted extension, a provider response, or an untrusted remote request?
- Is the checked value exactly the value used? Can normalization, a hook, a retry, or a mutable alias change it afterward?
- Does the grant belong to this resource, session, branch, and generation?
- Can revocation or ownership replacement occur across an `await`? Does execution still have the needed authority afterward?
- On validation, discovery, or refresh failure, does the code deny or silently recover into broader access?

Do not assume every step needs a duplicate check. Identify the authoritative boundary and each independently bypassable path.

## Empty and inherited values

JavaScript makes several tempting shortcuts dangerous:

- `value || defaultValue` conflates `0`, `false`, and `""` with omission. `??` preserves those values but still merges null and undefined; neither operator defines the correct policy by itself.
- An empty array is truthy. Establish whether an empty allowlist means deny all, inherit, or a configuration error.
- `Boolean("false")` is true. Parse configuration using an explicit schema, not truthiness.
- `Number.isFinite` and integer/range checks address different contracts. `NaN` can bypass comparisons because both `NaN < bound` and `NaN > bound` are false.
- `parseInt("123suffix", 10)` returns `123`; a radix does not make it a strict numeric parser.
- `key in object` includes inherited properties. When own fields matter, use `Object.hasOwn` and validate values. It does not itself narrow a property type for every compiler pattern.

Defaults are policy decisions. Report ambiguous or unsafe behavior with a concrete path rather than demanding that all zero values or configurable controls be forbidden.

## Prototype hazards: prove the exact effect

Assigning a parsed own `__proto__` property to an ordinary object's legacy setter can change that target's prototype. It does **not** by itself prove that `Object.prototype` or every object was modified. Recursive merges following `constructor.prototype` can have a broader effect; inspect the actual algorithm.

Test own versus inherited properties and the precise destination. `Map`, null-prototype dictionaries, or explicit schema reconstruction can reduce risk, but choose according to the existing API contract. Do not add a generic key blacklist without checking all paths and merge semantics.

Use local disposable objects for demonstrations, not global prototype mutation in a shared test process.

## Paths, commands, URLs, and regexes

- A string prefix check is not directory containment: `/safe-other` starts with `/safe`. Account for separators, canonicalization, symlinks, platform case rules, and races according to the promised boundary.
- Lexical path normalization is not evidence about what a symlink resolves to. A pre-check can also become stale before opening a resource.
- Passing arguments without a shell prevents shell metacharacter interpretation, not every argument-injection issue. Check leading options and the called program's semantics.
- URL syntax validity does not establish acceptable scheme, origin, redirect target, or credential forwarding. Apply the intended network policy, not a generic ban on all configurable endpoints.
- Suspicious regex nesting is a lead, not a proven denial of service. Establish attacker control and input bounds; use tightly bounded local experiments rather than hanging the application event loop.

## Tokens and lifecycle

For one-time or expiring tokens, check generation, storage, expiry units, consumption atomicity, replay, revocation, and cleanup. Two concurrent requests must not both succeed if the contract promises single use. A negative lifetime in `created + lifetime > now` normally expires earlier, not later; reason from the actual comparison instead of assuming a familiar pattern is vulnerable.

Use synthetic tokens and record only safe identifiers or state. Do not include secrets in findings, logs, shell commands, or screenshots.

## Evidence standard

Describe the security promise, caller's actual control, reachable operation, protection sought, protection found or missing, and observed impact. Separate a confirmed bypass from an intentionally powerful trusted feature, a hypothetical future misuse, or an untested concern. Suggest a focused mitigation without changing intentional functionality unless approved.

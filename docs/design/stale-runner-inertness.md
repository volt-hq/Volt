# Design: Make disposed/stale extension runners inert after session replacement

> **Status: implemented (2026-07-03).** Layers 1–4 landed in
> `packages/coding-agent/src/core/extensions/runner.ts`,
> `packages/coding-agent/src/core/agent-session.ts`, and
> `packages/agent/src/agent-loop.ts`. Deviations from this doc:
>
> - `emitError` on a stale runner drops silently (no `onStaleError` debug sink
>   was added): with Layer 1 gating, handlers never run on a stale runner, so
>   stale `emitError` calls are defense-in-depth only.
> - The agent-loop abort guard permits pending (steering) messages:
>   `if (signal?.aborted && pendingMessages.length === 0)`. Queued user input
>   survives abort by contract (`agent-session-concurrent` codifies this), and
>   the provider stream itself observes the aborted signal. A disposed session
>   cannot use this path because dispose() clears both queues.
>
> Tests: `packages/coding-agent/test/extension-runner-stale-inertness.test.ts`,
> `packages/coding-agent/test/agent-session-dispose-inertness.test.ts`,
> `packages/coding-agent/test/agent-session-reload-invalidation.test.ts`,
> `packages/agent/test/agent-abort-between-turns.test.ts`.
>
> Layer 5 (no idle-wait in teardown) required no code change. Layer 6
> follow-ups (EventBus generational unsubscribe, interactive-mode shortcut ctx
> bypass, autocomplete factory accumulation) remain open.

## Problem

An iOS client reconnect replaced the host `AgentSession`. The old session was
disposed (runner "invalidated"), but the old `Agent` run kept executing and
issued a provider request. `onPayload → emitBeforeProviderRequest` ran extension
handlers on the invalidated runner; a handler touched the stale `ctx`, threw, was
caught, and `emitError` delivered an `extension_error` to the still-attached
remote client through a never-unsubscribed error listener.

Root cause is a set of gaps that let a *dead generation* keep producing
externally-visible side effects:

- Invalidation is **lazy** (only `ctx` property access throws), so emit paths
  still run handlers.
- `dispose()` is **incomplete** (never unsubscribes the error listener, never
  clears the runner ref, no disposed flag, leaves queued messages).
- The agent loop **does not check `signal.aborted`** between turns, and
  `continue()` mints a fresh `AbortController`, so an aborted run can resume.
- `reload()` **never invalidates the old runner**, violating the documented
  stale-ctx contract.

### Verified evidence (read on 2026-07-03)

- `runner.ts`: every emit path (`emit` 736, `emitMessageEnd` 770,
  `emitToolResult` 812, `emitToolCall` 862 [no try/catch], `emitUserBash` 885,
  `emitContext` 914, `emitBeforeProviderRequest` 946, `emitBeforeAgentStart` 980,
  `emitResourcesDiscover` 1046, `emitInput`, `emitError` 530) builds `ctx` and
  runs handlers with **no** `staleMessage`/`assertActive` gate at entry.
  `invalidate()` (510) only sets `staleMessage` + `runtime.invalidate`;
  `assertActive()` (519) throws only when a `ctx` getter is read.
- `agent-session.ts` `dispose()` (781–800): invalidates runner, disconnects
  agent, clears `_eventListeners`; does **not** call `_extensionErrorUnsubscriber`
  (declared 339, wired 2301), does **not** clear `_extensionRunnerRef.current`
  (326/2637), no `_disposed` flag, does not clear agent queues.
- `packages/agent/agent-loop.ts` `runLoop` (154–265): no `signal?.aborted` guard
  at the top of the turn iteration before `transformContext`/`streamFn`.
  `agent.ts` `abort()` (308) only flips `activeRun.abortController`; `continue()`
  (347) → `runPromptMessages` creates a new `AbortController` (465).
- `agent-session.ts` `_runAgentPrompt` (1034) / `_handlePostAgentRun` (1069) can
  call `agent.continue()` after dispose via queued messages / retry / compaction.
- `agent-session-runtime.ts` `teardownCurrent` (221) and `dispose` (497) call
  `session.dispose()` without any idle wait; daemon `stopEntry`
  (`integrated-runtimes.ts` 421) disposes on replacement (199/537) without
  awaiting idle.
- `agent-session.ts` `reload()` (2657) → `_buildRuntime` (2552) reassigns
  `this._extensionRunner` to a new `ExtensionRunner` built from
  `resourceLoader.getExtensions().runtime` (fresh runtime for normal reload) and
  never invalidates the previous runner/runtime.
- Agent has `clearSteeringQueue()` / `clearFollowUpQueue()` (agent.ts 282/287) —
  usable from `dispose()`.

## Decisions

The correctness strategy is **inertness, not synchronization**: a disposed or
superseded generation must become a no-op with zero side effects on any live
session or attached client. We do **not** try to await in-flight work during
teardown (deadlock-prone). Layers 1–4 are in scope now; layers 5–6 below.

### Layer 1 — Hard-gate `ExtensionRunner` (in scope)

Add a single guard read at the entry of every handler-invoking method. When
`staleMessage` is set, return the pass-through / no-op value immediately without
building `ctx` or running handlers:

| method | inert return |
|---|---|
| `emit` | `undefined` |
| `emitMessageEnd` | `undefined` (unmodified) |
| `emitToolResult` | `undefined` |
| `emitToolCall` | `undefined` (no block) |
| `emitUserBash` | `undefined` |
| `emitContext(messages)` | `messages` (unchanged) |
| `emitBeforeProviderRequest(payload)` | `payload` (unchanged) |
| `emitBeforeAgentStart` | `undefined` |
| `emitResourcesDiscover` | empty `{skillPaths, promptPaths, themePaths}` |
| `emitInput` | `{ action: "continue" }` (pass-through) |

Implement with a private `private get inert(): boolean { return this.staleMessage !== undefined; }`
and an early return at the first line of each method. `hasHandlers()` should also
report `false` when inert so callers (e.g. `_runAgentPrompt` input dispatch) skip
the emit entirely.

**`emitError` decision — gate it (drop to debug, do not notify listeners).**
Rationale: the production bug *is* a stale runner delivering `extension_error` to
a live remote listener. An inert runner must have no external side effects, so
when `staleMessage` is set `emitError` must not fan out to `errorListeners`.
To preserve diagnosability, route stale errors to an optional injected debug sink
(`onStaleError?(error)`, default `undefined`; wired to the existing debug logger
in the daemon). With Layer 1 gating, handlers never run on a stale runner, so
`emitError` from a handler `catch` is unreachable in practice — the gate is
defense-in-depth for any direct `emitError` callers.

Rejected alternative: keep `emitError` live but only for "same-session"
listeners. This needs generation identity on every listener and is fragile;
dropping-to-debug is simpler and strictly safe.

### Layer 2 — Complete `AgentSession.dispose()` (in scope)

Make dispose fully sever the generation:

1. Add `private _disposed = false;` set at the top of `dispose()`; make
   `dispose()` idempotent (early return if already disposed).
2. Call `this._extensionErrorUnsubscriber?.()` and clear it.
3. Clear the shared runner ref: `if (this._extensionRunnerRef?.current === this._extensionRunner) this._extensionRunnerRef.current = undefined;`
   (guard so we never null out a *replacement* generation's ref).
4. Clear agent queues: `this.agent.clearSteeringQueue(); this.agent.clearFollowUpQueue();`
   inside the existing try/catch.
5. Guard the continuation drivers on `_disposed`:
   - `_runAgentPrompt`: if `_disposed`, return before `agent.prompt`.
   - `_handlePostAgentRun`: return `false` when `_disposed` (stops the
     retry/compaction/queued-message continuation loops at 1038, 1193, and the
     compaction path in `prompt()` around 1200).
   This guarantees no `agent.continue()` (fresh AbortController) fires after
   dispose.

Order in `dispose()`: set `_disposed` → abort hooks / `agent.abort()` →
clear queues → invalidate runner → unsubscribe error listener → clear runner ref
→ disconnect agent → clear listeners → cleanup resources.

### Layer 3 — Abort check in the agent loop (in scope)

In `packages/agent/agent-loop.ts` `runLoop`, add a guard at the top of the inner
turn iteration, before `emit turn_start` / `streamAssistantResponse`:

```ts
if (signal?.aborted) {
	await emit({ type: "agent_end", messages: newMessages });
	return;
}
```

This mirrors the existing `stopReason === "aborted"` handling (which already
emits `agent_end` and returns), so run-promise resolution and event settlement
are unchanged. It stops an aborted run from issuing `transformContext` and
provider requests on the next turn. `continue()` still mints a fresh controller
by design; Layer 2's `_disposed` guard prevents the session from *calling*
`continue()` after dispose, so the fresh-signal path is no longer reachable for a
dead generation.

### Layer 4 — Invalidate the old runner on reload (in scope)

`reload()` must honor the documented contract ("do not use the old ctx after
`await ctx.reload()`"). In `_buildRuntime`, capture the previous runner before
reassignment and invalidate it **only if it is a distinct generation** (different
runtime object), so we never kill the freshly-built runner in the
`resolveProjectTrust` path that reuses `preTrustExtensions.runtime`:

```ts
const previousRunner = this._extensionRunner;           // may be undefined on first build
// ... construct newRunner from extensionsResult.runtime ...
this._extensionRunner = newRunner;
previousRunner?.invalidateStaleGeneration(extensionsResult.runtime);
```

Add `ExtensionRunner.invalidateStaleGeneration(nextRuntime: ExtensionRuntime)`:
no-op when `this.runtime === nextRuntime`, otherwise call `this.invalidate()`.
This sets `staleMessage` on the old runner (Layer 1 makes its emits inert) and
calls the old `runtime.invalidate`, so old `volt`/`ctx` closures captured by the
previous extension generation throw via `assertActive` — including any re-entrant
`streamSimple` provider closures registered against the old runtime.

### Layer 5 — Teardown ordering: abort, do not await idle (decision)

Do **not** make `teardownCurrent` / runtime `dispose` / daemon `stopEntry` await
`session.waitForIdle()`. Extensions can call `ctx.newSession()` / `switchSession`
/ `fork` / `reload` from a handler that is itself running *inside* a turn;
awaiting idle from within that path would wait for the turn that is waiting for
the handler — a deadlock. Correctness comes from Layers 1–3 making the superseded
generation inert, plus the existing synchronous `agent.abort()`.

Daemon replacement paths (`stopEntry` at 199/537) may keep a **bounded, optional
best-effort** race (e.g. `Promise.race([waitForIdle(), timeout(N ms)])`) purely
to reduce duplicate/partial output, never as a correctness requirement. Default:
no wait. This keeps replacement fast and hang-free.

### Layer 6 — F-item scope

In scope now (covered as side effects of Layers 1/2/4):

- In-flight tool wrappers holding the old runner via closure (`wrapper.ts`
  17–29): wrapped tools call `runner.createContext()`, whose getters
  `assertActive()`; once the runner is invalidated they are inert.

Follow-up issues (tracked separately; single-process / lower blast radius):

- Shared `EventBus` handlers from old generations never unsubscribed
  (`resource-loader.ts` 223) — needs generational subscription tracking + unsub
  on reload/dispose.
- Interactive-mode shortcut ctx bypassing staleness (`interactive-mode.ts`
  ~2166–2212) and autocomplete provider-factory accumulation (~2620) — route
  through the runner ctx / clear on rebuild.

## Ordered work items

1. **runner.ts** — add `inert` gate + early returns to all emit methods and
   `hasHandlers`; gate `emitError` to the `onStaleError` debug sink; add
   `invalidateStaleGeneration(nextRuntime)`. (Layer 1, part of 4)
2. **agent-loop.ts** — add `signal?.aborted` guard at top of inner turn loop.
   (Layer 3)
3. **agent-session.ts** — complete `dispose()` (`_disposed`, unsubscribe, clear
   ref, clear agent queues, idempotent); guard `_runAgentPrompt` /
   `_handlePostAgentRun` on `_disposed`. (Layer 2)
4. **agent-session.ts `_buildRuntime`** — capture previous runner and call
   `invalidateStaleGeneration(newRuntime)` after swap. (Layer 4)
5. **daemon wiring** — inject `onStaleError` debug sink into runner construction;
   confirm `stopEntry` needs no mandatory idle wait. (Layer 5)
6. File follow-up issues for the remaining F items. (Layer 6)

## Test plan (vitest, `packages/coding-agent/test`)

Conventions: temp dirs under `tmpdir()`, `registerFauxProvider` +
`fauxAssistantMessage`, extensions via `resourceLoaderOptions.extensionFactories`,
regression files `test/suite/regressions/<issue>-<slug>.test.ts`.

Regression: `test/suite/regressions/<id>-stale-runner-inertness.test.ts`

1. **Reconnect/replace does not deliver stale `extension_error`** (primary
   repro). Build a session whose extension registers a `before_provider_request`
   handler that reads `ctx.<stale-sensitive>` and throws; attach an error
   listener that records `extension_error`s. Start a run, `dispose()` the session
   mid-flight (before the provider request resolves), then let the old run's
   provider request drain. Assert: the recorded error list is empty and the
   handler's throw never reached the listener.
2. **Inert emits are pass-through.** After `invalidate()`, assert
   `emitBeforeProviderRequest(payload)` returns the same `payload`,
   `emitContext(msgs)` returns `msgs`, `emitToolCall` returns `undefined`, and no
   handler side effect fires. Unit-level against `ExtensionRunner`.
3. **Aborted loop stops issuing provider requests.** Faux provider counts stream
   invocations. Queue a follow-up so a second turn would run, `agent.abort()`
   before the next turn, assert no additional stream/provider call and the run
   ends via `agent_end`. (packages/agent unit or session-level)
4. **`dispose()` is complete & idempotent.** After `dispose()`: error listener no
   longer fires on subsequent (stale) errors; `_extensionRunnerRef.current` is
   cleared; agent queues are empty; calling `dispose()` twice is a no-op; a
   post-dispose queued message does not trigger `agent.continue()` (spy asserts 0
   continuations).
5. **`reload()` invalidates the old ctx.** Capture the old `ctx`/`volt` in an
   extension; after `await session.reload()`, using the old `ctx` throws the
   stale-message error, while the new generation's `ctx` works. Verify the new
   session still streams normally (no false invalidation) — covers the
   distinct-runtime guard.
6. **Existing suites stay green**, especially
   `regressions/2860-replaced-session-context`,
   `2753-reload-stale-resource-settings`, `agent-session-runtime`,
   `agent-session-queue`, `agent-session-compaction`.

Run: `bun run test` in `packages/coding-agent` and `packages/agent`.

## Risks & mitigations

- **False invalidation of the live generation** (Layer 4). The
  `this.runtime === nextRuntime` guard in `invalidateStaleGeneration` prevents
  invalidating a runner that shares the new runtime (trust-resolution reload).
  Test 5 exercises the live path.
- **Swallowing legitimate errors** by gating `emitError`. Only stale-runner
  errors are dropped, and they go to the debug sink; live runners are unaffected.
  Handlers on live runners still surface errors normally.
- **Behavioral change from the abort guard** (Layer 3): a run that was going to
  do one more turn now stops one turn earlier when aborted. This matches user
  intent for abort and mirrors existing aborted handling; covered by test 3 and
  existing loop tests.
- **`_disposed` guard hiding a real continuation** for a *live* session: the flag
  is only set in `dispose()`, so live continuations are unaffected. Idempotency
  test guards regressions.
- **Deadlock risk if someone later adds an idle-await in teardown** (Layer 5):
  documented explicitly; keep teardown abort-only, bounded race at most.

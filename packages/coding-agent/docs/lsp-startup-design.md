# LSP startup lifecycle ownership

This is a development contract for `src/core/lsp/client.ts`, `manager.ts`, and
`outcome.ts`. Startup is shared work, not a child of the operation that first
requested it. No dependency or wire-protocol changes are required.

## Ownership

- **Client:** `LspClient.start()` owns one memoized initialize handshake, its
  deadline, stderr drainage, and process cleanup on failure. Its terminal promise
  has an owner-installed rejection observer even when nobody waits for it. The
  observer does not replace the promise or turn failure into success; subsequent
  callers receive the same result. A failed/disposed client is never restarted.
- **Manager:** one `ManagedLspStartup` per client owns completion evidence and
  startup-failure accounting. It captures evidence at settlement, not when a
  caller stops waiting. Failure removes the failed client and increments the
  server/root breaker once; concurrent callers reuse that recorded failure.
  Successful startup clears the previous startup failure and begins its idle
  interval at completion.
- **Operation:** owns only its wait and its cold-start waiting duration.
  `waitForLsp` rejects cancellation promptly without cancelling shared startup.
  Even its pre-aborted branch observes the supplied promise, since that work has
  already been created. Entry guards avoid starting new work for known-cancelled
  operations, but are not a substitute for rejection ownership.

## Lifetime boundaries

Cancellation of every waiter does not release startup ownership. Startup still
finishes or reaches its initialize deadline, and the manager still records its
outcome. A client whose process has exited but is still draining startup stderr
remains the shared startup owner until that bounded drain completes; new callers
join it rather than launching a replacement prematurely.
Idle shutdown skips an initializing client; once startup completes, the
normal idle policy applies even if no operation remains.

Explicit restart or manager disposal does release ownership: clients are disposed
and removed. Completion handlers check the exact client identity against the
current server/root entry before updating evidence or breaker state. An old
completion must not overwrite evidence or count a failure against a replacement
client. Startup records use weak keys so removed clients are not retained solely
for accounting.

Request-level errors after successful startup remain operation-owned. They do not
increment the startup breaker. Automatic installation/repair has its own existing
lifecycle; this contract does not introduce a generic background-task framework.

## Verification

`test/lsp-startup.test.ts` covers pre-aborted and later cancellation, shared
results, no-waiter startup failure accounting, concurrent failure deduplication,
retained completion evidence, joining during stderr drainage, idle protection,
restart, and disposal.
`test/fixtures/lsp-startup-lifecycle.ts` runs in a separate Node process with
strict unhandled rejection handling. It deliberately leaves work without a
caller-installed observer through rejection, then confirms later callers still
receive the original failure. No global rejection handler hides a regression.

When extending startup, observe the final promise of every owner-created chain,
not just its input: a catch that enriches and rethrows creates another rejection
that still needs an owner. Do not move shared cleanup/accounting into a caller's
cancellable `finally` block.

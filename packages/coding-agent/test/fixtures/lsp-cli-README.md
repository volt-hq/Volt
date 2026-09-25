# Synthetic CLI LSP acceptance fixture

From `packages/coding-agent`:

```bash
node test/lsp-cli-runner.mjs --scenario deltas
node node_modules/vitest/dist/cli.js --run test/lsp-cli-diagnostics.test.ts
```

No build, installation, API credentials, actual TypeScript/Swift server, or paid
provider request is needed. Existing dependencies and the normal workspace-fs
native artifact must be available, just as for other source CLI tests.

The standalone command runs the same assertions as Vitest and prints a one-line
JSON summary on success. Failures exit nonzero with assertion evidence. Each child
uses a fresh source-transpilation cache, so all ten scenarios can take several
minutes. Use `--reporter=verbose` with Vitest for per-scenario progress, and allow
an overall command deadline longer than the sum of the per-child deadlines. Temporary
artifacts are removed on success **and** failure; there is no keep-temp mode.

## Scenarios

| Name | Contract |
| --- | --- |
| `deltas` | First error; unrelated comment edit suppresses identical findings; explicit diagnostics remains full; changed/new errors and warnings; fresh removal notice; recurrence. |
| `unversioned` | Same sequence with unversioned publications, explicitly unverified labels and no verified-clean removal claim. |
| `stale-only` | First current publication, then only old-version publications after changes: no stale diagnostic prose, automatic timeouts remain non-fatal, repeated text is suppressed, explicit diagnostics reports an error. |
| `no-publication` | No publication at all: timeout/unknown, never a clean check, while hover still works. |
| `global-disabled` | `lsp.autoDiagnostics: false`; writes and edits skip silently without starting a server; explicit diagnostics and hover still work. |
| `server-disabled` | Per-server `autoDiagnostics: false` overrides the default global true. |
| `server-enabled` | Per-server true overrides global false. |
| `swift-loose` | No Swift project marker; limited-context notice and `not-detected` evidence/status. |
| `swift-swiftpm` | `Package.swift` marker yields `swiftpm-detected`. |
| `swift-build-server` | Both markers exist; `buildServer.json` takes precedence and yields `build-server-detected`. |

## What is real and what is synthetic

`lsp-cli-runner.mjs` uses the Jiti source aliases from `source-cli-runner.mjs`.
An isolated child registers `registerFauxProvider` and queues `fauxToolCall`
responses, writes its own `models.json`, and imports production `src/cli.ts` with
`--mode json`. It does **not** inject tools, create a session directly, replace
settings/services, or mock diagnostics. Production startup creates the ordinary
write/edit/LSP tools, manager, process transport, JSON projector, and persisted
session store.

The fake server is launched by ordinary settings using the absolute Node
executable plus `fake-lsp-server.mjs`. Its existing text scanner turns `ERROR`
and `WARN` markers into real stdio LSP publications. Swift coverage tests check
marker detection, not SourceKit correctness or workspace indexing. Explicit
hover uses the server's synthetic response.

Each check compares:

- Every mutation's actual disk content at the next provider request.
- `tool_execution_end` content, `details.lsp`, and `isError`.
- The same tool-result content/error flag delivered to the next faux request.
- Tool results read back from the authoritative SQLite store, including evidence
  retained when automatic diagnostic prose is suppressed.
- A final assistant response, `agent_settled`, normal child exit, and cleanup.
- Server initialize/document-sync/hover/publication acknowledgements; status and
  disabled automatic checks must not start a server.

## Isolation and lifecycle

Every invocation creates a separate workspace, HOME, agent directory, settings,
models, cache/temp roots, and session store. Child environment construction uses
a positive allowlist rather than copying `process.env`: inherited credentials,
proxy URLs, `NODE_OPTIONS`, remote/daemon overrides and unrelated resource paths
are absent. PATH contains only Node's directory; server launch never depends on
installed language servers. Startup is offline with telemetry disabled, project
trust refused, all resource discovery disabled, and only `write,edit,lsp` granted.
The inert faux API cannot make provider network requests. This is deterministic
resource isolation, not an OS/network sandbox.

The child has a 45-second deadline, 8-MiB output cap, and a 2-second termination
grace before forced process-tree cleanup. POSIX children own a dedicated process
group; Windows cleanup uses `taskkill /T /F`. The standalone parent handles
SIGINT/SIGTERM and always removes its temp tree in `finally`. As with other test
processes, SIGKILL of the parent cannot run its cleanup handler.

The fake server's opt-in `--event-log <path>` records incoming/outgoing protocol
messages and lifecycle acknowledgements outside LSP stdout. In that mode it also
exits on stdin EOF, preventing an orphan if the CLI dies. No fixture sleep waits
for readiness: provider requests acknowledge finished tools, LSP publications
acknowledge document synchronization, and child close acknowledges CLI teardown.
The configured publication windows are the production timeout behavior under
test, not synchronization sleeps.

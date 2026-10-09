# Development

See [AGENTS.md](../../../AGENTS.md) for additional guidelines.

## Setup

```bash
cd <volt-repo>
npm install
npm run build
```

Run from source:

```bash
/path/to/volt/volt-test.sh
```

The script can be run from any directory. Volt keeps the caller's current working directory. `volt-test.sh` and `volt-test.ps1` enable private review diagnostics for source-development runs. Model-reported limitations, verifier assessments and bounded completeness challenges, and bounded failed-tool output are written as one owner-only JSONL file per review with diagnostics under `~/.volt/agent/review-diagnostics/` (or the configured agent directory). The `verification_assessment` record retains the verifier's `assessment` and optional `challenge` even when no limitations or findings were reported; the public PR result never copies the private challenge. An unresolved concern can instead receive a code-grounded explanation from a separate context-blind pass that sees only host-validated changed-code locations. A completeness challenge triggers at most one follow-up discovery/verification cycle; diagnostics retain each cycle's verifier assessment. These records are untrusted and may contain sensitive GitHub context. They are not added to sessions, RPC responses, exports, or model context, and only the 20 newest files are retained.

On Windows, Volt uses the system Windows PowerShell and [.NET ACL-aware creation](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.directorysecurity?view=netframework-4.8.1) to restrict the diagnostic directory and newly created files to the current account. New files have a protected DACL installed at creation, before any diagnostic text is written. An existing diagnostic directory must belong to the current account and must not be a junction or symbolic link. The existing agent-directory ACL is not changed. Administrators with ownership/backup privileges remain outside this privacy boundary.

If Windows PowerShell is unavailable, times out, or cannot establish these ACLs, Volt does not fall back to chmod-only storage. Any diagnostic retention failure produces the local warning `Could not retain optional private review diagnostics.` after the TUI handoff, or on host stderr for headless execution. Raw errors, paths, and model prose are not included. The warning is transient and never added to review results, sessions, RPC events, or exports; diagnostic failures do not change the review verdict.

Set `VOLT_REVIEW_PRIVATE_DIAGNOSTICS=0` before launching either script to disable these records.

## Background-job performance diagnostics

`volt-test.sh` and `volt-test.ps1` enable `VOLT_BACKGROUND_JOB_DIAGNOSTICS=1` only when the variable is unset. `volt-test.bat` delegates to PowerShell. Set it to `0` to opt out; only `1` and `true` enable collection. Normal installed and SDK runs are off unless explicitly enabled. Newly created child runtimes inherit the setting. Interactive conversations run in the daemon's conversation workers ([Background daemon](daemon.md#conversation-workers)): a worker the TUI starts runs with the TUI's environment, so the setting reaches it, but a TUI that attaches to a conversation already open in a worker does not change that worker's environment. Phone-opened workers run with the daemon's environment, which keeps the `VOLT_*` variables of the process that started the daemon; restart the daemon with the intended setting when measuring phone-opened work.

Versioned, metadata-only JSONL batches go to `<agentDir>/background-job-diagnostics` (normally `~/.volt/agent/background-job-diagnostics`). Records correlate runtime, session, parent session when available, run, request, tool, job, and wait identities. They include UTC timestamps, monotonic durations, job lifecycle, wait wake reasons, native read byte counts/output revisions, collection acknowledgement, tool activity, and logical conversation request token/cache usage. Opaque Responses tool IDs containing provider item payloads are represented by stable SHA-256 digests so related records still join without retaining those payloads. They do not contain prompts, commands, arguments, reasoning, worker output, credentials, host paths, or provider payloads. They are never added to session SQLite, model context, RPC, or exports.

Dirty batches flush every 30 seconds, at 64 records, before 256 KiB, and at run settlement/disposal. Records are capped at 4 KiB. The collector keeps one active and one pending write, counts dropped records under pressure, and retains the newest 200 completed files (up to 50 MiB). Writes use the existing private atomic file protections, including ACL-aware creation on Windows. An I/O/privacy failure disables optional logging for that runtime and reports one sanitized local warning. Close drains are best-effort and bounded to ten seconds; incomplete logs must not be treated as complete measurements.

Analyze a directory with the repository-only script:

```bash
node scripts/summarize-background-job-performance.mjs --dir /path/to/background-job-diagnostics
node scripts/summarize-background-job-performance.mjs --dir /path/to/background-job-diagnostics --since 2026-09-10T00:00:00Z --until 2026-09-11T00:00:00Z
```

Use `--session <id>` to narrow the report and `--help` for output details. Reports distinguish root and child usage, requests started during waits, wait durations/reasons, active/unchanged reads, observable job/model/tool overlap, and completion-to-read/acknowledgement latency. Missing ends, sequence gaps, duplicates, dropped events, and partially retained windows are reported. Logical conversation stream invocations are not HTTP retry counts or a complete ledger of review, compaction, and session-name inference. Token counts are not billed cost, and overlapping tool activity is not proof of useful work.

## Forking / Rebranding

Configure via `package.json`:

```json
{
  "voltConfig": {
    "name": "volt",
    "configDir": ".volt"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: npm install, standalone binary, tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemeDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` captures live tool preparation and execution without submitting a prompt or cancelling the run. It atomically replaces `~/.volt/agent/debug/tool-progress-latest.json` (or the configured agent directory). Generation safeguards also save this record automatically; capture failures cannot change the run outcome. Capture I/O runs asynchronously, with one active snapshot and at most one queued snapshot. Repeated requests replace the queued snapshot with the latest request. Closing the session drains those already captured snapshots; new requests after disposal are rejected.

The record contains up to 16 recent calls, their provider/model and call IDs, phase and elapsed times, last event time, normalized argument byte/event counts, current and peak stream queue event counts and estimated retained bytes, and allowlisted safeguard/abort metadata. Unknown queue measurements are explicitly unavailable. Counts describe the normalized argument stream, not HTTP packet sizes. A new run resets the in-memory records; disposal releases them.

Each call retains at most a 4 KiB UTF-8 argument prefix. Recognizable credential fields, shell assignments, authorization markers, token prefixes, and PEM private-key markers are redacted conservatively before disk. Detection uses a bounded JSON-decoded view of the prefix, including markers split across provider chunks; it does not require a complete JSON value or PEM envelope. This is a diagnostic sample, not a complete JSON object: it may be truncated or redacted and must never be executed. Arbitrary source content can still be sensitive; inspect the file before sharing. Assistant prose, hidden reasoning, transport headers, tool output, and full conversation history are never copied into this capture.

Files and their directory are owner-only on Unix. On Windows the existing ACL-aware diagnostic writer installs a protected current-account DACL before writing; capture fails closed if those permissions cannot be established. Only the latest capture is retained.

## Interactive mode: client and host

The TUI is a protocol client of the host that runs its conversations ([architecture rewrite](architecture-rewrite-design.md) §10). It reaches them through a connector (`src/client/conversation-connector.ts`, `ConversationConnector`): `open` hands it a transport to a conversation, and `connectThrough` connects its `ProtocolClient`, follows each move by reconnecting (the client's `followMoves: "reconnect"`), and resumes the client on a new connection, with backoff, when a connector whose host runs elsewhere loses one. The `volt` CLI's connector is `DaemonConnector` (`src/modes/interactive/daemon-connector.ts`): it starts the daemon when none runs, refuses or restarts a daemon of another version, and opens each conversation in a daemon conversation worker with `conversation_open`, carrying the TUI's environment, working directory, CLI options, and one client key across its connections; the TUI's end of the daemon's relay is the client's transport. The worker (`src/daemon/worker/`) serves the TUI on the local profile (`serve-local.ts`) and phones on the remote profile (`serve-phone.ts`). `src/client/in-process-connector.ts` holds `InProcessConnector`, for SDK embedders and tests: it serves the TUI's client from a host in the same process as a redirect client that anchors its conversation, with one client key across its connections, and no daemon. `src/modes/interactive/` splits along the same seam:

- `daemon-connector.ts` and `worktree-control.ts`: the CLI's connector, and the daemon requests of `/worktree` and the workspace lookup.
- `client/`: the TUI's view of its conversation through its `ProtocolClient`. `tui-store.ts` holds the client fold and live lane of the conversation the client shows and follows its moves (`moving` until the target's snapshot; what the TUI sends meanwhile waits for it); `transcript-view.ts`, `work-view.ts`, `review-view.ts`, and `footer-model.ts` draw from it; `input.ts` and `session-commands.ts` turn the editor, keys, and commands into intents and queries; `tui-catalogs.ts` keeps the catalogs the status reads.
- `components/` and `ui-node/`: terminal components, and the mapping of `UiNode` data to them.
- `interactive-mode.ts`: the TUI itself, built from a `ConversationConnector` and its options only. What only the terminal has stays local: display settings (its own `SettingsManager`, read where `conversation_info` says the conversation runs), keybindings, themes, the clipboard, `$EDITOR`, `/trust`, and the daemon's control plane (`/remote`, `/worktree`).

Extensions reach the TUI only through the protocol: the `request_user_input` tool's questions are `user_input` host requests the TUI answers in its question dialog, and `ctx.ui.setTheme` is a `set_theme` directive the TUI applies unless its user picked a theme in it.

TUI tests use [`test/suite/tui-harness.ts`](../test/suite/tui-harness.ts): an `InProcessConnector` over the faux-provider host harness (`test/suite/host-harness.ts`), the TUI's client connected through it, and InteractiveMode rendering into a `VirtualTerminal` (`startMode()`, `submit()`, `waitForScreen()`, `choose()`). Phones the daemon relays into that host are served as a conversation worker serves them (`relayPhone()`, `relayPreamble()`, `connectRelayedPhone()`).

## Daemon and conversation workers

[`test/suite/daemon-harness.ts`](../test/suite/daemon-harness.ts) runs a daemon in the test's process on a temporary agent directory, with its real control socket and one registered workspace. Its conversation workers run in the test's process by default ([`test/suite/in-process-worker-launcher.ts`](../test/suite/in-process-worker-launcher.ts), `InProcessWorkerLauncher`), connected over that socket with role `worker`, or as `volt daemon worker` processes (`ProcessWorkerLauncher`). Workers load [`test/fixtures/faux-provider-extension.ts`](../test/fixtures/faux-provider-extension.ts), which registers the test's faux provider (served over a local socket to worker processes), so no real provider is involved. Tests drive the TUI's side through the harness daemon with a protocol client (`test/daemon-tui-workers.test.ts`) or the CLI's `DaemonConnector` (`test/daemon-connector.test.ts`); `test/daemon-worker-process.test.ts` covers workers as processes.

Run interactive Volt from source with an agent directory of its own, so the source daemon it starts never meets an installed daemon (another Volt version: the TUI refuses to attach or restarts it, see [version skew](daemon.md#version-skew)) or your real sessions and paired devices:

```bash
VOLT_CODING_AGENT_DIR=$(mktemp -d) ./volt-test.sh --no-env -e packages/coding-agent/test/fixtures/faux-provider-extension.ts
```

Run on its own, the fixture registers a `faux` provider that answers every request with a canned reply. `./volt-test.sh daemon status`, with the same `VOLT_CODING_AGENT_DIR`, lists the daemon's workers and their logs under `<agentDir>/daemon/workers/`. After the TUI quits, its idle conversations stay open in their worker for 30 minutes by default ([retention](daemon.md#retention-and-background)), and the daemon exits five minutes after nothing needs it ([idle exit](daemon.md#idle-exit)); stop both sooner with `./volt-test.sh daemon stop`.

The worker registry's model of record is [`docs/tla/WorkerRegistry.tla`](tla/WorkerRegistry.tla) (see the [TLA+ README](tla/README.md)). No CI job runs TLC: run `docs/tla/check.sh WorkerRegistry` (JDK 17+; it downloads `tla2tools.jar` on first run) by hand, and change the model first in every change to registry semantics.

## Testing

Run `npm run check` and only the tests affected by your changes, including every test file you create or modify. A full-suite run is not required before opening a PR. For docs-only changes, validate relevant links, examples, and metadata instead of unrelated runtime tests.

From the repository root, select the affected package and test files (skill loading shown as an example):

```bash
npm run check
./test.sh test --workspace packages/coding-agent -- test/skills.test.ts
```

You can also run a specific non-e2e test from its package root using the Vitest CLI installed in the root `node_modules`:

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/skills.test.ts
```

Only run the full non-e2e suite with root `./test.sh` when explicitly requested. Do not run an unfiltered Vitest command: provider e2e tests can activate when credentials or endpoint settings are present. See [CONTRIBUTING.md](../../../CONTRIBUTING.md) for the validation policy and worker limits.

## Session discovery benchmark

Run the observational SQLite listing/open/search benchmark from the repository root:

```bash
npm --prefix packages/coding-agent run benchmark:sessions
```

It reports elapsed time, main-thread heap delta, and sampled process-wide peak RSS delta for cold/warm listing of the default store, cold/warm exact open, and token/phrase/regex deep search. Sessions are spread across `VOLT_BENCH_WORKSPACE_COUNT` working directories, all in the one default store. Scale dimensions independently with `VOLT_BENCH_SESSION_COUNT` (total), `VOLT_BENCH_WORKSPACE_COUNT`, `VOLT_BENCH_SESSION_SUMMARY_BYTES`, `VOLT_BENCH_SESSION_NON_SEARCHABLE_BYTES`, `VOLT_BENCH_SESSION_SEARCHABLE_BYTES`, `VOLT_BENCH_QUERY_TOKEN_COUNT`, `VOLT_BENCH_QUERY_TOKEN_BYTES`, `VOLT_BENCH_QUERY_PHRASE_COUNT`, `VOLT_BENCH_QUERY_PHRASE_BYTES`, and `VOLT_BENCH_QUERY_REGEX_BYTES`. The command rejects query terms that do not fit the requested per-session searchable payload instead of silently increasing it.

Listing and exact lookup should remain independent of non-searchable transcript payload. Deep-search time still depends on total searchable text and query shape; the store's worker accumulates at most its largest one-session document rather than all searchable text in the store. Process RSS sampling includes worker threads but is host-dependent, observational, and has no pass/fail threshold.

## Lifecycle memory benchmark

Run the manual coding-agent memory benchmark from the repository root. It executes TypeScript source directly with Node strip-only mode and the `volt-source` export condition; it does not build or read `dist`:

```bash
npm run benchmark:memory
npm run benchmark:memory -- --quick
npm run benchmark:memory -- --scenario daemon-idle,rpc-idle --quick
```

The default is one warmup and three measured fresh processes per scenario. `--quick` skips the warmup and uses one measured process. Use `--runs`, `--warmup`, and `--settle-ms` for explicit sampling. Each checkpoint waits for the settle interval and then runs two exposed-GC passes before capturing memory.

Write and compare versioned reports with:

```bash
npm run benchmark:memory -- --quick --output ./memory-before.json
npm run benchmark:memory -- --quick --output ./memory-after.json --compare ./memory-before.json
```

Comparison requires identical Node version, platform, architecture, selected scenarios, workload schema, and workload parameters. Compare reports on the same host with the same allocator and otherwise idle system. Git revision/dirty state, Node/V8, OS, CPU, and host memory are recorded for interpretation but do not make results portable between hosts.

### Scenarios and checkpoints

| Scenario | Checkpoints | Lifecycle exercised |
| --- | --- | --- |
| `daemon-idle` | `idle` | Shared source daemon launch, including `--optimize-for-size`, authenticated empty status, Iroh relay-disabled readiness, graceful shutdown |
| `worker-idle` | `idle` | A daemon in the driver's process opens a stored, empty conversation in a conversation worker process (`volt daemon worker` from source, a generated faux provider extension, the phones' default tools), no client attached; the snapshot is the worker's, and `worker.spawnLatencyMs` is the time from the open to the worker's readiness |
| `rpc-idle` | `idle` | Protocol `hello` and a snapshot subscription while stdin and the benchmark snapshot channel remain open, then clean EOF shutdown |
| `runtime-idle` | `baseline`, `post-disposal` | Persisted conversation in a `ConversationHost` with the faux provider |
| `conversation` | `baseline`, `populated`, `post-disposal` | Schema-v1 fixed conversation: 20 user/assistant turns, exactly 2 KiB of text per message |
| `extension` | `before-activation`, `active`, `post-disposal` | Generated on-disk TypeScript extension loaded through Jiti, with a registered tool and `session_start` listener |
| `mcp` | `before-activation`, `active`, `post-disposal` | Local stdio MCP connect, list, call, and disconnect through `McpManager` |
| `lsp` | `before-activation`, `active`, `post-disposal` | Benchmark-owned stdio language server queried through the session `lsp` tool |

Workload schema v2 also fixes two GC passes, one MCP call, and one LSP query. Changing any parameter makes reports comparison-incompatible.

### Output and interpretation

The readable summary reports min, median, average, and max root RSS, used heap, and aggregate process-tree RSS. Stable machine-readable lines use this form for every captured numeric metric:

```text
METRIC scenario=mcp checkpoint=active metric=memory.rssBytes unit=bytes min=... median=... average=... max=...
```

`--output` includes all warmup and measured runs, raw root memory (`rss`, heap total/used, external, and array buffers), V8 heap statistics, active-resource counts, checkpoint timing, lifecycle invariants, process-tree observations, measured-run summaries, workload parameters, and host/runtime/Git metadata. `--compare` prints absolute and percentage median deltas; a zero baseline produces `percent=n/a`.

Process-tree RSS is best effort. Linux and macOS use one `ps` snapshot whose RSS values are normalized from KiB; Windows uses `Get-CimInstance Win32_Process` working-set data. Descendants can exit, reparent, or reuse a PID around a snapshot, and Windows may include shell or console helper processes. If enumeration is unavailable, raw root metrics remain valid and process-tree summaries are omitted.

Every run uses isolated HOME, agent, session, and workspace directories; forces offline/version-check-disabled execution; removes inherited provider credentials; disables external Iroh relays; and cleans the process tree and temporary files on success, failure, or handled termination signals. The benchmark is observational: it is not run in CI, has no committed absolute baseline, and enforces no pass/fail memory threshold.

## SWE-bench Verified smoke benchmark

The repository-only SWE-bench runner exercises one Verified instance sequentially with an extracted Linux x64 Volt standalone distribution. It requires Linux x64, Docker, Python, at least 16 GB RAM, and roughly 120 GB of free disk for official task images and evaluator artifacts.

Create the ignored Python environment and install the official harness at the commit pinned in `scripts/requirements-swebench.txt`:

```bash
python3 -m venv .venv-swebench
. .venv-swebench/bin/activate
python -m pip install -r scripts/requirements-swebench.txt
```

Build the native standalone distribution on Linux x64, or extract an existing Linux x64 standalone archive:

```bash
npm --prefix packages/coding-agent run build:binary
```

Log in to the `openai-codex` provider with Volt before running the benchmark. The runner reads `~/.volt/agent/auth.json` by default, copies only its `openai-codex` OAuth entry into a private temporary writable agent directory, and deletes that directory after generation. It never updates the source credential. The temporary credential is readable by code in the disposable task container, network egress is not restricted, and v1 must not be run concurrently with the same credential.

From the repository root, run the default `sympy__sympy-20590` smoke task with an exact Codex model:

```bash
npm run benchmark:swebench -- \
  --volt-dir packages/coding-agent/binaries/linux-x64 \
  --model openai-codex/gpt-5.6-sol \
  --thinking high
```

Use `--instance`, `--thinking`, `--timeout-seconds`, `--auth-file`, `--python`, or `--output-dir` to override defaults. Volt receives only the task's `problem_statement`; the runner does not include gold patches, test patches, or evaluation test names in the prompt. It records the clean initial image HEAD, stages tracked and non-ignored untracked changes after Volt exits, and captures a binary diff from that initial HEAD so model-created commits are included.

Artifacts are written under ignored `swebench-output/<run-id>/`: the prompt, `patch.diff`, redacted Volt stdout/stderr, one official `predictions.jsonl` record, evaluator stdout/stderr, and the official report directory. The official evaluator runs one worker for only the selected instance. Both resolved and unresolved reports are valid benchmark outcomes; infrastructure, authentication, timeout, malformed-output, missing-report, and cleanup failures exit nonzero.

## Project Structure

```
packages/
  ai/           # LLM provider abstraction
  protocol/     # Log entry schemas, protocol frames, UiNode, the contract artifact
  agent/        # Conversation kernel: agent loop, log fold, delivery queue
  tui/          # Terminal UI components
  coding-agent/ # CLI, conversation host, and interactive mode
```

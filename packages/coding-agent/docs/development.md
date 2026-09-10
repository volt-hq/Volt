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

`volt-test.sh` and `volt-test.ps1` enable `VOLT_BACKGROUND_JOB_DIAGNOSTICS=1` only when the variable is unset. `volt-test.bat` delegates to PowerShell. Set it to `0` to opt out; only `1` and `true` enable collection. Normal installed and SDK runs are off unless explicitly enabled. Newly created child runtimes inherit the setting. An already-running daemon does not acquire the launcher's environment; restart it with the intended setting when measuring daemon-owned work.

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

## Testing

```bash
./test.sh                         # Run non-LLM tests (no API keys needed)
npm test                          # Run all tests
npm test -- test/specific.test.ts # Run specific test
```

## Session discovery benchmark

Run the observational SQLite listing/open/search benchmark from the repository root:

```bash
npm --prefix packages/coding-agent run benchmark:sessions
```

It reports elapsed time, main-thread heap delta, and sampled process-wide peak RSS delta for cold/warm cross-store listing, cold/warm exact open, and token/phrase/regex deep search. Scale dimensions independently with `VOLT_BENCH_SESSION_COUNT` (total), `VOLT_BENCH_STORE_COUNT`, `VOLT_BENCH_SESSION_SUMMARY_BYTES`, `VOLT_BENCH_SESSION_NON_SEARCHABLE_BYTES`, `VOLT_BENCH_SESSION_SEARCHABLE_BYTES`, `VOLT_BENCH_QUERY_TOKEN_COUNT`, `VOLT_BENCH_QUERY_TOKEN_BYTES`, `VOLT_BENCH_QUERY_PHRASE_COUNT`, `VOLT_BENCH_QUERY_PHRASE_BYTES`, and `VOLT_BENCH_QUERY_REGEX_BYTES`. The command rejects query terms that do not fit the requested per-session searchable payload instead of silently increasing it.

Listing and exact lookup should remain independent of non-searchable transcript payload. Deep-search time still depends on total searchable text and query shape; stores are searched sequentially, and each worker accumulates at most its largest one-session document rather than all searchable text in that store. Process RSS sampling includes worker threads but is host-dependent, observational, and has no pass/fail threshold.

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
| `rpc-idle` | `idle` | Successful `get_state` while stdin and the benchmark snapshot channel remain open, then clean EOF shutdown |
| `runtime-idle` | `baseline`, `post-disposal` | Persisted `AgentSessionRuntime` with the faux provider |
| `conversation` | `baseline`, `populated`, `post-disposal` | Schema-v1 fixed conversation: 20 user/assistant turns, exactly 2 KiB of text per message |
| `reconnect-retention` | `baseline`, `detached`, `post-cycle`, `post-disposal` | Real registry attach/detach, ten warm same-runtime reattaches, then detached retirement with a short TTL |
| `extension` | `before-activation`, `active`, `post-disposal` | Generated on-disk TypeScript extension loaded through Jiti, with a registered tool and `session_start` listener |
| `mcp` | `before-activation`, `active`, `post-disposal` | Local stdio MCP connect, list, call, and disconnect through `McpManager` |
| `lsp` | `before-activation`, `active`, `post-disposal` | Benchmark-owned stdio language server queried through the session `lsp` tool |

Workload schema v1 also fixes two GC passes, ten reconnect cycles, one MCP call, one LSP query, and a reconnect-retention TTL of `settle-ms + 1000`. Changing any parameter makes reports comparison-incompatible.

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
  agent/        # Agent loop and message types  
  tui/          # Terminal UI components
  coding-agent/ # CLI and interactive mode
```

# LSP Diagnostics & Navigation

Volt runs language servers for semantic navigation, refactoring, and best-effort diagnostics after `edit` and `write`. Diagnostics supplement a build or test run; they do not prove that a project is clean.

The `lsp` tool exposes go-to-definition, references, hover, symbol outlines, diagnostics, rename, quick fixes, and a read-only `status` action. Status remains available when LSP is disabled, subject to normal tool grants, and never starts or installs servers.

## Default and Disabling

LSP and automatic diagnostics are on by default. To disable only automatic checks after `edit`/`write`, while retaining explicit diagnostics, navigation, rename, and fixes, set `lsp.autoDiagnostics` to `false` in `~/.volt/agent/settings.json` (or per project in `.volt/settings.json`):

```json
{
  "lsp": {
    "autoDiagnostics": false,
    "servers": {
      "typescript": { "autoDiagnostics": true }
    }
  }
}
```

Each server inherits the global automatic-check setting unless it supplies its own boolean override. The example keeps automatic TypeScript checks enabled. A disabled automatic check is silent, does not start/install a server or synchronize documents, and records `skipped` / `auto-diagnostics-disabled` with freshness `unknown` and source `none`. A later explicit operation synchronizes current disk content.

To disable **all semantic LSP operations**, set the master `lsp.enabled` switch to `false`:

```json
{
  "lsp": {
    "enabled": false
  }
}
```

Use `volt --lsp` to force-enable only the master switch for a run. It does not override `autoDiagnostics` or re-enable servers with `servers.<name>.enabled: false`. Status remains available without startup.

## How It Works

- Servers are spawned lazily: the first enabled automatic check or explicit semantic operation on a file with a matching extension starts the server for that file's server root.
- LSP can access files outside the current workspace, just like Volt's file tools. Absolute paths, relative paths such as `../shared/src/index.ts`, and symlink aliases work for diagnostics, navigation, refactoring, and server-initiated edits. Existing paths (or the nearest existing ancestor for new files) are canonicalized so aliases share document and server state; dangling symlinks still fail resolution. Normal tool grants and Plan mode's read-only action restrictions still apply.
- The session's canonical project workspace remains the base for configured commands and traces. It is normally the startup directory; remote and managed-worktree runtimes may retain the registered workspace or checkout while tools run from a nested directory. Accessing another repository does not load that repository's Volt settings, extensions, or other project resources: external servers use the current session's LSP configuration.
- For files inside the project workspace, server-root discovery searches upward only to that workspace and falls back to it. Markers are priority-ordered entry names: for TypeScript, a `tsconfig.json` inside the workspace wins over a closer `package.json`. For external files, the search stops at the nearest `.git` entry (including worktree `.git` files), or before climbing into the home directory or filesystem root. Without a matching marker, it uses that repository root or, for loose files, the file's directory. External projects get separate lazily started clients rather than broadening the current server to index their common parent.
- After each successful `edit`/`write`, volt syncs the new file content to the server and collects diagnostics, using pull diagnostics (`textDocument/diagnostic`) when the server supports them, otherwise waiting up to `settleMs` for the server to publish. The first collection on a freshly started server waits up to `firstSettleMs` instead, because some servers publish nothing until the project has loaded.
- Before every diagnostics collection or navigation query, volt re-syncs any previously opened file whose on-disk content changed outside the `edit`/`write` tools (e.g. via `bash`: `git checkout`, codegen). Deleted files are closed on the server, and servers are notified via `workspace/didChangeWatchedFiles`.
- Automatic diagnostics at or above the configured `severity` are appended as **changes since the last delivered snapshot**, not repeated full reports. The first observation reports findings without claiming that the edit caused them. Later checks report additions/changes or changed freshness/project context; unchanged findings are silent. Comparison includes message, full range, severity, code, and source, before truncation.
- Other open files are eligible after a known-clean-to-failing transition, reported in a `Newly failing in other open files` section (capped at 5 files). Each file carries its own freshness label; an unversioned dependent never inherits the edited file's `fresh` confidence. Current cross-file findings can still appear when the target file times out.
- `maxDiagnostics` applies across the entire automatic report, with an additional 8 KiB text budget and an explicit truncation notice. Only emitted findings count as delivered, so omitted findings remain eligible on a later check. Delivery history is bounded to 256 files and 4096 fixed-size fingerprints; eviction, document closure, client replacement, restart, or reload may cause findings to be reported again.
- Usable snapshots, including empty publications, remove disappeared findings from automatic history so recurrence is reported. Only fresh evidence can produce a concise `no longer reported` notice; this is not proof of a clean build. Unverified disappearance has no recovery claim. Timeouts, cancellation, stale, and unknown results do not clear baselines or imply clean checks.
- Explicit `lsp` with `action: "diagnostics"` always returns the complete severity-filtered file snapshot within the existing `maxDiagnostics` limit, without consuming automatic delivery history. Use it to inspect suppressed findings.
- One client runs per canonical `(server, server root)` pair. A failure in one nested root does not disable that server in another root. Servers shut down when the session ends or reloads, and after `idleShutdownMs` without use (they respawn lazily on the next operation).
- `/lsp` shows an on-demand health snapshot: configured unused/disabled servers and per-root starting, ready, degraded, failed, blocked, or idle records. Details include resolved executable, launch source, observed version, advertised capabilities, activity/latency counters, recent successes/failures, startup stderr, and request errors. `ready` means the transport initialized, not that build settings or indexing are verified. An alive process is not necessarily ready; an idle shutdown is not a failure. Unknown capabilities differ from an initialized server advertising none. There is no background status polling. `/lsp restart` stops owned processes and clears failed-start breakers so servers resolve and spawn fresh on next use.
- `/lsp trace [path]` enables protocol tracing at runtime (`/lsp trace off` disables): JSON-RPC traffic in both directions, server stderr, workspace/server roots, resolved launch context, attempts, and lifecycle events are appended with timestamps. Relative runtime paths and persistent `lsp.traceFile` paths resolve from the canonical project workspace, not the process invocation directory or nested runtime cwd.
- Reviewed install prompts apply only to missing unchanged built-in bare commands, plus the built-in TypeScript command with a confirmed incompatible pre-7 compiler. Install prompts and concurrent attempts coalesce by reviewed recipe; cancelling one caller stops only its wait, while the shared install continues without affecting that root's startup breaker. After the installer exits successfully, Volt searches PATH again and verifies the normal LSP initialize handshake for each requesting server root before reporting readiness. A successful installer with an unresolved launcher or failed initialization is reported separately from installation failure. Explicit paths, custom commands, manual-install-only servers, and present-but-broken or unrecognized executables are never auto-installed. Offline and Plan-mode sessions never offer or run installs. After three failed starts only that `(server, root)` record is blocked until `/lsp restart` or `/reload`.

Diagnostics are best-effort: server failures or timeouts never fail a successful edit or write. Automatic results retain structured evidence even when repeated failure text is suppressed. Fix only regressions caused by the current change; unrelated diagnostics do not expand the task.

## The lsp Tool

The `lsp` tool is active by default (it still respects `--tools` and `--exclude-tools`). When disabled, only status is useful; semantic operations report unavailability without starting a server. Status and other non-mutating actions are authorized reads in Plan mode; `rename` and `fix` remain restricted writes. Actions:

| Action | Parameters | Description |
|--------|------------|-------------|
| `status` | `path?` | Inspect cached health/capabilities for all configured servers, or route by a file path; no spawn, probe, or install |
| `definition` | `path`, `symbol`, `line?` | Where a symbol is defined, with a source snippet |
| `references` | `path`, `symbol`, `line?` | All usages of a symbol across the project (capped at 50) |
| `implementations` | `path`, `symbol`, `line?` | Implementations of an interface or abstract symbol |
| `type-definition` | `path`, `symbol`, `line?` | Where a symbol's type is defined |
| `callers` | `path`, `symbol`, `line?` | Functions that call the symbol (call hierarchy, one level) |
| `callees` | `path`, `symbol`, `line?` | Functions the symbol calls (call hierarchy, one level) |
| `hover` | `path`, `symbol`, `line?` | Type signature and documentation for a symbol |
| `symbols` | `path`, `symbol?` | Hierarchical symbol outline of a file; with `symbol`, a project-wide symbol search (the `path` routes the query to the right server) |
| `diagnostics` | `path` | Current diagnostics for a file, on demand |
| `rename` | `path`, `symbol`, `newName`, `line?` | Rename a symbol across the project (applies the server's WorkspaceEdit to disk) |
| `fix` | `path`, `symbol?` or `line?`, `title?`, `kind?` | Apply a quick fix (e.g. add a missing import). A single available action applies automatically; multiple actions are listed and chosen via `title`. `kind` filters by code-action kind, e.g. `source.organizeImports` or `source.fixAll` over the whole file |

Every action except `status` requires `path`. The symbol is located by name: Volt finds its position in the file (preferring a word-boundary match on the hinted `line`) and issues the positional LSP request. Failures such as unavailable servers, unsupported methods, invalid inputs, request errors, timeouts, and rejected edits set the normal tool-result `isError` flag. A legitimate empty result or a code-action selection list is not a transport failure.

`rename` and `fix` write the server's `WorkspaceEdit` to disk (including create/rename/delete file operations), re-sync changed open documents, and report a per-file summary. Edits may span projects: filesystem handles expand to cover the explicit edit targets without changing language-server roots. Every operation is preflighted before mutation, retaining document-version, stale-content, and rooted file-operation checks. Non-file URIs and filesystem roots are not valid mutation targets; resource renames between different filesystem volumes are unsupported. Command-based code actions use `workspace/executeCommand`, and server-initiated `workspace/applyEdit` requests use the same edit handling.

## Built-in Servers

The matching server must be installed on the exact inherited `PATH`, or be reported by its own toolchain as described below. Volt does not implicitly execute `node_modules/.bin`. Bare commands are searched in PATH order; relative PATH entries are based at the canonical project workspace. On Windows, commands with an explicit filename extension are probed as named before any `PATHEXT`-derived fallback, while extensionless commands use `PATHEXT` order for PATH, project-relative, and absolute launch forms. Commands containing `/` or `\\` resolve from the project workspace. All remaining command entries are passed as literal argv through Volt's cross-platform spawn wrapper, without shell joining.

For unchanged built-in bare commands only, Volt asks the language's toolchain where its server lives. PATH stays the first lookup, and custom commands and explicit paths are never located. `/lsp` shows the launch source `toolchain` for these servers.

- **Go:** when `gopls` is not on PATH, Volt runs `go env GOBIN GOPATH GOEXE` from a neutral directory with `GOTOOLCHAIN=local`, then launches `GOBIN/gopls`, or `gopls` in the first GOPATH entry's `bin` directory. This is where `go install` writes, and Go never adds it to PATH.
- **Rust:** when `rust-analyzer` is not on PATH, Volt uses the rust-analyzer rustup proxy next to the real `rustup` executable (for Homebrew rustup, the keg `bin` directory) and prepends that directory to the server's PATH only, so it also finds `cargo` and `rustc`. Rustup proxies exist even without the component, so Volt first runs `rustup which rust-analyzer` in the server root with `RUSTUP_AUTO_INSTALL=0`, which honors that root's `rust-toolchain.toml` and directory overrides. If the component is missing, including for a rustup proxy already on PATH, the reviewed install is offered for the toolchain selected at that root, by name: `rustup component add rust-analyzer --toolchain <name>`. If that toolchain is not installed or is a custom `path` toolchain, Volt reports it and offers no install.
- **Swift:** see below.

Volt does not search other directories, change settings, or modify shell profiles. Located executables are reused until `/lsp restart`, `/reload`, or an install.

Interactive and capable RPC hosts can request explicit consent for a reviewed built-in repair, then search PATH and the toolchain again and retry. Non-interactive hosts, clients without host-action support, overridden command argv, custom commands, explicit paths, and manual-install-only servers receive repair context instead. No arbitrary package or custom install command is executed.

### TypeScript

The built-in `tsc --lsp --stdio` command requires TypeScript >=7 and does not use the `typescript-language-server` bridge. Before starting it, Volt probes the **exact resolved executable** with a bounded, cached version check. Status reads do not run this probe. A confirmed older compiler is incompatible; a failed, timed-out, or unrecognized probe is not proof that installation will repair it.

For a missing built-in compiler or a confirmed pre-7 compiler, an eligible host may ask permission for exactly:

```bash
npm install -g typescript@7.0.2 --ignore-scripts --include=optional
```

This replaces the global TypeScript compiler. Lifecycle scripts are disabled; optional native dependencies are required. To avoid a global replacement, install a compatible native compiler yourself and set `lsp.servers.typescript.command` to its explicit executable path plus `--lsp`, `--stdio`. Custom and explicit commands are not automatically repaired.

### Swift

The built-in Swift server resolves `sourcekit-lsp` from inherited PATH first. On macOS only, if that unchanged built-in bare command is missing, Volt may use `xcrun --find sourcekit-lsp` to find SourceKit-LSP in the selected developer toolchain. There is no `xcrun` fallback for custom commands or explicit paths, and no automatic Swift/Xcode installation.

SwiftPM (`Package.swift`) and an existing BSP configuration (`buildServer.json`) provide project context. Module/reference coverage may require a recent build. A loose Swift file or an Xcode project without an already configured build server has limited semantics; a running server does not establish full workspace indexing. Volt defaults Swift initialization options to `backgroundIndexing: false`, does not create build-server configuration, select Xcode, run builds, or automatically set up an index. Explicit initialization options and SourceKit's own project configuration remain user-controlled; see [SourceKit configuration](https://github.com/swiftlang/sourcekit-lsp/blob/main/Documentation/Configuration%20File.md).

Volt reports read-only marker evidence at the actual canonical server root, independently of server health:

- `build-server-detected`: `buildServer.json` exists (takes precedence).
- `swiftpm-detected`: `Package.swift` exists without a detected build-server marker.
- `not-detected`: neither marker was detected.
- `unknown`: inspection was unsupported or failed.

These labels do **not** prove that SourceKit loaded the settings, that the marker is valid, or that indexing is complete. Path-routed status inspects its own root, including nested and external projects; it does not borrow evidence from the session root. Missing context produces one actionable automatic warning per server/root/context transition, and diagnostics remain visible with a best-effort label. Volt never hides an error by matching text such as `No such module`. Explicit diagnostics retains the context caveat. Marker changes refresh evidence on the next operation, but do not automatically reconfigure an existing server.

For an Xcode project, manually configure your chosen SourceKit-compatible build server for the intended workspace/project, scheme, and destination, and place its `buildServer.json` at the server root shown by `/lsp`. Follow that build server's setup instructions and run any required build yourself. Then use `/lsp restart` (or `/reload` after changing Volt settings) so the server can load the new configuration. Recheck status and use a real build/test to verify project correctness. Volt does not generate compiler arguments, create BSP files, invoke Xcode, or automatically repair project context.

SourceKit may finish `initialize` before loading the SwiftPM manifest. Early navigation can be empty while project context loads; an on-demand diagnostics collection can wait for publication evidence before navigation. Even a clean unversioned publication remains best-effort. Use a recent build and search fallback when references are incomplete, rather than repeatedly calling an unavailable server.

### Default definitions

| Name | Command | Extensions | Root markers | Install |
|------|---------|------------|--------------|---------|
| `typescript` | `tsc --lsp --stdio` | `.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs` | `tsconfig.json`, `jsconfig.json`, `package.json` | `npm install -g typescript@7.0.2 --ignore-scripts --include=optional` |
| `swift` | `sourcekit-lsp` | `.swift` | `buildServer.json`, `Package.swift` | Install Swift/Xcode manually |
| `python` | `pyright-langserver --stdio` | `.py` `.pyi` | `pyrightconfig.json`, `pyproject.toml`, `setup.py`, `requirements.txt` | `npm install -g pyright` |
| `go` | `gopls` | `.go` | `go.mod`, `go.work` | `go install golang.org/x/tools/gopls@latest` |
| `rust` | `rust-analyzer` | `.rs` | `Cargo.toml` | `rustup component add rust-analyzer` |
| `cpp` | `clangd` | `.c` `.h` `.cpp` `.cc` `.cxx` `.hpp` `.hh` | `compile_commands.json`, `compile_flags.txt`, `.clangd` | [clangd.llvm.org/installation](https://clangd.llvm.org/installation) |
| `zig` | `zls` | `.zig` | `build.zig` | [github.com/zigtools/zls](https://github.com/zigtools/zls) |
| `lua` | `lua-language-server` | `.lua` | `.luarc.json`, `.luarc.jsonc` | [luals.github.io/#install](https://luals.github.io/#install) |
| `bash` | `bash-language-server start` | `.sh` `.bash` | (project workspace fallback) | `npm install -g bash-language-server` |

## Configuration

All settings live under `lsp` in `settings.json`:

```json
{
  "lsp": {
    "settleMs": 1500,
    "maxDiagnostics": 20,
    "severity": "error",
    "servers": {
      "typescript": {
        "command": ["tsc", "--lsp", "--stdio"]
      },
      "rust": {
        "enabled": false
      },
      "zig": {
        "command": ["zls"],
        "fileExtensions": [".zig"],
        "rootMarkers": ["build.zig"]
      }
    }
  }
}
```

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Master switch; set `false` to disable (`--lsp` force-enables only this setting per run) |
| `autoDiagnostics` | boolean | `true` | Automatic edit/write checks only; explicit operations remain available |
| `settleMs` | number | `1500` | How long to wait for published diagnostics after a change (servers without pull diagnostics) |
| `firstSettleMs` | number | `10000` | Wait window for the first diagnostics from a freshly started server (project load time) |
| `idleShutdownMs` | number | `600000` | Shut down servers idle for this long (10 minutes); `0` disables idle shutdown |
| `traceFile` | string | | Append protocol traffic, server stderr, resolved launch context, and lifecycle events to this file; relative paths resolve from the canonical project workspace (also `/lsp trace` at runtime) |
| `maxDiagnostics` | number | `20` | Maximum diagnostics across an automatic report, or in an explicit file snapshot; omitted output is summarized |
| `severity` | string | `"error"` | Minimum severity to report: `error`, `warning`, `information`, or `hint` |
| `servers.<name>` | object | | Server definition, merged over the built-in default with the same name |

Per-server fields:

| Field | Type | Description |
|-------|------|-------------|
| `command` | string[] | Launch argv. Absolute executables are preserved, explicit relative executables resolve from the project workspace, and bare names use only inherited PATH/PATHEXT; no shell or implicit `node_modules/.bin` lookup |
| `fileExtensions` | string[] | File extensions routed to this server |
| `rootMarkers` | string[] | Priority-ordered file/directory entry names marking a server root; searched within the current workspace or the external project discovery range described above |
| `initializationOptions` | any | Passed to the server in the `initialize` request |
| `settings` | object | Server configuration: sent via `workspace/didChangeConfiguration` after startup and used to answer `workspace/configuration` section requests (dot-separated section paths look up into this object) |
| `enabled` | boolean | Set `false` to disable a built-in or configured server; authoritative over automatic-check settings |
| `autoDiagnostics` | boolean | Override global automatic edit/write checks for this server; otherwise inherits global |

Example: tuning pyright through `settings`:

```json
{
  "lsp": {
    "servers": {
      "python": {
        "settings": {
          "python": { "analysis": { "typeCheckingMode": "strict" } }
        }
      }
    }
  }
}
```

User entries merge field-wise over built-in defaults: overriding only `command` for `typescript` keeps the default extensions and root markers.

### Installed but not ready

An installer can succeed without exposing the launcher on Volt's inherited PATH. Go and Rust installs are located through their toolchains, as described above. When a server is still unresolved, find the installed executable yourself, then set an explicit command. For Rust, point it at the rustup proxy rather than the toolchain binary from `rustup which`, and keep `cargo` and `rustc` on the PATH that starts Volt:

```json
{
  "lsp": {
    "servers": {
      "rust": { "command": ["/absolute/path/to/rust-analyzer"] }
    }
  }
}
```

Run `/reload` to load the changed settings and clear failed-start state without losing the conversation. If the existing configured command becomes usable without changing settings, `/lsp restart` clears failures and retries on next use. Neither command imports PATH changes from another shell. Volt does not search unconfigured installation directories or modify shell profiles. An initialization failure after resolution is a separate server/project problem; inspect `/lsp` and startup stderr rather than repeatedly reinstalling.

## Structured outcomes and freshness

Explicit LSP calls and automatic diagnostics attach bounded machine-readable `details.lsp` metadata: `operationId`, `trigger` (`explicit`, `edit`, or `write`), `action`, `completedAt`, `outcome`, `reason`, `language`, `server`, `durationMs`, `coldStartMs`, `diagnosticCount`, `resultCount`, `freshness`, `source`, and (for Swift) the bounded `projectContext` enum above. Metadata contains no diagnostic prose, source snippets, or compiler arguments. Collection counts and outcomes remain present when automatic display text is suppressed; silence is not a clean result. Consumers should use these fields and normal `isError`, not parse display text. RPC/mobile consumers use the existing tool-result error projection; there is no separate LSP wire protocol.

Outcomes distinguish `success`, `empty`, `needs-selection`, `skipped`, `unavailable`, `unsupported`, `invalid-input`, `timeout`, `cancelled`, `request-failed`, and `edit-failed`. For automatic diagnostics, these describe diagnostics collection, not whether the file mutation succeeded.

Freshness is separate from severity and result count:

- `fresh`: evidence matches the current synchronized document.
- `unverified`: diagnostics arrived without sufficient version evidence.
- `stale`: retained diagnostics belong to an older document version.
- `unknown`: no usable freshness evidence.

`source` is `pull`, `push`, `cache`, or `none`. Waiting out a publication window without diagnostics is a timeout, **not a clean result**. Likewise an unsupported request is not an empty semantic answer. Use a build/check when freshness or project coverage is uncertain.

## Offline audit

`volt lsp audit` reads persisted operation evidence without starting a session, provider, language server, or daemon:

```bash
volt lsp audit
volt lsp audit --json
volt lsp audit --since 2026-09-01 --until 2026-09-14
volt lsp audit --session-dir /path/to/session-store
volt lsp audit --all-workspaces
```

Text is the default; `--json` provides a machine-readable report. The default window is the last 14 days (`since` inclusive, `until` exclusive), scoped to the current canonical workspace. `--all-workspaces` explicitly broadens scope; `--session-dir` confines scanning to a custom store. No session-store creation, migration, repair, transcript export, authentication, or network request is performed. Unsupported, corrupt, busy, missing, and unreadable stores produce coverage warnings. Exit codes are `0` for complete coverage, `2` for partial coverage or invalid arguments, and `130` for cancellation.

The utilization denominator is distinct tool-active sessions in the window, excluding empty sessions and copied history predating session creation. Root and subagent cohorts are separate. All stored branches participate; operation IDs deduplicate cloned/forked histories, preferring original execution context when available and reporting uncertainty otherwise. Explicit calls and automatic checks are counted separately; disabled/no-server skips remain distinguishable. Historical LSP calls without metadata are uninstrumented/unknown, and historical edits have unknown automatic-check coverage. Grep/bash counts are context only, not missed LSP opportunities.

Duration p50/p95 use recorded monotonic operation durations and report sample counts, cold/warm separation, and startup contribution; timestamp differences are never used as duration estimates. Default scan bounds are 128 stores, 10,000 sessions, 100,000 entries, 64 MiB payloads, 256 KiB per entry, 5 seconds per store and 30 seconds overall. Group output is capped at 128 groups per dimension. Each report includes its denominator, limits and partial-coverage evidence. Audit output is not a benchmark or a claim about project correctness.

## Limitations

- Disk changes are only detected for files the server has already seen (opened by an earlier edit, write, or `lsp` query). Files created or changed via `bash` that were never touched by a tool are unknown to the server until first opened.
- Diagnostics focus on the requested/edited file. Newly failing previously open files may be included best-effort; this is not whole-project verification.
- On very large projects the first collection can still miss diagnostics if project loading exceeds `firstSettleMs`; raise it in settings if needed.

# Code mode

- Status: Design complete, ready for review. Every decision is recorded in section 5; section 8 lists the approvals for implementation, granted on 2026-11-04, and the follow-ups, and section 9 the delivery plan. Sections 5.1 to 5.14 were reviewed with the maintainer; sections 5.15 to 5.18 were decided without a separate review round.
- Date: 2026-11-04
- Audience: Volt maintainers.
- Scope: A sandboxed script tool that lets the model call Volt tools programmatically, so intermediate results stay out of the model context. This document covers the runtime that executes scripts, how it is supervised, and the constraints Volt places on it.
- Decisions: model-written JavaScript runs in [`quickjs-wasi`](https://github.com/vercel-labs/quickjs-wasi) (QuickJS-NG compiled to WebAssembly) on a per-process pool of worker threads, one fresh VM per script, booted by creating the VM and running a trusted prelude. Scripts are bounded by a compute budget and a nested-call budget, not by a default wall-clock deadline. Adding `quickjs-wasi` is a new dependency and needs maintainer approval before implementation. Values cross the bridge through a lossless JSON codec built on native `JSON.parse` `context.source` and `JSON.rawJSON`; nested calls resolve to text or internal per-tool projections, fail with typed `ToolCallError`s, and return images as opaque references that only reach the model when the script shows them (section 5.9). The model reads one plain-text result: an ordered output stream with multi-line items fenced, a 50 KB budget split by priority with structural truncation of the return value, and the full output spilled to a temp file (section 5.10). A failed script keeps its partial output and adds a failure kind, an error block, and a grouped summary of the nested calls that may have changed state (section 5.11). Scripts can call only operations the model could call directly in the same session, excluding user, session, job, and delegation tools (section 5.12). Nested calls run concurrently up to 10 per script; tools that declare `sequential` run alone, and MCP calls are limited per server rather than serialized (section 5.13). The tool is `run_code`, taking JSON `{ code, description?, timeoutMs? }` with JavaScript or erasable TypeScript; its description lists bindings and result shapes without repeating native tool declarations, and MCP tools are discovered through the `mcp` tool (section 5.14). Code mode is off by default and enabled with the `codeMode.enabled` setting (section 5.15). Nested calls appear inside the `run_code` card and its `details`, not as separate tool calls (section 5.16). Scripts keep small JSON values across runs with `store()` and `load()`, recorded as session entries (section 5.17). Section 5.18 collects every default, including a 64 MiB memory limit per VM.

## 1. Objective

Every Volt tool call today is a separate model-issued call whose result enters the transcript. For work that fans out or iterates (list 200 records and act on some, pull many issues and classify them, page through MCP results), the model must read every intermediate result and write every call. Context grows with the work, and arithmetic and bookkeeping over many records degrade.

Code mode adds a tool whose input is a script. The script calls tools as `await tools.<name>(args)`, loops, branches, filters, and aggregates, and only what it prints or returns reaches the model. Nested calls remain real tool calls: they pass through Volt's tool-call policy, and their side effects are not undone if the script fails.

### Evidence that shapes the goals

- Code mode pays off on long, tool-heavy tasks and costs more on small ones. Pydantic's 5,276-run benchmark ([article](https://pydantic.dev/articles/why-code-mode-is-the-future)) measured -58% cost, -51% wall time, and +16 points success on long tasks, but +21% to +38% cost at 5 items on three of five tasks. The savings came from fewer tokens per request, not fewer round trips; models already batch independent calls.
- It does not improve ordinary coding work. DeepSeek's scaffold comparison on its own model ([model card](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/README.md)) shows its PTC mode at 67.6 on DeepSWE v1.1 against 70.5 for its standard mode and 72.6 for its minimal bash-and-edit mode, and equal to standard on Terminal-Bench 2.1 (85.8).
- Reported failure modes: rerun snippets repeating writes (Pydantic), models skipping discovery and inventing tool names (Goose), and nested approvals diverging from outer approvals ([openai/codex#32848](https://github.com/openai/codex/issues/32848)).

Code mode is therefore an opt-in complement to direct tool calls, not a replacement.

### Prior art

| Implementation | Runtime | Relation to direct tools | State between scripts |
|---|---|---|---|
| Pi ([docs](https://pi.dev/docs/latest/codemode)) | QuickJS in WASM, worker thread per script | Complements; optional "only" mode | `store()`/`load()` persisted in the session |
| DeepSeek Harness PTC ([design note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-06-15-ptc.md)) | Node child process under the OS sandbox (replaced a worker-thread runtime after an escape) | Replaces, per agent | None, to keep sessions reconstructable from the log |
| Pydantic AI Harness ([docs](https://pydantic.dev/docs/ai/harness/code-mode/)) | Monty (Rust Python subset), worker process | Complements, selected tools | REPL persists within a run |
| OpenCode 2 | Hand-rolled JS interpreter | MCP through `execute` by default | Not documented |
| Codex CLI | V8, out-of-process host | `exec`, plus a code-mode-only option | Session key-value store |
| Goose ([docs](https://goose-docs.ai/docs/guides/managing-tools/code-mode/)) | Boa, worker per run | Replaces when enabled | None |
| Anthropic and OpenAI APIs | Hosted Python container / hosted V8 | Per-tool `allowed_callers` | Container state / none |
| Cloudflare | V8 isolate per run | Single tool | Durable call log with replay |

Every implementation exposes no ambient file, network, process, or environment access to the script; tool bindings are its only capability.

## 2. Current state

Checked against `4e9366efa`.

- **Tools.** `ToolDefinition` (`src/core/extensions/types.ts:850`) has a TypeBox `parameters` schema, `executionMode`, `execute`, and `present`. It has no output schema, no exposure levels, and no API for one tool to call another. The agent loop runs `prepareArguments` and then `validateToolArguments` before executing a call (`packages/agent/src/agent-loop.ts:756-787`).
- **Tool-call policy.** `SessionTurnPolicy` (`src/core/session/turn-policy.ts`) composes the session's tool-call and tool-result policy with registered turn policies. Extension services (`src/core/session/extension-services.ts`) already run trusted read tools outside the model loop through the same tool-call and tool-result gates, attributing them with `ExtensionOperationOrigin` (`src/core/extensions/services-types.ts:202`), whose variants are currently `agent` and `extension`.
- **Parallelism.** The agent loop runs a batch of tool calls sequentially if any tool in it declares `executionMode: "sequential"` (`packages/agent/src/agent-loop.ts`). The MCP gateway and direct MCP tools both declare `sequential` (`src/core/mcp/gateway-tool.ts:109`, `src/core/mcp/direct-tools.ts:34`), with no rationale recorded in code, docs, or tests; `subagent` and `request_user_input` also declare it. Otherwise the loop runs each call's preparation and policy hooks in submission order, then executes the allowed calls concurrently without a cap (`packages/agent/src/agent-loop.ts:651`).
- **File mutations.** `edit` and `write` serialize mutations per canonical file path (`src/core/tools/file-mutation-queue.ts`); mutations of different files run concurrently.
- **MCP connections.** Concurrent callers of one server share a single in-flight connection attempt (`src/core/mcp/server-supervisor.ts:172-218`), and the MCP client multiplexes requests by JSON-RPC ID.
- **MCP results.** The gateway bounds model-facing output and retains large results in a session-scoped output store with opaque cache ids and `read_cache` selection ([mcp.md](mcp.md)). It renders content blocks to text with `contentPartToText` (`src/core/mcp/manager.ts:158`), so MCP images reach the model only as placeholders. `@modelcontextprotocol/sdk` 1.32.2 decodes every message with plain `JSON.parse`, so integers above `Number.MAX_SAFE_INTEGER` are rounded before Volt sees them ([#1024](https://github.com/volt-hq/Volt/issues/1024)).
- **Bash.** No default wall-clock timeout; stall detection after 300 s of silence (`src/core/tools/bash.ts:35`) can move a foreground command into a background job through an `AsyncLocalStorage` context (`bash.ts:47`). A non-zero exit code produces an error result (`bash.ts:445`). Output beyond the model-facing limit is saved to a temp file reported as `fullOutputPath`. A caller abort keeps the partial output and appends `Command aborted`; a stall kill appends an instruction to pass a larger `stallTimeout` (`bash.ts:395-440`).
- **Process model.** Each interactive conversation runs in its own conversation worker process supervised by voltd ([daemon-hosted-conversations-design.md](daemon-hosted-conversations-design.md) section 5). Subagents are child conversations in the same host process ([architecture-rewrite-design.md](architecture-rewrite-design.md) section 7), with a default limit of 16 active descendants (`src/core/subagents/delegation-scope.ts:45`).
- **Worker threads.** Volt already ships worker threads, including in the standalone binary (`src/core/session-store/client.ts`, `src/utils/image-resize.ts`).
- **Native code.** Volt ships a Rust napi addon (`native/workspace-fs`) with prebuilds for eight targets. The standalone binary is a Node 22.23.1 single executable application (`compliance/standalone-runtime.json`); the engines floor is Node 22.19.0.
- **Sandboxing.** Volt has no OS sandbox backend (no Seatbelt, Landlock, or bubblewrap integration).
- **Tool results.** A tool's `AgentToolResult.content` (`packages/agent/src/types.ts:373`) is what the model reads; `createToolResultMessage` (`packages/agent/src/agent-loop.ts:950`) adds it to the conversation. The OpenAI Completions and Responses providers join a result's text blocks with newlines (`packages/ai/src/providers/openai-completions.ts:908`, `openai-responses-shared.ts:258`), so separate text blocks do not preserve boundaries on every provider.
- **Output spill.** `OutputAccumulator` (`src/core/tools/output-accumulator.ts`) writes over-limit output to `os.tmpdir()` with a random name and mode 0600 and does not delete it. The `read` tool is authorized by tool (`workspace.read`, `src/core/operation-authorization.ts:74`), not by path.
- **Operation classification.** `getTrustedToolOperationResolver` (`src/core/operation-authorization.ts:220`) resolves a tool call to operation capabilities such as `workspace.read`, `workspace.write`, or `process.execute` (bash). `jobs`, `image_gen`, `subagent_registry`, direct MCP tools, and extension tools have no trusted resolver.
- **Active tools.** The default active tools are `request_user_input`, `jobs`, `read`, `bash`, `edit`, `write`, `image_gen`, `web_search`, `web_fetch`, and `lsp`, plus `subagent` when a subagent manager exists and `mcp` and promoted direct MCP tools when MCP is enabled; `grep`, `find`, `ls`, and `inspect` are available but inactive by default (`src/core/tools/index.ts:249`, `src/core/sdk.ts:561-576`). Tools are switched on and off only with `--tools`, `--no-tools`, `--no-builtin-tools`, `--exclude-tools`, SDK options, and, for conversations a paired phone opens, the `remote.allowTools` ceiling; no setting adds a tool to the default set. The `background` option that bash and subagent accept comes from `withBackgroundJobs` (`src/core/tools/background.ts`).
- **Plan research evidence.** The tool-result policy records Plan research evidence for a successful call whose authorized operation provides it, keyed by tool call ID (`src/core/session/turn-policy.ts:466-474`).

## 3. Goals and non-goals

### Goals

- Let the model compose tool calls in a script whose intermediate results never enter the model context.
- Keep the sandbox a real security boundary: the script's only capability is calling bindings the host chose to expose.
- Route every nested call through the same validation and tool-call policy as a model-issued call.
- Bound compute, memory, nested calls, and output without imposing a wall-clock deadline on legitimate long-running tool work.
- Run identically on every standalone target, including Windows, without a native build step.
- Keep the runtime replaceable behind a backend interface (section 5.8).

### Non-goals

- Replacing direct tool calls or making code mode the default calling convention.
- Heavy computation inside scripts. The engine is an interpreter; scripts are glue code.
- Persistent interpreter state across scripts in v1. Scripts keep explicit JSON values with `store()` and `load()` instead (section 5.17).
- Durable replay or suspend/resume of a running script across process restarts in v1.
- Speculative execution of tool calls while the model is still streaming.
- An OS sandbox. A future one could host a different backend, but code mode does not depend on it.

## 4. Terms

- **Script:** the model-written JavaScript body run by one code-mode tool call.
- **Nested call:** a tool call made by a script through a binding.
- **Binding:** a `tools.<name>` function the prelude installs for one tool the host exposes to the script.
- **Prelude:** trusted JavaScript evaluated in each fresh VM before the script, which owns the single host bridge and builds the bindings.
- **Host:** the conversation process thread that owns the tool pipeline, policy, call records, and supervision.
- **Worker:** a worker thread that hosts at most one VM at a time.

## 5. Decisions

### 5.1 Engine

Decided: `quickjs-wasi` (QuickJS-NG compiled to `wasm32-wasip1`), pinned to an exact version. At the time of writing that is 3.6.3, which bundles QuickJS-NG 0.17.0.

- Each VM is a separate WebAssembly instance with its own linear memory. Engine memory corruption stays inside that memory; escaping requires a V8 WebAssembly bug or a bug in the host-side glue.
- The bare engine has no file, network, process, or environment access. The VM's imports are six `env.host_*` functions (call, interrupt, timezone, unhandled rejection, module normalize, module load) and six WASI functions (clock, random, `fd_write`, and stubs). The host implements all of them.
- The package is MIT-licensed, has no runtime dependencies and no install scripts, and ships a roughly 640 KB WASM binary.
- The language is JavaScript because the bare engine has no ambient authority, JSON tool data maps directly onto it, promise-based async maps directly onto tool calls, and TypeBox schemas render naturally as TypeScript declarations. No head-to-head evidence shows models writing better JavaScript than Python for this purpose.

Alternatives and why they were rejected are in section 6.

### 5.2 Isolation boundary and threading

Decided: the security boundary is the WebAssembly instance plus the host bridge. The worker thread is not a security boundary.

Each VM runs on a worker thread for two reasons:

1. QuickJS runs synchronously. A computing script on the host thread would block the conversation's event loop.
2. Interrupts are not sufficient to stop every script. Built-ins that do not poll the interrupt handler, such as `String.prototype.indexOf` over a large string, ran 2.5 s past a 300 ms interrupt deadline in testing. `worker.terminate()` stopped the same workload in about 4 ms. The worker is the hard-kill backstop.

Running the VM on the host thread is therefore ruled out.

### 5.3 Worker pool

Decided:

- **Scope:** one pool per conversation process. Separate conversations never share or contend for workers. No cross-process limit through voltd.
- **One VM per worker.** A worker hosts at most one VM at a time. Sharing a worker among VMs would let one computing script block the others, and a hard kill would fail every co-tenant script after its side effects had already happened.
- **Elastic size:** the pool starts with no workers, grows on demand up to a per-process cap, and stops idle workers after an idle timeout.
- **Process lifetime:** a script keeps the process alive from the moment it is submitted until its result is returned, including the drain of nested calls, because its caller is waiting for the result. Workers never keep the process alive, idle or busy, so a short-lived process exits when its work is done instead of when the idle timeout ends.
- **Concurrency:** each conversation (a root conversation or a subagent) runs at most one script at a time.
- **Bounded queue:** when the cap is reached, scripts wait in a bounded queue; beyond it, the code-mode call fails immediately with a clear error instead of hanging the turn.
- **No nesting:** scripts cannot call `subagent` or the code-mode tool. Without nested waits on the pool, deadlock is impossible at any cap.
- **Prepared VMs:** after code mode is first used in a process, an idle worker boots the next VM in advance so boot time is off the critical path. Processes that never use code mode pay nothing.

Defaults (section 5.18): a cap of 4 workers per process (the maximum width of one parallel subagent spawn), a queue of 4 waiting scripts, and an idle timeout of 5 minutes.

Subagents share their parent's pool because they run in the same process. With a cap of 4, four parallel subagents can each run a script concurrently; further scripts queue.

### 5.4 VM boot

Decided: create a fresh VM for every script and evaluate the prelude in it, behind a `bootVm()` interface.

- The prelude captures private references to the built-ins it depends on (primordials) before any script code runs, instead of freezing the whole realm. Scripts may patch globals without affecting the bridge, and boot is cheaper.
- The VM's `Math.random()` seed is set explicitly. During context creation QuickJS reads the realtime clock (WASI clock 0) to seed its generator and the monotonic clock (clock 1) to set `performance.timeOrigin`; with the shim's coarse clock, two VMs created back to back produced identical sequences in testing. The worker serves the realtime clock from `Date.now()`, returning a seed from `crypto.randomInt()` instead while the VM is created, and the monotonic clock from `process.hrtime.bigint()`, so `performance.now()` measures time since the VM booted and never follows wall-clock steps. Seeding in the worker lets it boot the next VM before the next script arrives.
- `maxStackSize` is always set (512 KiB, `MAX_STACK_SIZE`), and workers run with `resourceLimits.stackSizeMb: 32`. QuickJS's stack guard measures the stack it keeps in linear memory, but WebAssembly call frames also use the worker's native stack, which the guard does not see, so the native stack must be deep enough for the guard to fire first. Without the guard, deep recursion overflowed the host stack. With the guard, recursion and a 100,000-level `JSON.parse` ended in a catchable guest `RangeError` from 8 MB up, but parsing deeply nested source (the script itself, `eval`, or `new Function`) needed 11 MB on Node 24.20 and 13 MB on Node 25.2 (section 11). Newer V8 versions use more native stack per WebAssembly frame, so the default leaves about 2.5 times the most measured. Stack pages become resident only as a script recurses, but on Windows each worker commits its whole stack when it starts: 4 workers at 32 MB committed 96 MB more than at 8 MB on Node 24.20, so a process commits up to 128 MB of worker stack while its workers are alive. A host-side `RangeError` from a VM operation is still treated as a sandbox failure that discards the VM (section 5.11).

Rejected for now:

- **Snapshot restore** (about 0.8 ms against about 4.9 ms for create plus a 16.8 KB prelude). With a fresh VM per script, the prelude already runs before untrusted code, so a snapshot gives no integrity advantage. It adds fingerprinting and invalidation, re-registration of host callbacks, identical random state across restores, and a raw memory image that must be trusted like native code. Boot is off the critical path once VMs are prepared in advance, so the latency difference does not matter. Revisit if the prelude grows enough to matter or if suspend/resume is built; `quickjs-wasi` can snapshot any VM regardless of how it booted.
- **Precompiled prelude bytecode.** It saved 1.2 ms because executing the prelude, not parsing it, dominates. QuickJS-NG treats untrusted bytecode as out of scope, and the format is tied to the engine version.
- **Reusing a VM across scripts.** State would leak between scripts, WebAssembly memory never shrinks, and any tampering with the prelude would persist.

### 5.5 Bridge mechanics

Decided:

- Async host calls use promises and job-queue draining, without Asyncify or JSPI. A binding creates a promise in the VM and posts the call to the host. The VM drains its pending jobs and goes idle. When the host settles the call, it resolves the promise in the VM and drains again. Many nested calls can be in flight at once, and results can arrive in any order. JSPI is unavailable on the Node 22 standalone binary in any case.
- Exactly one host function is registered: the bridge, held by the prelude in a closure the script cannot reach. `quickjs-wasi` dispatches host callbacks by a name stored in guest memory, so a guest whose memory is corrupted could call any registered callback; registering only one keeps that surface to the bridge itself.
- The host treats everything arriving through the bridge as untrusted, even though only the prelude calls it:
  - It accepts only primitive strings and checks `isString` before reading a handle. Calling `toString()` on a non-string handle executes guest code and would re-enter the VM.
  - It creates handles inside `withScope` and never uses a handle after disposal, which reads freed WebAssembly memory.
  - It never re-enters the VM from inside a host callback.
  - Any host-side exception from a VM operation discards that VM.
- `executePendingJobs()` honored the interrupt handler for `while (true) await null` (interrupted at 302 ms in testing), so the runtime uses only the public API and does not depend on internal exports.

The bridge contract built on these mechanics is in section 5.9.

### 5.6 Supervision and budgets

Decided: a compute budget and a nested-call budget, with no default wall-clock deadline. Waits on nested tools behave like waits on direct tool calls: bounded by each tool's own limits (for example MCP `callTimeoutMs` and bash stall detection) and by user cancellation.

- **Compute budget.** Default 30 s of time spent executing inside the VM. The worker sums the time spent inside `evalCode` and `executePendingJobs` calls, and the interrupt handler compares the sum with the budget. Time awaiting nested calls, approvals, or user input does not count.
- **Watchdog.** The worker publishes a "computing since" timestamp in shared memory whenever the VM executes. A host-side watchdog terminates the worker when continuous execution exceeds the budget plus the grace period, which covers built-ins that do not poll the interrupt handler.
- **Nested-call budget.** Default 200 calls per script, counted before each call is scheduled. Exhausting it aborts the script with a clear error that the script cannot catch.
- **Optional script timeout.** The model may set a wall-clock `timeoutMs` for one script, capped (initially 30 min), to bound its own work.
- **Cancellation.** A user abort (Esc, or cancelling from a remote client) aborts in-flight nested calls through their signals, sets the interrupt flag, and terminates the worker if the VM has not stopped within the grace period. Every stop the host decides (abort, timeout, call budget, output limit) aborts the nested-call signals at once, without waiting for the VM to stop.
- **Stop sequence.** Interrupt flag, then a grace period (initially 250 ms; honored interrupts stopped within about 70 ms in testing), then `worker.terminate()` and a background respawn.
- **Excluded time.** VM boot and waiting in the pool queue count toward no budget.
- **Memory.** `memoryLimit` is set on every VM. A 32 MiB limit held in testing: a string bomb and `new ArrayBuffer(1e9)` both failed with a catchable out-of-memory error, linear memory stayed at 32.3 MiB, and the VM remained usable. The default is 64 MiB (section 5.18).
- **Bash stall move.** Bash calls made from a script run without the stall-move context, because a script needs the command's result, not a background job handle. Nested calls run in a scope the background-job wrapper of bash and subagent honors: a silent command is killed as hung, and `background: true` is refused.

Rejected: a single elapsed deadline covering tool and approval waits (Pi, DeepSeek). Approvals answered from a phone would count against it, the model would have to guess a timeout, and legitimate long work would fail. An overall cap that pauses while a nested call waits on the user may be added later if needed. Codex-style yield-and-poll is rejected; an opt-in background mode that reuses Volt's existing jobs and completion-wake mechanism is the preferred direction for long scripts, outside v1.

### 5.7 Engine configuration

Decided:

- **Intrinsics:** all except `WEAK_REF`. `WeakRef` and `FinalizationRegistry` add garbage-collection timing nondeterminism and finalizers can fire after the script settles. `EVAL` is kept because it only creates code inside the same VM; `PROXY` is kept because disabling it also removes `Reflect`, and the host only receives strings from the guest, so proxy traps cannot run in host code. `BIG_INT` cannot be disabled in QuickJS-NG.
- **Extensions:** none in v1. The optional URL, encoding, Headers, crypto, and structured-clone extensions use a dynamic-linking ABI that `quickjs-wasi` describes as experimental, add C and C++ attack surface, and add license notices. If UTF-8 encoding becomes necessary, a small JavaScript implementation in the prelude is preferred over loading an extension.
- **Timezone:** the host timezone, matching bash. Scripts are not re-executed on replay, so determinism is not required.
- **Module loader:** none. Without one, `import` fails inside the VM.
- **Engine diagnostics:** QuickJS writes to WASI file descriptors 1 and 2; the host discards that output so it never reaches the terminal or a client.

### 5.8 Host and worker protocol

Decided: the host and the worker exchange framed, transport-neutral messages. The worker-thread backend is the only backend in v1, but a future backend (for example a Rust sidecar process with OS-level memory and CPU limits, or a process under an OS sandbox) should replace the transport without changing the bridge, policy, or tool integration above it.

### 5.9 Bridge contract

Decided. The contract has four layers: the script API, the prelude's bridge function, the messages between worker and host, and host dispatch into the tool pipeline.

#### Value codec

Values cross the VM boundary only as JSON text. The prelude encodes and decodes with built-ins it captured before the script ran. The host never inspects guest objects (no `dump()` or `hostToHandle()` on guest values), so no guest getter, proxy trap, or `toJSON` method runs on the host side.

The codec is lossless: a value either round-trips exactly or fails with an error that names its path, for example `args.when: Date is not JSON; use .toISOString()`.

- **Accepted values:** `null`, booleans, finite numbers (including `-0`), BigInt, strings (including lone surrogates), dense arrays, and plain objects whose prototype is `Object.prototype` or `null`.
- **Rejected values:** `NaN`, `Infinity`, `-Infinity`, `undefined` in arrays, array holes (including holes a script fills through `Array.prototype`, or with a getter while the array is being encoded), arrays with properties besides their elements, arrays with a prototype other than `Array.prototype`, functions, symbols, symbol-keyed properties, non-enumerable own properties, non-plain objects (`Date`, `Map`, `Set`, `RegExp`, typed arrays, `ArrayBuffer`, errors, boxed primitives, class instances), cycles, keys named `__proto__`, and nesting deeper than 64 levels. `toJSON` is never called, so nothing converts silently. Each element and property is read only while it is still an own enumerable property, so a getter that deletes one during encoding cannot make the codec encode a value inherited from a prototype; properties a getter adds during encoding are not part of the value.
- **One normalization:** object properties whose value is `undefined` are omitted. A missing field and `undefined` mean the same thing in tool arguments.
- **Encoding:** numbers are written as exact literals. Integers of 2^53 and above are written with all their digits (the double `2 ** 60` as `1152921504606846976`, not the shortest form `1152921504606847000`), so the literal is the double's exact value. Other numbers use their shortest form. BigInt values are written as their digits and `-0` as `-0`.
- **Decoding:** an integer literal decodes to a number when a double holds its value exactly, and otherwise to a BigInt. A literal with a fraction or exponent must be the shortest form of the double it decodes to; anything else is a protocol violation. JSON has one number type, so the codec preserves values, not the number/BigInt distinction: a BigInt that a double holds exactly arrives as a number. Decoded numbers must be finite.
- **Invariant:** neither side can produce a non-integer literal that a double cannot hold exactly, because both sides only hold doubles and BigInts. Receiving one is a protocol violation. When [#1024](https://github.com/volt-hq/Volt/issues/1024) brings exact decimals from MCP servers, the codec gains a type for them; `lossless-json`'s `LosslessNumber` is the reference design.
- **Implementation:** native on both sides, using a `JSON.parse` reviver that reads `context.source`, and `JSON.rawJSON`. Both are available in QuickJS-NG 0.17 and in Node 22.20 and 24.20. The host decodes with plain `JSON.parse` when the text cannot contain an unsafe or non-finite number literal (no run of 16 or more digits and decimal points, no exponent of three or more digits, no `"__proto__"` key, and no `\u` escape, which could spell one), and with the reviver otherwise. Encoding walks the value itself rather than using `JSON.stringify`, which would call `toJSON` (and so convert a `Date` to a string) before a replacer could reject it.
- **Patched built-ins:** the codec and the prelude keep their working lists in arrays without a prototype, because pushing onto an ordinary array runs setters a script may define on `Array.prototype` indices. For the same reason the prelude never calls QuickJS's `JSON.stringify` on an object: its implementation keeps its own stack in an ordinary array. It completes the script's promise with the intrinsic `then` and an own `constructor` of `undefined`, so a patched `Promise[Symbol.species]` or `Promise.prototype.constructor` is not consulted. Its property descriptors have no prototype either, because `Object.defineProperty` reads descriptor fields such as `get` through the prototype chain. A test patches every built-in the prelude and codec use, adds index accessors and descriptor fields to both prototypes, and then exercises the whole bridge.
- **Script-side parsing:** the script's own `JSON.parse` keeps standard semantics. Guidance shows the `context.source` reviver for scripts that parse large integers out of text output.

Rejected:

- Marshaling with `dump()` and `hostToHandle()`, which walks guest objects from the host and re-enters the VM.
- Plain `JSON.stringify` and `JSON.parse`, which coerce `NaN`, `-0`, `Date`, and `Map` silently and round large integers.
- `lossless-json` inside the VM: on a 0.89 MiB payload it parsed in 308.6 ms against 41.6 ms for the native reviver, stringified in 194.6 ms against 40.5 ms, and added 10.9 ms to every VM boot.
- `lossless-json` on the host: its slow path is 2 to 3 times faster than the native reviver and it rejects conflicting duplicate keys, but it is a new dependency for a path the fast path rarely takes. Duplicate keys cannot create a parser differential, because the host parses each frame once and policy and the tool see the same object.

The bridge cannot recover precision a transport has already lost. MCP results are rounded by the MCP SDK today ([#1024](https://github.com/volt-hq/Volt/issues/1024), [modelcontextprotocol/typescript-sdk#3150](https://github.com/modelcontextprotocol/typescript-sdk/issues/3150)).

#### Script API

- `tools.<name>(args)` takes zero or one argument. An omitted or `undefined` argument becomes `{}`; anything else must encode to a plain object. It returns a promise of the call's script value. An encoding error rejects that promise without issuing a call.
- **Script values:**
  - **Default:** the tool result's text blocks joined with newlines.
  - **bash:** `{ output, exitCode, truncated, fullOutputPath? }` for a command that ran to completion with any exit code. A command that could not start, timed out, or was aborted rejects. The exit code comes from the bash result's `details`, which carry `exitCode` for a command that ran to completion.
    - When no `tool_result` hook saw the result, `output` is the command's output: without the status line bash appends for a non-zero exit, empty when `details.noOutput` says the command printed nothing (the text then shows a placeholder), and read from `fullOutputPath` when the model saw it truncated.
    - When a hook saw the result, `output` is the result's text as the hooks left it, and `fullOutputPath` is omitted. A hook sees only the model-facing text, so a value that read the rest of the file would bypass a redacting hook.
    - Output that does not fit the size cap keeps its head and tail, cut at character boundaries around a marker, so the whole value fits. `truncated` says whether `output` is incomplete.
  - **read:** the text result for a text file, and an image reference for an image file.
  - **image_gen:** an image reference whose `path` is the file the image was saved to.
  - **MCP tool calls:** `{ text, structured?, images }`. `structured` is the result's `structuredContent`, typed from the tool's output schema when it has one. `images` holds image references for image blocks. `text` joins the remaining blocks as the gateway renders them for the model (`contentPartToText`).
    - `tool_result` hooks see the result as its complete text (`callToolResultToText`, with placeholders for images), never bounded or cached. When they leave its content and `isError` as they were, the value is the whole projection. When they change either, the value is `{ text, images: [] }` with the text they left, and an error they leave rejects with `failed`: a value never carries structured content or images a hook did not leave in place.
  - Projections are internal to built-in tools and MCP in v1. `ToolDefinition` is unchanged, and extension tools get the default.
- **Size:** a script value is at most 1 MiB once encoded. The runtime gives each call this cap (`maxValueBytes`), and projections bound themselves to it before materializing a value: bash measures the encoded size of its output exactly, escapes included, and reads only the head and tail of `fullOutputPath`. A value that still exceeds the cap rejects with `failed` (`result_too_large`), and the images it carried are dropped.
- **Errors:** a failed nested call rejects with a `ToolCallError` (an `Error` subclass the prelude provides) carrying `tool`, `kind`, an optional `reason`, and a `message` of at most 8 KiB. Kinds:
  - `invalid_arguments`: argument preparation or schema validation failed.
  - `blocked`: the tool-call policy denied the call.
  - `failed`: the tool returned an error result or threw, or the call hit a limit. `reason` distinguishes `result_too_large`, `limit_exceeded`, and `unavailable`.
  - `cancelled`: the call was aborted. `reason` is `not_started` for a call that never started because the script ended while it waited.

  Scripts can catch these, and `Promise.allSettled` keeps the results of calls that succeed. Projections may resolve instead of rejecting where a failure is ordinary data, as bash does for exit codes.
- **Terminations:** exhausting the call budget or the compute budget, the script timeout, a user abort, the output limit, and a protocol violation end the script. The script cannot catch them, and pending awaits never resume. Section 5.11 describes how they are reported.

#### Images

Nested calls never move image bytes into the VM. An image resolves to a reference:

```ts
interface ImageRef {
	type: "image";
	ref: string;
	mimeType: string;
	width?: number;
	height?: number;
	bytes: number;
	path?: string; // present when the image came from a file
}
```

- The host keeps the bytes for the lifetime of the script. References are valid only within the script that received them.
- A call retains the images of its value through the runtime (`CodeModeCall.images`) and puts their references in the value. They count toward the script's limit from then on, but become the script's only when the value is posted to it; a rejected value (such as `result_too_large`), a failed call, and a call still unsettled when the script ends drop them. The references the host issues are these images, never found by scanning the value, so a value shaped like a reference cannot be shown.
- Only images the script passes to `image(ref)` reach the model, at most 10 per script. A `result` message lists the image references the host issued with its value, and the prelude accepts only references the script has received: `image()` throws a `TypeError` for anything else and a `RangeError` for an eleventh image, both catchable. The host checks both as well, and treats an image output that breaks either rule as a protocol violation. An image shown without a file (from MCP) is saved to a temp file and its path is reported, so a later turn can pass it to tools that take image paths.
- `width` and `height` come from the image's PNG, GIF, JPEG, or WebP header, and are absent when the header does not give them.
- When a script ends with images it never showed, the result lists them, so the model learns the rule from the feedback instead of losing images silently.
- The host retains at most 64 MiB of decoded image bytes per script, counting the images of calls in flight. A nested call whose images would exceed that rejects with `failed` (`limit_exceeded`). The limit is checked first against the size the base64 length allows, so data over it is never decoded.
- Image data must be base64 (RFC 4648). Whitespace and missing padding are accepted, and the host keeps the canonical form, which is what later reaches the model. Empty data or data that is not base64, such as base64url or a `data:` URL, rejects the call with `failed`.
- Passing references as tool arguments is a non-goal: Volt's image tools take file paths (`image_gen` takes `referenced_image_paths`), which scripts pass as strings.

Rejected:

- Attaching every nested image to the outer result (DeepSeek, Pydantic, OpenCode). Nothing is forgotten, but a script that reads many images floods the model and the session, and a count cap drops images arbitrarily.
- base64 inside the VM (Pi). Volt's image tools take paths, so the bytes buy nothing, they count against the VM memory limit, the argument cap would block passing them on, and the model can print them by mistake.
- Including every image unless the script calls `image()`. An implicit mode switch with no precedent.

#### Bridge function

The prelude calls one host function with two primitive strings: a kind (`call`, `output`, or `done`) and a payload. The worker checks `isString` on both before reading them and forwards them to the host. The prelude numbers call attempts with `seq` values 1, 2, 3, and so on, assigned after the arguments are encoded, so a getter that calls a binding during encoding posts its call first and the numbers still arrive in order.

#### Messages

| Direction | Message | Contents |
|---|---|---|
| Worker to host | `ready` | `protocol`, `engine` versions, sent once the first VM has booted |
| Worker to host | `call` | `seq`, `binding`, `args` (codec text) |
| Worker to host | `output` | One output item: text, console text, or an image reference |
| Worker to host | `done` | `ok` with the return value (codec text), or the script error and the phase it occurred in (`evaluate` for syntax errors, `run` otherwise) |
| Worker to host | `stopped` | `reason`: the host's stop request, or the compute budget |
| Worker to host | `stalled` | none; the script awaits a promise nothing can settle (section 5.11) |
| Worker to host | `crash` | `reason` |
| Host to worker | `start` | `script`, bindings, limits |
| Host to worker | `result` | `seq` with a script value (codec text) and the image references the host issued with it, or a `ToolCallError` description |
| Host to worker | `stop` | none |

- Every message except `ready` carries the id of its script. The worker ignores `result` and `stop` messages for a script that is no longer running, and the host ignores worker messages for a script that has ended, so a stop that crosses a `done` cannot affect the worker's next script.
- `done`, `stopped`, `stalled`, and `crash` end the script; the worker then disposes the VM and boots the next one. After `done` or `stopped` the host may hand the worker to the next script immediately; after `crash` it terminates the worker.
- The host's stop request travels twice: as the `stop` message, which the worker handles when its VM is idle, and as the script id written to memory shared with the worker, which the interrupt handler reads while the VM computes. The worker publishes in the same memory when its VM started executing, from `process.hrtime.bigint()`, a monotonic clock shared by the threads of a process, and how much compute the script used before, which the watchdog reads.
- Each `seq` receives at most one `result`, and the host sends nothing after `done`. The worker applies results only while the VM is idle.
- A `protocol` version mismatch fails closed. This catches packaging errors such as a stale worker file in the standalone binary; it is not a compatibility path. The version changes whenever a message shape or the prelude's script API changes.
- Messages travel over `postMessage` as plain objects with string fields today. A process backend would carry the same messages as length-prefixed UTF-8 JSON frames.
- The host validates every message as if the worker were untrusted. Worker code is trusted today, but a future backend may not be. A malformed message is a protocol violation: the host terminates the VM, and the script fails with a `sandbox` error.
- The host enforces the bounds and the one-line rule of error descriptions (section 5.11) itself; a description beyond them is a protocol violation.
- The host handles worker messages, timers, and aborts outside any promise chain, where an exception would reach the process as uncaught. Every such handler runs inside one guard that turns an exception into a `sandbox` failure of that script.

#### Host checks for each call

1. **Message shape.** `seq` is exactly one more than the previous `seq`; `binding` is a string of at most 256 characters; `args` is a string within the argument cap. Any violation is a protocol violation.
2. **Call budget.** Counted here, so attempts that fail in later checks still count. Exhaustion terminates the script.
3. **Binding set.** The binding must be in the set fixed when the script started; otherwise it is a protocol violation, because the prelude exposes only those bindings.
4. **Outstanding argument bytes** across unfinished calls must stay within their cap; otherwise the call rejects with `failed` (`limit_exceeded`).
5. **Decode `args`** with the codec. The result must be a plain object; otherwise `invalid_arguments`.
6. **Tool still active.** The tool must still be active; otherwise `failed` (`unavailable`). For an MCP tool this is the tool the model's call to it goes through: the built-in `mcp` gateway when it makes the tool callable, otherwise the tool's direct tool. A server that disconnected or a tool disabled since the script started fails later, when the MCP manager runs the call. The tool must also be the same registered tool it was when the script started, so a tool an extension replaced in the meantime is unavailable. Whether it is the trusted built-in tool of its name is read with it then, and picks the call's projection in check 10, so a registry change while the call runs cannot change it.
7. **`prepareArguments` and `validateToolArguments`,** the same path as the agent loop; otherwise `invalid_arguments`. Arguments holding a BigInt are rejected first, because no tool schema accepts one. For a built-in or extension tool, so is `background: true` (section 5.12). An MCP call is checked as the model's call would be: the gateway's input `{ action: "call", server, tool, arguments }`, or the arguments themselves for a direct tool. Its arguments go to the server as they are, `background` included.
8. **Tool-call policy,** with an origin naming the parent tool call and `seq`, and the call ID `<parentToolCallId>:cm:<seq>`. IDs follow attempts, so invalid attempts leave gaps. A denial rejects with `blocked`. The policy is the session's, the one model-issued calls go through: the active-tool check, extension `tool_call` hooks, the grant profile, and registered turn policies. Each policy sees its own copy of the call, so the call runs with the input checked here; an MCP call runs with its binding's server and tool. Checks 6 to 8 run in submission order: a call's checks start once the earlier call's have finished, so a call waiting for an approval holds back the checks of later calls, as the agent loop prepares calls in order.
9. **Schedule and execute,** with an abort signal linked to the script's, under the scheduling rules of section 5.13. A built-in or extension tool runs as registered. An MCP call runs through the MCP manager's call path (`callToolRaw`) rather than the gateway or direct tool. It gets the checks, events, recent-call record, and audit entry of a model-issued call, and the result as the server sent it, which is neither bounded nor written to the output store: that store keeps 64 entries, for the results model-issued calls read back with `read_cache`, and a script's calls would evict them.
10. **Tool-result policy, projection, and size cap,** then the `result` message. The tool-result policy's hooks observe the call's signal, as its tool-call policy's do, so they see a script that stopped while the call ran. The projection receives the result as the tool returned it and what the tool-result policy returned, which is nothing when no `tool_result` hook saw the result. A call whose signal aborted rejects with `cancelled` and a fixed message: the tool's output, which a hook may have redacted, never reaches the call record. A call cancelled before its tool started rejects with `cancelled` (`not_started`), whatever failed on the way, including a policy that rejects on the abort. An MCP call that fails before its request is sent rejects with `failed` (`unavailable`), after the tool-result policy has seen the failure as an error result: an unknown, disabled, or unreachable server, one that needs authentication, unreadable tool metadata, a tool that is missing or filtered out, or a failed trusted-read revalidation. Any later failure, and an error result, rejects with `failed`.
11. **Record the call** for the outer result: tool name, a bounded summary of the arguments, status, duration, and error.

#### End of a script

When the script finishes, fails, or is terminated, the host aborts in-flight nested calls through their signals and waits up to about 1 s for them to settle. Calls that settle are recorded with their final status; calls still unsettled are recorded as possibly applied, because a tool can apply a change before it stops. Results that arrive later are discarded. DeepSeek drains before settling, Goose bounds its drain at 1 s, and Pydantic reports unfinished calls as possibly applied.

#### Caps

Defaults (section 5.18):

| Limit | Default |
|---|---|
| Arguments per call | 1 MiB encoded |
| Outstanding argument bytes per script | 16 MiB |
| Script value per nested call | 1 MiB encoded |
| `ToolCallError` message | 8 KiB |
| Message frame | 8 MiB |
| JSON nesting depth | 64 |
| Binding name | 256 characters |
| Images shown per script | 10 |
| Image bytes retained per script | 64 MiB |

The call budget (section 5.6) bounds how many calls can be outstanding. Caps on script output are in section 5.10.

### 5.10 Model-facing result

Decided. While the script runs, its output items arrive at the host as `output` messages, and the host accumulates them. After the end-of-script drain (section 5.9), the host assembles the code-mode tool's `AgentToolResult`. Its `content`, made of text and image blocks, is the only part of a code-mode call the model reads; `details` carries records for the TUI, session records, and remote clients (section 5.16). This section describes a successful script; failures reuse the same rendering (section 5.11).

#### Output channels

- `text(value)`, `console.log`, `console.info`, `console.debug`, `console.warn`, `console.error`, and `image(ref)` append items to one stream in call order.
- Output formatting is lenient and never throws, unlike the bridge codec. Strings render as-is. Other values render as compact JSON, with descriptive forms for values JSON cannot represent: `12n`, `undefined`, `Map(1) {"k" => 1}`, `Set(2) {1, 2}`, ISO dates, `TypeError: message`, `[Function name]`, and `[Circular]`.
- Console arguments are joined with spaces. `console.warn` and `console.error` items are prefixed `warn: ` and `error: `; the other levels are not.
- A top-level `return` adds a final item labeled `Return value: `. Returning `undefined` adds nothing.
- `image(ref)` adds an image block preceded by a caption line: `[image img_1: image/png 1280x720, <path>]`.

Rejected:

- A separate console block (Pi). It loses the order between console and other output; fences (below) solve the boundary problem it was introduced for.
- Removing `console` (Codex, OpenAI). No evidence supports it, and models write `console.log` by habit.
- A separator before every item (Pi). It doubled the tokens for 50 single-line `text()` calls in the prototype (927 against 471).

#### Rendering

- The first line is a status line: `Script completed in 3.2 s (14 tool calls)`.
- Items follow, one per line. An item whose text spans several lines is fenced, and the fence header states its line count, so the end of the item is unambiguous even if the item itself contains `>>>`:

  ```
  <<< output #3, 12 lines
  ...
  >>>
  ```

  Pi had to fix outputs running together because models could not tell where one ended and the next began ([v1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0)). Fencing only multi-line items keeps boundaries unambiguous at no cost when items are single lines.
- A script that printed nothing and returned `undefined` renders `(no output)`.
- Images not shown with `image(ref)` are listed on one line after the return value: `2 images not shown: img_3 (read b.png), img_4 (MCP browser.screenshot)`.
- Nested-call records do not appear in a successful result; they go to `details`. Models use whatever reaches them: Cloudflare moved call records out of model output after models rebuilt answers from them, and Pi shows nested calls to the model only after a failure.
- Text blocks are split around image blocks. Boundaries are marked in the text, so providers that join text blocks still see them.
- The result is plain text, not a JSON envelope. In the prototype a compact JSON envelope cost about the same tokens, cost more with images (108 against 70), and became invalid JSON once truncated.

Example:

```
Script completed in 3.2 s (14 tool calls)
reading 2 files
<<< output #2, 2 lines
export const a = 1;
export const b = 2;
>>>
warn: b.ts has CRLF endings
[image img_1: image/png 1280x720, C:\repo\test-results\login.png]
(image block)
Return value: {"files":["a.ts","b.ts"],"lines":5}
1 image not shown: img_2 (read old.png)
```

#### Truncation and spill

- **Budget.** Volt's standard model-facing limit, 50 KB and 2000 lines (`src/core/tools/truncate.ts`), applied to the whole rendered text.
- **Priority.**
  1. The status line is always kept.
  2. The return value may use up to half the budget. A larger return value is truncated structurally: array lengths and string lengths are capped uniformly until it fits, with `"[N more items]"` and `"... [N more chars]"` markers, so it remains valid JSON. A string return value keeps its head and tail.
  3. The output stream uses the remaining budget, keeping its head and tail around one marker.

  Either part may use budget the other leaves unused.
- **Spill.** When anything is truncated, the full rendering is written to a temp file through `OutputAccumulator`, as bash does, and the marker names it: `[... 3365 lines omitted (4002 lines, 315 KB total). Full output: <path> (read with offset/limit)]`. The model reads it with `read`, which is authorized in Build and Plan alike. Temp files are left for the OS to clean up, as bash's are.
- **No per-script override** of the budget (unlike Pi's `max_output_tokens`), matching bash. The model reads the spill file when it needs more.

Rejected:

- Head and tail over the whole output (Pi, Codex, DeepSeek). It can cut a large return value mid-JSON.
- Dropping the middle without a spill file (Codex, whose users have asked for one).
- The MCP output store as the spill target. It is MCP-specific and readable only through the `mcp` tool, which exists only when MCP is configured.

#### Retained output

While the script runs, the host retains at most 16 Mi characters of output text and 100,000 output items, Pi's limits enforced on the host instead of in the guest. Exceeding either, or a single output item larger than the 8 MiB message frame (section 5.9), terminates the script with an output-limit failure the script cannot catch. Output retained up to that point is kept and spilled.

### 5.11 Failures

Decided. A failed script returns the rendering of section 5.10 with a failure status line, an error block, and a summary of its nested calls, and the result is marked `isError: true`. Partial output is always kept, including after an abort. Bash does the same: a caller abort keeps the command's partial output and appends `Command aborted`. DeepSeek instead replaces an aborted run's output with `tool call aborted`, and OpenCode discards finished results on interrupt, an open bug ([anomalyco/opencode#54222](https://github.com/anomalyco/opencode/issues/54222)).

#### Failure kinds

| Kind | Cause | Status line ending |
|---|---|---|
| `script_error` | An uncaught exception or rejection: syntax errors, a stack overflow inside the guest, out-of-memory, an uncaught `ToolCallError`; or a script that awaits a promise nothing can settle | `uncaught TypeError` (the error's name), `syntax error`, `stalled` |
| `compute_budget` | The compute budget ran out (interrupt or watchdog) | `compute budget of 30 s exhausted` |
| `call_budget` | The nested-call budget ran out | `call budget of 200 exhausted` |
| `timeout` | The script's own `timeoutMs` passed | `timed out after 60 s` |
| `aborted` | The user or caller aborted | `aborted` |
| `output_limit` | Retained output exceeded its limit | `output limit exceeded` |
| `sandbox` | The worker crashed or failed to start, a protocol violation, or any host-side exception from a VM operation, including a host-side `RangeError` | `sandbox failure` |

- A script that never started, because the pool queue was full or it was aborted or timed out while waiting for a worker, says `The script did not start.` in its error block. It consumed no budget.
- **Stalled scripts.** The VM has no timers, so when it is idle with no nested call in flight and the script has not finished, nothing can resume it. Without a default wall clock (section 5.6), such a script would hold the turn until the user aborts it. The worker detects this state after every turn and ends the script as `script_error` with `The script awaited a promise that nothing can settle: no tool calls were in flight.`
- Scripts cannot intercept the terminations of section 5.9. In testing, a `try`/`catch` around a spinning loop did not catch the interrupt the host raises.

#### Rendering

The status line names the kind: `Script failed after 6.4 s (49 tool calls): uncaught TypeError`. The output stream follows as in section 5.10, then the error block, then the nested-call summary.

**Error block:**

- `script_error`: `Name: message` followed by the stack. Frames carry script line and column numbers (`at parse (script.js:2:10)`), because the script shares its first line with the wrapper prefix; column numbers on that first line are corrected for the prefix. A `cause` chain renders up to three levels (`Caused by: SyntaxError: ...`), and an `AggregateError` renders up to five inner errors. A thrown value that is not an `Error` renders as `Thrown string: ...`, `Thrown object: {...}`, or `Thrown null`. A describe step in the prelude captures all of this before the value leaves the VM; read from the host, a thrown object becomes `[object Object]`.
- Out-of-memory adds a hint: `The script exceeded its memory limit (64 MiB). Filter or aggregate data instead of accumulating it.`
- Other kinds get one sentence naming the limit and what to do next, following DeepSeek's call-limit message:
  - `call_budget`: `Call 201 was not made. The script may loop without end; check loop termination, or split the work into several scripts.`
  - `compute_budget`: `The script computed for more than 30 s without waiting on a tool. Process less data per script, or move heavy work into tools.`
  - `timeout`: `The script's timeoutMs of 60000 passed. Nested calls in flight were cancelled.`
  - `aborted`: `The script was aborted. Nested calls in flight were cancelled.`
  - `output_limit`: `The script printed more than 16 Mi characters or 100,000 items. Print summaries and return selected fields instead of whole results.`
  - `sandbox`: `The sandbox failed: <reason>. Calls listed below may have taken effect.`
- The error block is at most 8 KiB. The one-line summary used in status lines and warnings is at most 1,024 characters, and the error's name at most 128; line breaks in either appear as `\n`, so a message cannot add lines that read as other parts of the result. Each limit includes its truncation marker.

**Nested-call summary:**

- A totals line with exact counts: `Nested tool calls: 49 (46 completed, 1 failed, 1 cancelled, 1 may have applied). Completed calls were not undone.` A script that made no calls says `No tool calls were made.`
- Read-only calls are collapsed per tool: `Read-only: read ×41 (1 cancelled), grep ×3`. A call is read-only when its trusted operation resolution contains only read capabilities (`workspace.read`, `network.read`, `process.inspect`, `integration.discover`, `integration.read`).
- Every other call is listed individually under `May have changed state:`: calls that resolve to a write, execute, or prompt capability (bash resolves to `process.execute`), and calls with no trusted resolver, such as `image_gen` and extension tools. Each entry shows the tool name, an argument preview, and the outcome.
  - Argument preview: strings of up to 60 characters in full, longer strings as `<1470 chars>`, other values as compact JSON, at most 120 characters per call.
  - Outcomes: `completed`, `failed: <message>`, `cancelled before it ran`, and `still running when stopped; may have applied`.
- At most 20 entries are listed, followed by `(N more not shown)`; the totals stay exact.
- Full call records go to `details` on success and failure alike. A successful result omits the summary (section 5.10).

Example:

```
Script failed after 6.4 s (49 tool calls): uncaught TypeError
generated 6 test files
warn: widget3 has no default export

TypeError: cannot read property 'length' of undefined
    at summarize (script.js:24:18)
    at <anonymous> (script.js:31:7)

Nested tool calls: 49 (46 completed, 1 failed, 1 cancelled, 1 may have applied). Completed calls were not undone.
Read-only: read ×41 (1 cancelled)
May have changed state:
- write path="src/generated/widget0.test.tsx" content=<1470 chars>: completed
- write path="src/generated/widget1.test.tsx" content=<1470 chars>: completed
- bash command="npx vitest run src/generated --reporter=dot": failed: Command exited with code 1
- mcp__github__create_issue owner="volt-hq" repo="Volt" title="Generated tests fail for widget3" body=<400 chars>: still running when stopped; may have applied
```

**Background rejections.** A promise that rejects without the script handling it is reported as a `warn: unhandled rejection: <description>` line in the output when the script completes, fails with an error, or stalls. At most 10 are described; one more line counts the rest, such as `warn: 3 more unhandled rejections not shown`. The count is exact even past the 100 rejections the worker tracks at once, because QuickJS also reports when an untracked rejection gets a handler. A script the host stops (a budget, the timeout, an abort, or the output limit) reports none, because describing a rejection would run script code after the stop. A rejection counts only if it is still unhandled when the script can no longer resume, because it finished or stalled; a script that attaches a handler after awaiting a call, such as `const a = tools.x(); const b = tools.y(); await a; await b;` when `b` fails first, gets no warning. The warnings therefore follow the script's other output. QuickJS's rejection callback also fires for the script's own promise when the script fails; the host excludes that one.

**Truncation priority.** Under the budget of section 5.10, a failed result keeps, in order: the status line, the error block, the nested-call summary, and then the output stream, head and tail.

Rejected:

- Names and statuses only (Pi). For the 49-call prototype it cost 216 tokens without showing which writes happened.
- Every call in order, capped at 20 entries (Pydantic). It cost 299 tokens, and the 20 entries shown were all reads, hiding the writes.
- Discarding output on abort (DeepSeek, OpenCode).
- No summary (Codex). Its users have asked for one ([openai/codex#49908](https://github.com/openai/codex/issues/49908)).

### 5.12 Tool scope and bindings

Decided. The binding set is computed once, when a script starts (section 5.9), from three rules: no escalation, eligibility by operation capability, and the session's grant profile.

#### No escalation

A binding exists only for an operation the model could call directly in the same session at that moment:

- Built-in and extension tools must be active after tool policy: `--tools`, `--exclude-tools`, and a subagent's own tool policy. Available but inactive tools get no binding; by default that includes `grep`, `find`, `ls`, and `inspect`.
- MCP tools require the `mcp` tool to be active and the tool to pass its server's `includeTools`/`excludeTools` filters and project trust.

Code mode therefore never grants a capability the session lacks. A subagent's scripts get bindings from the subagent's own tool policy.

#### Eligibility

Bindable tools:

| Tools | Operation capability |
|---|---|
| `read`, `grep`, `find`, `ls` | `workspace.read` |
| `web_search`, `web_fetch` | `network.read` |
| `inspect`, `lsp` | Resolved per action: reads, plus `workspace.write` for `lsp` `rename` and `fix` |
| `edit`, `write` | `workspace.write` |
| `bash` | `process.execute` |
| `image_gen` | No trusted resolver |
| MCP tools | Integration capabilities, through the MCP resolver |
| Extension tools | No trusted resolver |

Never bindable:

- `request_user_input` (`session.input`). Questions for the user belong in the conversation; Pi likewise never lets scripts call tools that ask the user (its `model-only` exposure).
- `update_plan`, `submit_plan`, `update_plan_progress`, and `request_replan` (`session.*`), which control the session.
- `jobs`. Background jobs belong to model turns and their completion wake-ups, not to a bounded script.
- `subagent` and `subagent_registry` (section 5.3).
- The code-mode tool itself.
- The `mcp` gateway tool. Its management actions (connect, authenticate, enable) are lifecycle operations, and MCP tool calls get their own bindings.
- MCP prompts, which are user-preview by design, and MCP resources, which the model reads directly through the gateway.

The binding-set code lists every built-in tool as bindable or never bindable, and a new built-in tool is not bindable until it is classified. Extension and SDK tools are bindable, including one that replaces a built-in tool by name. The never-bindable names are excluded whatever registered a tool by that name.

Nested calls cannot start background jobs: a nested call of a built-in or extension tool with `background: true` rejects with `invalid_arguments` (`Scripts cannot start background jobs`). MCP tools start no jobs; their arguments, `background` included, go to the server as they are.

#### Writes and bash

Scripts may call `edit`, `write`, and `bash` in Build mode. OpenAI recommends direct calls for writes and approval-sensitive actions "to preserve a clear authorization boundary" ([guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)). In Volt that boundary holds per call: every nested call passes the same tool-call policy and hooks as a direct call, carries a parent-call origin, and appears in the failure summary (section 5.11). Bulk edits and repeated commands are among the main uses of code mode, and Pi, Codex, and DeepSeek allow both.

Shell commands written inside JavaScript are fragile. In testing, 6 of 12 realistic commands written in plain template literals changed or failed: `${HOME}` became JavaScript interpolation, `\d` lost its backslash, a Windows path gained a carriage return, and an embedded backtick was a syntax error. Written with `String.raw` and `$VAR` instead of `${VAR}`, 11 of 12 were intact and the remaining one failed loudly. Guidance recommends that form, and the bash script value carries `exitCode` and the output, so a mangled command is visible. Pydantic keeps its shell tools out of scripts for this reason; Volt keeps bash and mitigates instead.

#### MCP tools

- One binding per MCP tool of an enabled server whose cached tool metadata is fresh and that passes the server's tool filters; project trust already applies when the configuration loads. Bindings are fixed when a script starts, so they cannot include tools nobody has listed: a server whose tools were never listed, or whose metadata is stale, adds no bindings until `search`, `describe`, or `connect` refreshes it. Policy and hooks see each call as the model's call to the tool would be: through the gateway's `call` action when the gateway makes the tool callable, otherwise through its direct tool. Plan mode authorization and research evidence therefore apply unchanged. The call runs through the MCP manager's call path, not the gateway or direct tool, so server filters, `trustedReads` revalidation in restricted profiles, risk classification, audit, and authentication apply as they do to model-issued calls, while the result reaches the projection whole (section 5.9).
- A server whose tools were listed but which is not connected, such as a lazy server, connects on its first call. A server that needs authentication fails the call with `failed` (`unavailable`) and a message saying how to sign in: `volt mcp auth <server>` for an OAuth server, and setting the credentials its configuration reads from the environment for any other. The gateway's own message is unchanged.
- MCP tools are bound while the built-in `mcp` gateway is active. A tool promoted with `directTools` is also bound while its direct tool is active, so it stays callable from scripts when the gateway is excluded. Either way it has one binding, at `tools.mcp.<server>.<tool>`, and none under the direct tool's own name.
- For failure summaries (section 5.11), an MCP call counts as read-only only when the MCP resolver authorizes it as a trusted read.
- Binding names and discovery are part of the model-facing contract (section 5.14).

#### Restricted profiles

- In Plan mode the binding set is narrowed to tools the research profile can authorize: workspace reads, network reads, process inspection, and MCP tools configured as trusted reads. Per-call authorization still applies, so `lsp` `rename` and `fix` reject with `blocked`.
- The code-mode tool gets a trusted operation resolver that advertises the capability sets of its bindings, so a grant profile can make it visible (`isToolVisibleUnderGrant`, `src/core/operation-authorization.ts:232`) and authorize it.
- Successful nested reads record Plan research evidence through the existing tool-result policy, because nested calls pass that policy under their own call IDs.

#### Declarations

Volt's 14 built-in tools measure about 3.25k tokens as native JSON Schema declarations and about 3.0k as TypeScript declarations. In complement mode the native declarations are already in context, so the size of the binding set matters mainly through how bindings are presented, which is part of the model-facing contract (section 5.14).

Rejected:

- MCP tools only. Scripts could not combine MCP results with file reads, edits, or commands.
- Read-only tools only (OpenAI's default). It gives up bulk edits and repeated commands, while per-call policy already keeps the authorization boundary.
- Making tools callable from scripts whenever they are registered, even when inactive (Pi's `codemode` and `deferred` exposures). Code mode would reach tools the session's policy left out.
- Routing MCP calls through the `mcp` gateway's `call` action. It loses per-tool declarations and makes scripts pass server and tool names as strings.

### 5.13 Nested-call scheduling

Decided. After the host checks of section 5.9, each nested call enters a per-script scheduler.

#### Scheduling classes

| Class | Tools | Rule |
|---|---|---|
| Parallel | Tools without an `executionMode`, which is every bindable built-in tool | Runs concurrently with other calls |
| Exclusive | Tools that declare `executionMode: "sequential"`, in practice extension tools | Starts after every earlier call has finished, runs alone, and holds back later calls until it completes |
| Per server | MCP tools | At most `maxConcurrentCalls` calls run at once per server |

- The exclusive class respects what a tool's author declared, as DeepSeek's exclusive calls and Pydantic's `sequential=True` tools do. Pi does not: its nested calls run as soon as they are issued and ignore `executionMode` (`runToolCall` in `@earendil-works/pi-agent-core`).
- MCP tools are limited per server instead of following their top-level `sequential` flag. No rationale for that flag is recorded, and the MCP SDK Volt ships (1.32.2) ran 40 concurrent calls on one stdio connection in 309 ms with the server handling all 40 at once. In simulation, honoring the flag made 40 MCP calls take 12.4 s; four per server took 3.1 s. MCP fan-out is one of the main uses of code mode.
- Same-file edits need no scheduler rule: `edit` and `write` already serialize per canonical path.

#### Limits

- **Per script:** at most 10 nested calls run at once (DeepSeek's default). With the pool's cap of four scripts per process (section 5.3), a process runs at most 40 nested calls at once.
- **Per MCP server:** at most 4 calls at once by default, counted across every script in the process. A server's MCP configuration may set `maxConcurrentCalls` to change this; 1 serializes a server that does not handle concurrent requests well. This adds one optional field to the MCP server configuration format.
- Every session, subagents included, has its own MCP manager, so the count is kept for the process and keyed by server id rather than kept by a manager. A call starts while fewer calls to its server id than its own configured limit run, which is the configured limit itself whenever the sessions share a configuration.
- A `maxConcurrentCalls` that is not a positive integer is ignored with a configuration warning. The field does not change cached tool metadata, and it is not reported to clients.

#### Ordering

- Host checks, including tool-call policy, run in submission order (section 5.9), as the agent loop prepares calls in order before executing them.
- Calls start in submission order under the per-script limit and within each MCP server.
- A call waiting only for its server's limit does not hold back calls to other servers or calls to other tools, and it does not count toward the script's limit of 10.
- When a server slot frees, the longest-waiting call that can start takes it. A call whose script cannot start it yet, because the script is at its limit or behind an exclusive call, keeps its place, and the slot goes to the next one. No slot stays free while a call that could use it waits.
- An exclusive call is a full barrier in both directions: it starts only after every earlier call has finished, including one still waiting for its server, and no later call starts before it finishes.
- A call cancelled while queued never starts and is recorded as `cancelled before it ran` (section 5.11).

#### The code-mode tool at the top level

The code-mode tool declares `executionMode: "sequential"`, so the agent loop runs it alone within its batch. Sibling top-level calls in the same model response therefore never run during a script, where a sibling MCP call would bypass the per-server limit. Models rarely issue code mode in the same response as other calls, so the cost is small.

Rejected:

- No scheduling (Pi). Unbounded concurrency, and extension tools' `sequential` declarations would be ignored.
- One call at a time. 4.1 s instead of 0.8 s for a script reading 50 files, fetching 10 pages, editing 10 files, and running one command.
- Treating MCP tools as exclusive, following their top-level flag. It serializes MCP fan-out without a protocol reason.
- Per-server limits with strict submission order. A call waiting on one server held back calls to other servers; two servers took 12.1 s instead of 6.2 s at one call per server.

Volt's top-level MCP tools are serialized for the same unrecorded reason. Changing that is outside code mode and tracked in [#1026](https://github.com/volt-hq/Volt/issues/1026).

### 5.14 Model-facing contract

Decided.

#### Name and input

- The tool is named `run_code`, the name DeepSeek Harness and Pydantic use, in Volt's snake_case style.
- Its input is JSON:

  ```ts
  {
  	code: string; // the script: the body of an async function
  	description?: string; // a short label of at most 80 characters
  	timeoutMs?: number; // optional wall-clock limit, at most 1800000 (section 5.6)
  }
  ```

- `description` becomes the title of the call's card in the TUI and remote clients; without it, the first non-empty line of the script is used. It is optional because DeepSeek found that models sending only the code lost the whole program to an argument error when the label was required.
- Raw (non-JSON) input is a non-goal. Volt's AI package supports only JSON-schema tools (`Tool.parameters`, `packages/ai/src/types.ts:484`), and only OpenAI offers grammar-constrained raw tool input; Pi uses JSON `{ code }` and adds a raw grammar variant only on OpenAI. JSON wrapping added 26% to a script's tokens in testing, and models already write code inside JSON strings through `write` and `edit`.

#### Language

Scripts are JavaScript or erasable TypeScript. The host strips TypeScript with `node:module`'s `stripTypeScriptTypes` in strip mode before the script reaches the VM. On Node 22.20 and 24.20 it preserved every line and column, so stack traces still map to the script, and it rejected `enum`, `namespace`, and parameter properties with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, which the host reports as a syntax error (section 5.11). The API is experimental and emits an `ExperimentalWarning`, which the host suppresses so it never reaches the terminal or a client; if the API changes, `amaro`, the stripper Node bundles, is the replacement DeepSeek also names.

#### Binding names

- Built-in and extension tools: `tools.<name>`, using the tool's own name.
- In call messages a binding is identified by the JSON text of its path, so identifiers are unique by construction. A tool whose binding the runtime could not install (an empty or `__proto__` path segment, or an identifier longer than 256 characters) gets none.
- MCP tools: `tools.mcp.<server>.<tool>`. Names that are not JavaScript identifiers use brackets: `tools.mcp["my-server"]["get-file"](args)`. Normalized MCP server ids may contain hyphens (`src/core/mcp/config.ts:184`), and both `my-server` and `my_server` are valid ids, so identifier aliases could collide; as in DeepSeek's design, there are none.

#### Presentation

- Natively declared tools are not declared again. Their parameters are already in context, about 3.25k tokens for the built-in tools (section 5.12).
- The `run_code` description lists the bindings available in the session and the result shapes that differ from plain text: bash's object, `read`'s `string | ImageRef`, and MCP's `{ text, structured?, images }`. The list is generated from the session's bindings. It lives in the one tool description rather than in a line appended to every tool's description, as Pi does, so other tools' descriptions do not change.
- MCP tools are discovered with the `mcp` tool's `search` and `describe` actions before a script calls them. While `run_code` is active, `describe` also returns the tool's binding path and result type. There are no discovery functions inside scripts: discovery results belong in the model's context, and OpenAI likewise runs tool search only at the top level.
- The description depends only on the active built-in and extension tools and on whether the `mcp` tool is active, never on which MCP servers are connected, so connecting a server does not change it and does not invalidate the prompt cache.

#### Text

Tool description, with the binding lines generated from the session's bindings:

```
Run a JavaScript script in a sandbox. The script calls tools and only what it prints or returns comes back to you, so use it to fan out calls, loop, and filter large results instead of making many separate calls.

The script is the body of an async function: top-level await and return work. Erasable TypeScript annotations are allowed. The sandbox has no file system, network, process, timers, or modules; tools are its only way out.

Call tools as `await tools.<name>(args)` with the same arguments as the tool itself:
- tools.bash(args): Promise<{ output: string; exitCode: number | null; truncated: boolean; fullOutputPath?: string }>, resolving for any exit code
- tools.read(args): Promise<string | ImageRef>
- tools.image_gen(args): Promise<ImageRef>
- tools.edit(args), tools.write(args), tools.web_search(args), tools.web_fetch(args): Promise<string>
- MCP tools: tools.mcp.<server>.<tool>(args): Promise<{ text: string; structured?: unknown; images: ImageRef[] }>. Find them and their arguments with the mcp tool's search and describe actions first. Use brackets for names that are not identifiers: tools.mcp["my-server"]["get-file"](args).

A failed call rejects with ToolCallError { tool; kind: "invalid_arguments" | "blocked" | "failed" | "cancelled"; reason?; message }. Use Promise.allSettled for independent calls so one failure does not lose the others.

Output: text(value), console.log/warn/error(...), image(ref), and the return value appear in order. ImageRef = { type: "image"; ref; mimeType; width?; height?; bytes; path? }; only images passed to image(ref) reach you. Output is limited to 50 KB, with the full output saved to a file you can read.

Limits: 30 s of computation, 200 tool calls, and 64 MiB of memory per script. Tool calls made before a failure are not undone; a failed result lists them. Write shell commands with String.raw`...` and $VAR instead of ${VAR}.

store(key, value) and load(key) keep small JSON values across scripts in this conversation; up to 1 MiB in total.
```

System-prompt snippet: `Run a JavaScript script that calls other tools and returns only what it prints`.

Guidelines:

- Use run_code when a task needs many tool calls, loops over items, or filtering of large results; use direct tool calls for single calls, for steps that need your judgment between calls, and for questions to the user.
- In run_code scripts, print counts, summaries, and selected fields rather than whole tool results.
- When a run_code script fails, check which nested calls completed before running it again.

The description measures about 470 tokens, plus about 20 for the store line that section 5.17 added; with the snippet, guidelines, and parameter schema, the contract adds about 650 tokens per request, comparable to the roughly 2,600 characters of guidance Pydantic reports.

The description does not mention BigInt or the `context.source` reviver: until [#1024](https://github.com/volt-hq/Volt/issues/1024) lands, no BigInt reaches a script.

Rejected:

- A required `description` (DeepSeek). Models that omit it lose the whole program.
- In-script discovery functions (Pi, Cloudflare, OpenCode). A second discovery surface whose results land inside the script instead of the model's context.
- Repeating full declarations for natively declared tools. About 3k more tokens per request for parameters already in context.
- Identifier aliases for MCP names (Pi, Cloudflare). They can collide.

### 5.15 Enablement

Decided without a separate review round.

- Code mode is off by default. A new host setting, `codeMode.enabled` (boolean, default `false`), adds `run_code` to a conversation's default active tools. Like other host settings it can be set globally, in a profile, or in a trusted project's `.volt/settings.json`, and it is read when a conversation's tools are created.
- The setting stays out of the protocol. Remote clients read and change host settings through `QueryResult.settings` and `set_settings`, which list their fields explicitly and reject unknown ones, and the iOS app rejects unknown fields in host frames. `codeMode.enabled` is not added to either, so the recorded iOS build keeps working, and a phone can neither see nor change it. Exposing it remotely is a later protocol change that waits for app support.
- `run_code` is otherwise an ordinary tool name: `--tools` must list it to keep it, `--exclude-tools run_code` removes it, `--no-tools` removes it, and SDK callers pass it in `tools`. A conversation a paired phone opens needs it in `remote.allowTools` when that ceiling is set. Enabling code mode never widens what a session may do (section 5.12).
- Subagents inherit `run_code` with the parent's active tools unless their own tool policy leaves it out, and their scripts get bindings from their own tool policy.
- In Plan mode, an enabled `run_code` is available with read-only bindings (section 5.12).
- There is no per-model routing: code mode is not switched on or off by model. The evidence varies by model and task. Pydantic measured the largest gains for the weakest model and lower accuracy for one model; DeepSeek measured no gain on coding benchmarks with its own model; Codex reportedly enables its code mode for one model only (secondary source). Volt has no measurements of its own yet, so the choice stays with the user.
- Code mode complements the `mcp` tool and `directTools` and changes neither, apart from the binding path `describe` adds while `run_code` is active (section 5.14).

Why off by default: `run_code` adds about 650 tokens to every request, 11% of a default session's fixed overhead (5,739 tokens of system prompt and default tool declarations, before project context, skills, and MCP). Code mode costs more than direct calls on small tasks (Pydantic: 21% to 38% more at five items) and did not improve coding benchmarks (DeepSeek). It pays off on long, tool-heavy work, which the user can opt into.

Rejected:

- On by default. Every session pays the overhead and the small-task cost.
- On by default only when MCP servers are configured (OpenCode routes MCP through its code mode by default). Volt's MCP gateway already keeps MCP declarations out of the prompt, so the gain would come only from fan-out, which the user can opt into.
- An additive `defaultTools` setting with `+name` entries (Pi). More general than code mode needs; a dedicated setting is enough.

### 5.16 Observability

Decided without a separate review round.

#### Nested calls are not separate tool calls

Nested calls produce no agent tool events, no live `tool` items, and no transcript entries of their own. They appear inside the `run_code` call: its card while it runs, and its result's `details` afterwards. Pi, DeepSeek, and Codex likewise keep nested calls out of the transcript. Separate items would show each nested call as a top-level card, with no link to its script, and would add host-frame variants the iOS app cannot decode yet (section 7).

Extension `tool_call` and `tool_result` hooks still run for every nested call (section 5.9). `ExtensionOperationOrigin` (`src/core/extensions/services-types.ts:202`) gains a variant, `{ kind: "code_mode"; parentToolCallId: string; seq: number }`, so hooks can tell nested calls from model-issued ones. Hooks run in process, so this changes the extension API but not the protocol.

#### The card

`run_code` has a presenter ([presentations](ui-nodes.md#presentations)) built only from existing node types, so every client renders it, the iOS app included:

- `title`: the call's `description`, or the first non-empty line of the script.
- `activity` while running: `Running script: 14 calls, 2 running`.
- `summary`: the status line of section 5.10 or 5.11, for example `200 tool calls, 15 failed, 6.4 s`.
- `body`: a `code` node with the script, a `progress` node of kind `steps` with the 50 newest nested calls (label: tool name and argument preview; status; start and end times) titled with the total, and a `terminal` node with the newest 100 output lines.
- Images the script showed reach the card as the result's images, which clients already draw.

Updates go through `onUpdate` as presentation patches, at most every 250 ms. A card with the script, 50 calls, and 100 output lines measured about 13.7 KB, within the 16 KB presentation bound for paired devices (the bound for local clients is 64 KB); a presentation over its bound loses its oldest terminal lines and the ends of its code node first.

#### Details

The result's `details`, which the session stores and which the protocol treats as opaque producer data, records the run:

```ts
interface RunCodeDetails {
	status: "completed" | "failed";
	failureKind?: "script_error" | "compute_budget" | "call_budget" | "timeout" | "aborted" | "output_limit" | "sandbox";
	language: "javascript" | "typescript";
	wallMs: number;
	computeMs: number;
	calls: Array<{
		seq: number;
		tool: string;
		argsPreview: string; // at most 160 characters (section 5.11 preview rules)
		path?: string; // exact `path` argument of read, write, and edit calls
		status: "completed" | "failed" | "cancelled" | "unsettled";
		readOnly: boolean;
		startedAt?: number;
		durationMs?: number;
		error?: string; // at most 256 characters
	}>;
	callTotals: { completed: number; failed: number; cancelled: number; unsettled: number };
	complete: boolean; // false when records were dropped to fit the bound
	output: { truncated: boolean; fullOutputPath?: string; items: number; characters: number };
	images: { shown: ImageRef[]; unshown: ImageRef[] };
}
```

- Nested results are never stored in `details`; what the model saw is in the result's content, and the full output is in the spill file.
- `details` is at most 64 KB. The call budget (200) bounds the records; if they still do not fit, argument previews of read-only calls are dropped first, then the oldest read-only records, and `complete` becomes `false`. State-changing records are kept.

#### Session records, compaction, and audit

- The session stores the `run_code` call (with the script in its arguments) and its result like any tool call.
- Compaction counts files that nested `read`, `write`, and `edit` calls touched, from `details.calls[].path`. Today it extracts files only from assistant tool calls with those names (`src/core/compaction/utils.ts:30-57`), so edits made in scripts would otherwise be missing from its file lists; Pi uses its nested-call records the same way.
- Nested MCP calls write MCP audit entries as gateway calls do, with caller surface `model` and a new optional `parentToolCallId`.
- The HTML export renders the card from its presentation.
- Code mode adds no telemetry.

Rejected:

- Emitting nested calls as live `tool` items or transcript entries. Top-level cards without their script, and new host-frame content the current iOS app rejects.
- Storing nested results in `details`. Up to 200 MiB per run at the 1 MiB script-value cap.
- One presentation per client size. Presenters are pure and shared by every client; the host already trims a presentation that exceeds a client's bound.

### 5.17 State

Decided without a separate review round.

Each VM is fresh (section 5.4), but scripts in one conversation can keep small JSON values with two globals:

- `store(key, value)` keeps `value` under `key`; storing `undefined` deletes the key.
- `load(key)` returns a copy of the value, or `undefined`.

Both are synchronous. The host passes the conversation's current values to the VM when the script starts, and the prelude sends each write to the host as it happens.

#### Why keep state

Models split work across several scripts and read each result before writing the next: in Pydantic's benchmark they wrote about five snippets per run, and its REPL kept variables between them. Without state, a later script must fetch its data again or the model must carry it through its own context, which is what code mode exists to avoid. Pi (`store`/`load`) and Codex (a session key-value store, per secondary sources) keep values between scripts for the same reason; DeepSeek keeps none, because state outside the session log would break reconstructing a session from its log.

#### Storage

- Writes are recorded as `custom` session entries (`customType: "volt-run-code-store"`, data `{ set, delete }`), one entry per script that wrote anything, appended when the script ends. `custom` is an existing public log-entry type (`packages/protocol/src/entries.ts:560`), so no protocol change is needed, and extensions already append such entries.
- A conversation's values are the fold of those entries along the current branch, so a branch or fork sees the values written on its own path, and the state survives restarts and resumption. Compaction does not remove log entries, so it does not affect the values.
- This keeps the state in the session log, which answers DeepSeek's objection.
- Each conversation has its own values; a subagent's scripts use the subagent's conversation.

#### Failures

Writes made before a failure are kept, and the failed result lists the keys written. Nested calls made before a failure are not undone either (section 5.11), so the values stay consistent with the side effects; a script that records progress, such as processed IDs or a cursor, can resume from it. Pi instead keeps writes only when the script succeeds.

#### Limits

- Values pass through the bridge codec (section 5.9).
- A key is at most 256 characters. A value is at most 256 KiB of encoded JSON, and all values together at most 1 MiB, Pi's limits. A write past either limit throws a `RangeError` in the script.
- Passing a full 1 MiB of values into a VM costs about 14 to 42 ms with the codec's fast and slow paths (section 11).

#### What the model sees

- The `run_code` description (section 5.14) gains one line: `store(key, value) and load(key) keep small JSON values across scripts in this conversation; up to 1 MiB in total.`
- When a script writes values, its result ends with `Stored keys: cursor, done_ids` (deleted keys are listed as such), so the model knows the values exist when it writes the next script.

Rejected:

- A persistent VM or REPL per conversation (Pydantic). It contradicts a fresh VM per script (section 5.4), grows memory, pins a conversation to one worker, and keeps state outside the session log.
- No state (DeepSeek). Later scripts would fetch data again or route it through the model's context.
- Files in the workspace as state. They pollute the workspace and do not follow branches.
- Keeping writes only when the script succeeds (Pi). A script that fails after recording progress would lose it, while its side effects remain.

### 5.18 Defaults

Decided without a separate review round. Every limit in one place; only the last three rows are user-configurable.

| Limit | Default | Section | Basis |
|---|---|---|---|
| Workers per conversation process | 4 | 5.3 | Width of one parallel subagent spawn |
| Scripts waiting for a worker | 4 | 5.3 | Fail fast instead of hanging a turn |
| Worker idle timeout | 5 minutes | 5.3 | Keeps a worker warm during active work; a cold start costs about 44 ms |
| Worker native stack | 32 MB | 5.4 | About 2.5 times the most any tested Node version needed for every stack probe, deeply nested source included, to end in a guest `RangeError` (13 MB on Node 25.2); on Windows each live worker commits all of it, so 4 workers commit 128 MB per process at most |
| QuickJS `maxStackSize` | 512 KiB | 5.4 | `MAX_STACK_SIZE` |
| VM memory limit | 64 MiB | 5.6 | Holds 18 parsed 1 MiB results at once (32 MiB holds 9, 128 MiB holds 38); 4 VMs make 256 MiB per process at most. Pi and Pydantic use 256 MiB, Cloudflare 32 MiB |
| Compute budget | 30 s | 5.6 | Pydantic's per-snippet limit |
| Nested calls per script | 200 | 5.6 | Pydantic uses 100; scripts that fan out over pages of results need more |
| Grace before hard kill | 250 ms | 5.6 | Honored interrupts stopped within about 70 ms |
| Arguments per call / outstanding | 1 MiB / 16 MiB | 5.9 | Bounds host memory per script |
| Script value per nested call | 1 MiB | 5.9 | Pi's bash value size |
| `ToolCallError` message | 8 KiB | 5.9 | Bounded error text |
| Message frame | 8 MiB | 5.9 | Argument cap plus overhead |
| JSON nesting depth | 64 | 5.9 | Codec bound |
| Binding name | 256 characters | 5.9 | Codec bound |
| Images shown / retained per script | 10 / 64 MiB | 5.9 | Bounded model and session cost |
| Model-facing output | 50 KB, 2,000 lines | 5.10 | Volt's standard tool output limit |
| Retained output | 16 Mi characters, 100,000 items | 5.10 | Pi's limits |
| Error block | 8 KiB | 5.11 | Bounded failure text |
| Nested-call summary | 20 entries, 120 characters each | 5.11 | 231 tokens for a 49-call failure |
| Background rejections reported | 10 | 5.11 | Bounded warnings |
| Concurrent nested calls per script | 10 | 5.13 | DeepSeek's default |
| Card | 50 newest calls, 100 output lines | 5.16 | About 13.7 KB, within the 16 KB bound for paired devices |
| `details` | 64 KB | 5.16 | Bounded session record |
| Stored values | 256 KiB per value, 1 MiB total | 5.17 | Pi's limits |
| Script timeout (`timeoutMs`) | None; at most 30 minutes when set | 5.6 | Per-call model choice |
| `codeMode.enabled` | `false` | 5.15 | Host setting |
| MCP `maxConcurrentCalls` | 4 per server | 5.13 | MCP server configuration |

The other limits are fixed in code. They are maintainer tuning, revisited with measurements from real use, not settings.

## 6. Rejected alternatives

| Alternative | Reason |
|---|---|
| `node:vm`, plain worker threads, the Node permission model, ShadowRealm | Not security boundaries. Node's documentation says `node:vm` "is not a security mechanism", and the permission model "does not provide security guarantees in the presence of malicious code". DeepSeek's worker-thread runtime was escaped with `import('node:fs')` ([discussion #3245](https://github.com/deepseek-ai/deepseek-harness/discussions/3245)). |
| vm2 or another JavaScript-level membrane | Repeated sandbox escapes as V8 changes. |
| SES / Hardened JavaScript in process | A capability boundary without memory or time limits, and `lockdown()` would freeze Volt's own realm. |
| `isolated-vm` | Maintenance mode, majors coupled to Node release lines, native build at install, soft memory limit, and a critical 2026 escape in its native glue. |
| Sandboxed Node child process (DeepSeek) | Safe only under an OS sandbox, which Volt lacks; reported at about 100 ms per program. |
| Native engine in Volt's process (rquickjs, Boa via napi) | Loses WebAssembly memory containment. QuickJS-NG does not issue CVEs; Boa reportedly lacked a heap cap. A crash or panic (`workspace-fs` builds with `panic = "abort"`) ends the conversation process. A second V8 cannot practically be embedded in Node's process. |
| Rust sidecar process (Codex approach) | Not rejected; deferred as a future backend (section 5.8). Costs a new executable for every target, a hardened IPC protocol, and pool management. |
| Custom interpreter (OpenCode) | Large maintenance burden; OpenCode's has no memory cap. |
| `quickjs-emscripten` | Older bundled QuickJS-NG, single maintainer, and its Asyncify variant supports only one suspended host call at a time. |
| Python (Monty, Pyodide) | A second language runtime; Pyodide is heavy. Monty's Node WASM build was not evaluated. |

## 7. Integration requirements

These follow from Volt's architecture and the decisions of section 5.

- **Policy.** Every nested call passes argument validation and the session's tool-call and tool-result gates, as extension services already do. The host never calls `ToolDefinition.execute` directly for a nested call.
- **Attribution.** Nested calls need a parent-call origin so hooks, audit, and policy can tell them apart from model-issued calls. `ExtensionOperationOrigin` gains a `code_mode` variant, and MCP audit entries an optional `parentToolCallId` (section 5.16).
- **Compaction.** Compaction's file lists read nested `read`, `write`, and `edit` paths from `run_code` details (section 5.16).
- **Session entries.** Script state is stored in `custom` entries with `customType: "volt-run-code-store"` (section 5.17).
- **Restricted profiles.** In restricted profiles such as Plan mode, a script must not reach operations the profile does not authorize, including MCP tools outside `trustedReads` (section 5.12).
- **Bash.** Nested bash calls run without the stall-move context (section 5.6).
- **Public tool API.** Script-value projections are internal to built-in tools and MCP in v1, so `ToolDefinition` does not change.
- **Exact MCP numbers.** The lossless codec cannot recover integers the MCP SDK has already rounded. Fixing that needs an exact-number decode path upstream ([modelcontextprotocol/typescript-sdk#3150](https://github.com/modelcontextprotocol/typescript-sdk/issues/3150)) and Volt-side changes through the MCP manager and output store ([#1024](https://github.com/volt-hq/Volt/issues/1024)), likely including an upgrade to MCP SDK v2.
- **iOS app compatibility.** The app rejects unknown fields and variants in host frames ([AGENTS.md](https://github.com/volt-hq/Volt/blob/main/AGENTS.md#ios-app-compatibility)). New protocol events for nested calls would require a compatible app build first; until then, nested-call records travel inside the outer tool result.
- **Packaging.** The standalone binary must ship `quickjs.wasm` and the worker entry as files, as it already does for native prebuilds and the session-store worker.
- **Licensing.** The `quickjs-wasi` package license covers only Vercel's wrapper. The WASM binary also contains QuickJS-NG (MIT) and components linked by the wasi-sdk build, whose notices are not in the npm package and must be added to the standalone license files. The exact component list must be derived from the `quickjs-wasi` build.
- **Dependency approval.** `quickjs-wasi` is a new direct dependency, pinned exactly, and requires maintainer approval and a shrinkwrap update.
- **MCP configuration.** Per-server `maxConcurrentCalls` (section 5.13) is a new optional field in MCP server configuration.
- **Settings.** `codeMode.enabled` (section 5.15) is a new host setting, documented in `docs/settings.md`.
- **Engine updates.** QuickJS-NG states that it no longer accepts private security reports or issues CVEs, and that untrusted bytecode is out of scope ([SECURITY.md](https://github.com/quickjs-ng/quickjs/blob/master/SECURITY.md)). Volt tracks QuickJS-NG releases through `quickjs-wasi` and never loads bytecode or snapshots from untrusted sources.

## 8. Approvals and follow-ups

No design decisions remain open. The maintainer approved these on 2026-11-04, so implementation may proceed with them:

- **Dependency.** `quickjs-wasi`, pinned exactly, with a shrinkwrap update (section 7).
- **Configuration and settings.** The `codeMode.enabled` host setting (section 5.15) and the per-server MCP `maxConcurrentCalls` field (section 5.13).
- **Extension API.** The `code_mode` variant of `ExtensionOperationOrigin` (section 5.16).
- **MCP surfaces.** The binding path and result type in the gateway's `describe` output while `run_code` is active (section 5.14), and the optional `parentToolCallId` in MCP audit entries (section 5.16).

Follow-ups tracked outside this design:

- Exact numbers from MCP servers: [#1024](https://github.com/volt-hq/Volt/issues/1024), with the upstream request [modelcontextprotocol/typescript-sdk#3150](https://github.com/modelcontextprotocol/typescript-sdk/issues/3150). The codec gains a type for exact decimals when it lands (section 5.9).
- Concurrent top-level MCP calls: [#1026](https://github.com/volt-hq/Volt/issues/1026).
- Measurement gaps listed in section 11.

## 9. Delivery plan

Each step is its own pull request. None changes the protocol contract, so none should need the `breaks-ios-app` label; each still runs the iOS compatibility workflow.

1. **Runtime.** The `quickjs-wasi` dependency; the worker pool, VM boot, prelude, codec, and host–worker messages; supervision (compute budget, watchdog, interrupt, grace, memory and stack limits). Unit tests drive scripts against fake bindings. Nothing is exposed to the model yet, and nothing reachable from the CLI imports the runtime, so neither bundled form includes it.
2. **Bridge and scheduling.** Binding-set computation (no escalation, eligibility, grant profiles), the host checks with tool-call and tool-result policy and the `code_mode` origin, script-value projections, `ToolCallError`, image references, the scheduler, and per-server MCP limits with `maxConcurrentCalls`.
3. **The `run_code` tool.** Input and TypeScript stripping, result rendering, truncation and spill, failure rendering, `store()`/`load()` session entries, the generated description, snippet, and guidelines, the presenter and `details`, compaction file tracking, the gateway `describe` addition, MCP audit attribution, the `codeMode.enabled` setting, user documentation (a code-mode page in `docs.json` and `docs/settings.md`), and the changeset.
4. **Packaging.** Bundle the worker entry and load `quickjs.wasm` in the bundled npm CLI and the standalone binary, add the WASM's third-party notices to the standalone archive, and verify on all six targets. The npm package needs no notice of its own: npm installs `quickjs-wasi` as a dependency with its license file.

### Verification

- **Codec:** property-based tests (fast-check) that accepted values round-trip exactly and rejected values fail with their path, on Node and in QuickJS.
- **Runtime:** interrupts, the watchdog's hard kill on non-polling built-ins, out-of-memory, stack overflow with the 32 MB worker stack, stalled promises, and cancellation, as measured in section 11.
- **Bridge:** hostile and malformed frames from a test worker, every host check in order, and bounded outstanding arguments.
- **Scheduling:** ordering guarantees, exclusive barriers, and per-server limits, with a fake MCP server that records overlapping requests.
- **Integration:** `packages/coding-agent/test/suite/` scenarios with the faux provider: policy and hooks on nested calls, Plan mode bindings and research evidence, failure summaries, spill files, state across branches, and compaction file lists.
- **Measurements:** repeat the runtime and stack measurements on the standalone Node 22.23.1 runtime and on Linux and macOS before step 4 ships.

The invariants below tie each guarantee to the test that fails when it breaks.

### Invariants

Each guarantee the runtime makes, where it is enforced, and the test that fails when it breaks. Section 5 records the decisions; these tables are how they are kept. A pull request that adds a guarantee adds its row, and a guarantee without a test says why. Every row describes merged code. A planned guarantee gets a row in a planned table, naming the test to write before the implementation, until the pull request that lands it moves the row into a table of its own. Steps 3 and 4 add their rows in their own pull requests.

Sources are in `src/core/code-mode/` unless a path says otherwise. Tests are cited as `file: "test name"`, where `file` names a test file in `test/code-mode/` without `.test.ts`, except `mcp`, which is `test/mcp.test.ts`.

#### Isolation and the engine

| Guarantee | Enforced in | Test |
|---|---|---|
| A script has no ambient capability: no timers, `process`, `require`, `fetch`, `WebAssembly`, module loading, `WeakRef`, or `FinalizationRegistry`. | `vm.ts`: intrinsics without `WEAK_REF`, no module loader, every import implemented by the host | vm: "omits timers, WeakRef, module loading, and host globals" |
| Without timers, a script that is idle with no call in flight can never resume, so it ends as stalled. | `vm.ts` `endTurn` | vm: "detects a script waiting on a promise nothing can settle"; runtime: "reports stalled scripts and syntax errors as script errors" |
| The bridge is the only host function, and the script cannot reach it. | `vm.ts` `initialize`; the prelude's closure | vm: "omits timers, WeakRef, module loading, and host globals" (`typeof bridge`) |
| The host reads only primitive strings from the guest and never converts a guest value, so no guest code runs on the host. | `vm.ts` `onBridge` | Reviewed only: the prelude passes only strings, so a script cannot reach this check without corrupting VM memory |
| Engine diagnostics never reach the terminal or a client. | `vm.ts` `fd_write` | Reviewed only: no script-reachable path writes to file descriptors 1 or 2 |
| Every script runs in a fresh VM: nothing a script changes reaches the next script on the same worker. | `worker.ts` `afterTurn` | runtime: "runs every script in a fresh VM, so nothing a script changes reaches the next one" |
| Stack exhaustion in guest code, including parsing deeply nested source, ends in a catchable guest error, never a host stack overflow. | `vm.ts` `maxStackSize`; `limits.ts` `workerStackSizeMb` | runtime: "ends stack exhaustion in a catchable error, including source nested deeper than the parser allows" |
| Memory exhaustion is a catchable out-of-memory error, flagged when uncaught. | `vm.ts` `memoryLimit` | vm: "keeps out-of-memory catchable and flags it when uncaught" |
| VMs get distinct `Math.random` sequences, and `performance.now()` is monotonic. | `vm.ts` `clock_time_get` | vm: "seeds Math.random differently in every VM"; "measures performance.now() from VM start with the monotonic clock" |

#### Codec

| Guarantee | Enforced in | Test |
|---|---|---|
| Accepted values round-trip exactly, on the host and in the VM. | `codec.ts` | codec: "round-trips every accepted value exactly"; vm: "round-trips accepted values through the VM exactly" |
| A value with any unrepresentable part fails with an error naming that part's path, on the host and in the VM; nothing converts silently. | `codec.ts` `write` | codec: "rejects every value with one unrepresentable part, naming the path of that part"; vm: "rejects unrepresentable values inside the VM, naming the same path as the host" |
| Each element and property is read only while it is still own and enumerable, and holes present when encoding starts are rejected. | `codec.ts` `readOwn`, `checkArrayShape` | codec: "reads only properties that are still own and enumerable when a getter changes the value"; vm: "rejects elements and properties a getter deletes and the prototype fills during encoding" |
| The decoder accepts only text the encoder could produce, and bounds nesting before parsing. | `codec.ts` `decode`, `decodeBridgeValue` | codec: "rejects literals the encoder cannot produce"; "bounds nesting before parsing" |
| Patched built-ins and prototypes do not change how the prelude or the codec behaves. | `prelude.ts`, `codec.ts`: captured built-ins, and lists and descriptors without prototypes | vm: "keeps the whole bridge working in a realm the script has made hostile", and the three tests before it |

#### Script API

| Guarantee | Enforced in | Test |
|---|---|---|
| Nothing a script passes to `text`, `console`, `image`, or a binding ends it as a `sandbox` failure; invalid input throws an error the script can catch. | `prelude.ts`: a check before each host check a script could otherwise trip (argument encoding and size, image references the script received, the shown-image limit) | runtime: "never ends a script as a sandbox failure, whatever it passes to the script API" |
| The prelude and the host count arguments in the same exact UTF-8 bytes. | `prelude.ts` `callTool`; `runtime.ts` `onCall` | vm: "counts arguments in exact UTF-8 bytes, including characters outside the BMP"; runtime: "agrees with the prelude on the argument limit when the binding name needs escaping" |
| Call numbers reach the host in order, even when a getter calls a binding while arguments are encoded. | `prelude.ts` `callTool` | vm: "assigns call numbers after encoding so nested calls keep the order they are posted in" |
| Error names and summaries are bounded and on one line, and error blocks are bounded, on both sides of the bridge. | `prelude.ts` `describe`; `protocol.ts` `parseErrorDescription` | vm: "bounds error names, summaries, and blocks, markers included"; "keeps summaries and error names on one line"; codec: "parses output and done frames" |

#### Host validation

| Guarantee | Enforced in | Test |
|---|---|---|
| A malformed message, a forged frame, call arguments over the argument limit, or an image reference or error description beyond its bounds is a protocol violation: the script fails as `sandbox`, no call handler runs for it, and the worker is discarded. | `protocol.ts` parsers; `runtime.ts` `protocolViolation` | runtime: "treats hostile worker frames as protocol violations and discards the worker"; "treats call arguments over the argument limit as a protocol violation" |
| An output or done frame larger than the message frame is not a protocol violation: the script fails as `output_limit`. An oversized output frame stops the VM like any other output past the limit; after an oversized done frame the VM has already ended, and the worker is reused. | `runtime.ts` `onOutput`, `onDone` | runtime: "fails with an output limit when one output item is larger than a message frame"; "fails with an output limit and reuses the worker when the done frame is larger than a message frame" |
| The host checks a call in this order: frame size and shape, `seq` order, call budget, binding set, outstanding argument bytes, plain-object arguments. An attempt that fails a check after the budget still counts against it. | `runtime.ts` `onCall` | runtime: "runs the host checks for a call in order and ignores messages for other scripts"; "rejects a call whose arguments would exceed the outstanding-argument limit until earlier calls finish" |
| Messages for another script are ignored, on both sides. | `runtime.ts` `onMessage`; `worker.ts` `handle` | Host: runtime: "runs the host checks for a call in order and ignores messages for other scripts". Worker: reviewed only, because a test would need two scripts racing on one worker |
| A worker whose protocol version differs fails closed. | `pool.ts` `onWorkerMessage` | runtime: "fails closed when a worker reports a different protocol version" |
| An exception in a host handler for a worker message, a timer, or an abort fails that script, never the process. | `runtime.ts` `contain` | runtime: "fails the script instead of the process when handling a worker message throws"; "fails the script instead of the process when the output handler throws" |

#### Supervision

| Guarantee | Enforced in | Test |
|---|---|---|
| A script that computes past its budget is stopped and cannot catch it; the watchdog terminates a worker stuck in a built-in that ignores the interrupt. | `vm.ts` `shouldInterrupt`; `runtime.ts` `checkWatchdog` | vm: "stops a script that exhausts its compute budget, which the script cannot catch"; runtime: "stops computing scripts by interrupt or by terminating the worker, then runs the next script" |
| The call budget, the timeout, an abort, and the output limit end a script, which cannot catch them. | `runtime.ts` `terminate` | runtime: "terminates a script when its call budget runs out"; "times out, keeps partial output, and records calls that may still apply"; "aborts in-flight calls through their signal"; "fails with an output limit and keeps the output retained until then" |
| Every stop the host decides cancels in-flight nested calls at once. | `runtime.ts` `terminate` | runtime: "cancels in-flight calls at once, even while the VM is stuck in a built-in" |
| When a script ends, in-flight calls are aborted and drained for at most `drainMs`; the rest are recorded as `unsettled`, and their later results are discarded. | `runtime.ts` `finalize`, `execute` | runtime: "times out, keeps partial output, and records calls that may still apply"; "keeps an unsettled record unchanged when the call completes after the script returned" |
| Unhandled rejections are reported only once the script cannot resume, at most 10 described and the rest counted exactly; a script the host stops reports none. | `vm.ts` `trackRejection`, `reportRejections` | vm: "does not report rejections the script handles after awaiting a call"; "counts unhandled rejections it does not describe, including untracked ones"; "stops a script that exhausts its compute budget, which the script cannot catch" |

#### Pool and process

| Guarantee | Enforced in | Test |
|---|---|---|
| At most `maxWorkers` scripts run and `maxQueuedScripts` wait; a script beyond that fails without starting. | `pool.ts` `acquire`, `spawn` | runtime: "queues scripts beyond its workers and fails scripts beyond its queue without starting them" |
| A script aborted while it waits for a worker, or while the engine loads, never starts and leaves no worker behind. | `pool.ts` `acquire`, `spawn` | runtime: "gives up waiting for a worker when the script is aborted"; "gives up without booting a worker when a script is aborted while the engine loads" |
| A worker is reused only after its VM ended normally; a crash, a hard kill, or a protocol violation discards it. | `runtime.ts` `settleWorker` | runtime: "treats hostile worker frames as protocol violations and discards the worker"; "stops computing scripts by interrupt or by terminating the worker, then runs the next script" |
| A run keeps the process alive from entry until it returns, drain included; workers never keep it alive. | `runtime.ts` `run`; `pool.ts` `CodeModeWorker` | runtime: "keeps the process alive while a script runs and lets it exit once its worker is idle"; "keeps the process alive while it drains calls that outlive the script" |
| Closing the pool ends running scripts with a `sandbox` failure. | `pool.ts` `close` | runtime: "ends running scripts when the pool closes" |
| Idle workers stop after the idle timeout. | `pool.ts` `startIdleTimer` | runtime: "stops idle workers after the idle timeout" |

#### Bindings

| Guarantee | Enforced in | Test |
|---|---|---|
| A binding exists only for a call the model could make directly in the same session at that moment, and every such call has one. | `bindings.ts` `computeCodeModeBindings`; `src/core/session/tool-runtime.ts` `codeModeBindingSources` | bindings: "binds exactly the calls the model could make directly, at paths the runtime accepts"; session-bindings: "binds active built-in, extension, and listed MCP tools in Build mode" |
| Never-bindable tools get no binding, whatever registered them, and a built-in tool is bindable only once it is classified. | `bindings.ts` `BUILTIN_TOOL_ELIGIBILITY`, `NEVER_BINDABLE_TOOL_NAMES` | bindings: "classifies every built-in tool as bindable or never bindable, as the design lists them"; "binds no never-bindable tool, whoever registered it" |
| In a restricted profile, bindings are limited to built-in tools the profile can authorize and MCP tools configured as trusted reads. | `bindings.ts` `computeCodeModeBindings` | bindings: "limits bindings in Plan mode to what the research profile authorizes"; session-bindings: "binds only tools the research profile authorizes in Plan mode" |
| An MCP tool is bound once, at its MCP path, through the built-in gateway or its own direct tool, and only from fresh metadata that passes its server's filters. | `bindings.ts` `computeCodeModeBindings`; `src/core/mcp/manager.ts` `getCallableTools` | bindings: "binds MCP tools only through an active gateway that is the built-in one, or their own direct tool"; session-bindings: "keeps a promoted MCP tool bound through its direct tool when the gateway is excluded"; mcp: "lists callable tools only from fresh metadata that passes the server's filters" |
| Binding names are unique, no path is a namespace of another, and a binding the runtime could not install is omitted. | `bindings.ts` `computeCodeModeBindings` | bindings: "binds exactly the calls the model could make directly, at paths the runtime accepts"; "omits bindings whose path the runtime would reject" |

#### Scheduling

| Guarantee | Enforced in | Test |
|---|---|---|
| At most 10 nested calls of a script run at once, and a call waiting for its server does not count. | `scheduler.ts` `CodeModeCallScheduler` | scheduler: "follows the scheduling rules for any sequence of calls, finishes, and cancellations"; "starts calls to other servers and tools while a call waits for its server" |
| Calls start in submission order, and a call waiting for a full server holds back only later calls to that server. | `scheduler.ts` `CodeModeCallScheduler` | scheduler: "follows the scheduling rules for any sequence of calls, finishes, and cancellations"; "starts calls to other servers and tools while a call waits for its server"; "starts a call to a freed server past an earlier call held behind a stricter call to its own server" |
| An exclusive call starts after every earlier call has finished, runs alone, and holds back every later call. | `scheduler.ts` `CodeModeCallScheduler` | scheduler: "follows the scheduling rules for any sequence of calls, finishes, and cancellations"; "runs an exclusive call after every earlier call has finished and before any later call starts" |
| A call to an MCP server starts only while fewer calls to that server than its limit run in the process. A freed slot goes to the longest-waiting call that can start, and no slot stays free while a call that could use it waits. | `scheduler.ts` `CodeModeServerLimiter`, `getCodeModeServerLimiter` | scheduler: "follows the scheduling rules for any sequence of calls, finishes, and cancellations"; "gives a freed server slot to the longest-waiting call that can start, across scripts"; "keeps the place of a server call submitted while its script is full"; "starts a server call only while fewer calls to that server than its own limit run in the process"; "shares one server limiter across the process" |
| A call cancelled while it waits never starts and rejects as not started, and every other call eventually runs. | `scheduler.ts` `CodeModeCallScheduler` | scheduler: "follows the scheduling rules for any sequence of calls, finishes, and cancellations"; "rejects calls cancelled before they start, which never run"; "never starts a queued call whose signal aborted with the call that was holding it back"; "never starts a call cancelled while a freed server slot is offered" |
| A call's failure, including a synchronous throw, reaches its caller and frees its slots. | `scheduler.ts` `CodeModeCallScheduler` | scheduler: "passes on a call's failure, including a synchronous throw, and keeps scheduling" |
| MCP tools are limited per server whatever their direct tool declares; other tools run exclusively only if they declare `executionMode: "sequential"`. | `scheduler.ts` `schedulingClassFor` | scheduler: "derives the scheduling class from the binding target and the tool's execution mode" |
| A server's `maxConcurrentCalls` is a positive integer that defaults to 4; an invalid value is ignored with a warning, and the field does not change cached tool metadata. | `src/core/mcp/config.ts` `normalizeServer`; `src/core/mcp/manager.ts` `getMaxConcurrentCalls` | mcp: "reads each server's maxConcurrentCalls and warns about invalid values" |

#### Script values

| Guarantee | Enforced in | Test |
|---|---|---|
| A bash command that ran resolves with its output and exit code, whatever the code; one that timed out or was aborted rejects. | `projections.ts` `projectBash`; `src/core/tools/bash.ts` (`details.exitCode`) | projections: "resolves with the output and exit code of a command that ran, whatever the code"; "rejects a command that timed out or was aborted" |
| Bash output is the command's own output, even when it reads like the no-output placeholder. | `projections.ts` `commandOutput`; `src/core/tools/bash.ts` (`details.noOutput`) | projections: "resolves with the output and exit code of a command that ran, whatever the code" |
| Bash output the model saw truncated comes from the full output file, and output beyond the cap keeps its head and tail, cut at character boundaries, so the encoded value fits the cap. | `projections.ts` `readBounded`, `boundText`; `codec.ts` `encodedStringBytes`, `encodedPrefix`, `encodedSuffix` | projections: "reads output the model saw truncated from the full output file"; "keeps the head and tail of large output whole, with the value within its limit"; codec: "measures strings and cuts them between code points by their encoded size" |
| A bash result a `tool_result` hook saw resolves with the text the hooks left, and never reads the full output file. | `projections.ts` `projectBash` | projections: "gives a result a hook saw as the hook left it, never reading the full output file" |
| `read` and `image_gen` resolve with an image reference for an image, and other tools with their text; an error result rejects with its text. | `projections.ts` `projectToolResult` | projections: "resolves with the text of a text file and a reference to an image file"; "resolves with a reference to a generated image and the file it was saved to"; "joins a result's text blocks and rejects an error result with its text" |
| The built-in projections apply only to the trusted built-in tools; any other tool gets the default. | `projections.ts` `projectToolResult` | projections: "applies the bash projection only to the trusted built-in tool" |
| An MCP result resolves with its text, structured content, and image references; an error result rejects and keeps none of its images. | `projections.ts` `projectMcpResult` | projections: "resolves with an MCP result's text, structured content, and image references"; "rejects an MCP error result or images over the limit, keeping none of their images" |

#### Images

| Guarantee | Enforced in | Test |
|---|---|---|
| Image bytes stay on the host; a script receives references, unique within the script, with the image's type, size, and file. | `images.ts` `CodeModeImageStore` | images: "issues sequential references with each image's type, size, and file" |
| A script's image bytes, including those of calls in flight, stay within its limit; a call whose images would exceed it rejects with `limit_exceeded` and keeps none of them. | `images.ts` `CodeModeImageStore` | images: "keeps a call's images only once committed, and counts staged images toward the limit"; "checks the limit against the base64 length before decoding"; projections: "rejects an MCP error result or images over the limit, keeping none of their images"; runtime: "counts the images of calls in flight toward the script's image limit" |
| A call's images become the script's only when its value is posted; a rejected value, a failed call, and an unsettled call drop them. | `runtime.ts` `execute`, `reply`, `finalize` | runtime: "keeps a call's images only when its value reaches the script" |
| Image data is base64, kept canonical; anything else rejects the call. | `images.ts` `CodeModeImageStore` | images: "accepts base64 with whitespace or without padding, keeps it canonical, and rejects other data" |
| Width and height come from the image header when it gives them, and reading them never throws. | `images.ts` `imageDimensions` | images: "reads the size of PNG and JPEG images"; "reads the size of GIF and WebP images"; "gives no size for data that is not a complete image header, and never throws" |
| A script shows only image references the host issued with its call results, at most 10; anything else throws an error it can catch. The host reads a call's value once, to encode it. | `prelude.ts` `image`, `settle`; `runtime.ts` `reply` | vm: "shows only image references the script received, at most the limit, and rejects the rest catchably"; "keeps image() working when a script patches Set"; runtime: "shows only images the script received in call results, at most the limit"; "reads each property of a call's value once" |
| An image output for a reference the script did not receive, or past the limit, is a protocol violation. | `runtime.ts` `onOutput` | runtime: "treats an image the script could not have shown as a protocol violation" |

#### Call dispatch

| Guarantee | Enforced in | Test |
|---|---|---|
| Every nested call of a built-in or extension tool passes argument preparation and validation, then the session's tool-call and tool-result policy with a `code_mode` origin and the ID `<parentToolCallId>:cm:<seq>`, before and after the registered tool runs. | `dispatch.ts` `createCodeModeCallHandler`; `src/core/session/turn-policy.ts` (`origin`) | dispatch: "runs a call through the policies and the tool with its nested call id and origin"; session-dispatch: "passes a nested call through the session's hooks with its call ID and code mode origin" |
| A tool no longer active, or replaced since the script started, rejects with `unavailable` before any policy runs. | `dispatch.ts` `createCodeModeCallHandler` | dispatch: "rejects a call to a tool that is no longer active or was replaced, before any policy runs" |
| Invalid arguments, including a BigInt, reject with `invalid_arguments`, and so does `background: true` for a built-in or extension tool, without the policy or the tool running. | `dispatch.ts` `createCodeModeCallHandler` | dispatch: "prepares and validates arguments as the agent loop does"; "rejects background jobs without running the policies or the tool"; session-dispatch: "rejects background jobs and kills a silent nested command instead of moving it to the background" |
| A policy denial rejects with `blocked` and its reason, and the tool does not run. | `dispatch.ts` `createCodeModeCallHandler` | dispatch: "rejects a call the policy blocks, with its reason"; session-dispatch: "rejects a nested call an extension hook blocks, without running it" |
| In a restricted profile, each nested call is authorized as a model-issued call would be, and nested reads count as Plan research. | `src/core/session/turn-policy.ts` `toolCall`, `toolResult` | session-dispatch: "authorizes each nested call under Plan mode and counts nested reads as research" |
| Checks 6 to 8 of later calls start only after an earlier call's have finished. | `dispatch.ts` `createCodeModeCallHandler` | dispatch: "runs the checks of a later call only after an earlier call's checks finish" |
| A tool's failure passes the tool-result policy and rejects with `failed`; a call aborted while it runs rejects with `cancelled` and none of the tool's output, and one cancelled before its tool started with `cancelled` (`not_started`), even when a pending policy rejects on the abort. | `dispatch.ts` `createCodeModeCallHandler`, `run` | dispatch: "passes a tool's failure through the tool-result policy and rejects with it"; "rejects a call aborted while it runs as cancelled, with none of the tool's output"; "rejects a call cancelled while it waits to run as cancelled before it ran"; "rejects a call cancelled while a policy is pending, which rejects on the abort, as cancelled before it ran" |
| The hooks of a nested call's tool-call and tool-result policy observe the call's signal. | `dispatch.ts` `createCodeModeCallHandler`; `src/core/session/turn-policy.ts` `toolResult` (`signal`) | dispatch: "gives the tool-result policy the call's signal, which shows a script that stopped during the call"; session-dispatch: "gives the session's tool_call and tool_result hooks the script call's signal" |
| A result is projected by the trust of the tool that ran, read with it when the script started, whatever the registry holds when the result arrives. | `dispatch.ts` `createCodeModeCallHandler`, `CodeModeDispatchHost.tool` | dispatch: "projects a result by the trust of the tool that ran, even when the registry changes while it runs" |
| The projection receives the executed result and the tool-result policy's return value unchanged, so a result a hook saw is never projected from the full output file. | `dispatch.ts` `createCodeModeCallHandler`; `projections.ts` | dispatch: "passes the tool-result policy's result to the projection, which then never reads the full output file" |
| A nested bash command that goes silent is killed as hung rather than moved to a background job, and a nested call cannot start one. | `src/core/tools/background.ts` `withoutBackgroundJobs`; `dispatch.ts` `run` | session-dispatch: "rejects background jobs and kills a silent nested command instead of moving it to the background" |

#### MCP dispatch

| Guarantee | Enforced in | Test |
|---|---|---|
| A nested MCP call is checked as the model's call to the tool would be. When the built-in gateway makes the tool callable, the call goes through `mcp` with `{ action: "call", server, tool, arguments }`; otherwise it goes through the tool's direct tool, with the arguments as input. The session's tool-call and tool-result policy run with a `code_mode` origin and the ID `<parentToolCallId>:cm:<seq>`. | `bindings.ts` `computeCodeModeBindings` (`toolName`); `dispatch.ts` `createCodeModeCallHandler` | bindings: "binds MCP tools only through an active gateway that is the built-in one, or their own direct tool"; dispatch: "runs an MCP call through the gateway's policies and the session's MCP manager, with its nested call id and origin"; "runs an MCP call through its direct tool's validation and policies when that tool is its route"; session-mcp-dispatch: "calls an MCP tool through the gateway's hooks and the manager, and gives the script the whole result"; "calls a promoted MCP tool through its direct tool's hooks when the gateway is excluded" |
| A routing tool no longer active, or replaced since the script started, rejects with `unavailable` before any policy runs. | `dispatch.ts` `createCodeModeCallHandler` | dispatch: "rejects an MCP call whose routing tool is no longer active or was replaced, before any policy runs" |
| The call runs with its binding's server and tool and the checked arguments; a policy's changes to its copy of the call change nothing. | `dispatch.ts` `createCodeModeCallHandler`; `src/core/session/turn-policy.ts` `reduceToolCall` | dispatch: "calls the binding's MCP tool with the checked arguments, whatever a policy does to its copy of the call" |
| Arguments holding a BigInt reject with `invalid_arguments`; `background: true` goes to the server like any other argument. | `dispatch.ts` `createCodeModeCallHandler` | dispatch: "passes background through to an MCP tool and rejects BigInt arguments" |
| The call runs through the MCP manager's call path, with its tool filters, trusted-read revalidation in a restricted profile, risk, events, recent-call record, and an audit entry as the model's call. It returns the result as the server sent it and writes nothing to the output store. | `src/core/mcp/manager.ts` `callToolRaw`, `runToolCall`; `dispatch.ts` `codeModeDispatchHostOf` | mcp: "calls a tool for a script with callTool's checks, events, record, and audit, and returns the raw result"; session-mcp-dispatch: "calls an MCP tool through the gateway's hooks and the manager, and gives the script the whole result" |
| Calls are scheduled per server with the server's own limit. | `dispatch.ts` `createCodeModeCallHandler`, `CodeModeDispatchHost.mcpServerLimit` | dispatch: "schedules MCP calls with their server's limit" |
| A failure before the request is sent rejects with `failed` (`unavailable`) after the tool-result policy sees it as an error result, and a server that needs authentication says how to sign in. Later failures and error results reject with `failed`. | `src/core/mcp/manager.ts` `McpToolUnavailableError`, `callToolRaw`; `src/core/mcp/server-supervisor.ts` `McpServerAuthRequiredError`; `dispatch.ts` `createCodeModeCallHandler` | mcp: "fails a script's call as unavailable before sending it to a filtered tool, a disabled server, or a server that needs authentication"; dispatch: "rejects an MCP call that fails before its request is sent as unavailable, after the tool-result policy sees the failure" |
| Hooks see the complete result as text, without details. Unless they change it, the script gets the whole projection, structured content and images included. Once they do, it gets only the text they left, and an error they leave rejects with `failed`. | `dispatch.ts` `createCodeModeCallHandler` | dispatch: "runs an MCP call through the gateway's policies and the session's MCP manager, with its nested call id and origin"; "projects an MCP result in full unless a hook changes it, then gives only the text the hook left"; session-mcp-dispatch: "calls an MCP tool through the gateway's hooks and the manager, and gives the script the whole result" |
| In Plan mode, a trusted-read MCP call is authorized through the gateway's resolver and counts as research. | `src/core/session/turn-policy.ts` `toolCall`, `toolResult`; `src/core/operation-authorization.ts` (the MCP resolver) | session-mcp-dispatch: "authorizes a trusted-read MCP call through the gateway in Plan mode and counts it as research" |

## 10. Risks

- **Engine vulnerabilities without CVEs.** Mitigated by WebAssembly containment, the single-bridge rule, host-side validation of every call, exact pinning, and tracking QuickJS-NG releases.
- **Maintainer concentration.** `quickjs-wasi` has two maintainers. It is MIT-licensed with a documented wasi-sdk build, so Volt can rebuild or fork it.
- **Documentation drift.** The `quickjs-wasi` README states that the stack guard is unavailable on WASI and lists seven imports; version 3.6.3 has a working `maxStackSize` option and twelve imports. Volt pins behavior with its own tests rather than relying on the README.
- **Interpreter speed.** Heavy computation is slow. Acceptable for glue code; the compute budget bounds abuse.
- **Cost on small tasks.** Code mode costs more than direct calls on short tasks. Mitigated by keeping it opt-in and keeping its guidance compact.
- **Repeated side effects.** Scripts that fail after writes, or that the model reruns, can repeat side effects. Mitigated by failure results that list nested calls and calls that possibly applied (sections 5.9 and 5.11).
- **BigInt surprises.** Integers beyond the safe range arrive in scripts as BigInt, and mixing them with numbers throws (`id + 1`). This is rare, because most APIs send 64-bit IDs as strings, and an exception is preferable to silent rounding. Guidance covers it.
- **Forgotten images.** A script that never calls `image(ref)` shows no images. Mitigated by listing unshown images in the result.
- **Models printing whole tool results.** Models often print entire results back into the output; in one Codex dataset, 748 of about 2,340 cells printed a whole `exec_command` result. Mitigated by compact script values (section 5.9), the output budget with structural truncation and spill (section 5.10), and guidance.

## 11. Validation so far

Measured on Windows with Node 24.20.0 and `quickjs-wasi` 3.6.3 (QuickJS-NG 0.17.0), using throwaway scripts outside the repository.

| Check | Result |
|---|---|
| Module compile | 2 ms |
| VM create | 0.55 to 0.68 ms |
| Create plus 16.8 KB prelude with 40 bindings | 4.9 ms |
| Snapshot restore | 0.8 ms (1.6 MiB raw snapshot) |
| Baseline VM linear memory | 1.3 MiB |
| Worker thread plus VM, end to end | about 44 ms per script (72 ms first run) |
| Ten parallel 100 ms nested calls | 164 ms total, ten in flight |
| Ambient globals | `process`, `require`, `fetch`, `setTimeout`, `WebAssembly` undefined; `import('node:fs')` fails |
| `while (true) {}` and `while (true) await null` with a 500 ms deadline | Interrupted at about 512 ms |
| Regex backtracking, comparator sort, large `JSON.stringify` | Interrupted within 300 to 370 ms; VM reusable |
| Large `indexOf` loop | Ignored the interrupt for 2.5 s; `worker.terminate()` stopped it in 3.7 ms |
| 32 MiB `memoryLimit` | Catchable out-of-memory error; linear memory 32.3 MiB |
| Deep recursion | Host-side `RangeError` by default; catchable guest `RangeError` with `maxStackSize` (see the stack table below) |
| Interrupt handler | Called about every 5,000 loop iterations; 13 to 20% overhead on a tight loop |
| 11.5 MiB JSON passed in, parsed, and filtered | 127 ms |
| Idle worker with one VM | Roughly 1 to 9 MiB (Windows working-set figures understate committed memory) |

Codec primitives and costs, on a 0.89 MiB payload containing integers above `Number.MAX_SAFE_INTEGER` (every exact method returned them exactly):

| Check | Node 24.20 | Node 22.20 | QuickJS-NG 0.17 |
|---|---|---|---|
| `context.source` in `JSON.parse` revivers, `JSON.rawJSON` | Available | Available | Available |
| `JSON.parse('-0')` is `-0`; lone surrogates round-trip | Yes | Yes | Yes |
| Plain `JSON.parse` (lossy) | 2.7 ms | 5.2 ms | 13.5 ms |
| `JSON.parse` with a `context.source` reviver | 24.1 ms | 34.7 ms | 41.6 ms |
| `lossless-json` 4.3.3 parse | 10.7 ms | 12.0 ms | 308.6 ms |
| `JSON.stringify` with a `JSON.rawJSON` replacer | 6.8 ms | 8.4 ms | 40.5 ms |
| `lossless-json` 4.3.3 stringify | 7.5 ms | 12.8 ms | 194.6 ms |

`@modelcontextprotocol/client` 2.4.0 decodes `{"id":9007199254740993}` in `structuredContent` as `9007199254740992` ([modelcontextprotocol/typescript-sdk#3150](https://github.com/modelcontextprotocol/typescript-sdk/issues/3150)).

Output format prototype: a lenient guest prelude in QuickJS rendered realistic scripts in four candidate formats, counted with the o200k tokenizer:

| Scenario | Pi separators | Unmarked stream | Fenced stream (decided) | JSON envelope |
|---|---|---|---|---|
| One log line and a small return value | 45 | 40 | 40 | 44 |
| 150 log lines, a summary, a 20-row return value | 1781 | 1760 | 1760 | 1767 |
| Map, Set, Date, BigInt, cycle, error values | 124 | 102 | 102 | 117 |
| Two captioned images | 85 | 70 | 70 | 108 |
| Two multi-line `text()` items and console lines | 103 | 73 (ambiguous) | 95 | 80 |
| 50 single-line `text()` calls | 927 | 471 | 471 | 475 |
| 40 lines of code with quotes and backslashes | 1396 | 1381 | 1392 | 1385 |
| 315 KB of output, truncated to 50 KB | 9909 | 9903 | 9904 | 9462, invalid JSON |

A 20-row return value cost 522 tokens as compact JSON and 842 pretty-printed. Structural truncation reduced a 2.5 MB return value to 25 KB of valid JSON ending in `"[4936 more items]"`.

Stack guard against the worker's native stack (recursion through plain and async functions, and a 100,000-level `JSON.parse`):

| Worker native stack | `maxStackSize` | Recursion | Async recursion | Deep `JSON.parse` |
|---|---|---|---|---|
| 1 MB | 512 KiB | Host overflow | Host overflow | Host overflow |
| 4 MB (worker default) | 512 KiB | Guest `RangeError` | Guest `RangeError` | Host overflow |
| 8 MB | 512 KiB | Guest `RangeError` | Guest `RangeError` | Guest `RangeError` |
| 4 MB | 256 KiB | Guest `RangeError` | Guest `RangeError` | Guest `RangeError` |

Parsing nested source needs a deeper native stack, and how much deeper depends on the Node version. The probes, on Windows with `maxStackSize` at 512 KiB: `eval` of a 100,000-level array literal, `new Function` with 100,000 levels of parentheses, `eval` of 5,000 nested template literals, and a script whose own source is a 100,000-level array literal.

| Node | Smallest worker native stack at which every probe ended in a guest error |
|---|---|
| 22.20.0 | 8 MB or less |
| 24.20.0 | 11 MB |
| 25.2.1 | 13 MB |

At every size from 8 MB, these ended in a guest error or completed: getter, async, and generator recursion; proxy, `bind`, and prototype chains 100,000 deep; `JSON.stringify`, `String`, and `flat` on a 100,000-level array; and deeply nested regular expressions.

Error reporting in QuickJS, through the same-line wrapper:

- Syntax errors report exact lines and columns (`script.js:3:11`); runtime stacks name functions with script lines (`at parse (script.js:2:10)`).
- `cause` chains, `AggregateError` inner errors, and thrown non-`Error` values are recoverable inside the guest; read from the host, a thrown object renders as `[object Object]`.
- The unhandled-rejection callback fires for background rejections and also for the script's own rejected promise.
- Out-of-memory surfaces as a catchable `InternalError: out of memory`; the host's interrupt cannot be caught.

Nested-call summary formats for a failed script with 49 calls (41 reads, 6 writes, a failed bash call, and an MCP call still running when stopped):

| Format | Tokens | Shows which writes happened |
|---|---|---|
| Names and statuses (Pi) | 216 | No |
| Every call with arguments, first 20 (Pydantic-like) | 299 | No; the first 20 calls were reads |
| Grouped: read-only collapsed, state changes listed (decided) | 231 | Yes, with paths |

Declarations of Volt's built-in tools, measured from the built tool definitions with the o200k tokenizer: 3,254 tokens as JSON Schema declarations and 3,015 tokens as one TypeScript declaration block (largest: `lsp` 593, `request_user_input` 353, `bash` 313, `jobs` 309; smallest: `write` 84).

Shell commands written inside a script, evaluated in QuickJS:

| Command intended | Plain template literal | `String.raw` with `$VAR` |
|---|---|---|
| `git log --oneline -5` | Intact | Intact |
| `grep -rn "TODO" src` | Intact | Intact |
| `echo ${HOME}` | `ReferenceError: HOME is not defined` | Intact (`echo $HOME`) |
| `for f in *.ts; do echo "$f"; done` | Intact | Intact |
| `awk '{print $1}' file.txt` | Intact | Intact |
| `grep -E "\d+\.\d+" versions.txt` | Changed to `d+.d+` | Intact |
| `printf "a\tb\n"` | Changed to real tab and newline | Intact |
| `sed -i 's/foo/bar/g' a.txt` | Intact | Intact |
| `jq ".items[] \| select(.id == $id)" --arg id 3 data.json` | Intact | Intact |
| `find . -name '*.log' -exec rm {} \;` | Changed: backslash lost | Intact |
| `echo "C:\repo\src"` | Changed: carriage return inserted | Intact |
| ``npm test -- --grep `date +%F` `` | `SyntaxError` | `SyntaxError` |

Nested-call scheduling, simulated with tool latencies of 15 ms (`read`), 20 ms (`edit`), 250 ms (`web_fetch`), 400 ms (`bash`), and 300 ms (MCP), and a per-script limit of 10:

| Policy | 40 MCP calls, one server | 20 + 20 MCP calls, two servers | 50 reads, 10 fetches, 10 edits, 1 command | 10 × (MCP call, then 3 reads) |
|---|---|---|---|---|
| No scheduling (Pi) | 0.3 s, 40 at once | 0.3 s, 40 at once | 0.7 s, 50 at once | 0.3 s |
| One call at a time | 12.4 s | 12.4 s | 4.1 s | 3.6 s |
| Exclusive MCP calls (DeepSeek, Pydantic semantics) | 12.4 s | 12.4 s | 0.8 s | 3.2 s |
| One per server, strict submission order | 12.4 s | 12.1 s | 0.8 s | 3.1 s |
| One per server, others not held back | 12.4 s | 6.2 s | 0.8 s | 3.1 s |
| Four per server, others not held back (decided) | 3.1 s | 1.5 s | 0.8 s | 1.0 s |

MCP concurrency with the SDK Volt ships (`@modelcontextprotocol/sdk` 1.32.2), a stdio server whose tool waits 300 ms: 1 call took 320 ms; 10 and 40 concurrent calls took 309 ms each, with the server running 10 and 40 calls at once.

Model-facing contract measurements (o200k tokenizer):

- Script input wrapped as JSON tool arguments: 90 to 113 tokens and 135 to 170 tokens for two sample scripts, 26% more than the raw source in both.
- Draft `run_code` description: 471 tokens (1,987 characters); system-prompt snippet and guidelines: 96 tokens; parameter schema: 81 tokens.
- `stripTypeScriptTypes` in strip mode on Node 22.20 and 24.20: a 10-line script kept every line length; `enum`, `namespace`, and parameter properties were rejected with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`; plain JavaScript passed through unchanged.

Fixed per-request overhead of a default session, from the built system prompt and tool definitions (o200k tokenizer): 3,175 tokens of system prompt without project context or skills, and 2,564 tokens of declarations for the 10 default tools without `mcp`; 5,739 tokens in total, to which `run_code` adds about 650 (11%).

`run_code` card sizes (UTF-8 JSON of the presentation, with a 3.4 KB script and nested-call steps of about 142 bytes each): 7.6 KB with 20 calls and 30 output lines, 9.3 KB with 30 and 40, 13.7 KB with 50 and 100, and 38.9 KB with 200 and 200.

Runtime implementation (delivery step 1, Node 24.20, Windows): the first script in a process took 104 ms end to end, including compiling `quickjs.wasm`, starting the worker, and booting the VM; the next script took 3 ms on the prepared VM. With a 200 ms compute budget and 250 ms grace, the interrupt stopped `while (true) {}` after 204 ms, and the watchdog terminated a worker blocked in `String.prototype.indexOf` after 489 ms.

QuickJS heap for nested-call results (`getMemoryUsage().memoryUsedSize`, results of 1 MiB of JSON rows):

| State | Heap |
|---|---|
| Baseline VM | 0.1 MiB |
| One result held as a string | 0.6 MiB |
| Plus parsed into objects | 2.6 MiB |
| 5, 10, and 20 parsed results kept | 10.7, 20.9, and 41.3 MiB |
| 20 results reduced to the IDs of open rows | 0.6 MiB |

Parsed 1 MiB results held before out-of-memory: 9 with a 32 MiB limit, 18 with 64 MiB, and 38 with 128 MiB.

Gaps:

- Repeat the runtime measurements on Node 22.23.1, the standalone runtime, and on Linux and macOS, including the stack-guard table, which depends on native stack usage. The codec primitives are confirmed on Node 22.20.
- Verify loading `quickjs.wasm` and the worker entry from the standalone binary.
- Derive the license notices embedded in the WASM binary. Inputs for `quickjs-wasi` 3.6.3, from its `Makefile` at tag `quickjs-wasi@3.6.3`: QuickJS-NG at submodule commit `6d46d07` (`quickjs.c`, `dtoa.c`, `libregexp.c`, `libunicode.c`; MIT), Vercel's `c/interface.c` (MIT), and the wasi-sdk 32 sysroot's libc and emulated process-clock and signal libraries, linked statically. The package's own `LICENSE` covers only Vercel's code.

## 12. References

- Pi codemode: <https://pi.dev/docs/latest/codemode>; release notes: <https://github.com/earendil-works/pi/releases/tag/v0.99.0>
- DeepSeek Harness PTC note: <https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-06-15-ptc.md>
- DeepSeek-V4.1-Flash scaffold comparison: <https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/blob/main/README.md>
- Pydantic benchmark: <https://pydantic.dev/articles/why-code-mode-is-the-future>; CodeMode docs: <https://pydantic.dev/docs/ai/harness/code-mode/>
- Anthropic programmatic tool calling: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling>
- OpenAI programmatic tool calling: <https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling>
- Cloudflare Code Mode: <https://developers.cloudflare.com/agents/tools/codemode/>
- Goose Code Mode: <https://goose-docs.ai/docs/guides/managing-tools/code-mode/>
- `quickjs-wasi`: <https://github.com/vercel-labs/quickjs-wasi>
- QuickJS-NG security policy: <https://github.com/quickjs-ng/quickjs/blob/master/SECURITY.md>
- Node `vm` documentation: <https://nodejs.org/api/vm.html>
- `lossless-json`: <https://github.com/josdejong/lossless-json>
- Go MCP SDK precision fix: <https://github.com/modelcontextprotocol/go-sdk/issues/1236>, <https://github.com/modelcontextprotocol/go-sdk/pull/1239>
- TypeScript MCP SDK exact-number decode request: <https://github.com/modelcontextprotocol/typescript-sdk/issues/3150>
- Volt MCP exact numbers: <https://github.com/volt-hq/Volt/issues/1024>
- Pi v1.1.0 release notes (output item boundaries): <https://github.com/earendil-works/pi/releases/tag/v1.1.0>
- Codex code mode issues: output spill request <https://github.com/openai/codex/issues/49907>, unbounded output <https://github.com/openai/codex/issues/42367>, completed calls on failure <https://github.com/openai/codex/issues/49908>
- Cloudflare call records leaking into model output: <https://github.com/cloudflare/agents/issues/2143>
- Pi failure rendering: `dist/extensions/codemode/execute.js` in `@earendil-works/pi-coding-agent` 1.5.0 on npm
- DeepSeek Harness run failures: <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tool-executor-ptc/src/errors.ts>, <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tool-executor-ptc/src/ptc.ts>
- OpenCode interrupt discarding finished results: <https://github.com/anomalyco/opencode/issues/54222>
- Pi nested calls: `runToolCall` in `dist/agent-loop.js` of `@earendil-works/pi-agent-core` 1.5.0 on npm
- Pi codemode input and per-tool call notes: `codemodeSchema` and `describeScriptCall` in `dist/extensions/codemode/tool.js` of `@earendil-works/pi-coding-agent` 1.5.0 on npm
- Pi callable tools: `dist/extensions/codemode/tool.js` (`getCodemodeCallableTools`) in `@earendil-works/pi-coding-agent` 1.5.0 on npm; Pi tool exposure: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>

Vendor benchmark figures are as published by each vendor. Figures for Anthropic, Cloudflare, OpenCode, Codex, and Goose come from a research summary that cited their documentation and issues; they were not each re-verified for this document. The Pi output-boundary fix was verified against its release notes, Pi's failure rendering against its published package, DeepSeek's failure text against its source, Pydantic's failure reporting and shell exclusion against its documentation, OpenAI's routing guidance against its guide, and Pi's nested-call scheduling and codemode input against its published packages.

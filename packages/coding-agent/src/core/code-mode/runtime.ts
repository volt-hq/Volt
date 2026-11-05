import { encodeBridgeValue } from "./codec.ts";
import {
	type CodeModeScriptLimits,
	DEFAULT_CODE_MODE_SCRIPT_LIMITS,
	MAX_BINDING_NAME_LENGTH,
	MAX_CODE_MODE_SCRIPT_TIMEOUT_MS,
} from "./limits.ts";
import { CodeModePoolBusyError, type CodeModeWorker, type CodeModeWorkerPool } from "./pool.ts";
import type { CodeModeBinding, CodeModeErrorDescription } from "./prelude.ts";
import {
	CONTROL_COMPUTE_USED_INDEX,
	CONTROL_COMPUTING_SINCE_INDEX,
	CONTROL_STOP_INDEX,
	type CodeModeOutputItem,
	isPlainArguments,
	type ParsedCall,
	parseCallPayload,
	parseDonePayload,
	parseOutputPayload,
	type WorkerToHostMessage,
} from "./protocol.ts";

export type { CodeModeOutputItem } from "./protocol.ts";

/** Kinds of `ToolCallError` (section 5.9 of docs/code-mode-design.md). */
export type CodeModeCallErrorKind = "invalid_arguments" | "blocked" | "failed" | "cancelled";
export type CodeModeCallErrorReason = "result_too_large" | "limit_exceeded" | "unavailable";

/** Thrown by a call handler to reject a nested call with a typed `ToolCallError` in the script. */
export class CodeModeCallError extends Error {
	readonly kind: CodeModeCallErrorKind;
	readonly reason: CodeModeCallErrorReason | undefined;

	constructor(kind: CodeModeCallErrorKind, message: string, reason?: CodeModeCallErrorReason) {
		super(message);
		this.name = "CodeModeCallError";
		this.kind = kind;
		this.reason = reason;
	}
}

/** A nested call that passed the runtime's checks, handed to the caller's handler. */
export interface CodeModeCall {
	seq: number;
	binding: string;
	args: Record<string, unknown>;
	/** Aborted when the script ends, fails, or is terminated. */
	signal: AbortSignal;
}

export interface CodeModeScriptRequest {
	/** JavaScript; it becomes the body of an async function, so top-level `await` and `return` work. */
	code: string;
	bindings: readonly CodeModeBinding[];
	/**
	 * Executes a nested call. Resolves with the call's script value, which must be representable by the
	 * bridge codec. Rejects with a `CodeModeCallError` to choose the `ToolCallError` kind; any other
	 * rejection becomes `failed`, or `cancelled` once the call's signal has aborted.
	 */
	onCall(call: CodeModeCall): Promise<unknown>;
	/** Receives output items as the script produces them. */
	onOutput?(item: CodeModeOutputItem): void;
	signal?: AbortSignal;
	/** Optional wall-clock limit, including the wait for a worker. */
	timeoutMs?: number;
	limits?: Partial<CodeModeScriptLimits>;
}

export type CodeModeCallStatus = "completed" | "failed" | "cancelled" | "unsettled";

export interface CodeModeCallRecord {
	seq: number;
	binding: string;
	/** `unsettled` calls were still running when the script ended and may have taken effect. */
	status: CodeModeCallStatus;
	durationMs: number;
	error?: { kind: CodeModeCallErrorKind; reason?: CodeModeCallErrorReason; message: string };
}

/** Why a script failed (section 5.11 of docs/code-mode-design.md). */
export type CodeModeFailure =
	| { kind: "script_error"; phase: "evaluate" | "run"; error: CodeModeErrorDescription }
	| { kind: "compute_budget"; budgetMs: number }
	| { kind: "call_budget"; budget: number }
	| { kind: "timeout"; timeoutMs: number }
	| { kind: "aborted" }
	| { kind: "output_limit" }
	| { kind: "sandbox"; reason: string };

interface ScriptResultBase {
	output: CodeModeOutputItem[];
	calls: CodeModeCallRecord[];
	durationMs: number;
}

export interface CodeModeScriptSuccess extends ScriptResultBase {
	ok: true;
	/** False when the script returned `undefined`. */
	hasValue: boolean;
	value?: unknown;
}

export interface CodeModeScriptFailure extends ScriptResultBase {
	ok: false;
	failure: CodeModeFailure;
	/** False when the script never reached a VM; it consumed no budget. */
	started: boolean;
}

export type CodeModeScriptResult = CodeModeScriptSuccess | CodeModeScriptFailure;

/** Runs one script on a pooled worker and supervises it until it ends. */
export function runCodeModeScript(
	pool: CodeModeWorkerPool,
	request: CodeModeScriptRequest,
): Promise<CodeModeScriptResult> {
	validateBindings(request.bindings);
	const { timeoutMs } = request;
	if (timeoutMs !== undefined && !(timeoutMs > 0 && timeoutMs <= MAX_CODE_MODE_SCRIPT_TIMEOUT_MS)) {
		throw new RangeError(`timeoutMs must be between 1 and ${MAX_CODE_MODE_SCRIPT_TIMEOUT_MS}`);
	}
	return new ScriptRun(pool, request).run();
}

function validateBindings(bindings: readonly CodeModeBinding[]): void {
	const names = new Set<string>();
	const leaves = new Set<string>();
	const branches = new Set<string>();
	for (const binding of bindings) {
		if (binding.name.length === 0 || binding.name.length > MAX_BINDING_NAME_LENGTH || names.has(binding.name)) {
			throw new TypeError(`invalid or duplicate binding name: ${binding.name}`);
		}
		names.add(binding.name);
		if (binding.path.length === 0 || binding.path.some((segment) => segment === "" || segment === "__proto__")) {
			throw new TypeError(`invalid binding path for ${binding.name}`);
		}
		for (let i = 1; i < binding.path.length; i++) branches.add(JSON.stringify(binding.path.slice(0, i)));
		const leaf = JSON.stringify(binding.path);
		if (leaves.has(leaf)) throw new TypeError(`duplicate binding path for ${binding.name}`);
		leaves.add(leaf);
	}
	for (const leaf of leaves) {
		if (branches.has(leaf)) throw new TypeError(`binding path ${leaf} is both a binding and a namespace`);
	}
}

const WATCHDOG_INTERVAL_MS = 50;
// Room for the seq, the binding name escaped in the worst case, and the envelope keys.
const CALL_ENVELOPE_BYTES = 2048;

let lastScriptId = 0;

function nextScriptId(): number {
	lastScriptId = lastScriptId >= 0x7fffffff ? 1 : lastScriptId + 1;
	return lastScriptId;
}

interface CallState {
	record: CodeModeCallRecord;
	startedAt: number;
	bytes: number;
	settled: Promise<void>;
	done: boolean;
}

const STALLED_ERROR: CodeModeErrorDescription = {
	name: "stalled",
	summary: "The script awaited a promise that nothing can settle",
	text: "The script awaited a promise that nothing can settle: no tool calls were in flight. Await tool calls, and do not create promises that never resolve.",
	outOfMemory: false,
};

/** The message of any thrown value. Never throws, whatever the value's getters or conversions do. */
function errorMessage(error: unknown): string {
	try {
		const message = error instanceof Error ? error.message : error;
		return typeof message === "string" ? message : String(message);
	} catch {
		return "unknown error";
	}
}

function asCallError(error: unknown): CodeModeCallError | undefined {
	try {
		return error instanceof CodeModeCallError ? error : undefined;
	} catch {
		return undefined;
	}
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text) <= maxBytes) return text;
	const marker = " [truncated]";
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end)) + marker.length > maxBytes) end--;
	return `${text.slice(0, end)}${marker}`;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

class ScriptRun {
	private readonly pool: CodeModeWorkerPool;
	private readonly request: CodeModeScriptRequest;
	private readonly limits: CodeModeScriptLimits;
	private readonly id = nextScriptId();
	private readonly bindingNames: Set<string>;
	private readonly startedAt = performance.now();
	private readonly output: CodeModeOutputItem[] = [];
	private readonly calls: CallState[] = [];
	private readonly inFlight = new Set<CallState>();
	/** Aborts the signals of nested calls when the script ends. */
	private readonly callController = new AbortController();
	/** Aborts the wait for a worker. */
	private readonly waitController = new AbortController();
	private readonly settled: Promise<void>;
	private resolveSettled: () => void = () => {};
	private retainedChars = 0;
	private lastSeq = 0;
	private outstandingArgumentBytes = 0;
	private worker: CodeModeWorker | undefined;
	private stopFlags: Int32Array | undefined;
	private clock: BigInt64Array | undefined;
	private started = false;
	private workerSettled = false;
	private workerReusable = true;
	private stopRequested = false;
	private failure: CodeModeFailure | undefined;
	private completion: { hasValue: boolean; value?: unknown } | undefined;
	private graceTimer: NodeJS.Timeout | undefined;
	private watchdog: NodeJS.Timeout | undefined;

	constructor(pool: CodeModeWorkerPool, request: CodeModeScriptRequest) {
		this.pool = pool;
		this.request = request;
		this.limits = { ...DEFAULT_CODE_MODE_SCRIPT_LIMITS, ...request.limits };
		this.bindingNames = new Set(request.bindings.map((binding) => binding.name));
		this.settled = new Promise((resolve) => {
			this.resolveSettled = resolve;
		});
	}

	async run(): Promise<CodeModeScriptResult> {
		const { signal, timeoutMs } = this.request;
		if (signal?.aborted) return this.fail({ kind: "aborted" });
		const onAbort = () => this.terminate({ kind: "aborted" });
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout =
			timeoutMs === undefined
				? undefined
				: setTimeout(() => this.terminate({ kind: "timeout", timeoutMs }), timeoutMs);
		timeout?.unref();
		try {
			let worker: CodeModeWorker;
			try {
				worker = await this.pool.acquire(this.waitController.signal);
			} catch (error) {
				this.failure ??= {
					kind: "sandbox",
					reason:
						error instanceof CodeModePoolBusyError
							? error.message
							: `the sandbox failed to start: ${errorMessage(error)}`,
				};
				return this.finalize();
			}
			if (this.failure) {
				this.pool.release(worker);
				return this.finalize();
			}
			this.begin(worker);
			await this.settled;
			return await this.finalize();
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (timeout) clearTimeout(timeout);
		}
	}

	private fail(failure: CodeModeFailure): Promise<CodeModeScriptResult> {
		this.failure ??= failure;
		return this.finalize();
	}

	private begin(worker: CodeModeWorker): void {
		this.worker = worker;
		this.stopFlags = new Int32Array(worker.control, 0, 1);
		this.clock = new BigInt64Array(worker.control, 0, 3);
		if (!worker.alive) {
			this.failure ??= { kind: "sandbox", reason: "the worker exited before the script started" };
			this.workerReusable = false;
			this.settleWorker();
			return;
		}
		worker.attach({
			onMessage: (message) => this.onMessage(message),
			onMalformed: () => this.protocolViolation("malformed message"),
			onExit: (reason) => this.onWorkerExit(reason),
		});
		this.started = true;
		worker.post({
			type: "start",
			id: this.id,
			code: this.request.code,
			bindings: this.request.bindings.map((binding) => ({ name: binding.name, path: [...binding.path] })),
			computeBudgetMs: this.limits.computeBudgetMs,
			maxReportedRejections: this.limits.maxReportedRejections,
			maxArgumentBytes: this.limits.maxArgumentBytes,
		});
		this.watchdog = setInterval(() => this.checkWatchdog(), WATCHDOG_INTERVAL_MS);
		this.watchdog.unref();
	}

	/** Decides the outcome on behalf of the host and stops the VM. The first decision wins. */
	private terminate(failure: CodeModeFailure): void {
		if (this.failure || this.completion) return;
		this.failure = failure;
		if (!this.started) this.waitController.abort(new Error("The script did not start"));
		else this.requestStop();
	}

	/** Sets the interrupt flag, asks the worker to stop, and terminates it if the grace period passes. */
	private requestStop(): void {
		if (this.stopRequested || this.workerSettled || !this.worker || !this.stopFlags) return;
		this.stopRequested = true;
		Atomics.store(this.stopFlags, CONTROL_STOP_INDEX, this.id);
		this.worker.post({ type: "stop", id: this.id });
		this.graceTimer = setTimeout(() => this.kill(), this.limits.graceMs);
		this.graceTimer.unref();
	}

	private kill(): void {
		if (this.workerSettled) return;
		this.workerReusable = false;
		this.settleWorker();
	}

	/** The VM has ended or the worker is gone; the worker goes back to the pool or is discarded. */
	private settleWorker(): void {
		if (this.workerSettled) return;
		this.workerSettled = true;
		if (this.graceTimer) clearTimeout(this.graceTimer);
		if (this.watchdog) clearInterval(this.watchdog);
		if (this.worker) {
			this.worker.detach();
			if (this.workerReusable) this.pool.release(this.worker);
			else this.pool.discard(this.worker);
		}
		this.resolveSettled();
	}

	private protocolViolation(detail: string): void {
		this.failure ??= { kind: "sandbox", reason: `protocol violation: ${detail}` };
		this.kill();
	}

	private onWorkerExit(reason: string): void {
		this.failure ??= { kind: "sandbox", reason };
		this.workerReusable = false;
		this.settleWorker();
	}

	/** Terminates a VM that computes past its budget without polling the interrupt handler. */
	private checkWatchdog(): void {
		if (!this.clock || this.workerSettled) return;
		const since = Atomics.load(this.clock, CONTROL_COMPUTING_SINCE_INDEX);
		if (since === 0n) return;
		const used = Number(Atomics.load(this.clock, CONTROL_COMPUTE_USED_INDEX));
		const computingMs = Number(process.hrtime.bigint() - since) / 1e6;
		if (used + computingMs <= this.limits.computeBudgetMs + this.limits.graceMs) return;
		this.failure ??= { kind: "compute_budget", budgetMs: this.limits.computeBudgetMs };
		this.kill();
	}

	private onMessage(message: WorkerToHostMessage): void {
		if (this.workerSettled || message.type === "ready" || message.id !== this.id) return;
		switch (message.type) {
			case "call":
				this.onCall(message.payload);
				return;
			case "output":
				this.onOutput(message.payload);
				return;
			case "done":
				this.onDone(message.payload);
				return;
			case "stopped":
				this.failure ??=
					message.reason === "compute_budget"
						? { kind: "compute_budget", budgetMs: this.limits.computeBudgetMs }
						: { kind: "sandbox", reason: "the VM stopped without a request" };
				this.settleWorker();
				return;
			case "stalled":
				this.failure ??= { kind: "script_error", phase: "run", error: STALLED_ERROR };
				this.settleWorker();
				return;
			case "crash":
				this.failure ??= { kind: "sandbox", reason: message.reason };
				this.workerReusable = false;
				this.settleWorker();
				return;
		}
	}

	private onCall(payload: string): void {
		// After the outcome is decided, no further calls are made.
		if (this.failure) return;
		const bytes = Buffer.byteLength(payload);
		if (bytes > this.limits.maxArgumentBytes + CALL_ENVELOPE_BYTES) {
			this.protocolViolation("call arguments exceed the argument limit");
			return;
		}
		let call: ParsedCall;
		try {
			call = parseCallPayload(payload);
		} catch (error) {
			this.protocolViolation(errorMessage(error));
			return;
		}
		// The prelude enforces the argument limit on the exact encoded arguments before posting; a frame
		// beyond it was not produced by the prelude. The envelope around the arguments does not count.
		const envelopeBytes = Buffer.byteLength(`{"seq":${call.seq},"binding":${JSON.stringify(call.binding)},"args":}`);
		const argumentBytes = Math.max(0, bytes - envelopeBytes);
		if (argumentBytes > this.limits.maxArgumentBytes) {
			this.protocolViolation("call arguments exceed the argument limit");
			return;
		}
		if (call.seq !== this.lastSeq + 1) {
			this.protocolViolation(`call ${call.seq} after call ${this.lastSeq}`);
			return;
		}
		this.lastSeq = call.seq;
		// Counted before any other check, so attempts that fail later still count.
		if (call.seq > this.limits.callBudget) {
			this.terminate({ kind: "call_budget", budget: this.limits.callBudget });
			return;
		}
		if (!this.bindingNames.has(call.binding)) {
			this.protocolViolation(`unknown binding ${call.binding}`);
			return;
		}
		const state: CallState = {
			record: { seq: call.seq, binding: call.binding, status: "completed", durationMs: 0 },
			startedAt: performance.now(),
			bytes: argumentBytes,
			settled: Promise.resolve(),
			done: false,
		};
		this.calls.push(state);
		if (this.outstandingArgumentBytes + argumentBytes > this.limits.maxOutstandingArgumentBytes) {
			this.reply(
				state,
				this.failurePayload(
					state,
					new CodeModeCallError(
						"failed",
						`unfinished calls already hold ${this.outstandingArgumentBytes} bytes of arguments; await earlier calls first`,
						"limit_exceeded",
					),
				),
			);
			return;
		}
		if (!isPlainArguments(call.args)) {
			this.reply(
				state,
				this.failurePayload(state, new CodeModeCallError("invalid_arguments", "tool arguments must be an object")),
			);
			return;
		}
		this.outstandingArgumentBytes += argumentBytes;
		this.inFlight.add(state);
		state.settled = this.execute(state, call.args);
	}

	/** Runs one nested call and answers it. The returned promise never rejects. */
	private async execute(state: CallState, args: Record<string, unknown>): Promise<void> {
		let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
		try {
			const value = await this.request.onCall({
				seq: state.record.seq,
				binding: state.record.binding,
				args,
				signal: this.callController.signal,
			});
			outcome = { ok: true, value };
		} catch (error) {
			outcome = { ok: false, error };
		}
		// A call recorded as unsettled at the end of the script keeps that record; its late result is dropped.
		if (state.done) return;
		this.inFlight.delete(state);
		this.outstandingArgumentBytes -= state.bytes;
		let reply: { ok: boolean; payload: string };
		try {
			reply = outcome.ok ? this.valuePayload(state, outcome.value) : this.failurePayload(state, outcome.error);
		} catch {
			state.record.status = "failed";
			state.record.error = { kind: "failed", message: "the result could not be prepared" };
			reply = { ok: false, payload: JSON.stringify(state.record.error) };
		}
		this.reply(state, reply);
	}

	private valuePayload(state: CallState, value: unknown): { ok: boolean; payload: string } {
		let encoded: string;
		try {
			encoded = encodeBridgeValue(value, "result");
		} catch (error) {
			return this.failurePayload(
				state,
				new CodeModeCallError("failed", `the tool result is not JSON: ${errorMessage(error)}`),
			);
		}
		const bytes = Buffer.byteLength(encoded);
		if (bytes > this.limits.maxScriptValueBytes) {
			return this.failurePayload(
				state,
				new CodeModeCallError(
					"failed",
					`the result is ${bytes} bytes encoded, more than the limit of ${this.limits.maxScriptValueBytes}`,
					"result_too_large",
				),
			);
		}
		state.record.status = "completed";
		return { ok: true, payload: encoded };
	}

	private failurePayload(state: CallState, error: unknown): { ok: boolean; payload: string } {
		const typed = asCallError(error);
		const kind: CodeModeCallErrorKind = typed?.kind ?? (this.callController.signal.aborted ? "cancelled" : "failed");
		const reason = typed?.reason;
		const message = truncateUtf8(errorMessage(error), this.limits.maxErrorMessageBytes);
		state.record.status = kind === "cancelled" ? "cancelled" : "failed";
		state.record.error = reason === undefined ? { kind, message } : { kind, reason, message };
		return { ok: false, payload: JSON.stringify({ kind, reason, message }) };
	}

	private reply(state: CallState, reply: { ok: boolean; payload: string }): void {
		state.done = true;
		state.record.durationMs = performance.now() - state.startedAt;
		// After the outcome is decided, the host sends nothing more to the VM.
		if (this.failure || this.workerSettled || !this.worker) return;
		this.worker.post({ type: "result", id: this.id, seq: state.record.seq, ok: reply.ok, payload: reply.payload });
	}

	private onOutput(payload: string): void {
		// Output produced before a stop takes effect is kept, except past the output limit or a sandbox failure.
		if (this.failure?.kind === "output_limit" || this.failure?.kind === "sandbox") return;
		// One item larger than a message frame fails like output past the retained-output limit.
		if (Buffer.byteLength(payload) > this.limits.maxFrameBytes) {
			this.terminate({ kind: "output_limit" });
			return;
		}
		let item: CodeModeOutputItem;
		try {
			item = parseOutputPayload(payload);
		} catch (error) {
			this.protocolViolation(errorMessage(error));
			return;
		}
		const chars = item.type === "image" ? 0 : item.text.length;
		if (
			this.output.length >= this.limits.maxOutputItems ||
			this.retainedChars + chars > this.limits.maxRetainedOutputChars
		) {
			this.terminate({ kind: "output_limit" });
			return;
		}
		this.output.push(item);
		this.retainedChars += chars;
		// This runs inside the worker's message listener, where a throw would be an uncaught exception.
		try {
			this.request.onOutput?.(item);
		} catch (error) {
			this.terminate({ kind: "sandbox", reason: `the output handler failed: ${errorMessage(error)}` });
		}
	}

	private onDone(payload: string): void {
		if (Buffer.byteLength(payload) > this.limits.maxFrameBytes) {
			this.failure ??= { kind: "output_limit" };
			this.settleWorker();
			return;
		}
		let done: ReturnType<typeof parseDonePayload>;
		try {
			done = parseDonePayload(payload);
		} catch (error) {
			this.protocolViolation(errorMessage(error));
			return;
		}
		this.settleWorker();
		if (this.failure) return;
		if (done.ok) this.completion = done.hasValue ? { hasValue: true, value: done.value } : { hasValue: false };
		else this.failure = { kind: "script_error", phase: done.phase, error: done.error };
	}

	/** Ends the script: aborts nested calls still in flight and waits briefly for them (section 5.9). */
	private async finalize(): Promise<CodeModeScriptResult> {
		this.callController.abort(new Error("The script ended"));
		if (this.inFlight.size > 0) {
			await Promise.race([
				Promise.allSettled([...this.inFlight].map((state) => state.settled)),
				delay(this.limits.drainMs),
			]);
			for (const state of this.inFlight) {
				state.done = true;
				state.record.status = "unsettled";
				state.record.durationMs = performance.now() - state.startedAt;
			}
			this.inFlight.clear();
		}
		const base: ScriptResultBase = {
			output: this.output,
			calls: this.calls.map((state) => state.record),
			durationMs: performance.now() - this.startedAt,
		};
		if (this.failure) return { ok: false, failure: this.failure, started: this.started, ...base };
		if (this.completion) return { ok: true, ...this.completion, ...base };
		return {
			ok: false,
			failure: { kind: "sandbox", reason: "the script ended without a result" },
			started: this.started,
			...base,
		};
	}
}

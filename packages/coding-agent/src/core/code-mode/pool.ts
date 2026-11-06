import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
	type CodeModePoolOptions,
	DEFAULT_CODE_MODE_POOL_OPTIONS,
	MAX_BRIDGE_JSON_DEPTH,
	MAX_IMAGE_REF_LENGTH,
	MAX_SCRIPT_ERROR_CHARS,
	MAX_SCRIPT_ERROR_NAME_CHARS,
	MAX_SCRIPT_ERROR_SUMMARY_CHARS,
} from "./limits.ts";
import { PRELUDE_FILENAME, type PreludeConfig, SCRIPT_FILENAME, SCRIPT_PREFIX } from "./prelude.ts";
import {
	CODE_MODE_PROTOCOL_VERSION,
	CONTROL_BUFFER_BYTES,
	type CodeModeWorkerData,
	type CompiledWasm,
	type HostToWorkerMessage,
	parseWorkerMessage,
	type WorkerToHostMessage,
} from "./protocol.ts";

// The package's TypeScript libraries do not declare the WebAssembly global.
const wasmApi = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<CompiledWasm> } })
	.WebAssembly;

/** Thrown when every worker is busy and the queue of waiting scripts is full. */
export class CodeModePoolBusyError extends Error {
	constructor(maxWorkers: number, maxQueued: number) {
		super(`${maxWorkers} scripts are running and ${maxQueued} are waiting in this process`);
		this.name = "CodeModePoolBusyError";
	}
}

/** Receives the events of a worker while a script owns it. */
export interface CodeModeWorkerListener {
	onMessage(message: WorkerToHostMessage): void;
	/** A message failed validation. */
	onMalformed(): void;
	onExit(reason: string): void;
}

/** One worker thread of the pool, hosting at most one VM at a time. */
export class CodeModeWorker {
	readonly control = new SharedArrayBuffer(CONTROL_BUFFER_BYTES);
	readonly ready: Promise<string>;
	private readonly worker: Worker;
	private listener: CodeModeWorkerListener | undefined;
	private idleTimer: NodeJS.Timeout | undefined;
	private exited = false;
	private exitReason = "the worker exited";
	private booted = false;
	private resolveReady: (engine: string) => void = () => {};
	private rejectReady: (error: Error) => void = () => {};

	/**
	 * Starts the thread. It never keeps the process alive: a script waiting for a worker or for its result keeps
	 * the process alive itself (`runCodeModeScript`).
	 */
	constructor(url: URL, data: Omit<CodeModeWorkerData, "control">, stackSizeMb: number, onExit: () => void) {
		this.worker = new Worker(url, {
			workerData: { ...data, control: this.control } satisfies CodeModeWorkerData,
			resourceLimits: { stackSizeMb },
			// The worker needs no flags of the host process, and some host flags are invalid in workers.
			execArgv: [],
		});
		this.ready = new Promise<string>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		// Rejections are handled by whoever awaits `ready`; this keeps an unawaited failure from crashing the host.
		this.ready.catch(() => {});
		// One listener for the worker's lifetime: adding or removing a message listener refs or unrefs the
		// worker's port, which would undo the `unref` below.
		this.worker.on("message", (raw: unknown) => this.onWorkerMessage(raw));
		this.worker.on("error", (error: Error) => {
			this.exitReason = `the worker failed: ${error.message}`;
		});
		this.worker.on("exit", (code: number) => {
			this.exited = true;
			if (this.exitReason === "the worker exited") this.exitReason = `the worker exited with code ${code}`;
			if (!this.booted) this.rejectReady(new Error(`The code mode worker failed to start: ${this.exitReason}`));
			this.clearIdleTimer();
			const listener = this.listener;
			this.listener = undefined;
			onExit();
			listener?.onExit(this.exitReason);
		});
		this.worker.unref();
	}

	get alive(): boolean {
		return !this.exited;
	}

	attach(listener: CodeModeWorkerListener): void {
		this.listener = listener;
	}

	detach(): void {
		this.listener = undefined;
	}

	post(message: HostToWorkerMessage): void {
		if (!this.exited) this.worker.postMessage(message);
	}

	/** Terminates the thread. An attached listener receives `onExit` with `reason`. */
	terminate(reason = "the worker was terminated"): void {
		if (this.exited) return;
		this.exitReason = reason;
		void this.worker.terminate();
	}

	startIdleTimer(timeoutMs: number, onIdle: () => void): void {
		this.clearIdleTimer();
		this.idleTimer = setTimeout(onIdle, timeoutMs);
		this.idleTimer.unref();
	}

	clearIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private onWorkerMessage(raw: unknown): void {
		if (this.booted) {
			this.route(raw);
			return;
		}
		const message = parseWorkerMessage(raw);
		if (message?.type === "ready" && message.protocol === CODE_MODE_PROTOCOL_VERSION) {
			this.booted = true;
			this.resolveReady(message.engine);
			return;
		}
		const reason =
			message?.type === "ready"
				? `protocol ${message.protocol} does not match ${CODE_MODE_PROTOCOL_VERSION}`
				: message?.type === "crash"
					? message.reason
					: "unexpected first message";
		this.rejectReady(new Error(`The code mode worker failed to start: ${reason}`));
		this.terminate();
	}

	private route(raw: unknown): void {
		const message = parseWorkerMessage(raw);
		if (message === undefined) this.listener?.onMalformed();
		else this.listener?.onMessage(message);
	}
}

interface Waiter {
	resolve(worker: CodeModeWorker): void;
	reject(error: unknown): void;
	signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
}

/**
 * Worker pool of one process (section 5.3 of docs/code-mode-design.md). It starts with no workers, grows
 * on demand up to `maxWorkers`, queues up to `maxQueuedScripts` scripts beyond that, and stops workers
 * that stay idle for `idleTimeoutMs`. Workers never keep the process alive, idle or busy; a script keeps the
 * process alive itself while its caller waits for the result.
 */
export class CodeModeWorkerPool {
	private readonly options: CodeModePoolOptions;
	private readonly workers = new Set<CodeModeWorker>();
	private readonly idle: CodeModeWorker[] = [];
	private readonly waiters: Waiter[] = [];
	/** Workers being created; they count against `maxWorkers` from the moment `acquire` decides to spawn. */
	private spawning = 0;
	private wasm: Promise<CompiledWasm> | undefined;
	private closed = false;

	constructor(options: Partial<CodeModePoolOptions> = {}) {
		this.options = { ...DEFAULT_CODE_MODE_POOL_OPTIONS, ...options };
	}

	get stats(): { workers: number; idle: number; queued: number } {
		return { workers: this.workers.size + this.spawning, idle: this.idle.length, queued: this.waiters.length };
	}

	/**
	 * Returns a worker for one script. Throws `CodeModePoolBusyError` when the queue is full, the signal's
	 * reason when it aborts while waiting, and an Error when a worker fails to start.
	 */
	async acquire(signal?: AbortSignal): Promise<CodeModeWorker> {
		if (this.closed) throw new Error("The code mode worker pool is closed");
		signal?.throwIfAborted();
		const idle = this.idle.pop();
		if (idle) {
			idle.clearIdleTimer();
			return idle;
		}
		if (this.hasCapacity()) return this.spawn(signal);
		if (this.waiters.length >= this.options.maxQueuedScripts) {
			throw new CodeModePoolBusyError(this.options.maxWorkers, this.options.maxQueuedScripts);
		}
		return new Promise<CodeModeWorker>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject, signal, onAbort: undefined };
			if (signal) {
				waiter.onAbort = () => {
					const index = this.waiters.indexOf(waiter);
					if (index !== -1) this.waiters.splice(index, 1);
					reject(signal.reason);
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.waiters.push(waiter);
		});
	}

	/** Returns a worker whose VM has finished. A waiting script receives it immediately. */
	release(worker: CodeModeWorker): void {
		worker.detach();
		if (!worker.alive || this.closed) {
			this.discard(worker);
			return;
		}
		const waiter = this.waiters.shift();
		if (waiter) {
			this.hand(waiter, worker);
			return;
		}
		this.idle.push(worker);
		worker.startIdleTimer(this.options.idleTimeoutMs, () => this.discard(worker));
	}

	/** Terminates a worker, for example after a hard kill, and starts a replacement for a waiting script. */
	discard(worker: CodeModeWorker): void {
		worker.detach();
		worker.terminate();
		this.forget(worker);
	}

	/** Terminates every worker and rejects waiting scripts. */
	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) {
			if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
			waiter.reject(new Error("The code mode worker pool is closed"));
		}
		// Listeners stay attached, so scripts running on these workers end with a sandbox failure.
		for (const worker of [...this.workers]) worker.terminate("the code mode worker pool was closed");
	}

	private hasCapacity(): boolean {
		return this.workers.size + this.spawning < this.options.maxWorkers;
	}

	private forget(worker: CodeModeWorker): void {
		this.workers.delete(worker);
		const index = this.idle.indexOf(worker);
		if (index !== -1) this.idle.splice(index, 1);
		this.refill();
	}

	/** Starts workers for waiting scripts while there is capacity, for example after a worker was terminated. */
	private refill(): void {
		if (this.closed) return;
		while (this.waiters.length > 0 && this.hasCapacity()) {
			const waiter = this.waiters.shift()!;
			if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
			this.spawn(waiter.signal).then(waiter.resolve, waiter.reject);
		}
	}

	private hand(waiter: Waiter, worker: CodeModeWorker): void {
		if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
		waiter.resolve(worker);
	}

	private async spawn(signal: AbortSignal | undefined): Promise<CodeModeWorker> {
		// Reserved synchronously, before the first await, so concurrent acquires cannot exceed the cap.
		this.spawning++;
		let worker: CodeModeWorker;
		try {
			const wasm = await untilAborted(this.loadWasm(), signal);
			if (this.closed) throw new Error("The code mode worker pool is closed");
			const prelude: PreludeConfig = {
				maxJsonDepth: MAX_BRIDGE_JSON_DEPTH,
				maxErrorChars: MAX_SCRIPT_ERROR_CHARS,
				maxErrorNameChars: MAX_SCRIPT_ERROR_NAME_CHARS,
				maxErrorSummaryChars: MAX_SCRIPT_ERROR_SUMMARY_CHARS,
				maxImageRefLength: MAX_IMAGE_REF_LENGTH,
				scriptFilename: SCRIPT_FILENAME,
				scriptPrefixLength: SCRIPT_PREFIX.length,
				preludeFilename: PRELUDE_FILENAME,
			};
			const created = new CodeModeWorker(
				workerUrl(),
				{ wasm, memoryLimitBytes: this.options.memoryLimitBytes, prelude },
				this.options.workerStackSizeMb,
				() => this.forget(created),
			);
			worker = created;
			this.workers.add(worker);
		} catch (error) {
			this.spawning--;
			this.refill();
			if (signal?.aborted) throw signal.reason;
			throw new Error(
				`The code mode engine failed to load: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.spawning--;
		try {
			await untilAborted(worker.ready, signal);
			return worker;
		} catch (error) {
			// A worker that boots after its script gave up waiting serves the next script.
			if (signal?.aborted)
				worker.ready.then(
					() => this.release(worker),
					() => this.discard(worker),
				);
			else this.discard(worker);
			throw error;
		}
	}

	private loadWasm(): Promise<CompiledWasm> {
		if (!this.wasm) {
			const pending = readFile(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm")).then((bytes) =>
				wasmApi.compile(bytes),
			);
			pending.catch(() => {
				if (this.wasm === pending) this.wasm = undefined;
			});
			this.wasm = pending;
		}
		return this.wasm;
	}
}

/**
 * Settles like `promise`, or rejects with the signal's reason once the signal aborts. Checks the signal first:
 * an abort event is not replayed to listeners added after it fired.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function workerUrl(): URL {
	const moduleUrl = import.meta.url;
	return new URL(moduleUrl.endsWith(".ts") ? "./worker.ts" : "./worker.js", moduleUrl);
}

let processPool: CodeModeWorkerPool | undefined;

/** The worker pool shared by every conversation and subagent in this process. */
export function getCodeModeWorkerPool(): CodeModeWorkerPool {
	processPool ??= new CodeModeWorkerPool();
	return processPool;
}

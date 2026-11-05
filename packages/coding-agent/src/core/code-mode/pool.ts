import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
	type CodeModePoolOptions,
	DEFAULT_CODE_MODE_POOL_OPTIONS,
	MAX_BRIDGE_JSON_DEPTH,
	MAX_SCRIPT_ERROR_CHARS,
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

	constructor(url: URL, data: Omit<CodeModeWorkerData, "control">, stackSizeMb: number, onExit: () => void) {
		this.worker = new Worker(url, {
			workerData: { ...data, control: this.control } satisfies CodeModeWorkerData,
			resourceLimits: { stackSizeMb },
			// The worker needs no flags of the host process, and some host flags are invalid in workers.
			execArgv: [],
		});
		this.worker.unref();
		this.ready = new Promise<string>((resolve, reject) => {
			const onReady = (raw: unknown) => {
				const message = parseWorkerMessage(raw);
				if (message?.type === "ready" && message.protocol === CODE_MODE_PROTOCOL_VERSION) {
					this.worker.off("message", onReady);
					this.worker.on("message", (next: unknown) => this.route(next));
					resolve(message.engine);
					return;
				}
				this.worker.off("message", onReady);
				const reason =
					message?.type === "ready"
						? `protocol ${message.protocol} does not match ${CODE_MODE_PROTOCOL_VERSION}`
						: message?.type === "crash"
							? message.reason
							: "unexpected first message";
				reject(new Error(`The code mode worker failed to start: ${reason}`));
				this.terminate();
			};
			this.worker.on("message", onReady);
			this.worker.once("exit", () => reject(new Error(`The code mode worker failed to start: ${this.exitReason}`)));
		});
		// Rejections are handled by whoever awaits `ready`; this keeps an unawaited failure from crashing the host.
		this.ready.catch(() => {});
		this.worker.on("error", (error: Error) => {
			this.exitReason = `the worker failed: ${error.message}`;
		});
		this.worker.on("exit", (code: number) => {
			this.exited = true;
			if (this.exitReason === "the worker exited") this.exitReason = `the worker exited with code ${code}`;
			this.clearIdleTimer();
			const listener = this.listener;
			this.listener = undefined;
			onExit();
			listener?.onExit(this.exitReason);
		});
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

	terminate(): void {
		if (this.exited) return;
		this.exitReason = "the worker was terminated";
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
 * that stay idle for `idleTimeoutMs`. Workers never keep the process alive.
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
		for (const worker of [...this.workers]) this.discard(worker);
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
			const wasm = await this.loadWasm();
			if (this.closed) throw new Error("The code mode worker pool is closed");
			const prelude: PreludeConfig = {
				maxJsonDepth: MAX_BRIDGE_JSON_DEPTH,
				maxErrorChars: MAX_SCRIPT_ERROR_CHARS,
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
			throw new Error(
				`The code mode engine failed to load: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.spawning--;
		if (!signal) {
			await worker.ready;
			return worker;
		}
		const aborted = new Promise<never>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
		aborted.catch(() => {});
		try {
			await Promise.race([worker.ready, aborted]);
			return worker;
		} catch (error) {
			// A worker that boots after its script gave up waiting serves the next script.
			if (signal.aborted)
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

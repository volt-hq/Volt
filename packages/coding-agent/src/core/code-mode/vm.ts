import { randomInt } from "node:crypto";
import {
	Intrinsics,
	JSException,
	type JSValueHandle,
	MAX_STACK_SIZE,
	QuickJS,
	type QuickJSOptions,
} from "quickjs-wasi";
import {
	CODE_MODE_PRELUDE_SOURCE,
	type CodeModeBinding,
	PRELUDE_FILENAME,
	type PreludeConfig,
	type PreludeInstall,
	SCRIPT_FILENAME,
	SCRIPT_PREFIX,
	SCRIPT_SUFFIX,
} from "./prelude.ts";
import type { CompiledWasm } from "./protocol.ts";

/** Messages a VM produces; the worker adds the script id and forwards them to the host. */
export type ScriptVmMessage =
	| { type: "call"; payload: string }
	| { type: "output"; payload: string }
	| { type: "done"; payload: string }
	| { type: "stopped"; reason: "stop" | "compute_budget" }
	| { type: "stalled" }
	| { type: "crash"; reason: string };

export interface ScriptVmOptions {
	wasm: CompiledWasm;
	memoryLimitBytes: number;
	prelude: PreludeConfig;
	/** Polled by the interrupt handler; returns true when the host asked this script to stop. */
	isStopRequested?: () => boolean;
	/** Called when the VM starts executing, with the compute the script used before. */
	onComputeStart?: (usedMs: number) => void;
	/** Called when the VM stops executing. */
	onComputeEnd?: () => void;
}

export interface ScriptVmStart {
	code: string;
	bindings: CodeModeBinding[];
	computeBudgetMs: number;
	maxReportedRejections: number;
	maxArgumentBytes: number;
}

type HaltReason = "done" | "stop" | "compute_budget" | "crash";

interface PreludeHandles {
	install: JSValueHandle;
	run: JSValueHandle;
	settle: JSValueHandle;
	describe: JSValueHandle;
}

interface TrackedRejection {
	promise: JSValueHandle;
	reason: JSValueHandle;
}

const MAX_TRACKED_REJECTIONS = 100;
const WASI_ERRNO_SUCCESS = 0;
const WASI_ERRNO_NOSYS = 52;
const WASI_CLOCK_REALTIME = 0;
const WASI_CLOCK_MONOTONIC = 1;

/**
 * One QuickJS VM running one script (sections 5.4 to 5.7 of docs/code-mode-design.md).
 *
 * The VM is booted with the prelude before the script is known, so a worker can prepare the next VM in
 * advance. Every entry into the VM runs synchronously until the VM is idle; the instance never re-enters
 * the VM from inside a host callback. Once the script finishes or is stopped, the VM must be disposed.
 */
export class ScriptVm {
	private readonly options: ScriptVmOptions;
	private vm: QuickJS | undefined;
	private prelude: PreludeHandles | undefined;
	private emit: (message: ScriptVmMessage) => void = () => {};
	private state: "booting" | "prepared" | "running" | "finished" = "booting";
	private haltReason: HaltReason | undefined;
	private crashReason = "";
	private pendingDone: string | undefined;
	private describing = false;
	private computeBudgetMs = Number.POSITIVE_INFINITY;
	private maxReportedRejections = 0;
	private computeUsedMs = 0;
	private segmentStart = 0;
	private outstandingCalls = 0;
	private rejections: TrackedRejection[] = [];
	private reportedRejections = 0;

	private constructor(options: ScriptVmOptions) {
		this.options = options;
	}

	/** Creates a VM and evaluates the prelude. */
	static async boot(options: ScriptVmOptions): Promise<ScriptVm> {
		const instance = new ScriptVm(options);
		try {
			await instance.initialize();
		} catch (error) {
			instance.dispose();
			throw error;
		}
		return instance;
	}

	get engineVersion(): string {
		return this.quickjs.versions.quickjs ?? "unknown";
	}

	get finished(): boolean {
		return this.state === "finished";
	}

	private get quickjs(): QuickJS {
		if (!this.vm) throw new Error("The VM is not booted");
		return this.vm;
	}

	private get api(): PreludeHandles {
		if (!this.prelude) throw new Error("The prelude is not booted");
		return this.prelude;
	}

	private async initialize(): Promise<void> {
		// QuickJS seeds Math.random from the first clock reading while it creates the context. A coarse
		// clock gives VMs created back to back the same sequence, so the seed comes from crypto instead.
		let seeding = true;
		const seedNs = BigInt(randomInt(1, 2 ** 47)) * 1_000n;
		const options: QuickJSOptions = {
			wasm: this.options.wasm,
			memoryLimit: this.options.memoryLimitBytes,
			maxStackSize: MAX_STACK_SIZE,
			// WeakRef and FinalizationRegistry add garbage-collection timing to script behavior.
			intrinsics: (Intrinsics.ALL & ~Intrinsics.WEAK_REF) >>> 0,
			interruptHandler: () => this.shouldInterrupt(),
			onUnhandledRejection: (promise, reason, isHandled) => this.trackRejection(promise, reason, isHandled),
			wasi: (memory) => ({
				clock_time_get: (clockId: number, _precision: bigint, resultPtr: number): number => {
					if (clockId !== WASI_CLOCK_REALTIME && clockId !== WASI_CLOCK_MONOTONIC) return WASI_ERRNO_NOSYS;
					const time = seeding ? seedNs : BigInt(Date.now()) * 1_000_000n;
					new DataView(memory.buffer).setBigUint64(resultPtr, time, true);
					return WASI_ERRNO_SUCCESS;
				},
				// QuickJS writes engine diagnostics to fds 1 and 2; they never reach the terminal or a client.
				fd_write: (_fd: number, iovsPtr: number, iovsLength: number, writtenPtr: number): number => {
					const view = new DataView(memory.buffer);
					let total = 0;
					for (let i = 0; i < iovsLength; i++) total += view.getUint32(iovsPtr + i * 8 + 4, true);
					view.setUint32(writtenPtr, total, true);
					return WASI_ERRNO_SUCCESS;
				},
			}),
		};
		const vm = await QuickJS.create(options);
		seeding = false;
		this.vm = vm;

		const factory = vm.evalCode(CODE_MODE_PRELUDE_SOURCE, PRELUDE_FILENAME);
		// The only host function. The prelude keeps it in a closure the script cannot reach.
		const bridge = vm.newFunction("bridge", (kind, payload) => {
			this.onBridge(kind, payload);
			return vm.undefined;
		});
		const config = vm.newString(JSON.stringify(this.options.prelude));
		let api: JSValueHandle;
		try {
			api = vm.callFunction(factory, vm.undefined, bridge, config);
		} finally {
			factory.dispose();
			bridge.dispose();
			config.dispose();
		}
		try {
			const handles: PreludeHandles = {
				install: api.getProp("install"),
				run: api.getProp("run"),
				settle: api.getProp("settle"),
				describe: api.getProp("describe"),
			};
			this.prelude = handles;
			for (const handle of Object.values(handles)) {
				if (!handle.isFunction) throw new Error("The prelude did not return its API");
			}
		} finally {
			api.dispose();
		}
		this.state = "prepared";
	}

	/** Installs the bindings and runs the script until the VM is idle. */
	start(request: ScriptVmStart, emit: (message: ScriptVmMessage) => void): void {
		if (this.state !== "prepared") throw new Error("The VM cannot start a script");
		this.state = "running";
		this.emit = emit;
		this.computeBudgetMs = request.computeBudgetMs;
		this.maxReportedRejections = request.maxReportedRejections;
		const vm = this.quickjs;

		const install: PreludeInstall = { bindings: request.bindings, maxArgumentBytes: request.maxArgumentBytes };
		const bindings = vm.newString(JSON.stringify(install));
		try {
			this.execute(() => vm.callFunction(this.api.install, vm.undefined, bindings).dispose());
		} catch (error) {
			this.crash(`installing bindings failed: ${hostErrorMessage(error)}`);
			return;
		} finally {
			bindings.dispose();
		}

		let script: JSValueHandle | undefined;
		try {
			this.execute(() => {
				script = vm.evalCode(`${SCRIPT_PREFIX}${request.code}${SCRIPT_SUFFIX}`, SCRIPT_FILENAME);
			});
		} catch (error) {
			if (this.haltReason !== undefined) {
				this.endTurn();
				return;
			}
			if (error instanceof JSException) {
				this.failWith(error.handle);
				error.dispose();
				return;
			}
			this.crash(`evaluating the script failed: ${hostErrorMessage(error)}`);
			return;
		}
		const scriptFunction = script;
		if (!scriptFunction) {
			this.crash("evaluating the script returned nothing");
			return;
		}
		try {
			this.runUntilIdle(() => vm.callFunction(this.api.run, vm.undefined, scriptFunction).dispose());
		} finally {
			scriptFunction.dispose();
		}
	}

	/** Settles nested call `seq` and runs the VM until it is idle. */
	settle(seq: number, ok: boolean, payload: string): void {
		if (this.state !== "running") return;
		const vm = this.quickjs;
		this.outstandingCalls--;
		const seqHandle = vm.newString(String(seq));
		const statusHandle = vm.newString(ok ? "ok" : "error");
		const payloadHandle = vm.newString(payload);
		let status = "";
		try {
			this.runUntilIdle(() => {
				const result = vm.callFunction(this.api.settle, vm.undefined, seqHandle, statusHandle, payloadHandle);
				status = result.isString ? result.toString() : "";
				result.dispose();
				if (status !== "ok") this.halt("crash", `the VM rejected the result of call ${seq} (${status})`);
			});
		} finally {
			seqHandle.dispose();
			statusHandle.dispose();
			payloadHandle.dispose();
		}
	}

	/** Stops the script on request of the host. Has no effect once the script has finished. */
	stop(): void {
		if (this.state !== "running") return;
		this.halt("stop");
		this.endTurn();
	}

	dispose(): void {
		this.state = "finished";
		for (const rejection of this.rejections) {
			rejection.promise.dispose();
			rejection.reason.dispose();
		}
		this.rejections = [];
		if (this.prelude) {
			for (const handle of Object.values(this.prelude)) handle.dispose();
			this.prelude = undefined;
		}
		this.vm?.dispose();
		this.vm = undefined;
	}

	private shouldInterrupt(): boolean {
		const exhausted =
			this.segmentStart !== 0 && this.computeUsedMs + (performance.now() - this.segmentStart) > this.computeBudgetMs;
		if (this.describing) return exhausted || (this.options.isStopRequested?.() ?? false);
		// Once the script is done or stopped, the VM never resumes; any remaining execution is cut short.
		if (this.haltReason !== undefined) return true;
		if (this.state === "running" && this.options.isStopRequested?.()) {
			this.halt("stop");
			return true;
		}
		if (exhausted) {
			this.halt("compute_budget");
			return true;
		}
		return false;
	}

	private halt(reason: HaltReason, crashReason = ""): void {
		if (this.haltReason !== undefined) return;
		this.haltReason = reason;
		this.crashReason = crashReason;
	}

	/** Runs `action` inside the VM, counting the time against the compute budget. */
	private execute(action: () => void): void {
		this.segmentStart = performance.now();
		this.options.onComputeStart?.(this.computeUsedMs);
		try {
			action();
		} finally {
			this.computeUsedMs += performance.now() - this.segmentStart;
			this.segmentStart = 0;
			this.options.onComputeEnd?.();
		}
	}

	private runUntilIdle(action: () => void): void {
		try {
			this.execute(() => {
				action();
				this.quickjs.executePendingJobs();
			});
		} catch (error) {
			// An interrupt surfaces as an exception; anything else from a VM operation discards the VM.
			if (this.haltReason === undefined) this.halt("crash", hostErrorMessage(error));
		}
		this.endTurn();
	}

	/** Reports what the turn produced once the VM is idle. */
	private endTurn(): void {
		if (this.state !== "running") return;
		switch (this.haltReason) {
			case "crash":
				this.finish({ type: "crash", reason: this.crashReason });
				return;
			case "stop":
			case "compute_budget":
				this.finish({ type: "stopped", reason: this.haltReason });
				return;
			case "done":
				this.reportRejections();
				this.finish({ type: "done", payload: this.pendingDone ?? '{"ok":true}' });
				return;
		}
		// No timers exist in the VM, so with no call in flight nothing can resume the script. Rejections are
		// reported only once the script cannot resume; until then it may still attach a handler.
		if (this.outstandingCalls === 0) {
			this.reportRejections();
			this.finish({ type: "stalled" });
		}
	}

	private finish(message: ScriptVmMessage): void {
		this.state = "finished";
		this.emit(message);
	}

	private crash(reason: string): void {
		this.halt("crash", reason);
		this.endTurn();
	}

	private failWith(error: JSValueHandle): void {
		const description = this.describe(error);
		this.pendingDone = `{"ok":false,"phase":"evaluate","error":${description}}`;
		this.halt("done");
		this.endTurn();
	}

	private onBridge(kind: JSValueHandle | undefined, payload: JSValueHandle | undefined): void {
		if (this.state !== "running" || this.haltReason !== undefined) return;
		// Only primitive strings are read: converting any other handle would run guest code.
		if (!kind?.isString || !payload?.isString) {
			this.halt("crash", "the bridge received a value that is not a string");
			return;
		}
		const kindText = kind.toString();
		const payloadText = payload.toString();
		switch (kindText) {
			case "call":
				this.outstandingCalls++;
				this.emit({ type: "call", payload: payloadText });
				return;
			case "output":
				this.emit({ type: "output", payload: payloadText });
				return;
			case "done":
				this.pendingDone = payloadText;
				this.halt("done");
				return;
			default:
				this.halt("crash", "the bridge received an unknown message kind");
		}
	}

	private trackRejection(promise: JSValueHandle, reason: JSValueHandle, isHandled: boolean): void {
		if (isHandled) {
			const index = this.rejections.findIndex((rejection) => rejection.promise.identity === promise.identity);
			if (index !== -1) {
				const [rejection] = this.rejections.splice(index, 1);
				rejection.promise.dispose();
				rejection.reason.dispose();
			}
			return;
		}
		if (this.rejections.length < MAX_TRACKED_REJECTIONS) {
			this.rejections.push({ promise: promise.dup(), reason: reason.dup() });
		}
	}

	/** Reports promises that were rejected without a handler as warnings in the output. */
	private reportRejections(): void {
		const rejections = this.rejections;
		this.rejections = [];
		for (const rejection of rejections) {
			if (this.reportedRejections < this.maxReportedRejections) {
				this.reportedRejections++;
				const summary = summaryOf(this.describe(rejection.reason));
				const text = `unhandled rejection: ${summary}`;
				this.emit({ type: "output", payload: JSON.stringify({ type: "console", level: "warn", text }) });
			}
			rejection.promise.dispose();
			rejection.reason.dispose();
		}
	}

	/** Describes a thrown value with the prelude, which runs before the value leaves the VM. */
	private describe(value: JSValueHandle): string {
		const vm = this.quickjs;
		this.describing = true;
		try {
			for (let attempt = 0; attempt < 2; attempt++) {
				try {
					let description = "";
					this.execute(() => {
						const result = vm.callFunction(this.api.describe, vm.undefined, value);
						if (result.isString) description = result.toString();
						result.dispose();
					});
					if (description !== "") return description;
				} catch {
					// Describing can fail when the script exhausted its memory; collect garbage and retry once.
					vm.runGC();
				}
			}
		} finally {
			this.describing = false;
		}
		const summary = "Error: the thrown value could not be described";
		return JSON.stringify({ name: "Error", summary, text: summary, outOfMemory: false });
	}
}

function summaryOf(description: string): string {
	try {
		const parsed: unknown = JSON.parse(description);
		if (parsed !== null && typeof parsed === "object" && "summary" in parsed && typeof parsed.summary === "string") {
			return parsed.summary;
		}
	} catch {
		// Fall through to the generic summary.
	}
	return "the rejection could not be described";
}

function hostErrorMessage(error: unknown): string {
	// A JSException's message would be read from the guest value; only its host-side type is reported.
	if (error instanceof JSException) return "the VM raised an exception";
	if (error instanceof RangeError) return `host RangeError: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}

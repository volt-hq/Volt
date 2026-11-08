import { parentPort, workerData } from "node:worker_threads";
import {
	CODE_MODE_PROTOCOL_VERSION,
	CONTROL_COMPUTE_USED_INDEX,
	CONTROL_COMPUTING_SINCE_INDEX,
	CONTROL_STOP_INDEX,
	type CodeModeWorkerData,
	type HostToWorkerMessage,
	type WorkerToHostMessage,
} from "./protocol.ts";
import { ScriptVm, type ScriptVmMessage } from "./vm.ts";

/**
 * Worker entry for code mode. Each worker hosts at most one VM at a time and boots the next VM as soon
 * as a script ends, so boot time stays off the critical path. The worker is trusted code, but it is not
 * a security boundary: the VM and the bridge are (section 5.2 of docs/code-mode-design.md).
 */

const port = parentPort;
if (!port) throw new Error("The code mode worker must run in a worker thread");
const data = workerData as CodeModeWorkerData;
const stopFlags = new Int32Array(data.control, 0, 1);
const clock = new BigInt64Array(data.control, 0, 3);

// At most one VM is running a script; `prepared` is the next one, booted in advance.
let current: { id: number; vm: ScriptVm } | undefined;
let prepared: Promise<ScriptVm> | undefined;

function post(message: WorkerToHostMessage): void {
	port?.postMessage(message);
}

function boot(): Promise<ScriptVm> {
	return ScriptVm.boot({
		wasm: data.wasm,
		memoryLimitBytes: data.memoryLimitBytes,
		prelude: data.prelude,
		isStopRequested: () => current !== undefined && Atomics.load(stopFlags, CONTROL_STOP_INDEX) === current.id,
		onComputeStart: (usedMs) => {
			Atomics.store(clock, CONTROL_COMPUTE_USED_INDEX, BigInt(Math.round(usedMs)));
			Atomics.store(clock, CONTROL_COMPUTING_SINCE_INDEX, process.hrtime.bigint());
		},
		onComputeEnd: () => {
			Atomics.store(clock, CONTROL_COMPUTING_SINCE_INDEX, 0n);
		},
	});
}

function prepare(): void {
	const next = boot();
	// A failed boot is reported when a script needs the VM.
	next.catch(() => {});
	prepared = next;
}

function forward(id: number, message: ScriptVmMessage): void {
	post({ ...message, id });
}

/** Disposes the VM once its script has ended and prepares the next one. */
function afterTurn(): void {
	if (!current?.vm.finished) return;
	current.vm.dispose();
	current = undefined;
	prepare();
}

async function start(message: Extract<HostToWorkerMessage, { type: "start" }>): Promise<void> {
	let vm: ScriptVm;
	try {
		vm = await (prepared ?? boot());
	} catch (error) {
		prepared = undefined;
		post({ type: "crash", id: message.id, reason: `the VM failed to boot: ${errorMessage(error)}` });
		prepare();
		return;
	}
	prepared = undefined;
	current = { id: message.id, vm };
	vm.start(
		{
			code: message.code,
			bindings: message.bindings,
			computeBudgetMs: message.computeBudgetMs,
			maxReportedRejections: message.maxReportedRejections,
			maxArgumentBytes: message.maxArgumentBytes,
			stored: message.stored,
		},
		(vmMessage) => forward(message.id, vmMessage),
	);
	afterTurn();
}

function handle(message: HostToWorkerMessage): Promise<void> | undefined {
	switch (message.type) {
		case "start":
			return start(message);
		case "result":
			if (current?.id === message.id) {
				current.vm.settle(message.seq, message.ok, message.payload, message.imageRefs);
				afterTurn();
			}
			return undefined;
		case "stop":
			if (current?.id === message.id) {
				current.vm.stop();
				afterTurn();
			}
			return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Messages are handled in order; only `start` waits, for the prepared VM.
let queue: Promise<void> = Promise.resolve();
port.on("message", (message: HostToWorkerMessage) => {
	queue = queue
		.then(() => handle(message))
		.catch((error: unknown) => {
			post({ type: "crash", id: current?.id ?? 0, reason: `worker failure: ${errorMessage(error)}` });
		});
});

prepare();
prepared
	?.then((vm) => post({ type: "ready", protocol: CODE_MODE_PROTOCOL_VERSION, engine: vm.engineVersion }))
	.catch((error: unknown) => post({ type: "crash", id: 0, reason: `the VM failed to boot: ${errorMessage(error)}` }));

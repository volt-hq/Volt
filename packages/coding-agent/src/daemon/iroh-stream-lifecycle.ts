import type { IrohBiStreamLike, IrohBytes } from "../core/rpc/iroh-transport.ts";

export type IrohPhysicalTaskObserver = (task: Promise<unknown>) => void;

/** Raised only at the application/native boundary when stream ownership closes. */
export class IrohStreamLifecycleClosedError extends Error {
	readonly code = "ERR_IROH_STREAM_LIFECYCLE_CLOSED";

	constructor() {
		super("Iroh stream lifecycle closed");
		this.name = "IrohStreamLifecycleClosedError";
	}
}

export function isIrohStreamLifecycleClosedError(error: unknown): error is IrohStreamLifecycleClosedError {
	return error instanceof IrohStreamLifecycleClosedError;
}

export function runLifecycleFencedPhysicalOperation<T>(
	operation: () => Promise<T> | T,
	signal: AbortSignal,
	observePhysicalTask: IrohPhysicalTaskObserver,
): Promise<T> {
	if (signal.aborted) {
		return Promise.reject(new IrohStreamLifecycleClosedError());
	}
	let physicalTask: Promise<T>;
	try {
		physicalTask = Promise.resolve(operation());
	} catch (error) {
		return Promise.reject(error);
	}
	void physicalTask.catch(() => {});
	observePhysicalTask(physicalTask);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => reject(new IrohStreamLifecycleClosedError()));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		physicalTask.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

/**
 * Keep native I/O settlement separate from application settlement.
 *
 * Every raw operation remains observed by `observePhysicalTask`, while callers
 * stop awaiting it as soon as the stream owner closes. This lets application
 * finalizers drain deterministically before daemon state is disposed without
 * letting an uncooperative native read/write/reset/stop bypass the daemon's
 * bounded physical-disposal deadline.
 */
export function createLifecycleFencedIrohStream(
	stream: IrohBiStreamLike,
	signal: AbortSignal,
	observePhysicalTask: IrohPhysicalTaskObserver,
): IrohBiStreamLike {
	const run = <T>(operation: () => Promise<T> | T): Promise<T> =>
		runLifecycleFencedPhysicalOperation(operation, signal, observePhysicalTask);

	return {
		recv: {
			read: (sizeLimit: number): Promise<IrohBytes | null | undefined> => run(() => stream.recv.read(sizeLimit)),
			...(stream.recv.stop === undefined
				? {}
				: { stop: (errorCode: bigint): Promise<void> => run(() => stream.recv.stop?.(errorCode)) }),
		},
		send: {
			writeAll: (bytes: Array<number>): Promise<void> => run(() => stream.send.writeAll(bytes)),
			...(stream.send.finish === undefined
				? {}
				: { finish: (): Promise<void> => run(() => stream.send.finish?.()) }),
			...(stream.send.reset === undefined
				? {}
				: { reset: (errorCode: bigint): Promise<void> => run(() => stream.send.reset?.(errorCode)) }),
		},
	};
}

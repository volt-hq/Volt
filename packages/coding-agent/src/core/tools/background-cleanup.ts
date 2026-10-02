import { AsyncLocalStorage } from "node:async_hooks";

const backgroundCleanupContext = new AsyncLocalStorage<boolean>();

/** Native background execution must join cleanup that foreground cancellation may leave pending. */
export function withBackgroundCleanup<T>(execute: () => Promise<T>): Promise<T> {
	return backgroundCleanupContext.run(true, execute);
}

class BackgroundCleanupReceipt {
	private readonly pending = new Set<Promise<void>>();

	track<T>(work: Promise<T>): Promise<T> {
		// Observe both outcomes without changing the caller's result/error precedence.
		const settled = work.then(
			() => {
				this.pending.delete(settled);
			},
			() => {
				this.pending.delete(settled);
			},
		);
		this.pending.add(settled);
		return work;
	}

	async join(): Promise<void> {
		// A late start or a task's finally may register more cleanup while we wait.
		while (this.pending.size > 0) await Promise.all(this.pending);
	}
}

/** Each invocation owns its receipt; joining an ancestor's receipt would deadlock nested delegation. */
export function createBackgroundCleanupReceipt(): BackgroundCleanupReceipt | undefined {
	return backgroundCleanupContext.getStore() ? new BackgroundCleanupReceipt() : undefined;
}

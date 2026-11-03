import { AsyncLocalStorage } from "node:async_hooks";

/** Where an execution runs: only a background execution's end waits for the cleanup it left pending. */
interface CleanupScope {
	background: boolean;
}

const backgroundCleanupContext = new AsyncLocalStorage<CleanupScope>();

/** Native background execution must join cleanup that foreground cancellation may leave pending. */
export function withBackgroundCleanup<T>(execute: () => Promise<T>): Promise<T> {
	return backgroundCleanupContext.run({ background: true }, execute);
}

/**
 * A foreground execution that may move to the background while it runs. It
 * keeps fast foreground cancellation until `moveToBackground`; from then on,
 * its end joins pending cleanup as a background execution's does.
 */
export function withMovableCleanup<T>(execute: () => Promise<T>): { result: Promise<T>; moveToBackground(): void } {
	const scope: CleanupScope = { background: false };
	return {
		result: backgroundCleanupContext.run(scope, execute),
		moveToBackground: () => {
			scope.background = true;
		},
	};
}

class BackgroundCleanupReceipt {
	private readonly scope: CleanupScope;
	private readonly pending = new Set<Promise<void>>();

	constructor(scope: CleanupScope) {
		this.scope = scope;
	}

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
		// A foreground execution returns at once; its cleanup still runs.
		if (!this.scope.background) return;
		// A late start or a task's finally may register more cleanup while we wait.
		while (this.pending.size > 0) await Promise.all(this.pending);
	}
}

/** Each invocation owns its receipt; joining an ancestor's receipt would deadlock nested delegation. */
export function createBackgroundCleanupReceipt(): BackgroundCleanupReceipt | undefined {
	const scope = backgroundCleanupContext.getStore();
	return scope ? new BackgroundCleanupReceipt(scope) : undefined;
}

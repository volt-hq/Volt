export const DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS = 30 * 60 * 1000;

/** Delay before re-checking a runtime whose idle wait settled or failed while it stayed active. */
const ACTIVE_RECHECK_DELAY_MS = 1000;

export interface DetachedRuntimeRetentionHandle {
	cancel(): void;
}

export interface DetachedRuntimeRetentionOptions {
	clearTimeoutFn?: typeof clearTimeout;
	isActive(): boolean;
	isDetached(): boolean;
	onError?: (error: unknown) => void;
	onExpire(): Promise<void> | void;
	setTimeoutFn?: typeof setTimeout;
	ttlMs: number;
	waitForIdle(): Promise<void>;
}

export function parseIntegratedDetachedRuntimeTtlMs(value: string | undefined): number {
	if (value === undefined) {
		return DEFAULT_INTEGRATED_DETACHED_RUNTIME_TTL_MS;
	}
	const ttlMs = Number(value);
	if (!Number.isFinite(ttlMs) || ttlMs < 0) {
		throw new Error("--detached-runtime-ttl-ms must be a non-negative finite number");
	}
	return Math.floor(ttlMs);
}

export function scheduleDetachedRuntimeRetention(
	options: DetachedRuntimeRetentionOptions,
): DetachedRuntimeRetentionHandle {
	const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
	let cancelled = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const sleep = (delayMs: number): Promise<void> =>
		new Promise((resolve) => {
			timer = setTimeoutFn(() => {
				timer = undefined;
				resolve();
			}, delayMs);
		});

	const run = async (): Promise<void> => {
		while (!cancelled) {
			if (!options.isDetached()) {
				return;
			}
			if (options.isActive()) {
				try {
					await options.waitForIdle();
				} catch {
					// Re-check state after failed idle waits; prompt failure should not
					// turn active detached cleanup into immediate cancellation.
				}
				// Re-checking at once after a wait that failed or settled early would spin
				// in microtasks and starve the event loop the active work needs to finish.
				if (!cancelled && options.isActive()) await sleep(ACTIVE_RECHECK_DELAY_MS);
				continue;
			}

			await sleep(options.ttlMs);
			if (cancelled || !options.isDetached()) {
				return;
			}
			if (options.isActive()) {
				continue;
			}
			await options.onExpire();
			return;
		}
	};

	void run().catch((error: unknown) => {
		options.onError?.(error);
	});

	return {
		cancel() {
			cancelled = true;
			if (timer) {
				clearTimeoutFn(timer);
				timer = undefined;
			}
		},
	};
}

export const STREAMING_RENDER_INTERVAL_MS = 80;

export function isCoalescableAssistantUpdate(eventType: string | undefined): boolean {
	return eventType === "text_delta" || eventType === "thinking_delta";
}

export interface StreamingRenderScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultScheduler: StreamingRenderScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Limits high-frequency streaming updates with leading and trailing commits.
 * Semantic boundaries can bypass the cooldown with commitNow().
 */
export class StreamingRenderCoalescer<T> {
	private pending: T | undefined;
	private hasPending = false;
	private timer: unknown;
	private coolingDown = false;
	private disposed = false;
	private readonly commit: (value: T) => void;
	private readonly intervalMs: number;
	private readonly scheduler: StreamingRenderScheduler;

	constructor(
		commit: (value: T) => void,
		intervalMs = STREAMING_RENDER_INTERVAL_MS,
		scheduler: StreamingRenderScheduler = defaultScheduler,
	) {
		this.commit = commit;
		this.intervalMs = intervalMs;
		this.scheduler = scheduler;
	}

	update(value: T): void {
		if (this.disposed) return;
		if (!this.coolingDown) {
			this.commit(value);
			this.coolingDown = true;
			this.scheduleCooldown();
			return;
		}
		this.pending = value;
		this.hasPending = true;
	}

	commitNow(value: T): void {
		if (this.disposed) return;
		this.cancelTimer();
		this.pending = undefined;
		this.hasPending = false;
		this.coolingDown = false;
		this.commit(value);
	}

	flush(): void {
		if (this.disposed) return;
		this.cancelTimer();
		this.coolingDown = false;
		if (this.hasPending) {
			const pending = this.pending as T;
			this.pending = undefined;
			this.hasPending = false;
			this.commit(pending);
		}
	}

	finish(value: T): void {
		if (this.disposed) return;
		this.commitNow(value);
		this.disposed = true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.pending = undefined;
		this.hasPending = false;
		this.coolingDown = false;
		this.cancelTimer();
	}

	private scheduleCooldown(): void {
		this.timer = this.scheduler.setTimeout(() => {
			this.timer = undefined;
			if (this.disposed) return;
			if (!this.hasPending) {
				this.coolingDown = false;
				return;
			}
			const pending = this.pending as T;
			this.pending = undefined;
			this.hasPending = false;
			this.commit(pending);
			this.scheduleCooldown();
		}, this.intervalMs);
	}

	private cancelTimer(): void {
		if (this.timer === undefined) return;
		this.scheduler.clearTimeout(this.timer);
		this.timer = undefined;
	}
}

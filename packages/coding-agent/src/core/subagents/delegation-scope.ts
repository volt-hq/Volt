import { randomUUID } from "node:crypto";

export interface SubagentDelegationScopeSnapshot {
	id: string;
	startedAt: number;
	startsUsed: number;
	activeDescendants: number;
	peakActiveDescendants: number;
	maxDepthReached: number;
	turnsUsed: number;
	tokensUsed: number;
	costUsd: number;
	aborted: boolean;
}

export interface SubagentDelegationReservation {
	commit(subagentId: string, abort: () => void): void;
	release(): void;
	rollback(): void;
}

export interface SubagentDelegationScopeOptions {
	signal?: AbortSignal;
}

/** Shared, root-owned accounting and cancellation scope for one recursive delegation tree. */
export class SubagentDelegationScope {
	readonly id: string;
	readonly startedAt: number;
	readonly signal: AbortSignal;

	private readonly controller = new AbortController();
	private readonly activeAborters = new Map<string, () => void>();
	private readonly externalSignal: AbortSignal | undefined;
	private readonly onExternalAbort: (() => void) | undefined;
	private startsUsed = 0;
	private activeDescendants = 0;
	private peakActiveDescendants = 0;
	private maxDepthReached = 0;
	private turnsUsed = 0;
	private tokensUsed = 0;
	private costUsd = 0;
	private disposed = false;

	constructor(options: SubagentDelegationScopeOptions = {}) {
		this.id = `sat_${randomUUID()}`;
		this.startedAt = Date.now();
		this.signal = this.controller.signal;
		this.externalSignal = options.signal;
		this.onExternalAbort = options.signal
			? () => this.abort(options.signal?.reason ?? new Error("Operation aborted"))
			: undefined;
		if (this.externalSignal?.aborted) {
			this.abort(this.externalSignal.reason ?? new Error("Operation aborted"));
		} else if (this.externalSignal && this.onExternalAbort) {
			this.externalSignal.addEventListener("abort", this.onExternalAbort, { once: true });
		}
	}

	reserve(agentName: string, depth: number): SubagentDelegationReservation {
		if (this.disposed) {
			throw new Error(`Cannot delegate to "${agentName}": delegation scope ${this.id} is disposed.`);
		}
		if (this.signal.aborted) {
			throw this.abortReason();
		}

		this.startsUsed += 1;
		this.activeDescendants += 1;
		this.peakActiveDescendants = Math.max(this.peakActiveDescendants, this.activeDescendants);
		this.maxDepthReached = Math.max(this.maxDepthReached, depth);
		let committed = false;
		let released = false;
		let subagentId: string | undefined;

		const release = (): void => {
			if (released) return;
			released = true;
			this.activeDescendants = Math.max(0, this.activeDescendants - 1);
			if (subagentId) {
				this.activeAborters.delete(subagentId);
			}
		};

		return {
			commit: (id, abort) => {
				if (committed || released) return;
				committed = true;
				subagentId = id;
				if (this.signal.aborted) {
					abort();
					return;
				}
				this.activeAborters.set(id, abort);
			},
			release,
			rollback: () => {
				if (committed || released) return;
				this.startsUsed = Math.max(0, this.startsUsed - 1);
				release();
			},
		};
	}

	abort(reason: unknown = new Error("Subagent delegation aborted")): void {
		if (!this.signal.aborted) {
			this.controller.abort(reason);
		}
		for (const abort of this.activeAborters.values()) {
			try {
				abort();
			} catch {
				// One broken child aborter must not prevent cancellation of siblings.
			}
		}
	}

	recordTurn(): void {
		if (this.signal.aborted || this.disposed) return;
		this.turnsUsed += 1;
	}

	recordUsage(tokens: number, costUsd: number): void {
		if (this.signal.aborted || this.disposed) return;
		if (Number.isFinite(tokens) && tokens > 0) this.tokensUsed += tokens;
		if (Number.isFinite(costUsd) && costUsd > 0) this.costUsd += costUsd;
	}

	snapshot(): SubagentDelegationScopeSnapshot {
		return {
			id: this.id,
			startedAt: this.startedAt,
			startsUsed: this.startsUsed,
			activeDescendants: this.activeDescendants,
			peakActiveDescendants: this.peakActiveDescendants,
			maxDepthReached: this.maxDepthReached,
			turnsUsed: this.turnsUsed,
			tokensUsed: this.tokensUsed,
			costUsd: this.costUsd,
			aborted: this.signal.aborted,
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.externalSignal && this.onExternalAbort) {
			this.externalSignal.removeEventListener("abort", this.onExternalAbort);
		}
		if (this.activeAborters.size > 0) {
			this.abort(new Error("Subagent delegation scope disposed"));
		}
		this.activeAborters.clear();
	}

	private abortReason(): Error {
		return this.signal.reason instanceof Error ? this.signal.reason : new Error(String(this.signal.reason));
	}
}

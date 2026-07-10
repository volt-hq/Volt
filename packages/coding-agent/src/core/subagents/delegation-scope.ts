import { randomUUID } from "node:crypto";

export const DEFAULT_SUBAGENT_MAX_DEPTH = 4;
export const DEFAULT_SUBAGENT_MAX_TOTAL_STARTS = 64;
export const DEFAULT_SUBAGENT_MAX_ACTIVE_DESCENDANTS = 16;
export const DEFAULT_SUBAGENT_MAX_TOTAL_TURNS = 200;
export const DEFAULT_SUBAGENT_MAX_TOTAL_TOKENS = 1_000_000;
export const DEFAULT_SUBAGENT_MAX_COST_USD = 25;
export const DEFAULT_SUBAGENT_RUN_TIMEOUT_MS = 15 * 60 * 1_000;

export interface SubagentDelegationLimits {
	maxDepth: number;
	maxTotalStarts: number;
	maxActiveDescendants: number;
	maxTotalTurns: number;
	maxTotalTokens: number;
	maxCostUsd: number;
	timeoutMs: number;
}

export interface SubagentDelegationScopeSnapshot {
	id: string;
	startedAt: number;
	deadlineAt: number;
	startsUsed: number;
	activeDescendants: number;
	peakActiveDescendants: number;
	maxDepthReached: number;
	turnsUsed: number;
	tokensUsed: number;
	costUsd: number;
	limits: SubagentDelegationLimits;
	aborted: boolean;
}

export interface SubagentDelegationReservation {
	commit(subagentId: string, abort: () => void): void;
	release(): void;
	rollback(): void;
}

export interface SubagentDelegationScopeOptions {
	limits?: Partial<SubagentDelegationLimits>;
	signal?: AbortSignal;
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved <= 0) {
		throw new Error(`${field} must be a positive integer`);
	}
	return resolved;
}

function positiveNumber(value: number | undefined, fallback: number, field: string): number {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved <= 0) {
		throw new Error(`${field} must be a positive number`);
	}
	return resolved;
}

/** Shared, root-owned resource budget for one recursive delegation tree. */
export class SubagentDelegationScope {
	readonly id: string;
	readonly startedAt: number;
	readonly deadlineAt: number;
	readonly limits: SubagentDelegationLimits;
	readonly signal: AbortSignal;

	private readonly controller = new AbortController();
	private readonly activeAborters = new Map<string, () => void>();
	private readonly externalSignal: AbortSignal | undefined;
	private readonly onExternalAbort: (() => void) | undefined;
	private readonly deadlineTimer: ReturnType<typeof setTimeout>;
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
		this.limits = {
			maxDepth: Math.min(
				positiveInteger(options.limits?.maxDepth, DEFAULT_SUBAGENT_MAX_DEPTH, "maxDepth"),
				DEFAULT_SUBAGENT_MAX_DEPTH,
			),
			maxTotalStarts: Math.min(
				positiveInteger(options.limits?.maxTotalStarts, DEFAULT_SUBAGENT_MAX_TOTAL_STARTS, "maxTotalStarts"),
				DEFAULT_SUBAGENT_MAX_TOTAL_STARTS,
			),
			maxActiveDescendants: Math.min(
				positiveInteger(
					options.limits?.maxActiveDescendants,
					DEFAULT_SUBAGENT_MAX_ACTIVE_DESCENDANTS,
					"maxActiveDescendants",
				),
				DEFAULT_SUBAGENT_MAX_ACTIVE_DESCENDANTS,
			),
			maxTotalTurns: Math.min(
				positiveInteger(options.limits?.maxTotalTurns, DEFAULT_SUBAGENT_MAX_TOTAL_TURNS, "maxTotalTurns"),
				DEFAULT_SUBAGENT_MAX_TOTAL_TURNS,
			),
			maxTotalTokens: Math.min(
				positiveInteger(options.limits?.maxTotalTokens, DEFAULT_SUBAGENT_MAX_TOTAL_TOKENS, "maxTotalTokens"),
				DEFAULT_SUBAGENT_MAX_TOTAL_TOKENS,
			),
			maxCostUsd: Math.min(
				positiveNumber(options.limits?.maxCostUsd, DEFAULT_SUBAGENT_MAX_COST_USD, "maxCostUsd"),
				DEFAULT_SUBAGENT_MAX_COST_USD,
			),
			timeoutMs: Math.min(
				positiveInteger(options.limits?.timeoutMs, DEFAULT_SUBAGENT_RUN_TIMEOUT_MS, "timeoutMs"),
				DEFAULT_SUBAGENT_RUN_TIMEOUT_MS,
			),
		};
		this.deadlineAt = this.startedAt + this.limits.timeoutMs;
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
		this.deadlineTimer = setTimeout(() => {
			this.abort(new Error(`Subagent delegation timed out after ${this.limits.timeoutMs}ms`));
		}, this.limits.timeoutMs);
		this.deadlineTimer.unref?.();
	}

	reserve(agentName: string, depth: number): SubagentDelegationReservation {
		if (this.disposed) {
			throw new Error(`Cannot delegate to "${agentName}": delegation scope ${this.id} is disposed.`);
		}
		if (Date.now() >= this.deadlineAt && !this.signal.aborted) {
			this.abort(new Error(`Subagent delegation timed out after ${this.limits.timeoutMs}ms`));
		}
		if (this.signal.aborted) {
			throw this.abortReason();
		}
		if (depth > this.limits.maxDepth) {
			throw new Error(
				`Cannot delegate to "${agentName}": tree max depth ${this.limits.maxDepth} would be exceeded at depth ${depth}.`,
			);
		}
		if (this.startsUsed >= this.limits.maxTotalStarts) {
			throw new Error(
				`Cannot delegate to "${agentName}": tree start limit ${this.limits.maxTotalStarts} has been reached.`,
			);
		}
		if (this.activeDescendants >= this.limits.maxActiveDescendants) {
			throw new Error(
				`Cannot delegate to "${agentName}": tree concurrency limit ${this.limits.maxActiveDescendants} has been reached.`,
			);
		}
		if (this.turnsUsed >= this.limits.maxTotalTurns) {
			throw new Error(`Cannot delegate to "${agentName}": tree turn limit ${this.limits.maxTotalTurns} reached.`);
		}
		if (this.tokensUsed >= this.limits.maxTotalTokens) {
			throw new Error(`Cannot delegate to "${agentName}": tree token limit ${this.limits.maxTotalTokens} reached.`);
		}
		if (this.costUsd >= this.limits.maxCostUsd) {
			throw new Error(`Cannot delegate to "${agentName}": tree cost limit $${this.limits.maxCostUsd} reached.`);
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
		if (this.turnsUsed >= this.limits.maxTotalTurns) {
			this.abort(new Error(`Subagent delegation exceeded the tree turn limit ${this.limits.maxTotalTurns}`));
		}
	}

	recordUsage(tokens: number, costUsd: number): void {
		if (this.signal.aborted || this.disposed) return;
		if (Number.isFinite(tokens) && tokens > 0) this.tokensUsed += tokens;
		if (Number.isFinite(costUsd) && costUsd > 0) this.costUsd += costUsd;
		if (this.tokensUsed >= this.limits.maxTotalTokens) {
			this.abort(new Error(`Subagent delegation exceeded the tree token limit ${this.limits.maxTotalTokens}`));
			return;
		}
		if (this.costUsd >= this.limits.maxCostUsd) {
			this.abort(new Error(`Subagent delegation exceeded the tree cost limit $${this.limits.maxCostUsd}`));
		}
	}

	snapshot(): SubagentDelegationScopeSnapshot {
		return {
			id: this.id,
			startedAt: this.startedAt,
			deadlineAt: this.deadlineAt,
			startsUsed: this.startsUsed,
			activeDescendants: this.activeDescendants,
			peakActiveDescendants: this.peakActiveDescendants,
			maxDepthReached: this.maxDepthReached,
			turnsUsed: this.turnsUsed,
			tokensUsed: this.tokensUsed,
			costUsd: this.costUsd,
			limits: { ...this.limits },
			aborted: this.signal.aborted,
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearTimeout(this.deadlineTimer);
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

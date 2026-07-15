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

/**
 * Hard tree-wide ceilings shared by every descendant of one delegation scope.
 * Each limit accepts `Number.POSITIVE_INFINITY` as an explicit unlimited opt-in.
 */
export interface SubagentDelegationScopeLimits {
	/** Deepest delegation depth a descendant may start at; root children start at depth 1. */
	maxDepth?: number;
	/** Total child runtimes the whole tree may start over its lifetime. */
	maxStarts?: number;
	/** Concurrently active descendant runtimes across the whole tree. */
	maxActiveDescendants?: number;
	/** Total assistant turns consumed across all descendants before the tree aborts. */
	maxTurns?: number;
	/** Total tokens consumed across all descendants before the tree aborts. */
	maxTotalTokens?: number;
	/** Total provider cost in USD consumed across all descendants before the tree aborts. */
	maxTotalCostUsd?: number;
	/** Wall-clock lifetime of the tree before it aborts. Unlimited by default. */
	maxDurationMs?: number;
}

export const DEFAULT_SUBAGENT_DELEGATION_LIMITS: Required<SubagentDelegationScopeLimits> = {
	maxDepth: 5,
	maxStarts: 100,
	maxActiveDescendants: 16,
	maxTurns: 1_000,
	maxTotalTokens: 50_000_000,
	maxTotalCostUsd: 100,
	maxDurationMs: Number.POSITIVE_INFINITY,
};

export interface SubagentDelegationReservation {
	commit(subagentId: string, abort: () => void): void;
	release(): void;
	rollback(): void;
}

export interface SubagentDelegationScopeOptions {
	signal?: AbortSignal;
	/** Ceiling overrides; omitted limits use DEFAULT_SUBAGENT_DELEGATION_LIMITS. */
	limits?: SubagentDelegationScopeLimits;
}

function resolveLimits(overrides: SubagentDelegationScopeLimits | undefined): Required<SubagentDelegationScopeLimits> {
	const limits = { ...DEFAULT_SUBAGENT_DELEGATION_LIMITS, ...overrides };
	for (const [key, value] of Object.entries(limits)) {
		if (Number.isNaN(value) || value <= 0) {
			throw new Error(`Subagent delegation limit ${key} must be a positive number or Infinity`);
		}
	}
	return limits;
}

/**
 * Shared, root-owned accounting and cancellation scope for one recursive
 * delegation tree. Reservations enforce the depth, start, and concurrency
 * ceilings fail-closed; consumption ceilings (turns, tokens, cost, deadline)
 * abort the whole tree once crossed.
 */
export class SubagentDelegationScope {
	readonly id: string;
	readonly startedAt: number;
	readonly signal: AbortSignal;
	readonly limits: Required<SubagentDelegationScopeLimits>;

	private readonly controller = new AbortController();
	private readonly activeAborters = new Map<string, () => void>();
	private readonly externalSignal: AbortSignal | undefined;
	private readonly onExternalAbort: (() => void) | undefined;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
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
		this.limits = resolveLimits(options.limits);
		this.externalSignal = options.signal;
		this.onExternalAbort = options.signal
			? () => this.abort(options.signal?.reason ?? new Error("Operation aborted"))
			: undefined;
		if (this.externalSignal?.aborted) {
			this.abort(this.externalSignal.reason ?? new Error("Operation aborted"));
		} else if (this.externalSignal && this.onExternalAbort) {
			this.externalSignal.addEventListener("abort", this.onExternalAbort, { once: true });
		}
		if (Number.isFinite(this.limits.maxDurationMs) && !this.signal.aborted) {
			this.deadlineTimer = setTimeout(() => {
				this.abort(
					new Error(
						`Subagent delegation tree ${this.id} exceeded its ${this.limits.maxDurationMs}ms deadline (maxDurationMs).`,
					),
				);
			}, this.limits.maxDurationMs);
			this.deadlineTimer.unref?.();
		}
	}

	reserve(agentName: string, depth: number): SubagentDelegationReservation {
		if (this.disposed) {
			throw new Error(`Cannot delegate to "${agentName}": delegation scope ${this.id} is disposed.`);
		}
		if (this.signal.aborted) {
			throw this.abortReason();
		}
		if (depth > this.limits.maxDepth) {
			throw new Error(
				`Cannot delegate to "${agentName}": depth ${depth} exceeds the delegation tree limit of ${this.limits.maxDepth} (maxDepth).`,
			);
		}
		if (this.startsUsed >= this.limits.maxStarts) {
			throw new Error(
				`Cannot delegate to "${agentName}": the delegation tree already started ${this.startsUsed} subagents, the limit of ${this.limits.maxStarts} (maxStarts).`,
			);
		}
		if (this.activeDescendants >= this.limits.maxActiveDescendants) {
			throw new Error(
				`Cannot delegate to "${agentName}": ${this.activeDescendants} descendants are already active, the limit of ${this.limits.maxActiveDescendants} (maxActiveDescendants). Wait for running subagents to finish.`,
			);
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
		if (this.turnsUsed > this.limits.maxTurns) {
			this.abort(
				new Error(
					`Subagent delegation tree ${this.id} exceeded its ${this.limits.maxTurns}-turn budget (maxTurns).`,
				),
			);
		}
	}

	recordUsage(tokens: number, costUsd: number): void {
		if (this.signal.aborted || this.disposed) return;
		if (Number.isFinite(tokens) && tokens > 0) this.tokensUsed += tokens;
		if (Number.isFinite(costUsd) && costUsd > 0) this.costUsd += costUsd;
		if (this.tokensUsed > this.limits.maxTotalTokens) {
			this.abort(
				new Error(
					`Subagent delegation tree ${this.id} exceeded its ${this.limits.maxTotalTokens}-token budget (maxTotalTokens).`,
				),
			);
			return;
		}
		if (this.costUsd > this.limits.maxTotalCostUsd) {
			this.abort(
				new Error(
					`Subagent delegation tree ${this.id} exceeded its $${this.limits.maxTotalCostUsd} cost budget (maxTotalCostUsd).`,
				),
			);
		}
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
		if (this.deadlineTimer) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
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

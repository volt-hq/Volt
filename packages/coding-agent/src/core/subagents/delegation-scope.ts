import { randomUUID } from "node:crypto";
import type { SubagentCapacityLimitSnapshot, SubagentTreeCapacitySnapshot } from "./capacity.ts";
import { resolveSubagentTurnLimits, type SubagentTurnLimits } from "./turn-budget.ts";

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
 * Tree-wide limits shared by every descendant of one delegation scope.
 * Structural limits reject new spawns; finite aggregate consumption budgets
 * abort the admitted tree when crossed. Every limit accepts
 * `Number.POSITIVE_INFINITY`.
 */
export interface SubagentDelegationScopeLimits {
	/** Deepest delegation depth a descendant may start at; root children start at depth 1. */
	maxDepth?: number;
	/** Total child runtimes the whole tree may start over its lifetime. */
	maxStarts?: number;
	/** Concurrently active descendant runtimes across the whole tree. */
	maxActiveDescendants?: number;
	/** Finite total tokens allowed across all descendants before the tree aborts. */
	maxTotalTokens?: number;
	/** Finite total provider cost in USD allowed across all descendants before the tree aborts. */
	maxTotalCostUsd?: number;
	/** Wall-clock lifetime before the tree aborts: at most MAX_SUBAGENT_DURATION_MS, or Infinity. */
	maxDurationMs?: number;
}

/** Largest finite deadline Node's timers accept without overflowing to 1ms. */
export const MAX_SUBAGENT_DURATION_MS = 2_147_483_647;

export const DEFAULT_SUBAGENT_DELEGATION_LIMITS: Required<SubagentDelegationScopeLimits> = {
	maxDepth: 5,
	maxStarts: 100,
	maxActiveDescendants: 16,
	maxTotalTokens: Number.POSITIVE_INFINITY,
	maxTotalCostUsd: Number.POSITIVE_INFINITY,
	maxDurationMs: Number.POSITIVE_INFINITY,
};

export interface SubagentDelegationReservation {
	commit(subagentId: string, abort: () => void): void;
	release(): void;
	rollback(): void;
}

/** Tree permits atomically held for one admitted spawn batch. */
export interface SubagentDelegationBatchReservation {
	reserve(agentName: string): SubagentDelegationReservation;
	release(): void;
}

export interface SubagentDelegationBatchReservationOptions {
	requestedStarts: number;
	peakActiveDescendants: number;
	depth: number;
}

export interface SubagentDelegationScopeOptions {
	signal?: AbortSignal;
	/**
	 * Tree-wide limit overrides; omitted structural limits keep their built-in
	 * safeguards, or the parent's limits within a parent.
	 */
	limits?: SubagentDelegationScopeLimits;
	/** Per-runtime turn limit overrides inherited by every child in this scope, under the same rule. */
	turnLimits?: SubagentTurnLimits;
	/**
	 * The scope this one runs within. Each limit applies at the stricter of the
	 * two: a reservation here also takes the parent's permits, turns and usage
	 * count toward both, and aborting the parent aborts this scope. Aborting
	 * this scope leaves the parent running.
	 */
	parent?: SubagentDelegationScope;
}

function capacityLimitSnapshot(maximum: number, used: number, reserved: number): SubagentCapacityLimitSnapshot {
	return {
		maximum: Number.isFinite(maximum) ? maximum : null,
		used,
		reserved,
		remaining: Number.isFinite(maximum) ? Math.max(0, maximum - used - reserved) : null,
	};
}

function requirePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer`);
	}
}

/** The binding one of two snapshots of the same limit: the one with less remaining. */
function tighterCapacityLimit(
	left: SubagentCapacityLimitSnapshot,
	right: SubagentCapacityLimitSnapshot,
): SubagentCapacityLimitSnapshot {
	if (left.remaining === null) return right;
	if (right.remaining === null) return left;
	return right.remaining < left.remaining ? right : left;
}

function resolveLimits(
	overrides: SubagentDelegationScopeLimits | undefined,
	ceiling: Required<SubagentDelegationScopeLimits> | undefined,
): Required<SubagentDelegationScopeLimits> {
	// Explicitly-undefined overrides use the category-specific defaults instead
	// of bypassing resolution: structural safeguards stay finite while token,
	// cost, and deadline budgets stay unlimited. Within a ceiling, they keep the
	// ceiling's, and given ones apply only where they are stricter.
	const limits: Required<SubagentDelegationScopeLimits> = { ...(ceiling ?? DEFAULT_SUBAGENT_DELEGATION_LIMITS) };
	for (const key of Object.keys(limits) as Array<keyof SubagentDelegationScopeLimits>) {
		const value = overrides?.[key];
		if (value === undefined) {
			continue;
		}
		if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
			throw new Error(`Subagent delegation limit ${key} must be a positive number or Infinity`);
		}
		if (key === "maxDurationMs" && Number.isFinite(value) && value > MAX_SUBAGENT_DURATION_MS) {
			throw new Error(
				`Subagent delegation limit maxDurationMs must be at most ${MAX_SUBAGENT_DURATION_MS}ms or Infinity`,
			);
		}
		limits[key] = ceiling ? Math.min(value, ceiling[key]) : value;
	}
	return limits;
}

/**
 * Shared, root-owned accounting and cancellation scope for one recursive
 * delegation tree. Reservations enforce the default depth, start, and
 * concurrency ceilings without aborting admitted descendants. Aggregate turn
 * accounting remains observable, while opt-in finite token, cost, and deadline
 * budgets abort the whole tree. Turn enforcement is local to each runtime.
 * A scope with a parent bounds one subtree of the parent's tree: its limits
 * tighten the parent's, and the parent's still apply.
 */
export class SubagentDelegationScope {
	readonly id: string;
	readonly startedAt: number;
	readonly signal: AbortSignal;
	readonly limits: Required<SubagentDelegationScopeLimits>;
	readonly turnLimits: Required<SubagentTurnLimits>;

	private readonly parent: SubagentDelegationScope | undefined;
	private readonly controller = new AbortController();
	private readonly activeAborters = new Map<string, () => void>();
	/** The external signals and parent signal this scope aborts with, and its listener on each. */
	private readonly abortSources: Array<{ signal: AbortSignal; listener: () => void }> = [];
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private startsUsed = 0;
	private reservedStarts = 0;
	private activeDescendants = 0;
	private reservedActiveDescendants = 0;
	private peakActiveDescendants = 0;
	private maxDepthReached = 0;
	private readonly reservedBatchDepths = new Map<symbol, number>();
	private readonly batchReleases = new Set<() => void>();
	private turnsUsed = 0;
	private tokensUsed = 0;
	private costUsd = 0;
	private disposed = false;

	constructor(options: SubagentDelegationScopeOptions = {}) {
		this.id = `sat_${randomUUID()}`;
		this.startedAt = Date.now();
		this.signal = this.controller.signal;
		this.parent = options.parent;
		this.limits = resolveLimits(options.limits, options.parent?.limits);
		this.turnLimits = resolveSubagentTurnLimits(options.turnLimits, options.parent?.turnLimits);
		for (const signal of [options.signal, options.parent?.signal]) {
			if (!signal) continue;
			const listener = (): void => this.abort(signal.reason ?? new Error("Operation aborted"));
			if (signal.aborted) {
				listener();
				break;
			}
			signal.addEventListener("abort", listener, { once: true });
			this.abortSources.push({ signal, listener });
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

	/** Whether this scope is `scope` or runs within it. */
	isWithin(scope: SubagentDelegationScope): boolean {
		for (let current: SubagentDelegationScope | undefined = this; current; current = current.parent) {
			if (current === scope) return true;
		}
		return false;
	}

	capacitySnapshot(): SubagentTreeCapacitySnapshot {
		const own = this.ownCapacitySnapshot();
		const parent = this.parent?.capacitySnapshot();
		if (!parent) return own;
		// Depth is absolute and this scope's maxDepth is the stricter one; starts and width bind where less remains.
		return {
			maxStarts: tighterCapacityLimit(own.maxStarts, parent.maxStarts),
			maxActiveDescendants: tighterCapacityLimit(own.maxActiveDescendants, parent.maxActiveDescendants),
			maxDepth: own.maxDepth,
			aborted: own.aborted || parent.aborted,
			disposed: own.disposed || parent.disposed,
		};
	}

	private ownCapacitySnapshot(): SubagentTreeCapacitySnapshot {
		let highestReservedDepth = this.maxDepthReached;
		for (const depth of this.reservedBatchDepths.values()) {
			highestReservedDepth = Math.max(highestReservedDepth, depth);
		}
		return {
			maxStarts: capacityLimitSnapshot(this.limits.maxStarts, this.startsUsed, this.reservedStarts),
			maxActiveDescendants: capacityLimitSnapshot(
				this.limits.maxActiveDescendants,
				this.activeDescendants,
				this.reservedActiveDescendants,
			),
			maxDepth: capacityLimitSnapshot(
				this.limits.maxDepth,
				this.maxDepthReached,
				Math.max(0, highestReservedDepth - this.maxDepthReached),
			),
			aborted: this.signal.aborted,
			disposed: this.disposed,
		};
	}

	reserve(agentName: string, depth: number): SubagentDelegationReservation {
		this.assertAvailable(agentName, depth);
		if (this.startsUsed + this.reservedStarts >= this.limits.maxStarts) {
			throw new Error(
				`Cannot delegate to "${agentName}": the delegation tree already used or reserved ${this.startsUsed + this.reservedStarts} subagent starts, the limit of ${this.limits.maxStarts} (maxStarts).`,
			);
		}
		if (this.activeDescendants + this.reservedActiveDescendants >= this.limits.maxActiveDescendants) {
			throw new Error(
				`Cannot delegate to "${agentName}": ${this.activeDescendants + this.reservedActiveDescendants} descendant slots are already active or reserved, the limit of ${this.limits.maxActiveDescendants} (maxActiveDescendants). Wait for running subagents to finish.`,
			);
		}
		const outer = this.parent?.reserve(agentName, depth);

		this.startsUsed += 1;
		this.activeDescendants += 1;
		this.peakActiveDescendants = Math.max(this.peakActiveDescendants, this.activeDescendants);
		this.maxDepthReached = Math.max(this.maxDepthReached, depth);
		return this.createReservation(undefined, undefined, outer);
	}

	reserveBatch(options: SubagentDelegationBatchReservationOptions): SubagentDelegationBatchReservation {
		requirePositiveSafeInteger(options.requestedStarts, "requestedStarts");
		requirePositiveSafeInteger(options.peakActiveDescendants, "peakActiveDescendants");
		requirePositiveSafeInteger(options.depth, "depth");
		if (options.peakActiveDescendants > options.requestedStarts) {
			throw new Error("peakActiveDescendants cannot exceed requestedStarts");
		}
		this.assertAvailable("subagent batch", options.depth);
		if (this.startsUsed + this.reservedStarts + options.requestedStarts > this.limits.maxStarts) {
			throw new Error(
				`Cannot reserve subagent batch: ${options.requestedStarts} starts exceed the delegation tree's remaining maxStarts capacity.`,
			);
		}
		if (
			this.activeDescendants + this.reservedActiveDescendants + options.peakActiveDescendants >
			this.limits.maxActiveDescendants
		) {
			throw new Error(
				`Cannot reserve subagent batch: peak width ${options.peakActiveDescendants} exceeds the delegation tree's remaining maxActiveDescendants capacity.`,
			);
		}
		const outer = this.parent?.reserveBatch(options);

		const depthKey = Symbol("subagent-batch-depth");
		let remainingStarts = options.requestedStarts;
		let availableActiveDescendants = options.peakActiveDescendants;
		let released = false;
		this.reservedStarts += remainingStarts;
		this.reservedActiveDescendants += availableActiveDescendants;
		this.reservedBatchDepths.set(depthKey, options.depth);

		const release = (): void => {
			if (released) return;
			released = true;
			this.reservedStarts = Math.max(0, this.reservedStarts - remainingStarts);
			this.reservedActiveDescendants = Math.max(0, this.reservedActiveDescendants - availableActiveDescendants);
			remainingStarts = 0;
			availableActiveDescendants = 0;
			this.reservedBatchDepths.delete(depthKey);
			this.signal.removeEventListener("abort", release);
			this.batchReleases.delete(release);
			outer?.release();
		};
		this.signal.addEventListener("abort", release, { once: true });
		this.batchReleases.add(release);

		return {
			reserve: (agentName) => {
				if (released) {
					throw new Error("Cannot start subagent: the admitted batch reservation was released.");
				}
				this.assertAvailable(agentName, options.depth);
				if (remainingStarts <= 0) {
					throw new Error("Cannot start subagent: the admitted batch has no remaining start permits.");
				}
				if (availableActiveDescendants <= 0) {
					throw new Error("Cannot start subagent: the admitted batch has no available active permits.");
				}
				const outerReservation = outer?.reserve(agentName);

				remainingStarts -= 1;
				availableActiveDescendants -= 1;
				this.reservedStarts = Math.max(0, this.reservedStarts - 1);
				this.reservedActiveDescendants = Math.max(0, this.reservedActiveDescendants - 1);
				this.startsUsed += 1;
				this.activeDescendants += 1;
				this.peakActiveDescendants = Math.max(this.peakActiveDescendants, this.activeDescendants);
				this.maxDepthReached = Math.max(this.maxDepthReached, options.depth);

				return this.createReservation(
					() => {
						if (!released && remainingStarts > 0 && !this.signal.aborted && !this.disposed) {
							availableActiveDescendants += 1;
							this.reservedActiveDescendants += 1;
						}
					},
					() => {
						if (!released && !this.signal.aborted && !this.disposed) {
							remainingStarts += 1;
							this.reservedStarts += 1;
						}
					},
					outerReservation,
				);
			},
			release,
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
		this.parent?.recordTurn();
		if (this.signal.aborted || this.disposed) return;
		this.turnsUsed += 1;
	}

	recordUsage(tokens: number, costUsd: number): void {
		this.parent?.recordUsage(tokens, costUsd);
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
		for (const release of Array.from(this.batchReleases)) {
			release();
		}
		if (this.deadlineTimer) {
			clearTimeout(this.deadlineTimer);
			this.deadlineTimer = undefined;
		}
		for (const { signal, listener } of this.abortSources.splice(0)) {
			signal.removeEventListener("abort", listener);
		}
		if (this.activeAborters.size > 0) {
			this.abort(new Error("Subagent delegation scope disposed"));
		}
		this.activeAborters.clear();
	}

	/** A reservation of this scope; `outer`, the parent's reservation of the same start, follows it. */
	private createReservation(
		onActiveReleased: () => void = () => undefined,
		onStartRolledBack: () => void = () => undefined,
		outer?: SubagentDelegationReservation,
	): SubagentDelegationReservation {
		let committed = false;
		let released = false;
		let subagentId: string | undefined;
		const releaseActive = (): void => {
			if (released) return;
			released = true;
			this.activeDescendants = Math.max(0, this.activeDescendants - 1);
			if (subagentId) {
				this.activeAborters.delete(subagentId);
			}
			onActiveReleased();
			outer?.release();
		};
		return {
			commit: (id, abort) => {
				if (committed || released) return;
				committed = true;
				outer?.commit(id, abort);
				subagentId = id;
				if (this.signal.aborted) {
					abort();
					return;
				}
				this.activeAborters.set(id, abort);
			},
			release: releaseActive,
			rollback: () => {
				if (committed || released) return;
				outer?.rollback();
				this.startsUsed = Math.max(0, this.startsUsed - 1);
				onStartRolledBack();
				releaseActive();
			},
		};
	}

	private assertAvailable(agentName: string, depth: number): void {
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
	}

	private abortReason(): Error {
		return this.signal.reason instanceof Error ? this.signal.reason : new Error(String(this.signal.reason));
	}
}

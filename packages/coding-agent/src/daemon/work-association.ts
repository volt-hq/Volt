import { tmpdir } from "node:os";
import {
	githubCliPullRequestDiscoveryProvider,
	githubCliPullRequestStatusProvider,
} from "../core/code-host/github-cli-discovery.ts";
import type {
	CodeHostPullRequestDiscoveryOutcome,
	CodeHostPullRequestDiscoveryProvider,
	CodeHostPullRequestStatusOutcome,
	CodeHostPullRequestStatusProvider,
	CodeHostPullRequestStatusTarget,
} from "../core/code-host/types.ts";
import {
	isActiveWorkPullRequestStatus,
	isSameWorkPullRequestRepository,
	type WorkBindingMutationResult,
	type WorkChangeRecord,
	type WorkDiscoveryApplyOutcome,
	type WorkDiscoveryFence,
	type WorkPullRequestStatusUpdate,
	type WorkStateStore,
	type WorkStateWireContext,
} from "./work-state.ts";

const DEFAULT_BASE_BRANCHES = ["main", "master", "trunk", "develop", "development"] as const;
const DEFAULT_PROVIDER_CONCURRENCY = 2;
const DEFAULT_CACHE_MAX_ENTRIES = 128;
const RESOLVED_TTL_MS = 5 * 60_000;
const NONE_TTL_MS = 60_000;
const AMBIGUOUS_TTL_MS = 60_000;
const UNAVAILABLE_INITIAL_BACKOFF_MS = 30_000;
const UNAVAILABLE_MAX_BACKOFF_MS = 15 * 60_000;
/** Background status poll cadence while any client is (recently) connected. */
const STATUS_ACTIVE_INTERVAL_MS = 60_000;
/** Background status poll cadence with no recent client activity. */
const STATUS_IDLE_INTERVAL_MS = 15 * 60_000;
/** Minimum spacing between poll starts, so triggers cannot multiply provider calls. */
const STATUS_MIN_SPACING_MS = 15_000;
/** How long clients count as active after their last stream opened or closed. */
const CLIENT_ACTIVITY_WINDOW_MS = 3 * 60_000;
/** Slack past the next poll before a successfully refreshed status reads as stale. */
const STATUS_STALE_GRACE_MS = 30_000;
const STATUS_WATCH_LIMIT = 200;

export interface WorkAssociationObservation {
	workspaceName: string;
	workspaceGeneration: number;
	sessionId: string;
	cwd: string;
	commonGitDir: string;
	repositoryDisplayName: string;
	branch: string;
	headOid: string;
	trusted: boolean;
	baseBranches?: readonly string[];
}

export type WorkAssociationRevisionGuard = () => boolean;

interface ActiveObservation {
	readonly key: string;
	readonly cwd: string;
	readonly trusted: boolean;
	readonly fence: WorkDiscoveryFence;
	readonly change: WorkChangeRecord;
	/** The session currently observes the bound change's own repository and branch. */
	readonly onChangeBranch: boolean;
	readonly isCurrentRevision: WorkAssociationRevisionGuard;
}

type StatusPollResult = "succeeded" | "failed" | "idle";

interface CachedDiscovery {
	readonly outcome: CodeHostPullRequestDiscoveryOutcome;
	readonly expiresAt: number;
}

export type WorkAssociationRefreshFailurePhase = "discovery" | "scheduled_refresh" | "status_refresh";

export interface WorkAssociationServiceOptions {
	store: WorkStateStore;
	discoveryProvider?: CodeHostPullRequestDiscoveryProvider;
	/** Batched status refresh for already-associated pull requests. */
	statusProvider?: CodeHostPullRequestStatusProvider;
	/** Neutral working directory for status refresh; never a repository checkout. */
	statusCwd?: string;
	enabled?: boolean;
	isOnline?: () => boolean;
	now?: () => number;
	providerConcurrency?: number;
	cacheMaxEntries?: number;
	onRefreshError?: (phase: WorkAssociationRefreshFailurePhase, error: unknown) => void;
}

function observationKey(workspaceName: string, workspaceGeneration: number, sessionId: string): string {
	return `${workspaceGeneration}\0${workspaceName}\0${sessionId}`;
}

function normalizedBaseBranch(value: string): string {
	return value
		.trim()
		.replace(/^refs\/heads\//, "")
		.replace(/^refs\/remotes\/[^/]+\//, "");
}

export function isConfiguredBaseBranch(branch: string, configured: readonly string[] = []): boolean {
	const candidates = new Set(
		[...DEFAULT_BASE_BRANCHES, ...configured].map(normalizedBaseBranch).filter((value) => value.length > 0),
	);
	return candidates.has(normalizedBaseBranch(branch));
}

function discoveryKey(fence: WorkDiscoveryFence): string {
	return `${fence.repositoryId}\0${fence.branch}\0${fence.headOid}`;
}

function toStoreOutcome(outcome: CodeHostPullRequestDiscoveryOutcome): WorkDiscoveryApplyOutcome {
	if (outcome.state !== "resolved") return { state: outcome.state };
	return {
		state: "resolved",
		pullRequest: {
			provider: outcome.pullRequest.providerId.slice(0, 64),
			repository: {
				host: outcome.pullRequest.repository.host,
				owner: outcome.pullRequest.repository.owner,
				name: outcome.pullRequest.repository.name,
			},
			number: outcome.pullRequest.number,
			title: outcome.pullRequest.title.slice(0, 512),
			status: outcome.pullRequest.status,
			matchedHeadOid: outcome.pullRequest.matchedHeadOid,
		},
	};
}

function isSameResolvedPullRequest(change: WorkChangeRecord, outcome: CodeHostPullRequestDiscoveryOutcome): boolean {
	return (
		change.resolutionState === "resolved" &&
		change.pullRequest !== undefined &&
		outcome.state === "resolved" &&
		change.pullRequest.provider === outcome.pullRequest.providerId &&
		change.pullRequest.number === outcome.pullRequest.number &&
		isSameWorkPullRequestRepository(change.pullRequest.repository, outcome.pullRequest.repository)
	);
}

function isWatchedChange(change: WorkChangeRecord): boolean {
	return (
		change.resolutionState === "resolved" &&
		change.pullRequest !== undefined &&
		isActiveWorkPullRequestStatus(change.pullRequest.status)
	);
}

function backoffMs(failureCount: number): number {
	return Math.min(
		UNAVAILABLE_MAX_BACKOFF_MS,
		UNAVAILABLE_INITIAL_BACKOFF_MS * 2 ** Math.min(Math.max(0, failureCount), 8),
	);
}

function ttlForOutcome(outcome: CodeHostPullRequestDiscoveryOutcome): number {
	switch (outcome.state) {
		case "resolved":
			return RESOLVED_TTL_MS;
		case "none":
			return NONE_TTL_MS;
		case "ambiguous":
			return AMBIGUOUS_TTL_MS;
		case "unavailable":
			return UNAVAILABLE_INITIAL_BACKOFF_MS;
	}
}

export class WorkAssociationService {
	private readonly store: WorkStateStore;
	private readonly discoveryProvider: CodeHostPullRequestDiscoveryProvider;
	private readonly enabled: boolean;
	private readonly isOnline: () => boolean;
	private readonly now: () => number;
	private readonly providerConcurrency: number;
	private readonly cacheMaxEntries: number;
	private readonly onRefreshError: NonNullable<WorkAssociationServiceOptions["onRefreshError"]>;
	private readonly active = new Map<string, ActiveObservation>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly cache = new Map<string, CachedDiscovery>();
	private readonly inFlight = new Map<string, Promise<CodeHostPullRequestDiscoveryOutcome>>();
	private readonly providerWaiters: Array<() => void> = [];
	private readonly abortController = new AbortController();
	private readonly statusProvider: CodeHostPullRequestStatusProvider;
	private readonly statusCwd: string;
	private activeProviderCalls = 0;
	private closed = false;
	private statusStarted = false;
	private statusTimer: NodeJS.Timeout | undefined;
	private statusTimerAt = 0;
	private statusPoll: Promise<void> | undefined;
	private statusFollowUp = false;
	private lastStatusPollStartedAt: number | undefined;
	private statusFailureCount = 0;
	private clientActivityHolds = 0;
	private lastClientActivityAt = Number.NEGATIVE_INFINITY;

	constructor(options: WorkAssociationServiceOptions) {
		this.store = options.store;
		this.discoveryProvider = options.discoveryProvider ?? githubCliPullRequestDiscoveryProvider;
		this.statusProvider = options.statusProvider ?? githubCliPullRequestStatusProvider;
		this.statusCwd = options.statusCwd ?? tmpdir();
		this.enabled = options.enabled !== false;
		this.isOnline = options.isOnline ?? (() => true);
		this.now = options.now ?? (() => Date.now());
		this.providerConcurrency = Math.max(1, Math.floor(options.providerConcurrency ?? DEFAULT_PROVIDER_CONCURRENCY));
		this.cacheMaxEntries = Math.max(1, Math.floor(options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES));
		this.onRefreshError = options.onRefreshError ?? (() => {});
	}

	async observe(
		observation: WorkAssociationObservation,
		isCurrentRevision: WorkAssociationRevisionGuard = () => true,
	): Promise<void> {
		if (this.closed || !isCurrentRevision()) return;
		const now = this.now();
		const binding = await this.store.bindObservation(
			{
				workspaceName: observation.workspaceName,
				workspaceGeneration: observation.workspaceGeneration,
				sessionId: observation.sessionId,
				commonGitDir: observation.commonGitDir,
				repositoryDisplayName: observation.repositoryDisplayName,
				branch: observation.branch,
				headOid: observation.headOid.toLowerCase(),
				baseBranch: isConfiguredBaseBranch(observation.branch, observation.baseBranches),
				now,
			},
			isCurrentRevision,
		);
		if (!binding || this.closed || !isCurrentRevision()) return;
		const key = observationKey(observation.workspaceName, observation.workspaceGeneration, observation.sessionId);
		const previous = this.active.get(key);
		const active: ActiveObservation = {
			key,
			cwd: observation.cwd,
			trusted: observation.trusted,
			fence: binding.fence,
			change: binding.change,
			onChangeBranch: binding.shouldDiscover,
			isCurrentRevision,
		};
		this.active.set(key, active);
		this.clearTimer(key);
		// Leaving a linked PR's branch ends head-branch discovery for it; hand its status to the poller.
		if (previous?.onChangeBranch && !binding.shouldDiscover && isWatchedChange(binding.change)) {
			this.requestStatusPoll();
		}
		if (!binding.shouldDiscover) return;
		if (binding.change.nextRefreshAt > now) {
			this.schedule(active, binding.change.nextRefreshAt);
			return;
		}
		await this.resolve(active);
	}

	async inheritSession(
		workspaceName: string,
		workspaceGeneration: number,
		sourceSessionId: string,
		targetSessionId: string,
	): Promise<boolean> {
		if (this.closed) return false;
		return this.store.inheritSessionBinding({
			workspaceName,
			workspaceGeneration,
			sourceSessionId,
			targetSessionId,
			now: this.now(),
		});
	}

	retireSession(workspaceName: string, workspaceGeneration: number, sessionId: string): Promise<void> {
		const key = observationKey(workspaceName, workspaceGeneration, sessionId);
		const active = this.active.get(key);
		this.active.delete(key);
		this.clearTimer(key);
		if (active) {
			const change = this.store.getChange(active.fence.changeId);
			if (change && isWatchedChange(change)) this.requestStatusPoll();
		}
		return this.store.flush();
	}

	/**
	 * Start background status refresh for every linked open/draft pull request, independent of
	 * session branch and runtime. Polls immediately, then on the active or idle cadence.
	 */
	start(): void {
		if (this.statusStarted || this.closed || !this.enabled) return;
		this.statusStarted = true;
		this.requestStatusPoll();
	}

	/**
	 * Mark a client stream as open. Clients count as active while any hold is retained and for a
	 * short window after the last retain or release; becoming active requests a catch-up poll.
	 */
	retainClientActivity(): () => void {
		const wasActive = this.isClientActive();
		this.clientActivityHolds++;
		this.lastClientActivityAt = this.now();
		if (!wasActive) this.requestStatusPoll();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.clientActivityHolds = Math.max(0, this.clientActivityHolds - 1);
			this.lastClientActivityAt = this.now();
		};
	}

	retireWorkspace(workspaceName: string, workspaceGeneration?: number): Promise<void> {
		for (const [key, active] of this.active) {
			if (
				active.fence.workspaceName === workspaceName &&
				(workspaceGeneration === undefined || active.fence.workspaceGeneration === workspaceGeneration)
			) {
				this.active.delete(key);
				this.clearTimer(key);
			}
		}
		return this.store.flush();
	}

	getWorkContext(
		workspaceName: string,
		workspaceGeneration: number,
		sessionId: string,
	): WorkStateWireContext | undefined {
		return this.store.getWorkContext(workspaceName, workspaceGeneration, sessionId, this.now());
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.abortController.abort(new Error("Work association service closed"));
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.clearStatusTimer();
		this.active.clear();
		while (this.providerWaiters.length > 0) this.providerWaiters.shift()?.();
		await Promise.allSettled([...this.inFlight.values(), ...(this.statusPoll ? [this.statusPoll] : [])]);
		await this.store.close();
	}

	private isClientActive(): boolean {
		return this.clientActivityHolds > 0 || this.now() - this.lastClientActivityAt < CLIENT_ACTIVITY_WINDOW_MS;
	}

	private statusInterval(): number {
		return this.isClientActive() ? STATUS_ACTIVE_INTERVAL_MS : STATUS_IDLE_INTERVAL_MS;
	}

	/** Poll as soon as spacing allows; coalesces with an in-flight or earlier scheduled poll. */
	private requestStatusPoll(): void {
		if (!this.statusStarted || this.closed) return;
		if (this.statusPoll) {
			this.statusFollowUp = true;
			return;
		}
		const now = this.now();
		this.scheduleStatusPoll(
			this.lastStatusPollStartedAt === undefined
				? now
				: Math.max(now, this.lastStatusPollStartedAt + STATUS_MIN_SPACING_MS),
		);
	}

	/** Arm the single poll timer for `dueAt`, keeping an already earlier timer. */
	private scheduleStatusPoll(dueAt: number): void {
		if (!this.statusStarted || this.closed) return;
		if (this.statusTimer && this.statusTimerAt <= dueAt) return;
		this.clearStatusTimer();
		const delay = dueAt - this.now();
		if (delay <= 0) {
			this.runStatusPoll();
			return;
		}
		this.statusTimerAt = dueAt;
		const timer = setTimeout(
			() => {
				if (this.statusTimer !== timer) return;
				this.statusTimer = undefined;
				this.runStatusPoll();
			},
			Math.min(2_147_483_647, delay),
		);
		timer.unref?.();
		this.statusTimer = timer;
	}

	private clearStatusTimer(): void {
		if (this.statusTimer) clearTimeout(this.statusTimer);
		this.statusTimer = undefined;
	}

	private runStatusPoll(): void {
		if (!this.statusStarted || this.closed) return;
		if (this.statusPoll) {
			this.statusFollowUp = true;
			return;
		}
		this.clearStatusTimer();
		this.statusFollowUp = false;
		const startedAt = this.now();
		this.lastStatusPollStartedAt = startedAt;
		this.statusPoll = this.pollStatuses()
			.catch((error: unknown): StatusPollResult => {
				this.reportRefreshError("status_refresh", error);
				return "failed";
			})
			.then((result) => {
				this.statusPoll = undefined;
				if (this.closed) return;
				if (result === "succeeded") this.statusFailureCount = 0;
				else if (result === "failed") this.statusFailureCount++;
				const interval = this.statusInterval();
				const regularAt =
					startedAt + (result === "failed" ? Math.max(interval, backoffMs(this.statusFailureCount)) : interval);
				const followUpAt = this.statusFollowUp ? startedAt + STATUS_MIN_SPACING_MS : Number.POSITIVE_INFINITY;
				this.statusFollowUp = false;
				this.scheduleStatusPoll(Math.min(regularAt, followUpAt));
			});
	}

	/** Refresh every watched pull request with one batched provider call per host. */
	private async pollStatuses(): Promise<StatusPollResult> {
		const watched = this.store
			.listWatchedPullRequests(STATUS_WATCH_LIMIT)
			.filter((entry) => entry.provider === this.statusProvider.id);
		if (watched.length === 0) return "idle";
		const targetKey = (entry: (typeof watched)[number]): string =>
			`${entry.repository.owner}\0${entry.repository.name}\0${entry.number}`;
		const targetsByHost = new Map<string, Map<string, CodeHostPullRequestStatusTarget>>();
		for (const entry of watched) {
			let targets = targetsByHost.get(entry.repository.host);
			if (!targets) {
				targets = new Map();
				targetsByHost.set(entry.repository.host, targets);
			}
			targets.set(targetKey(entry), {
				owner: entry.repository.owner,
				name: entry.repository.name,
				number: entry.number,
			});
		}
		const outcomes = new Map<string, CodeHostPullRequestStatusOutcome>();
		for (const [host, targets] of targetsByHost) {
			const keys = [...targets.keys()];
			let hostOutcomes: CodeHostPullRequestStatusOutcome[];
			if (!this.isOnline()) {
				hostOutcomes = keys.map(() => ({ state: "unavailable", reason: "network" }));
			} else {
				try {
					hostOutcomes = await this.statusProvider.refreshPullRequestStatuses({
						cwd: this.statusCwd,
						host,
						pullRequests: [...targets.values()],
						signal: this.abortController.signal,
					});
				} catch (error) {
					if (this.closed) return "idle";
					this.reportRefreshError("status_refresh", error);
					hostOutcomes = keys.map(() => ({ state: "unavailable", reason: "provider_error" }));
				}
			}
			if (this.closed) return "idle";
			keys.forEach((key, index) => {
				outcomes.set(
					`${host}\0${key}`,
					hostOutcomes[index] ?? { state: "unavailable", reason: "invalid_response" },
				);
			});
		}
		const updates: WorkPullRequestStatusUpdate[] = watched.map((entry) => {
			const outcome = outcomes.get(`${entry.repository.host}\0${targetKey(entry)}`);
			return {
				...entry,
				outcome:
					outcome?.state === "resolved"
						? { state: "resolved", status: outcome.status, title: outcome.title }
						: { state: "unavailable" },
			};
		});
		const now = this.now();
		const changed = await this.store.applyPullRequestStatuses(updates, {
			now,
			nextRefreshAt: now + this.statusInterval() + STATUS_STALE_GRACE_MS,
		});
		for (const changeId of changed) this.invalidateCachedDiscovery(changeId);
		return updates.some((update) => update.outcome.state === "resolved") ? "succeeded" : "failed";
	}

	/** Drop cached head-branch discovery for a change so it cannot reapply an older status. */
	private invalidateCachedDiscovery(changeId: string): void {
		const change = this.store.getChange(changeId);
		if (!change) return;
		const prefix = `${change.repositoryId}\0${change.branch}\0`;
		for (const key of [...this.cache.keys()]) {
			if (key.startsWith(prefix)) this.cache.delete(key);
		}
	}

	private isCurrent(active: ActiveObservation): boolean {
		return !this.closed && active.isCurrentRevision() && this.active.get(active.key) === active;
	}

	private async resolve(active: ActiveObservation): Promise<void> {
		if (!this.isCurrent(active)) return;
		let outcome: CodeHostPullRequestDiscoveryOutcome;
		if (!this.enabled || !active.trusted) {
			outcome = { state: "unavailable", reason: "unsupported_repository" };
		} else if (!this.isOnline()) {
			outcome = { state: "unavailable", reason: "network" };
		} else {
			try {
				outcome = await this.discover(active);
			} catch (error) {
				if (!this.isCurrent(active)) return;
				this.reportRefreshError("discovery", error);
				outcome = { state: "unavailable", reason: "provider_error" };
			}
		}
		if (!this.isCurrent(active)) return;
		const latestChange = this.store.getChange(active.fence.changeId);
		if (!latestChange) return;
		const refreshSucceeded =
			latestChange.resolutionState === "resolved"
				? isSameResolvedPullRequest(latestChange, outcome)
				: outcome.state !== "unavailable";
		const nextDelay = refreshSucceeded ? ttlForOutcome(outcome) : backoffMs(latestChange.failureCount);
		const nextRefreshAt = this.now() + nextDelay;
		const applied = await this.store.applyDiscovery(active.fence, toStoreOutcome(outcome), {
			now: this.now(),
			nextRefreshAt,
			refreshSucceeded,
		});
		if (!applied || !this.isCurrent(active)) return;
		const change = this.store.getChange(active.fence.changeId);
		if (!change) return;
		const next: ActiveObservation = { ...active, change };
		this.active.set(active.key, next);
		this.schedule(next, change.nextRefreshAt);
	}

	private async discover(active: ActiveObservation): Promise<CodeHostPullRequestDiscoveryOutcome> {
		const key = discoveryKey(active.fence);
		const cached = this.cache.get(key);
		const now = this.now();
		if (cached && cached.expiresAt > now) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return cached.outcome;
		}
		if (cached) this.cache.delete(key);
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const operation = this.withProviderSlot(async () => {
			if (this.closed) return { state: "unavailable", reason: "cancelled" } as const;
			return this.discoveryProvider.discoverPullRequest({
				cwd: active.cwd,
				branch: active.fence.branch,
				headOid: active.fence.headOid,
				signal: this.abortController.signal,
			});
		});
		this.inFlight.set(key, operation);
		try {
			const outcome = await operation;
			this.cache.set(key, { outcome, expiresAt: this.now() + ttlForOutcome(outcome) });
			while (this.cache.size > this.cacheMaxEntries) {
				const oldest = this.cache.keys().next().value as string | undefined;
				if (oldest === undefined) break;
				this.cache.delete(oldest);
			}
			return outcome;
		} finally {
			if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
		}
	}

	private async withProviderSlot<T>(operation: () => Promise<T>): Promise<T> {
		if (this.activeProviderCalls >= this.providerConcurrency) {
			await new Promise<void>((resolve) => this.providerWaiters.push(resolve));
		}
		if (this.closed) return operation();
		this.activeProviderCalls++;
		try {
			return await operation();
		} finally {
			this.activeProviderCalls--;
			this.providerWaiters.shift()?.();
		}
	}

	private reportRefreshError(phase: WorkAssociationRefreshFailurePhase, error: unknown): void {
		try {
			this.onRefreshError(phase, error);
		} catch {
			// Error reporting must not break refresh supervision.
		}
	}

	private async runScheduledRefresh(active: ActiveObservation): Promise<void> {
		try {
			await this.resolve(active);
		} catch (error) {
			if (!this.isCurrent(active)) return;
			this.reportRefreshError("scheduled_refresh", error);
			const change = this.store.getChange(active.fence.changeId);
			if (!change) return;
			this.schedule(active, this.now() + backoffMs(change.failureCount));
		}
	}

	private schedule(active: ActiveObservation, refreshAt: number): void {
		if (!this.isCurrent(active)) return;
		this.clearTimer(active.key);
		const timer = setTimeout(
			() => {
				this.timers.delete(active.key);
				if (this.isCurrent(active)) void this.runScheduledRefresh(active);
			},
			Math.max(1, Math.min(2_147_483_647, refreshAt - this.now())),
		);
		timer.unref?.();
		this.timers.set(active.key, timer);
	}

	private clearTimer(key: string): void {
		const timer = this.timers.get(key);
		if (timer) clearTimeout(timer);
		this.timers.delete(key);
	}
}

export function createWorkAssociationService(
	store: WorkStateStore,
	options: Omit<WorkAssociationServiceOptions, "store"> = {},
): WorkAssociationService {
	return new WorkAssociationService({ store, ...options });
}

export function workBindingNeedsDiscovery(binding: WorkBindingMutationResult): boolean {
	return binding.shouldDiscover;
}

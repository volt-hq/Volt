/**
 * The session's prompt cache: the documented retention of the active branch's
 * reusable prompt prefix, keepalive refreshes that renew it while the session
 * idles, and the audit of requests and refreshes. Its status is published as
 * `prompt_cache_changed` whenever it changes.
 */

import type {
	AgentTool,
	Conversation,
	ConversationPromptCacheRefreshResult,
	ConversationStreamOptions,
} from "@hansjm10/volt-agent-core";
import { type Api, type AssistantMessage, type Model, resolvePromptCacheRetention } from "@hansjm10/volt-ai";
import type { AgentSessionEvent } from "../agent-session.ts";
import { PromptCacheAudit, promptCacheAuditUsage } from "../prompt-cache-audit.ts";
import {
	PROMPT_CACHE_REFRESH_ENTRY_TYPE,
	PromptCacheKeepAlive,
	type PromptCacheKeepAliveStop,
	type PromptCacheRefreshEntryData,
	type PromptCacheRefreshReason,
	promptCacheRefreshBudget,
} from "../prompt-cache-keepalive.ts";
import {
	applyPromptCacheRefresh,
	type PromptCacheRefreshRecord,
	type PromptCacheStatus,
	promptCacheStatusEquals,
	resolvePromptCacheStatus,
} from "../prompt-cache-status.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SessionWriter } from "../session-writer.ts";
import type { SettingsManager } from "../settings-manager.ts";

export interface SessionPromptCacheHost {
	/** Global config directory the audit writes under. */
	readonly agentDir: string;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	conversation(): Conversation<AgentTool>;
	sessionWriter(): SessionWriter;
	/** The model the active branch names. */
	model(): Model<Api> | undefined;
	/** The retention the session's requests ask for. */
	cacheRetention(): ConversationStreamOptions["cacheRetention"];
	/**
	 * Work that keeps the cache warm is running: an operation the session observed,
	 * a busy conversation, or a background job.
	 */
	hasInFlightWork(): boolean;
	isDisposed(): boolean;
	emit(event: AgentSessionEvent): void;
}

export class SessionPromptCache {
	private readonly host: SessionPromptCacheHost;
	private readonly audit: PromptCacheAudit;
	private readonly keepAlive: PromptCacheKeepAlive;
	private readonly refreshAbort = new AbortController();
	/**
	 * Latest confirmed renewal of the branch request's prefix: a keepalive refresh, or a request the
	 * provider read that is not persisted yet.
	 */
	private renewal: PromptCacheRefreshRecord | undefined;
	/** Audit basis and provisional renewal of the provider request in flight. */
	private requestBasis:
		| {
				precededBy: "none" | "request" | "refresh";
				previousAt?: number;
				prefixTokens?: number;
				/** Confirmed only once the provider reports reading the prompt. */
				renewal?: PromptCacheRefreshRecord;
		  }
		| undefined;
	private published: { status: PromptCacheStatus | undefined } | undefined;

	constructor(host: SessionPromptCacheHost) {
		this.host = host;
		this.audit = new PromptCacheAudit({
			agentDir: host.agentDir,
			sessionId: () => host.sessionManager.getSessionId(),
			parentSessionId: () => host.sessionManager.getHeader()?.parentSession?.sessionId,
		});
		this.keepAlive = new PromptCacheKeepAlive({
			now: () => Date.now(),
			settings: () => host.settingsManager.getPromptCacheKeepAlive(),
			status: () => this.currentStatus(),
			refreshBudget: () => {
				const model = host.model();
				return model === undefined
					? 0
					: promptCacheRefreshBudget(model, resolvePromptCacheRetention(model, host.cacheRetention()));
			},
			canRefresh: () => host.conversation().canRefreshPromptCache(),
			hasInFlightWork: () => host.hasInFlightWork(),
			refresh: async (reason) => await this.refresh(reason),
			stopped: (reason, status) => this.recordStop(reason, status),
			changed: () => this.publish(),
		});
	}

	/** Documented retention of the current model's reusable prompt prefix; undefined when caching does not apply. */
	status(): PromptCacheStatus | undefined {
		const status = this.currentStatus();
		if (status?.kind !== "retained") return status;
		const keepAliveUntil = this.keepAlive.keepAliveUntil();
		return keepAliveUntil === undefined ? status : { ...status, keepAliveUntil };
	}

	/**
	 * An input of the keepalive idle window changed (`isBusy`, `hasBackgroundJobs`, or the
	 * observed operation): keepalive measures the window from these transitions.
	 */
	activityChanged(): void {
		try {
			this.keepAlive.activityChanged();
		} catch {
			// Keepalive is derived state; it cannot fail the transition that reported it.
		}
	}

	/** Status derived from persisted requests on the active branch. */
	private branchStatus(): PromptCacheStatus | undefined {
		return resolvePromptCacheStatus({
			model: this.host.model(),
			branch: this.host.sessionManager.getBranch(),
			cacheRetention: this.host.cacheRetention(),
		});
	}

	/** Branch status extended by in-memory renewals (refreshes and requests not yet persisted). */
	private currentStatus(): PromptCacheStatus | undefined {
		return this.applyRenewals(this.branchStatus());
	}

	private applyRenewals(base: PromptCacheStatus | undefined): PromptCacheStatus | undefined {
		return applyPromptCacheRefresh(base, this.renewal, this.requestBasis?.renewal);
	}

	/** Keep the latest confirmed renewal of the request the branch status derives from. */
	private confirmRenewal(renewal: PromptCacheRefreshRecord): void {
		const base = this.branchStatus();
		if (base?.kind !== "retained" || renewal.basisRequestAt !== base.lastRequestAt) return;
		const confirmed = this.renewal;
		if (confirmed?.basisRequestAt === renewal.basisRequestAt && confirmed.at >= renewal.at) return;
		this.renewal = renewal;
	}

	private isCurrentModelMessage(message: AssistantMessage): boolean {
		const model = this.host.model();
		return model !== undefined && message.provider === model.provider && message.model === model.id;
	}

	private auditCommon(model: Model<Api>) {
		const keepAlive = this.host.settingsManager.getPromptCacheKeepAlive();
		const retention = resolvePromptCacheRetention(model, this.host.cacheRetention());
		const ttlSeconds = retention === "none" ? undefined : model.promptCache?.retention[retention]?.ttlSeconds;
		return {
			provider: model.provider,
			model: model.id,
			...(ttlSeconds === undefined ? {} : { ttlSeconds }),
			keepAlive: {
				enabled: keepAlive.enabled,
				idleWindowMinutes: keepAlive.idleWindowMs / 60_000,
				refreshBudget: promptCacheRefreshBudget(model, retention),
			},
		};
	}

	private promptTokensOfRequestAt(timestamp: number): number | undefined {
		const branch = this.host.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index]!;
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			if (entry.message.timestamp !== timestamp) continue;
			const usage = entry.message.usage;
			return usage.input + usage.cacheRead + usage.cacheWrite;
		}
		return undefined;
	}

	/** A provider request started: it renews the prefix, so keepalive restarts from its start time. */
	requestStarted(message: AssistantMessage): void {
		if (!this.isCurrentModelMessage(message)) return;
		const base = this.branchStatus();
		const confirmed = this.renewal;
		const current = applyPromptCacheRefresh(base, confirmed);
		if (base?.kind === "retained" && current?.kind === "retained") {
			const renewed = confirmed !== undefined && current.lastRequestAt !== base.lastRequestAt;
			const prefixTokens = this.promptTokensOfRequestAt(base.lastRequestAt);
			this.requestBasis = {
				precededBy: renewed ? confirmed.source : "request",
				previousAt: current.lastRequestAt,
				...(prefixTokens === undefined ? {} : { prefixTokens }),
				renewal: { basisRequestAt: base.lastRequestAt, at: message.timestamp, source: "request" },
			};
		} else {
			this.requestBasis = { precededBy: "none" };
		}
		this.keepAlive.requestStarted();
	}

	/** A provider request ended: audit it, and confirm its renewal once the provider read the prompt. */
	requestEnded(message: AssistantMessage): void {
		const basis = this.requestBasis;
		this.requestBasis = undefined;
		if (!basis) return;
		const usage = message.usage;
		if (usage.input + usage.cacheRead + usage.cacheWrite <= 0) {
			// No evidence the provider read the prompt, so the request renewed nothing; renewals confirmed
			// meanwhile (such as a refresh that overlapped it) stand.
			this.keepAlive.update();
			return;
		}
		if (basis.renewal) this.confirmRenewal(basis.renewal);
		if (!this.isCurrentModelMessage(message)) return;
		const model = this.host.model();
		if (!model) return;
		this.audit.record({
			kind: "request",
			...this.auditCommon(model),
			stopReason: message.stopReason,
			precededBy: basis.precededBy,
			...(basis.previousAt === undefined ? {} : { gapMs: message.timestamp - basis.previousAt }),
			...(basis.prefixTokens === undefined ? {} : { prefixTokens: basis.prefixTokens }),
			usage: promptCacheAuditUsage(usage),
		});
	}

	private async refresh(reason: PromptCacheRefreshReason): Promise<boolean> {
		const model = this.host.model();
		const base = this.branchStatus();
		const current = this.applyRenewals(base);
		if (!model || base?.kind !== "retained" || current?.kind !== "retained") return false;
		const common = this.auditCommon(model);
		const startedAt = Date.now();
		const sinceLastRequestMs = startedAt - current.lastRequestAt;
		let result: ConversationPromptCacheRefreshResult;
		try {
			result = await this.host.conversation().refreshPromptCache(this.refreshAbort.signal);
		} catch {
			if (!this.host.isDisposed()) {
				this.audit.record({
					kind: "refresh",
					...common,
					reason,
					outcome: "error",
					durationMs: Date.now() - startedAt,
					sinceLastRequestMs,
				});
			}
			return false;
		}
		const durationMs = Date.now() - startedAt;
		if (result.status !== "refreshed") {
			this.audit.record({
				kind: "refresh",
				...common,
				reason,
				outcome: result.status,
				detail: result.reason,
				durationMs,
				sinceLastRequestMs,
			});
			return false;
		}
		this.audit.record({
			kind: "refresh",
			...common,
			reason,
			outcome: "refreshed",
			durationMs,
			sinceLastRequestMs,
			usage: promptCacheAuditUsage(result.usage),
		});
		if (this.host.isDisposed()) return false;
		// Applies only while the branch still derives from the request this refresh started from.
		this.confirmRenewal({ basisRequestAt: base.lastRequestAt, at: startedAt, source: "refresh" });
		const data: PromptCacheRefreshEntryData = {
			provider: result.model.provider,
			model: result.model.id,
			reason,
			usage: result.usage,
		};
		void this.host
			.sessionWriter()
			.appendCustomEntry(PROMPT_CACHE_REFRESH_ENTRY_TYPE, data)
			.catch(() => {
				// The audit already holds the refresh; a failed append only omits it from session totals.
			});
		this.publish();
		return true;
	}

	private recordStop(reason: PromptCacheKeepAliveStop, status: PromptCacheStatus): void {
		const model = this.host.model();
		if (!model) return;
		this.audit.record({
			kind: "keepalive_stop",
			...this.auditCommon(model),
			reason,
			...(status.kind === "retained" && status.expiresAt !== undefined
				? { expiresInMs: status.expiresAt - Date.now() }
				: {}),
		});
	}

	/** Emit prompt_cache_changed when the status differs from the last published value. */
	publish(): void {
		this.keepAlive.update();
		let status: PromptCacheStatus | undefined;
		try {
			status = this.status();
		} catch {
			// Derived presentation state cannot fail the event that triggered it.
			return;
		}
		const published = this.published;
		if (published && promptCacheStatusEquals(published.status, status)) return;
		this.published = { status };
		this.host.emit({ type: "prompt_cache_changed", promptCache: status ?? null });
	}

	/** Stop keepalive and cancel a refresh in flight; the session is disposing. */
	dispose(): void {
		this.keepAlive.dispose();
		this.refreshAbort.abort();
	}

	/** Flush and close the audit. */
	async close(): Promise<void> {
		await this.audit.close();
	}
}

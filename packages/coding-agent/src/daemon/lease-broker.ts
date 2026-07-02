import { randomUUID } from "node:crypto";

/**
 * Conversation lease broker: the single authority on which process owns the
 * live runtime for a (workspaceName, sessionId). Runtimes and relays are
 * effects driven by its transitions. Runs single-threaded on the daemon event
 * loop; every transition is a synchronous state mutation followed by async
 * effects.
 */

export type LeaseState = "unowned" | "daemon-active" | "daemon-detached" | "daemon-draining" | "tui-owned";

export type LeaseHandoff = "cold" | "warm" | "none";

export type LeaseDenyReason = "held_by_tui" | "force_unsupported" | "draining_elsewhere";

export type LeaseReleaseReason = "quit" | "switch" | "connection_lost" | "rekey" | "shutdown" | "retention_expired";

export interface LeaseRecord {
	key: string;
	workspaceName: string;
	sessionId: string;
	state: LeaseState;
	/** control connectionId of owning TUI when tui-owned / target of daemon-draining */
	tuiConnectionId?: string;
	/** live phone stream count when daemon-* */
	streamCount: number;
	/** active relayIds when tui-owned */
	relayIds: Set<string>;
	/** drain bookkeeping when daemon-draining */
	drain?: {
		viewerFeedId: string;
		startedAtMs: number;
		cancelled: boolean;
		resolveGranted: (result: { handoff: "warm" }) => void;
		rejectGranted: (error: Error) => void;
	};
	/** pending lazy-resume shared by racing attaches (daemon-active sub-flag) */
	resuming?: Promise<void>;
}

export type LeaseAcquireOutcome =
	| { kind: "granted"; handoff: LeaseHandoff }
	| { kind: "pending"; viewerFeedId: string; granted: Promise<{ handoff: "warm" }> }
	| { kind: "denied"; reason: LeaseDenyReason };

export interface LeaseBrokerEffects {
	/** True when the daemon runtime for the key is mid-turn. */
	isRuntimeStreaming(workspaceName: string, sessionId: string): boolean;
	/** Resolves when the daemon runtime's current turn ends. */
	waitForRuntimeIdle(workspaceName: string, sessionId: string): Promise<void>;
	/** Dispose the daemon runtime through the normal dispose path (session_shutdown "quit"). */
	disposeRuntime(workspaceName: string, sessionId: string, reason: string): Promise<void>;
	/** Close daemon-attached phone streams for the key with the given reason. */
	closePhoneStreams(workspaceName: string, sessionId: string, reason: string): Promise<void> | void;
	/** Close open relays for a tui-owned lease. */
	closeRelays(
		record: LeaseRecord,
		reason: "lease_transferred" | "session_rekeyed_reconnect" | "host_shutdown" | "error",
	): void;
	onDrainStarted?(record: LeaseRecord, viewerFeedId: string): void;
	onDrainEnded?(record: LeaseRecord, viewerFeedId: string, reason: "granted" | "cancelled" | "error"): void;
	audit(event: {
		type: "lease_acquired" | "lease_released" | "lease_denied";
		workspaceName: string;
		sessionId: string;
		details: Record<string, unknown>;
	}): void;
	generateViewerFeedId?(): string;
}

const LEASE_TRANSFERRED_CLOSE_REASON = "lease_transferred";

function getLeaseKey(workspaceName: string, sessionId: string): string {
	return `${workspaceName}\0${sessionId}`;
}

export class LeaseBroker {
	private readonly effects: LeaseBrokerEffects;
	private readonly records = new Map<string, LeaseRecord>();

	constructor(effects: LeaseBrokerEffects) {
		this.effects = effects;
	}

	lookup(workspaceName: string, sessionId: string): LeaseRecord | undefined {
		return this.records.get(getLeaseKey(workspaceName, sessionId));
	}

	list(): LeaseRecord[] {
		return Array.from(this.records.values());
	}

	private getOrCreateRecord(workspaceName: string, sessionId: string): LeaseRecord {
		const key = getLeaseKey(workspaceName, sessionId);
		let record = this.records.get(key);
		if (!record) {
			record = {
				key,
				workspaceName,
				sessionId,
				state: "unowned",
				streamCount: 0,
				relayIds: new Set(),
			};
			this.records.set(key, record);
		}
		return record;
	}

	private dropIfUnowned(record: LeaseRecord): void {
		if (record.state === "unowned" && record.relayIds.size === 0 && record.streamCount === 0) {
			this.records.delete(record.key);
		}
	}

	// ==========================================================================
	// TUI acquire / release / rekey
	// ==========================================================================

	async acquireForTui(request: {
		connectionId: string;
		workspaceName: string;
		sessionId: string;
		force?: boolean;
	}): Promise<LeaseAcquireOutcome> {
		const { connectionId, workspaceName, sessionId } = request;
		if (request.force) {
			this.effects.audit({
				type: "lease_denied",
				workspaceName,
				sessionId,
				details: { requester: connectionId, reason: "force_unsupported" },
			});
			return { kind: "denied", reason: "force_unsupported" };
		}
		const record = this.getOrCreateRecord(workspaceName, sessionId);
		switch (record.state) {
			case "unowned": {
				record.state = "tui-owned";
				record.tuiConnectionId = connectionId;
				this.effects.audit({
					type: "lease_acquired",
					workspaceName,
					sessionId,
					details: { owner: "tui", handoff: "none", connectionId },
				});
				return { kind: "granted", handoff: "none" };
			}
			case "tui-owned": {
				if (record.tuiConnectionId === connectionId) {
					return { kind: "granted", handoff: "none" };
				}
				this.effects.audit({
					type: "lease_denied",
					workspaceName,
					sessionId,
					details: { requester: connectionId, reason: "held_by_tui" },
				});
				return { kind: "denied", reason: "held_by_tui" };
			}
			case "daemon-draining": {
				if (record.tuiConnectionId === connectionId && record.drain) {
					const drain = record.drain;
					return {
						kind: "pending",
						viewerFeedId: drain.viewerFeedId,
						granted: new Promise((resolve, reject) => {
							const previousResolve = drain.resolveGranted;
							const previousReject = drain.rejectGranted;
							drain.resolveGranted = (result) => {
								previousResolve(result);
								resolve(result);
							};
							drain.rejectGranted = (error) => {
								previousReject(error);
								reject(error);
							};
						}),
					};
				}
				this.effects.audit({
					type: "lease_denied",
					workspaceName,
					sessionId,
					details: { requester: connectionId, reason: "draining_elsewhere" },
				});
				return { kind: "denied", reason: "draining_elsewhere" };
			}
			case "daemon-detached":
			case "daemon-active": {
				if (record.state === "daemon-active" && this.effects.isRuntimeStreaming(workspaceName, sessionId)) {
					return this.beginDrain(record, connectionId);
				}
				// Idle daemon runtime: dispose and grant immediately.
				record.state = "tui-owned";
				record.tuiConnectionId = connectionId;
				await this.effects.disposeRuntime(workspaceName, sessionId, "lease_transferred_to_tui");
				await this.effects.closePhoneStreams(workspaceName, sessionId, LEASE_TRANSFERRED_CLOSE_REASON);
				record.streamCount = 0;
				this.effects.audit({
					type: "lease_acquired",
					workspaceName,
					sessionId,
					details: { owner: "tui", handoff: "warm", connectionId },
				});
				return { kind: "granted", handoff: "warm" };
			}
		}
	}

	private beginDrain(record: LeaseRecord, connectionId: string): LeaseAcquireOutcome {
		const viewerFeedId = this.effects.generateViewerFeedId?.() ?? `vf-${randomUUID()}`;
		record.state = "daemon-draining";
		record.tuiConnectionId = connectionId;
		let resolveGranted: (result: { handoff: "warm" }) => void = () => {};
		let rejectGranted: (error: Error) => void = () => {};
		const granted = new Promise<{ handoff: "warm" }>((resolve, reject) => {
			resolveGranted = resolve;
			rejectGranted = reject;
		});
		granted.catch(() => {});
		record.drain = {
			viewerFeedId,
			startedAtMs: Date.now(),
			cancelled: false,
			resolveGranted,
			rejectGranted,
		};
		this.effects.onDrainStarted?.(record, viewerFeedId);
		void this.runDrain(record);
		return { kind: "pending", viewerFeedId, granted };
	}

	private async runDrain(record: LeaseRecord): Promise<void> {
		const drain = record.drain;
		if (!drain) {
			return;
		}
		try {
			await this.effects.waitForRuntimeIdle(record.workspaceName, record.sessionId);
		} catch (error) {
			if (!drain.cancelled && record.drain === drain) {
				record.drain = undefined;
				record.state = record.streamCount > 0 ? "daemon-active" : "daemon-detached";
				record.tuiConnectionId = undefined;
				this.effects.onDrainEnded?.(record, drain.viewerFeedId, "error");
				drain.rejectGranted(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}
		if (drain.cancelled || record.drain !== drain) {
			return;
		}
		record.drain = undefined;
		await this.effects.disposeRuntime(record.workspaceName, record.sessionId, "lease_transferred_to_tui");
		await this.effects.closePhoneStreams(record.workspaceName, record.sessionId, LEASE_TRANSFERRED_CLOSE_REASON);
		record.streamCount = 0;
		record.state = "tui-owned";
		this.effects.onDrainEnded?.(record, drain.viewerFeedId, "granted");
		this.effects.audit({
			type: "lease_acquired",
			workspaceName: record.workspaceName,
			sessionId: record.sessionId,
			details: { owner: "tui", handoff: "warm", connectionId: record.tuiConnectionId },
		});
		drain.resolveGranted({ handoff: "warm" });
	}

	private cancelDrain(record: LeaseRecord): void {
		const drain = record.drain;
		if (!drain) {
			return;
		}
		drain.cancelled = true;
		record.drain = undefined;
		record.tuiConnectionId = undefined;
		record.state = record.streamCount > 0 ? "daemon-active" : "daemon-detached";
		this.effects.onDrainEnded?.(record, drain.viewerFeedId, "cancelled");
		drain.rejectGranted(new Error("drain cancelled"));
	}

	releaseFromTui(
		connectionId: string,
		workspaceName: string,
		sessionId: string,
		reason: LeaseReleaseReason = "quit",
	): { ok: true } | { ok: false; code: "not_held" } {
		const record = this.lookup(workspaceName, sessionId);
		if (!record || record.state !== "tui-owned" || record.tuiConnectionId !== connectionId) {
			return { ok: false, code: "not_held" };
		}
		this.effects.closeRelays(record, "lease_transferred");
		record.relayIds.clear();
		record.state = "unowned";
		record.tuiConnectionId = undefined;
		this.effects.audit({
			type: "lease_released",
			workspaceName,
			sessionId,
			details: { owner: "tui", reason, connectionId },
		});
		this.dropIfUnowned(record);
		return { ok: true };
	}

	/** Connection died: implicit release of ALL leases held by connectionId. */
	releaseAllForConnection(connectionId: string): void {
		for (const record of Array.from(this.records.values())) {
			if (record.state === "tui-owned" && record.tuiConnectionId === connectionId) {
				this.releaseFromTui(connectionId, record.workspaceName, record.sessionId, "connection_lost");
				continue;
			}
			if (record.state === "daemon-draining" && record.tuiConnectionId === connectionId) {
				this.cancelDrain(record);
			}
		}
	}

	rekey(workspaceName: string, oldSessionId: string, newSessionId: string): void {
		if (oldSessionId === newSessionId) {
			return;
		}
		const record = this.lookup(workspaceName, oldSessionId);
		if (!record) {
			return;
		}
		this.records.delete(record.key);
		record.sessionId = newSessionId;
		record.key = getLeaseKey(workspaceName, newSessionId);
		const displaced = this.records.get(record.key);
		if (displaced && displaced.state === "tui-owned") {
			// The rekey target is already tui-owned elsewhere; keep the displaced record.
			this.records.set(record.key, displaced);
		} else {
			this.records.set(record.key, record);
		}
		if (record.state === "tui-owned" && record.relayIds.size > 0) {
			this.effects.closeRelays(record, "session_rekeyed_reconnect");
			record.relayIds.clear();
		}
	}

	// ==========================================================================
	// Relay bookkeeping (tui-owned)
	// ==========================================================================

	registerRelay(workspaceName: string, sessionId: string, relayId: string): void {
		const record = this.lookup(workspaceName, sessionId);
		if (record?.state === "tui-owned") {
			record.relayIds.add(relayId);
		}
	}

	unregisterRelay(workspaceName: string, sessionId: string, relayId: string): void {
		const record = this.lookup(workspaceName, sessionId);
		if (record) {
			record.relayIds.delete(relayId);
			this.dropIfUnowned(record);
		}
	}

	// ==========================================================================
	// Daemon runtime lifecycle notifications
	// ==========================================================================

	onDaemonRuntimeAttached(workspaceName: string, sessionId: string): void {
		const record = this.getOrCreateRecord(workspaceName, sessionId);
		if (record.state === "unowned" || record.state === "daemon-detached") {
			record.state = "daemon-active";
			this.effects.audit({
				type: "lease_acquired",
				workspaceName,
				sessionId,
				details: { owner: "daemon", handoff: "none" },
			});
		}
	}

	onDaemonRuntimeStreamCountChanged(workspaceName: string, sessionId: string, liveStreams: number): void {
		const record = this.lookup(workspaceName, sessionId);
		if (!record) {
			return;
		}
		record.streamCount = liveStreams;
		if (record.state === "daemon-draining" || record.state === "tui-owned" || record.state === "unowned") {
			// Drain completes regardless of stream count; tui-owned counts relays instead.
			return;
		}
		record.state = liveStreams > 0 ? "daemon-active" : "daemon-detached";
	}

	onDaemonRuntimeDisposed(workspaceName: string, sessionId: string, reason: string): void {
		const record = this.lookup(workspaceName, sessionId);
		if (!record) {
			return;
		}
		if (record.state === "daemon-draining") {
			// Disposal is part of the drain flow (or shutdown subsumed it); the drain
			// path handles its own transition.
			return;
		}
		if (record.state === "tui-owned") {
			// The runtime disposal that accompanies an immediate grant.
			return;
		}
		record.streamCount = 0;
		record.state = "unowned";
		this.effects.audit({
			type: "lease_released",
			workspaceName,
			sessionId,
			details: {
				owner: "daemon",
				reason: reason === "detached_runtime_ttl_expired" ? "retention_expired" : reason,
			},
		});
		this.dropIfUnowned(record);
	}

	isDraining(workspaceName: string, sessionId: string): boolean {
		return this.lookup(workspaceName, sessionId)?.state === "daemon-draining";
	}
}

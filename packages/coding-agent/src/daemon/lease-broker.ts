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
export type DaemonAttachRejectionReason = "tui_owned" | "draining";

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
		/**
		 * Runtime disposal has started; the drain can no longer revert to a
		 * daemon-owned state, so a cancellation must defer the final transition
		 * to runDrain's continuation.
		 */
		disposing: boolean;
		resolveGranted: (result: { handoff: "warm" }) => void;
		rejectGranted: (error: Error) => void;
	};
	/** Provisional daemon runtime creations that have not committed ownership. */
	pendingDaemonAttaches: number;
	/** pending lazy-resume shared by racing attaches (daemon-active sub-flag) */
	resuming?: Promise<void>;
}

export interface DaemonAttachClaim {
	readonly id: string;
	readonly workspaceName: string;
	readonly sessionId?: string;
}

export type DaemonAttachBeginOutcome =
	| { kind: "proceed"; claim: DaemonAttachClaim }
	| { kind: "relay"; tuiConnectionId: string }
	| { kind: "retry"; retryAfterMs: number };

export type DaemonAttachCommitOutcome =
	| { ok: true; previousState: LeaseState }
	| { ok: false; reason: DaemonAttachRejectionReason; tuiConnectionId?: string };

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
				pendingDaemonAttaches: 0,
			};
			this.records.set(key, record);
		}
		return record;
	}

	private dropIfUnowned(record: LeaseRecord): void {
		if (
			record.state === "unowned" &&
			record.relayIds.size === 0 &&
			record.streamCount === 0 &&
			record.pendingDaemonAttaches === 0
		) {
			this.records.delete(record.key);
		}
	}

	beginDaemonAttach(workspaceName: string, sessionId: string | undefined): DaemonAttachBeginOutcome {
		const claim: DaemonAttachClaim = {
			id: randomUUID(),
			workspaceName,
			...(sessionId === undefined ? {} : { sessionId }),
		};
		if (sessionId === undefined) {
			return { kind: "proceed", claim };
		}
		const record = this.getOrCreateRecord(workspaceName, sessionId);
		if (record.state === "tui-owned" && record.tuiConnectionId) {
			this.dropIfUnowned(record);
			return { kind: "relay", tuiConnectionId: record.tuiConnectionId };
		}
		if (record.state === "daemon-draining") {
			this.dropIfUnowned(record);
			return { kind: "retry", retryAfterMs: 1000 };
		}
		record.pendingDaemonAttaches++;
		return { kind: "proceed", claim };
	}

	abortDaemonAttach(claim: DaemonAttachClaim): void {
		if (claim.sessionId === undefined) {
			return;
		}
		const record = this.lookup(claim.workspaceName, claim.sessionId);
		if (!record) {
			return;
		}
		record.pendingDaemonAttaches = Math.max(0, record.pendingDaemonAttaches - 1);
		this.dropIfUnowned(record);
	}

	commitDaemonRuntime(claim: DaemonAttachClaim, workspaceName: string, sessionId: string): DaemonAttachCommitOutcome {
		this.abortDaemonAttach(claim);
		const record = this.getOrCreateRecord(workspaceName, sessionId);
		if (record.state === "tui-owned") {
			return {
				ok: false,
				reason: "tui_owned",
				...(record.tuiConnectionId ? { tuiConnectionId: record.tuiConnectionId } : {}),
			};
		}
		if (record.state === "daemon-draining") {
			return { ok: false, reason: "draining" };
		}
		const previousState = record.state;
		if (record.state === "unowned" || record.state === "daemon-detached") {
			record.state = "daemon-active";
			this.effects.audit({
				type: "lease_acquired",
				workspaceName,
				sessionId,
				details: { owner: "daemon", handoff: "none" },
			});
		} else if (record.state === "daemon-active") {
			record.state = "daemon-active";
		}
		return { ok: true, previousState };
	}

	rollbackDaemonRuntimeCommit(workspaceName: string, sessionId: string, previousState: LeaseState): void {
		const record = this.lookup(workspaceName, sessionId);
		if (!record || record.state === "tui-owned" || record.state === "daemon-draining") {
			return;
		}
		record.state = previousState;
		if (previousState === "unowned") {
			record.streamCount = 0;
			this.dropIfUnowned(record);
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
				// Idle daemon runtime: dispose and grant immediately. The flip to
				// tui-owned happens BEFORE disposal so the disposal's
				// onDaemonRuntimeDisposed callback no-ops (it is part of this grant).
				record.state = "tui-owned";
				record.tuiConnectionId = connectionId;
				try {
					await this.effects.disposeRuntime(workspaceName, sessionId, "lease_transferred_to_tui");
					await this.effects.closePhoneStreams(workspaceName, sessionId, LEASE_TRANSFERRED_CLOSE_REASON);
				} catch (error) {
					// Disposal failed after the premature tui-owned flip. Leaving the
					// lease tui-owned would strand the still-alive daemon runtime and
					// phone streams. Revert to a daemon-owned state and fail the acquire
					// (unless the connection already died and released the lease).
					if (record.state === "tui-owned" && record.tuiConnectionId === connectionId) {
						record.state = record.streamCount > 0 ? "daemon-active" : "daemon-detached";
						record.tuiConnectionId = undefined;
					}
					throw error;
				}
				record.streamCount = 0;
				if ((record.state as LeaseState) !== "tui-owned" || record.tuiConnectionId !== connectionId) {
					// The connection died while the disposal effects ran and the lease
					// was already released (releaseAllForConnection). The release path
					// audited; there is no live owner left to grant to.
					this.dropIfUnowned(record);
					return { kind: "granted", handoff: "warm" };
				}
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
			disposing: false,
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
		// From here disposal is irreversible: record.drain stays set so a
		// cancellation landing during these awaits is visible afterwards, and
		// cancelDrain defers the final transition to this continuation.
		drain.disposing = true;
		try {
			await this.effects.disposeRuntime(record.workspaceName, record.sessionId, "lease_transferred_to_tui");
			await this.effects.closePhoneStreams(record.workspaceName, record.sessionId, LEASE_TRANSFERRED_CLOSE_REASON);
		} catch (error) {
			// This phase is otherwise unguarded, so a disposal failure (e.g. a
			// state-manager IO error) would wedge the lease in daemon-draining forever
			// and leave the acquiring TUI's grant promise unsettled. Recover: clear the
			// drain, settle the grant, and move to a state a later acquire can retry
			// from (unowned when the requester already gave up, else daemon-owned).
			if (record.drain === drain) {
				record.drain = undefined;
				record.tuiConnectionId = undefined;
			}
			if (drain.cancelled) {
				// Zero the stream count before dropping. dropIfUnowned requires
				// streamCount === 0, so leaving it stale here (the success path resets it
				// at the bottom of runDrain, but this early return skips that) would
				// strand the record in `records` as an undroppable "unowned" ghost that
				// then hands a phantom stream count to the next acquire.
				record.streamCount = 0;
				record.state = "unowned";
				this.dropIfUnowned(record);
			} else {
				record.state = record.streamCount > 0 ? "daemon-active" : "daemon-detached";
				this.effects.onDrainEnded?.(record, drain.viewerFeedId, "error");
				drain.rejectGranted(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}
		record.drain = undefined;
		record.streamCount = 0;
		if (drain.cancelled) {
			// The requesting connection died mid-disposal. The runtime is gone, so
			// the lease returns to unowned instead of granting to a dead owner.
			record.state = "unowned";
			record.tuiConnectionId = undefined;
			this.effects.audit({
				type: "lease_released",
				workspaceName: record.workspaceName,
				sessionId: record.sessionId,
				details: { owner: "daemon", reason: "connection_lost", drainCancelledDuringDisposal: true },
			});
			this.dropIfUnowned(record);
			return;
		}
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
		if (!drain || drain.cancelled) {
			return;
		}
		drain.cancelled = true;
		if (drain.disposing) {
			// Runtime disposal already started and cannot be reverted; fail the
			// grant now and let runDrain's continuation finish the transition
			// (to unowned) once the disposal effects settle.
			this.effects.onDrainEnded?.(record, drain.viewerFeedId, "cancelled");
			drain.rejectGranted(new Error("drain cancelled"));
			return;
		}
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
		if (record?.state === "daemon-draining" && record.tuiConnectionId === connectionId) {
			// The requesting TUI is abandoning its own pending drain (a change of
			// mind). Cancel it rather than letting runDrain complete and force-grant
			// an unwanted warm lease — which would needlessly dispose the daemon
			// runtime and close every phone stream for a handoff no one wants.
			this.cancelDrain(record);
			this.dropIfUnowned(record);
			return { ok: true };
		}
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
		const newKey = getLeaseKey(workspaceName, newSessionId);
		const displaced = this.records.get(newKey);
		if (displaced) {
			// The target session id already has its own lease record. A destructive
			// rekey would either orphan `record` (its old key removed but never
			// re-inserted) or silently drop the live `displaced` record from all
			// lease accounting, stranding its runtime/streams/relays. Refuse instead
			// and leave both records on their current keys; the caller re-acquires
			// under the new id on its next reconnect.
			this.effects.audit({
				type: "lease_denied",
				workspaceName,
				sessionId: newSessionId,
				details: { reason: "rekey_target_in_use", oldSessionId, displacedState: displaced.state },
			});
			return;
		}
		this.records.delete(record.key);
		record.sessionId = newSessionId;
		record.key = newKey;
		this.records.set(newKey, record);
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

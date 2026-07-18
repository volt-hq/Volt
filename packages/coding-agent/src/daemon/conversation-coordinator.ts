import type { DetachedRuntimeRetentionHandle } from "../remote/integrated-runtime-retention.ts";
import type {
	DaemonAttachClaim,
	DaemonRuntimeCommitToken,
	DaemonRuntimeOwnerCapability,
	LeaseBroker,
} from "./lease-broker.ts";

export type ConversationRuntimeLifecycle = "prepared" | "active" | "retiring" | "retired";

export interface ConversationAttachClaim {
	readonly coordinator: ConversationCoordinator;
	readonly generation: number;
	readonly released: boolean;
	release(): void;
}

export interface ConversationSubscriber {
	readonly id: string;
	readonly attachedAt: number;
}

export type ConversationTransportKind = "direct" | "relay";

export interface ConversationTransportOwner {
	readonly id: string;
	readonly kind: ConversationTransportKind;
	readonly clientNodeId: string;
	readonly connectionId: string;
	close(reason: string): Promise<void> | void;
}

interface OwnedConversationTransport {
	readonly owner: ConversationTransportOwner;
	leaseActive: boolean;
	closePromise?: Promise<void>;
}

export interface ConversationRuntimeRetirement {
	/** Completes when the runtime-specific finalizer has run. */
	readonly finalization: Promise<void>;
	/** The sole terminal barrier: transports, runtime finalization, and ownership cleanup. */
	readonly settled: Promise<void>;
}

export interface BeginConversationRuntimeRetirementOptions {
	/**
	 * A replacement command can be executing inside one of the transports it is
	 * retiring. In that case finalization must start concurrently so the command
	 * can return and allow its own transport to settle. All other retirement uses
	 * the stricter transports-before-runtime ordering.
	 */
	finalizationOrder?: "after_transports" | "concurrent";
}

export interface ConversationCoordinatorRekeyReservation {
	readonly coordinator: ConversationCoordinator;
	readonly previousSessionId: string;
	readonly nextSessionId: string;
}

/**
 * Stable authority for one logical conversation. The object survives session
 * rekeys and daemon-runtime/TUI-relay ownership changes; registries only index
 * it. Every mutable lifetime fact that can fence an attach or keep the
 * conversation alive is owned here.
 */
export class ConversationCoordinator {
	readonly workspaceName: string;
	private currentSessionId: string;
	private readonly previousSessionIdSet = new Set<string>();
	private runtimeLifecycleValue: ConversationRuntimeLifecycle | undefined;
	private generationValue = 0;
	private runtimeRetirementValue: ConversationRuntimeRetirement | undefined;
	private leaseOwnerValue: DaemonRuntimeOwnerCapability | undefined;
	private tuiLeaseConnectionIdValue: string | undefined;
	private pendingTuiLeaseConnectionIdValue: string | undefined;
	private readonly attachClaimSet = new Set<ConversationAttachClaim>();
	private readonly subscriberSet = new Set<ConversationSubscriber>();
	private detachedAtValue: number | undefined;
	private retentionValue: DetachedRuntimeRetentionHandle | undefined;
	private readonly transports = new Map<string, OwnedConversationTransport>();
	private readonly onVacant: (coordinator: ConversationCoordinator) => void;
	private leaseBrokerValue: LeaseBroker | undefined;

	constructor(
		workspaceName: string,
		sessionId: string,
		onVacant: (coordinator: ConversationCoordinator) => void = () => {},
	) {
		this.workspaceName = workspaceName;
		this.currentSessionId = sessionId;
		this.onVacant = onVacant;
	}

	get sessionId(): string {
		return this.currentSessionId;
	}

	get previousSessionIds(): ReadonlySet<string> {
		return this.previousSessionIdSet;
	}

	get runtimeLifecycle(): ConversationRuntimeLifecycle | undefined {
		return this.runtimeLifecycleValue;
	}

	get generation(): number {
		return this.generationValue;
	}

	get retirement(): ConversationRuntimeRetirement | undefined {
		return this.runtimeRetirementValue;
	}

	get leaseOwner(): DaemonRuntimeOwnerCapability | undefined {
		return this.leaseOwnerValue;
	}

	get tuiLeaseConnectionId(): string | undefined {
		return this.tuiLeaseConnectionIdValue;
	}

	get pendingTuiLeaseConnectionId(): string | undefined {
		return this.pendingTuiLeaseConnectionIdValue;
	}

	get attachClaims(): ReadonlySet<ConversationAttachClaim> {
		return this.attachClaimSet;
	}

	get subscribers(): ReadonlySet<ConversationSubscriber> {
		return this.subscriberSet;
	}

	get detachedAt(): number | undefined {
		return this.detachedAtValue;
	}

	get detachedRuntimeRetention(): DetachedRuntimeRetentionHandle | undefined {
		return this.retentionValue;
	}

	get transportCount(): number {
		return this.transports.size;
	}

	get activeDirectTransportCount(): number {
		let count = 0;
		for (const transport of this.transports.values()) {
			if (transport.owner.kind === "direct" && transport.leaseActive) count++;
		}
		return count;
	}

	get hasRuntime(): boolean {
		return this.runtimeLifecycleValue !== undefined && this.runtimeLifecycleValue !== "retired";
	}

	get hasLeaseBroker(): boolean {
		return this.leaseBrokerValue !== undefined;
	}

	get isVacant(): boolean {
		return (
			this.transports.size === 0 &&
			!this.hasRuntime &&
			this.leaseOwnerValue === undefined &&
			this.tuiLeaseConnectionIdValue === undefined &&
			this.pendingTuiLeaseConnectionIdValue === undefined
		);
	}

	prepareRuntime(): void {
		if (this.runtimeLifecycleValue !== undefined) {
			throw new Error(`conversation runtime already reserved for ${this.workspaceName}/${this.sessionId}`);
		}
		if (this.transports.size !== 0) {
			throw new Error(`conversation transports are still retiring for ${this.workspaceName}/${this.sessionId}`);
		}
		if (this.tuiLeaseConnectionIdValue !== undefined || this.pendingTuiLeaseConnectionIdValue !== undefined) {
			throw new Error(`conversation lease is still TUI-owned for ${this.workspaceName}/${this.sessionId}`);
		}
		this.runtimeLifecycleValue = "prepared";
	}

	bindLeaseBroker(leaseBroker: LeaseBroker): void {
		if (this.leaseBrokerValue && this.leaseBrokerValue !== leaseBroker) {
			throw new Error("conversation coordinator is already bound to another lease broker");
		}
		this.leaseBrokerValue = leaseBroker;
	}

	activateRuntime(): void {
		if (this.runtimeLifecycleValue !== "prepared" && this.runtimeLifecycleValue !== "active") {
			throw new Error(`conversation runtime cannot activate from ${this.runtimeLifecycleValue ?? "unowned"}`);
		}
		this.runtimeLifecycleValue = "active";
	}

	createAttachClaim(): ConversationAttachClaim {
		if (this.runtimeLifecycleValue !== "prepared" && this.runtimeLifecycleValue !== "active") {
			throw new Error("conversation runtime is not accepting attach claims");
		}
		let released = false;
		const claim: ConversationAttachClaim = {
			coordinator: this,
			generation: this.generationValue,
			get released() {
				return released;
			},
			release: () => {
				if (released) return;
				released = true;
				this.attachClaimSet.delete(claim);
			},
		};
		this.attachClaimSet.add(claim);
		return claim;
	}

	isAttachClaimCurrent(claim: ConversationAttachClaim): boolean {
		return (
			claim.coordinator === this &&
			!claim.released &&
			claim.generation === this.generationValue &&
			this.attachClaimSet.has(claim)
		);
	}

	invalidateAttachClaims(): void {
		for (const claim of [...this.attachClaimSet]) {
			claim.release();
		}
	}

	addSubscriber(subscriber: ConversationSubscriber): void {
		if (this.runtimeLifecycleValue !== "active") {
			throw new Error("conversation runtime is not accepting subscribers");
		}
		this.subscriberSet.add(subscriber);
	}

	removeSubscriber(subscriber: ConversationSubscriber): boolean {
		return this.subscriberSet.delete(subscriber);
	}

	markDetached(at = Date.now()): void {
		this.detachedAtValue = at;
	}

	markAttached(): void {
		this.detachedAtValue = undefined;
	}

	setDetachedRuntimeRetention(handle: DetachedRuntimeRetentionHandle): void {
		this.cancelDetachedRuntimeRetention();
		this.retentionValue = handle;
	}

	cancelDetachedRuntimeRetention(): void {
		this.retentionValue?.cancel();
		this.retentionValue = undefined;
	}

	installLeaseOwner(owner: DaemonRuntimeOwnerCapability): void {
		if (this.runtimeLifecycleValue === "retiring" || this.runtimeLifecycleValue === "retired") {
			throw new Error("cannot install a lease owner on a retiring conversation runtime");
		}
		if (this.tuiLeaseConnectionIdValue !== undefined) {
			throw new Error("cannot install daemon lease authority while the conversation is TUI-owned");
		}
		this.leaseOwnerValue = owner;
	}

	clearLeaseOwner(expectedOwner?: DaemonRuntimeOwnerCapability): boolean {
		if (expectedOwner !== undefined && this.leaseOwnerValue !== expectedOwner) {
			return false;
		}
		const hadOwner = this.leaseOwnerValue !== undefined;
		this.leaseOwnerValue = undefined;
		return hadOwner;
	}

	commitDaemonRuntime(claim: DaemonAttachClaim): {
		outcome: ReturnType<LeaseBroker["commitDaemonRuntime"]>;
		installedProvisionalOwner: boolean;
	} {
		const existingOwner = this.leaseOwnerValue;
		const outcome = this.requireLeaseBroker().commitDaemonRuntime(
			claim,
			this.workspaceName,
			this.sessionId,
			existingOwner,
		);
		if (outcome.ok) {
			this.installLeaseOwner(outcome.owner);
		}
		return { outcome, installedProvisionalOwner: outcome.ok && existingOwner === undefined };
	}

	rollbackDaemonRuntimeCommit(
		token: DaemonRuntimeCommitToken,
		provisionalOwner: DaemonRuntimeOwnerCapability,
		installedProvisionalOwner: boolean,
	): boolean {
		const rolledBack = this.requireLeaseBroker().rollbackDaemonRuntimeCommit(token);
		if (installedProvisionalOwner) {
			this.clearLeaseOwner(provisionalOwner);
		}
		return rolledBack;
	}

	finalizeDaemonRuntimeCommit(
		token: DaemonRuntimeCommitToken,
	): ReturnType<LeaseBroker["finalizeDaemonRuntimeCommit"]> {
		const outcome = this.requireLeaseBroker().finalizeDaemonRuntimeCommit(token);
		if (outcome.kind === "finalized" || outcome.kind === "already_finalized") {
			this.installLeaseOwner(outcome.owner);
		}
		return outcome;
	}

	syncDaemonRuntimeStreamCount(): boolean {
		const owner = this.leaseOwnerValue;
		return (
			owner !== undefined &&
			this.requireLeaseBroker().onDaemonRuntimeStreamCountChanged(
				owner,
				this.workspaceName,
				this.sessionId,
				this.activeDirectTransportCount,
			)
		);
	}

	releaseDaemonRuntimeLease(reason: string): boolean {
		const owner = this.leaseOwnerValue;
		if (!owner) return false;
		const released = this.requireLeaseBroker().onDaemonRuntimeDisposed(
			owner,
			this.workspaceName,
			this.sessionId,
			reason,
		);
		if (!released) {
			throw new Error(`conversation runtime lease release was fenced for ${this.workspaceName}/${this.sessionId}`);
		}
		this.clearLeaseOwner(owner);
		return true;
	}

	rekeyDaemonRuntimeLease(nextSessionId: string): void {
		const owner = this.leaseOwnerValue;
		if (!owner) throw new Error("daemon runtime lease owner is unavailable for session rekey");
		const result = this.requireLeaseBroker().rekeyDaemonRuntime(
			owner,
			this.workspaceName,
			this.sessionId,
			nextSessionId,
		);
		if (!result.ok) throw new Error(`Unable to rekey conversation lease: ${result.code}`);
	}

	prepareDaemonRuntimeLeaseRekey(nextSessionId: string): { commit(): void; rollback(): void } {
		const owner = this.leaseOwnerValue;
		if (!owner) throw new Error("daemon runtime lease owner is unavailable for session replacement");
		const prepared = this.requireLeaseBroker().prepareDaemonRekey(
			owner,
			this.workspaceName,
			this.sessionId,
			nextSessionId,
		);
		if (!prepared.ok) throw new Error(`Unable to reserve conversation lease rekey: ${prepared.code}`);
		return {
			commit: () => {
				const result = this.requireLeaseBroker().commitDaemonRekey(prepared.reservation.id);
				if (!result.ok) throw new Error(`Unable to commit conversation lease rekey: ${result.code}`);
			},
			rollback: () => {
				this.requireLeaseBroker().rollbackDaemonRekey(prepared.reservation.id);
			},
		};
	}

	registerRelayLease(relayId: string): boolean {
		return this.requireLeaseBroker().registerRelay(this.workspaceName, this.sessionId, relayId);
	}

	unregisterRelayLease(relayId: string): void {
		this.requireLeaseBroker().unregisterRelay(this.workspaceName, this.sessionId, relayId);
	}

	beginTuiLeaseHandoff(connectionId: string): void {
		if (this.tuiLeaseConnectionIdValue !== undefined && this.tuiLeaseConnectionIdValue !== connectionId) {
			throw new Error("conversation TUI lease is already owned by another connection");
		}
		if (
			this.pendingTuiLeaseConnectionIdValue !== undefined &&
			this.pendingTuiLeaseConnectionIdValue !== connectionId
		) {
			throw new Error("conversation TUI handoff is already reserved by another connection");
		}
		this.pendingTuiLeaseConnectionIdValue = connectionId;
	}

	commitTuiLeaseHandoff(connectionId: string): void {
		if (this.pendingTuiLeaseConnectionIdValue !== connectionId && this.tuiLeaseConnectionIdValue !== connectionId) {
			throw new Error("conversation TUI handoff reservation is unavailable");
		}
		if (this.hasRuntime || this.leaseOwnerValue !== undefined) {
			throw new Error("cannot commit TUI lease authority while a daemon runtime is owned");
		}
		this.pendingTuiLeaseConnectionIdValue = undefined;
		this.tuiLeaseConnectionIdValue = connectionId;
	}

	cancelTuiLeaseHandoff(connectionId: string): boolean {
		if (this.pendingTuiLeaseConnectionIdValue !== connectionId) return false;
		this.pendingTuiLeaseConnectionIdValue = undefined;
		this.notifyIfVacant();
		return true;
	}

	releaseTuiLease(connectionId: string): boolean {
		let released = false;
		if (this.tuiLeaseConnectionIdValue === connectionId) {
			this.tuiLeaseConnectionIdValue = undefined;
			released = true;
		}
		if (this.pendingTuiLeaseConnectionIdValue === connectionId) {
			this.pendingTuiLeaseConnectionIdValue = undefined;
			released = true;
		}
		if (!released) return false;
		this.notifyIfVacant();
		return true;
	}

	rekeySession(nextSessionId: string): void {
		if (this.runtimeLifecycleValue !== "active" && this.tuiLeaseConnectionIdValue === undefined) {
			throw new Error("cannot rekey a conversation without active lease authority");
		}
		if (this.attachClaimSet.size !== 0) {
			throw new Error("cannot rekey a conversation while attach publication is in flight");
		}
		if (nextSessionId === this.currentSessionId) return;
		this.previousSessionIdSet.add(this.currentSessionId);
		this.currentSessionId = nextSessionId;
		this.generationValue++;
	}

	registerTransport(owner: ConversationTransportOwner): () => void {
		if (this.runtimeLifecycleValue === "retiring" || this.runtimeLifecycleValue === "retired") {
			throw new Error("conversation is retiring");
		}
		if (owner.kind === "direct" && this.runtimeLifecycleValue !== "active") {
			throw new Error("direct conversation transport requires an active daemon runtime");
		}
		if (owner.kind === "relay" && (this.hasRuntime || this.tuiLeaseConnectionIdValue === undefined)) {
			throw new Error("relay transport requires TUI lease authority without a daemon runtime");
		}
		if (this.transports.has(owner.id)) {
			throw new Error(`conversation transport already registered: ${owner.id}`);
		}
		const owned: OwnedConversationTransport = { owner, leaseActive: false };
		this.transports.set(owner.id, owned);
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			if (this.transports.get(owner.id) === owned) {
				this.transports.delete(owner.id);
				this.notifyIfVacant();
			}
		};
	}

	transportOwners(): ConversationTransportOwner[] {
		return Array.from(this.transports.values(), (transport) => transport.owner);
	}

	transportOwnersForClient(clientNodeId: string): ConversationTransportOwner[] {
		return this.transportOwners().filter((owner) => owner.clientNodeId === clientNodeId);
	}

	markTransportLeaseActive(transportId: string, active: boolean): boolean {
		const transport = this.transports.get(transportId);
		if (!transport || transport.owner.kind !== "direct") return false;
		transport.leaseActive = active;
		return true;
	}

	closeTransport(transportId: string, reason: string): Promise<boolean> {
		const transport = this.transports.get(transportId);
		if (!transport) return Promise.resolve(false);
		return this.startTransportClose(transport, reason).then(() => true);
	}

	async closeTransports(
		reason: string,
		predicate: (owner: ConversationTransportOwner) => boolean = () => true,
	): Promise<number> {
		const selected = Array.from(this.transports.values()).filter(({ owner }) => predicate(owner));
		const results = await Promise.allSettled(
			selected.map((transport) => this.startTransportClose(transport, reason)),
		);
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length > 0) {
			throw new AggregateError(errors, `failed to close ${errors.length} conversation transport(s)`);
		}
		return selected.length;
	}

	beginRuntimeRetirement(
		reason: string,
		finalizeRuntime: () => Promise<void> | void,
		options: BeginConversationRuntimeRetirementOptions = {},
	): ConversationRuntimeRetirement {
		if (this.runtimeRetirementValue) {
			return this.runtimeRetirementValue;
		}
		if (this.runtimeLifecycleValue === undefined || this.runtimeLifecycleValue === "retired") {
			const settled = Promise.resolve();
			return { finalization: settled, settled };
		}

		// Win terminal ownership synchronously before any close/finalization await.
		this.runtimeLifecycleValue = "retiring";
		this.generationValue++;
		this.invalidateAttachClaims();
		this.cancelDetachedRuntimeRetention();
		const transportsSettled = this.closeTransports(reason).then(() => undefined);
		const finalization =
			options.finalizationOrder === "concurrent"
				? Promise.resolve().then(finalizeRuntime)
				: (async () => {
						await transportsSettled.catch(() => undefined);
						await finalizeRuntime();
					})();

		const settled = Promise.allSettled([transportsSettled, finalization]).then((results) => {
			const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
			try {
				if (this.leaseOwnerValue !== undefined) {
					this.releaseDaemonRuntimeLease(reason);
				}
			} catch (error) {
				errors.push(error);
			}
			this.runtimeLifecycleValue = "retired";
			this.detachedAtValue = undefined;
			this.notifyIfVacant();
			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					`conversation retirement failed for ${this.workspaceName}/${this.sessionId}`,
				);
			}
		});
		this.runtimeRetirementValue = { finalization, settled };
		return this.runtimeRetirementValue;
	}

	private startTransportClose(transport: OwnedConversationTransport, reason: string): Promise<void> {
		if (transport.closePromise) return transport.closePromise;
		let resolveStarted: () => void = () => {};
		let rejectStarted: (error: unknown) => void = () => {};
		const started = new Promise<void>((resolve, reject) => {
			resolveStarted = resolve;
			rejectStarted = reject;
		});
		// Publish the close barrier before invoking owner code so a re-entrant close
		// joins it, while the owner itself is fenced synchronously in this call.
		transport.closePromise = started;
		try {
			Promise.resolve(transport.owner.close(reason)).then(resolveStarted, rejectStarted);
		} catch (error) {
			rejectStarted(error);
		}
		transport.closePromise = started.finally(() => {
			if (this.transports.get(transport.owner.id) === transport) {
				this.transports.delete(transport.owner.id);
				this.notifyIfVacant();
			}
		});
		return transport.closePromise;
	}

	private notifyIfVacant(): void {
		if (this.isVacant) {
			this.onVacant(this);
		}
	}

	private requireLeaseBroker(): LeaseBroker {
		if (!this.leaseBrokerValue) {
			throw new Error("conversation coordinator is not bound to the lease broker");
		}
		return this.leaseBrokerValue;
	}
}

/** Lookup index for stable conversation authorities, including rekey aliases. */
export class ConversationCoordinatorRegistry {
	private readonly coordinatorsByKey = new Map<string, ConversationCoordinator>();
	private readonly rekeyReservations = new Set<ConversationCoordinatorRekeyReservation>();
	private readonly rekeyReservationsByCoordinator = new Map<
		ConversationCoordinator,
		ConversationCoordinatorRekeyReservation
	>();
	private readonly rekeyReservationsByTarget = new Map<string, ConversationCoordinatorRekeyReservation>();
	private leaseBroker: LeaseBroker | undefined;

	get size(): number {
		return new Set(this.coordinatorsByKey.values()).size;
	}

	getRegistryKey(workspaceName: string, sessionId: string): string {
		return `${workspaceName}\0${sessionId}`;
	}

	get(workspaceName: string, sessionId: string): ConversationCoordinator | undefined {
		return this.coordinatorsByKey.get(this.getRegistryKey(workspaceName, sessionId));
	}

	getOrCreate(workspaceName: string, sessionId: string): ConversationCoordinator {
		const existing = this.get(workspaceName, sessionId);
		if (existing) return existing;
		if (this.rekeyReservationsByTarget.has(this.getRegistryKey(workspaceName, sessionId))) {
			throw new Error(`conversation coordinator rekey target is reserved for ${workspaceName}/${sessionId}`);
		}
		const coordinator = new ConversationCoordinator(workspaceName, sessionId, (candidate) => {
			this.releaseIfVacant(candidate);
		});
		if (this.leaseBroker) coordinator.bindLeaseBroker(this.leaseBroker);
		this.coordinatorsByKey.set(this.getRegistryKey(workspaceName, sessionId), coordinator);
		return coordinator;
	}

	bindLeaseBroker(leaseBroker: LeaseBroker): void {
		if (this.leaseBroker && this.leaseBroker !== leaseBroker) {
			throw new Error("conversation coordinator registry is already bound to another lease broker");
		}
		this.leaseBroker = leaseBroker;
		for (const coordinator of this.values()) {
			coordinator.bindLeaseBroker(leaseBroker);
		}
	}

	reserveRuntime(workspaceName: string, sessionId: string): ConversationCoordinator {
		const coordinator = this.getOrCreate(workspaceName, sessionId);
		coordinator.prepareRuntime();
		return coordinator;
	}

	rekey(coordinator: ConversationCoordinator, nextSessionId: string): void {
		const reservation = this.prepareRekey(coordinator, nextSessionId);
		try {
			this.commitRekey(reservation);
		} catch (error) {
			this.rollbackRekey(reservation);
			throw error;
		}
	}

	prepareRekey(coordinator: ConversationCoordinator, nextSessionId: string): ConversationCoordinatorRekeyReservation {
		const existingReservation = this.rekeyReservationsByCoordinator.get(coordinator);
		if (existingReservation) {
			if (existingReservation.nextSessionId === nextSessionId) return existingReservation;
			throw new Error(`conversation coordinator already has a pending session rekey`);
		}
		const targetKey = this.getRegistryKey(coordinator.workspaceName, nextSessionId);
		const targetOwner = this.coordinatorsByKey.get(targetKey);
		if (targetOwner && targetOwner !== coordinator) {
			throw new Error(`conversation coordinator already active for ${coordinator.workspaceName}/${nextSessionId}`);
		}
		const targetReservation = this.rekeyReservationsByTarget.get(targetKey);
		if (targetReservation && targetReservation.coordinator !== coordinator) {
			throw new Error(
				`conversation coordinator rekey target is reserved for ${coordinator.workspaceName}/${nextSessionId}`,
			);
		}
		if (!this.values().includes(coordinator)) {
			throw new Error("conversation coordinator is not registered");
		}
		const reservation: ConversationCoordinatorRekeyReservation = {
			coordinator,
			previousSessionId: coordinator.sessionId,
			nextSessionId,
		};
		this.rekeyReservations.add(reservation);
		this.rekeyReservationsByCoordinator.set(coordinator, reservation);
		this.rekeyReservationsByTarget.set(targetKey, reservation);
		return reservation;
	}

	commitRekey(reservation: ConversationCoordinatorRekeyReservation): void {
		if (
			!this.rekeyReservations.has(reservation) ||
			this.rekeyReservationsByCoordinator.get(reservation.coordinator) !== reservation ||
			reservation.coordinator.sessionId !== reservation.previousSessionId
		) {
			throw new Error("conversation coordinator rekey reservation is no longer current");
		}
		const targetKey = this.getRegistryKey(reservation.coordinator.workspaceName, reservation.nextSessionId);
		if (this.rekeyReservationsByTarget.get(targetKey) !== reservation) {
			throw new Error("conversation coordinator rekey target reservation is no longer current");
		}
		const targetOwner = this.coordinatorsByKey.get(targetKey);
		if (targetOwner && targetOwner !== reservation.coordinator) {
			throw new Error(
				`conversation coordinator already active for ${reservation.coordinator.workspaceName}/${reservation.nextSessionId}`,
			);
		}
		reservation.coordinator.rekeySession(reservation.nextSessionId);
		this.clearRekeyReservation(reservation);
		this.coordinatorsByKey.set(
			this.getRegistryKey(reservation.coordinator.workspaceName, reservation.previousSessionId),
			reservation.coordinator,
		);
		this.coordinatorsByKey.set(targetKey, reservation.coordinator);
	}

	rollbackRekey(reservation: ConversationCoordinatorRekeyReservation): boolean {
		if (!this.rekeyReservations.has(reservation)) return false;
		this.clearRekeyReservation(reservation);
		return true;
	}

	private clearRekeyReservation(reservation: ConversationCoordinatorRekeyReservation): void {
		this.rekeyReservations.delete(reservation);
		if (this.rekeyReservationsByCoordinator.get(reservation.coordinator) === reservation) {
			this.rekeyReservationsByCoordinator.delete(reservation.coordinator);
		}
		const targetKey = this.getRegistryKey(reservation.coordinator.workspaceName, reservation.nextSessionId);
		if (this.rekeyReservationsByTarget.get(targetKey) === reservation) {
			this.rekeyReservationsByTarget.delete(targetKey);
		}
	}

	values(): ConversationCoordinator[] {
		return Array.from(new Set(this.coordinatorsByKey.values()));
	}

	releaseIfVacant(coordinator: ConversationCoordinator): boolean {
		if (!coordinator.isVacant) return false;
		let removed = false;
		for (const [key, owner] of this.coordinatorsByKey) {
			if (owner !== coordinator) continue;
			this.coordinatorsByKey.delete(key);
			removed = true;
		}
		return removed;
	}
}

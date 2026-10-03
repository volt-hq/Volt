/**
 * The single operation coordinator (RFC §5.1): at most one exclusive
 * operation at a time, one reserved successor, counted non-exclusive
 * activities, and the busy state derived from them. A shared admission gate
 * is its suspend fence: a suspension rejects new admission and revokes
 * reservations that have not started, but never interrupts started work.
 */

import type { AgentAbortAcceptance, AgentAbortSource } from "../types.ts";
import { AdmissionGate } from "./admission-gate.ts";

/** Lifecycle stage of one exclusive operation. */
export type OperationStage = "admitted" | "executing" | "terminalizing" | "notifying" | "settled";

/** Non-exclusive work the coordinator counts toward `busy` but never serializes. */
export type ConversationActivityKind = "bash" | "extension_command" | "background";

const ACTIVITY_KINDS: readonly ConversationActivityKind[] = ["bash", "extension_command", "background"];

/** Abort authority of one operation. Sealing makes a late abort request a no-op. */
export class OperationAbortGate {
	private readonly controller = new AbortController();
	private sealed = false;

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get isSealed(): boolean {
		return this.sealed;
	}

	seal(): boolean {
		if (this.sealed) return false;
		this.sealed = true;
		return true;
	}

	request(): boolean {
		if (this.sealed) return false;
		this.controller.abort();
		return true;
	}
}

export interface OperationLease<TKind extends string> {
	readonly id: string;
	readonly admissionRevision: number;
	kind: TKind;
	readonly abortGate: OperationAbortGate;
	stage: OperationStage;
	abortSource?: AgentAbortSource;
	diagnosticTimestamp?: number;
	requestAccepted: boolean;
}

export interface SuccessorReservation<TKind extends string> {
	readonly lease: OperationLease<TKind>;
	/** Settles when the successor becomes the active operation or is cancelled. */
	readonly ready: Promise<void>;
	cancel(): boolean;
}

/** The derived busy state, published after every change. */
export interface CoordinatorPhase<TKind extends string> {
	/** The active exclusive operation, or `null` when none is reserved or running. */
	readonly operation: TKind | null;
	readonly activities: Readonly<Record<ConversationActivityKind, number>>;
	/** An exclusive operation is reserved or running, or an activity is counted. */
	readonly busy: boolean;
}

export interface OperationCoordinatorOptions<TKind extends string> {
	/** Shared host admission fence. Defaults to an independent gate. */
	readonly admissionGate?: AdmissionGate;
	/** Creates the error thrown when admission is suspended or revoked. */
	readonly busyError?: (message: string) => Error;
	/** Prefix of operation lease ids. */
	readonly leaseIdPrefix?: string;
	/** Called synchronously after every change of the derived phase. */
	readonly onPhaseChange?: (phase: CoordinatorPhase<TKind>) => void;
}

interface PendingSuccessor<TKind extends string> {
	lease: OperationLease<TKind>;
	ready: Promise<void>;
	resolveReady(): void;
	cancelled: boolean;
}

/** Owns admission and abort authority for every exclusive operation, plus counted activities. */
export class OperationCoordinator<TKind extends string> {
	private readonly admissionGate: AdmissionGate;
	private readonly busyError: (message: string) => Error;
	private readonly leaseIdPrefix: string;
	private readonly onPhaseChange: ((phase: CoordinatorPhase<TKind>) => void) | undefined;
	private active: OperationLease<TKind> | undefined;
	private successor: PendingSuccessor<TKind> | undefined;
	private readonly successorSettlementWaiters = new Map<string, Array<() => void>>();
	private readonly activityCounts: Record<ConversationActivityKind, number> = {
		bash: 0,
		extension_command: 0,
		background: 0,
	};
	private lifecycle: "open" | "closing" | "closed" = "open";
	private resolveIdle: (() => void) | undefined;
	private idlePromise: Promise<void> = Promise.resolve();
	private notBusyWaiters: Array<() => void> = [];
	private publishedPhase: CoordinatorPhase<TKind>;
	private resolveClosed: (() => void) | undefined;
	private readonly closedPromise = new Promise<void>((resolve) => {
		this.resolveClosed = resolve;
	});

	constructor(options: OperationCoordinatorOptions<TKind> = {}) {
		this.admissionGate = options.admissionGate ?? new AdmissionGate();
		this.busyError = options.busyError ?? ((message) => new Error(message));
		this.leaseIdPrefix = options.leaseIdPrefix ?? "operation";
		this.onPhaseChange = options.onPhaseChange;
		this.publishedPhase = this.computePhase();
	}

	get current(): OperationLease<TKind> | undefined {
		return this.active;
	}

	get isOpen(): boolean {
		return this.lifecycle === "open";
	}

	get isClosing(): boolean {
		return this.lifecycle !== "open";
	}

	get busy(): boolean {
		return this.publishedPhase.busy;
	}

	get phase(): CoordinatorPhase<TKind> {
		return this.publishedPhase;
	}

	/** Whether admission is currently open; does not consider the active operation. */
	get admissionOpen(): boolean {
		return this.admissionGate.isOpen;
	}

	private assertAdmissionOpen(): void {
		if (!this.admissionGate.isOpen) throw this.busyError("Operation admission is suspended");
	}

	/** Reserve the idle coordinator synchronously, or return undefined when it is occupied or closed. */
	reserve(kind: TKind): OperationLease<TKind> | undefined {
		this.assertAdmissionOpen();
		if (this.lifecycle !== "open" || this.active || this.successor) return undefined;
		const lease = this.createLease(kind);
		this.active = lease;
		this.beginBusyPeriod();
		this.publishPhase();
		return lease;
	}

	reserveSuccessor(kind: TKind): SuccessorReservation<TKind> | undefined {
		this.assertAdmissionOpen();
		if (this.lifecycle !== "open" || !this.active || this.successor) return undefined;
		return this.createSuccessor(kind);
	}

	/** Replace a known pending successor without opening an idle admission gap. */
	reserveSuccessorReplacing(replacedKind: TKind, kind: TKind): SuccessorReservation<TKind> | undefined {
		this.assertAdmissionOpen();
		if (this.lifecycle !== "open" || !this.active || this.successor?.lease.kind !== replacedKind) return undefined;
		const replaced = this.successor;
		replaced.cancelled = true;
		this.successor = undefined;
		const replacement = this.createSuccessor(kind);
		const inheritedWaiters = this.successorSettlementWaiters.get(replaced.lease.id) ?? [];
		this.successorSettlementWaiters.delete(replaced.lease.id);
		this.successorSettlementWaiters.set(replacement.lease.id, [...inheritedWaiters, replaced.resolveReady]);
		return replacement;
	}

	private createSuccessor(kind: TKind): SuccessorReservation<TKind> {
		const lease = this.createLease(kind);
		let resolveReady = (): void => undefined;
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const pending: PendingSuccessor<TKind> = { lease, ready, resolveReady, cancelled: false };
		this.successor = pending;
		return {
			lease,
			ready,
			cancel: () => {
				if (this.successor !== pending) return false;
				pending.cancelled = true;
				this.successor = undefined;
				resolveReady();
				this.resolveSuccessorSettlementWaiters(lease);
				return true;
			},
		};
	}

	private resolveSuccessorSettlementWaiters(lease: OperationLease<TKind>): void {
		const waiters = this.successorSettlementWaiters.get(lease.id);
		if (!waiters) return;
		this.successorSettlementWaiters.delete(lease.id);
		for (const resolve of waiters) resolve();
	}

	private createLease(kind: TKind): OperationLease<TKind> {
		return {
			id: `${this.leaseIdPrefix}:${globalThis.crypto.randomUUID()}`,
			admissionRevision: this.admissionGate.revision,
			kind,
			abortGate: new OperationAbortGate(),
			stage: "admitted",
			requestAccepted: false,
		};
	}

	private beginBusyPeriod(): void {
		this.idlePromise = new Promise<void>((resolve) => {
			this.resolveIdle = resolve;
		});
	}

	start(lease: OperationLease<TKind>): void {
		if (this.active !== lease || lease.stage !== "admitted") {
			throw new Error("Operation lease cannot start");
		}
		if (!this.admissionGate.isCurrent(lease.admissionRevision)) {
			this.finish(lease);
			throw this.busyError("Operation admission was revoked");
		}
		lease.stage = "executing";
	}

	/** Whether an admitted lease can still start: it is active and admission was not suspended since it was reserved. */
	canStart(lease: OperationLease<TKind>): boolean {
		return (
			this.active === lease && lease.stage === "admitted" && this.admissionGate.isCurrent(lease.admissionRevision)
		);
	}

	reclassify(lease: OperationLease<TKind>, kind: TKind): boolean {
		if (this.active !== lease || lease.stage !== "admitted") return false;
		if (!this.admissionGate.isCurrent(lease.admissionRevision)) {
			this.finish(lease);
			return false;
		}
		lease.kind = kind;
		this.publishPhase();
		return true;
	}

	sealTerminal(lease: OperationLease<TKind>): boolean {
		if (this.active !== lease || lease.stage === "settled") return false;
		if (!lease.abortGate.seal()) return false;
		lease.stage = "terminalizing";
		return true;
	}

	beginNotifications(lease: OperationLease<TKind>): void {
		if (this.active !== lease || lease.stage === "settled") return;
		lease.stage = "notifying";
	}

	finish(lease: OperationLease<TKind>): void {
		if (this.active !== lease) return;
		lease.stage = "settled";
		this.resolveSuccessorSettlementWaiters(lease);
		const successor = this.successor;
		this.successor = undefined;
		if (
			successor &&
			!successor.cancelled &&
			this.lifecycle === "open" &&
			this.admissionGate.isCurrent(successor.lease.admissionRevision)
		) {
			this.active = successor.lease;
			this.publishPhase();
			successor.resolveReady();
			return;
		}
		if (successor) {
			successor.cancelled = true;
			successor.lease.stage = "settled";
			successor.resolveReady();
			this.resolveSuccessorSettlementWaiters(successor.lease);
		}
		this.active = undefined;
		const resolveIdle = this.resolveIdle;
		this.resolveIdle = undefined;
		resolveIdle?.();
		this.publishPhase();
		if (this.lifecycle === "closing") this.finishClose();
	}

	requestAbort(source?: AgentAbortSource): AgentAbortAcceptance {
		const lease = this.active;
		if (!lease || lease.stage === "settled" || lease.abortGate.isSealed || lease.abortGate.signal.aborted) {
			return Object.freeze({
				runId: lease?.id,
				accepted: false,
				source: lease?.abortSource,
			});
		}
		if (source !== undefined && lease.abortSource === undefined) {
			lease.abortSource = source;
			lease.diagnosticTimestamp = Date.now();
		}
		lease.abortGate.request();
		return Object.freeze({ runId: lease.id, accepted: true, source: lease.abortSource });
	}

	requestClose(source: AgentAbortSource = "disposal"): boolean {
		if (this.lifecycle !== "open") return false;
		this.lifecycle = "closing";
		const successor = this.successor;
		this.successor = undefined;
		if (successor) {
			successor.cancelled = true;
			successor.resolveReady();
			this.resolveSuccessorSettlementWaiters(successor.lease);
		}
		this.requestAbort(source);
		if (!this.active) this.finishClose();
		return true;
	}

	/**
	 * Count one non-exclusive activity until the returned release runs. Admission
	 * must be open; release is idempotent.
	 */
	beginActivity(kind: ConversationActivityKind): () => void {
		this.assertAdmissionOpen();
		if (this.lifecycle !== "open") throw this.busyError("Operation admission is closed");
		this.activityCounts[kind]++;
		this.publishPhase();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activityCounts[kind]--;
			this.publishPhase();
		};
	}

	/** Resolves when no exclusive operation is reserved or running. */
	waitForIdle(): Promise<void> {
		return this.idlePromise;
	}

	/** Resolves when nothing is busy: no exclusive operation and no counted activity. */
	waitForNotBusy(): Promise<void> {
		if (!this.publishedPhase.busy) return Promise.resolve();
		return new Promise((resolve) => this.notBusyWaiters.push(resolve));
	}

	waitForClosed(): Promise<void> {
		return this.closedPromise;
	}

	private finishClose(): void {
		if (this.lifecycle !== "closing") return;
		this.lifecycle = "closed";
		this.resolveClosed?.();
		this.resolveClosed = undefined;
	}

	private computePhase(): CoordinatorPhase<TKind> {
		const activities = Object.freeze({ ...this.activityCounts });
		const operation = this.active?.kind ?? null;
		const busy = operation !== null || ACTIVITY_KINDS.some((kind) => activities[kind] > 0);
		return Object.freeze({ operation, activities, busy });
	}

	private publishPhase(): void {
		const next = this.computePhase();
		const previous = this.publishedPhase;
		if (
			next.operation === previous.operation &&
			next.busy === previous.busy &&
			ACTIVITY_KINDS.every((kind) => next.activities[kind] === previous.activities[kind])
		) {
			return;
		}
		this.publishedPhase = next;
		if (!next.busy) {
			const waiters = this.notBusyWaiters;
			this.notBusyWaiters = [];
			for (const resolve of waiters) resolve();
		}
		this.onPhaseChange?.(next);
	}
}

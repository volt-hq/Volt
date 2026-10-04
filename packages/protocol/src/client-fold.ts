/**
 * The client fold: what a client knows about a conversation is
 * `clientFold(entries)` over the projected entries it received (RFC §4.3,
 * §6.1). It mirrors the kernel fold for what clients see: the active leaf, the
 * branch's model, thinking level, Fast mode, and planning state, the name,
 * labels, the pending client inputs (the delivery queue), and fork lineage.
 *
 * The fold is pure and tolerant of what profiles hide. Ordinals must increase
 * but may skip; a parent, input, or label target the client never received is
 * not an error. A `public` entry becomes the leaf when appended, a `leaf` entry
 * moves it, and other host entries never do, exactly as in the kernel.
 * Moving to another branch re-derives the branch values along the entries the
 * client holds; values with no change on that path come from `base`: the
 * defaults for a fold from the first entry, or the snapshot's values when a
 * bounded snapshot (`earlier: true`) stands in for the history before its
 * entries.
 *
 * A snapshot frame carries `ClientSnapshot` at ordinal N; `clientRestore(N,
 * snapshot)` followed by the entries after N equals the fold of every entry.
 * States are immutable: a returned state shares unchanged parts with its basis,
 * and entries are shared by reference, never copied.
 */

import { type Static, Type } from "typebox";
import {
	ClientInputCommandSchema,
	ClientInputQueuedDeliverySchema,
	type ClientInputQueuedEntryPayload,
	type ClientInputReceiptEntryPayload,
	type ClientInputStateEntryPayload,
	type ForkedFromEntryPayload,
	ForkedFromEntryPayloadSchema,
	LogEntryIdSchema,
	LogEntryOrdinalSchema,
	LogEntryTimestampSchema,
} from "./entries.ts";
import { stringEnum } from "./helpers.ts";
import { type PlanningState, RpcPlanningStateSchema } from "./planning.ts";
import { RpcClientMessageIdSchema, RpcThinkingLevelSchema } from "./primitives.ts";
import { isPublicProjectedEntryType, type ProjectedEntry, ProjectedEntrySchema } from "./projected.ts";

const closed = { additionalProperties: false } as const;

// ============================================================================
// Snapshot schema
// ============================================================================

/** The model the active branch uses: its latest model change or assistant message. */
export const ClientModelRefSchema = Type.Object(
	{ provider: Type.String(), modelId: Type.String() },
	{ ...closed, description: "A model, by provider and model id." },
);
export type ClientModelRef = Static<typeof ClientModelRefSchema>;

/** A user-defined bookmark on a conversation entry. */
export const ClientLabelSchema = Type.Object(
	{ targetId: LogEntryIdSchema, label: Type.String(), timestamp: LogEntryTimestampSchema },
	closed,
);
export type ClientLabel = Static<typeof ClientLabelSchema>;

/**
 * One pending client input. `accepted` inputs wait for dispatch, queued as
 * `delivery` when they have one; `started` inputs are being delivered. An input
 * leaves the queue when it completes, fails, or is withdrawn.
 */
export const ClientQueuedInputSchema = Type.Object(
	{
		clientMessageId: RpcClientMessageIdSchema,
		state: stringEnum(["accepted", "started"]),
		/** Admission ordinal: the queued entry's ordinal once queued, before that the receipt's. */
		ordinal: LogEntryOrdinalSchema,
		/** Present when the client received the input's receipt. */
		command: Type.Optional(ClientInputCommandSchema),
		delivery: Type.Optional(ClientInputQueuedDeliverySchema),
		/** `host` on input the host submitted itself. */
		origin: Type.Optional(Type.Literal("host")),
		message: Type.String(),
		imageCount: Type.Integer({ minimum: 0 }),
	},
	closed,
);
export type ClientQueuedInput = Static<typeof ClientQueuedInputSchema>;

/** A client fold result, as a snapshot frame carries it at its ordinal. */
export const ClientSnapshotSchema = Type.Object(
	{
		leafId: Type.Union([LogEntryIdSchema, Type.Null()]),
		/** Projected entries in ordinal order: every entry, or a bounded tail of the active branch. */
		entries: Type.Array(ProjectedEntrySchema),
		/** True when older entries exist before `entries`; page them with the `history` query. */
		earlier: Type.Boolean(),
		model: Type.Union([ClientModelRefSchema, Type.Null()]),
		thinkingLevel: RpcThinkingLevelSchema,
		fastMode: Type.Boolean(),
		planning: Type.Union([RpcPlanningStateSchema, Type.Null()]),
		name: Type.Union([Type.String(), Type.Null()]),
		labels: Type.Array(ClientLabelSchema),
		/** Pending client inputs by admission ordinal. */
		queue: Type.Array(ClientQueuedInputSchema),
		/** Present on a conversation created by fork, clone, or import. */
		forkedFrom: Type.Optional(ForkedFromEntryPayloadSchema),
	},
	closed,
);
export type ClientSnapshot = Static<typeof ClientSnapshotSchema>;

// ============================================================================
// State
// ============================================================================

type ThinkingLevel = Static<typeof RpcThinkingLevelSchema>;

/** The values the active branch's change entries determine. */
export interface ClientBranchValues {
	readonly model: ClientModelRef | null;
	readonly thinkingLevel: ThinkingLevel;
	readonly fastMode: boolean;
	readonly planning: PlanningState | null;
}

export interface ClientLabelValue {
	readonly label: string;
	readonly timestamp: string;
}

export interface ClientState extends ClientBranchValues {
	/** The client's position: the newest ordinal it saw in an entry, a head frame, or a snapshot. */
	readonly ordinal: number;
	/** Every entry the client holds, in ordinal order. */
	readonly entries: readonly ProjectedEntry[];
	readonly byId: ReadonlyMap<string, ProjectedEntry>;
	readonly earlier: boolean;
	readonly leafId: string | null;
	readonly name: string | null;
	/** Labels by target entry id. */
	readonly labels: ReadonlyMap<string, ClientLabelValue>;
	/** Pending client inputs by admission ordinal. */
	readonly queue: readonly ClientQueuedInput[];
	readonly forkedFrom: ForkedFromEntryPayload | null;
	/** Branch values before the oldest entry the client holds. */
	readonly base: ClientBranchValues;
}

/** Branch values of a conversation with no change entries. */
export const DEFAULT_CLIENT_BRANCH_VALUES: ClientBranchValues = Object.freeze({
	model: null,
	thinkingLevel: "off",
	fastMode: false,
	planning: null,
});

/** An entry or position the client fold cannot accept. */
export class ClientFoldError extends Error {
	readonly ordinal: number;

	constructor(ordinal: number, message: string) {
		super(`Projected entry at ordinal ${ordinal}: ${message}`);
		this.name = "ClientFoldError";
		this.ordinal = ordinal;
	}
}

const EMPTY_STATE: ClientState = Object.freeze({
	ordinal: 0,
	entries: Object.freeze([]),
	byId: new Map(),
	earlier: false,
	leafId: null,
	...DEFAULT_CLIENT_BRANCH_VALUES,
	name: null,
	labels: new Map(),
	queue: Object.freeze([]),
	forkedFrom: null,
	base: DEFAULT_CLIENT_BRANCH_VALUES,
});

/** The state of a client that holds nothing yet. */
export function emptyClientState(): ClientState {
	return EMPTY_STATE;
}

function modelRef(provider: string, modelId: string): ClientModelRef {
	return Object.freeze({ provider, modelId });
}

/** The held entries from the root of the held path to `leafId`; stops at an entry the client does not hold. */
function heldBranch(byId: ReadonlyMap<string, ProjectedEntry>, leafId: string | null): ProjectedEntry[] {
	const path: ProjectedEntry[] = [];
	const seen = new Set<string>();
	for (let id = leafId; id !== null && !seen.has(id); ) {
		seen.add(id);
		const entry = byId.get(id);
		if (!entry) break;
		path.push(entry);
		id = entry.parentId;
	}
	return path.reverse();
}

/**
 * A mutable working copy of one state. Collections are copied on first write
 * and owned copies are changed in place, so folding a batch costs one copy of
 * each collection it touches, and the basis state is never touched.
 */
class ClientStateBuilder {
	private readonly basis: ClientState;
	private readonly owned = new Set<object>();
	private ordinal: number;
	private entries: readonly ProjectedEntry[];
	private byId: ReadonlyMap<string, ProjectedEntry>;
	private leafId: string | null;
	private model: ClientModelRef | null;
	private thinkingLevel: ThinkingLevel;
	private fastMode: boolean;
	private planning: PlanningState | null;
	private name: string | null;
	private labels: ReadonlyMap<string, ClientLabelValue>;
	private queue: readonly ClientQueuedInput[];
	private forkedFrom: ForkedFromEntryPayload | null;

	constructor(basis: ClientState) {
		this.basis = basis;
		this.ordinal = basis.ordinal;
		this.entries = basis.entries;
		this.byId = basis.byId;
		this.leafId = basis.leafId;
		this.model = basis.model;
		this.thinkingLevel = basis.thinkingLevel;
		this.fastMode = basis.fastMode;
		this.planning = basis.planning;
		this.name = basis.name;
		this.labels = basis.labels;
		this.queue = basis.queue;
		this.forkedFrom = basis.forkedFrom;
	}

	apply(entry: ProjectedEntry): void {
		if (entry.ordinal <= this.ordinal) {
			throw new ClientFoldError(entry.ordinal, `expected an ordinal after ${this.ordinal}`);
		}
		if (this.byId.has(entry.id)) throw new ClientFoldError(entry.ordinal, `duplicate entry id ${entry.id}`);
		this.entries = this.appended(this.entries, entry);
		const byId = this.writableMap(this.byId);
		this.byId = byId;
		byId.set(entry.id, entry);
		this.applyRecords(entry);
		if (entry.type === "leaf") {
			if (entry.payload) this.moveLeaf(entry.payload.targetId);
		} else if (isPublicProjectedEntryType(entry.type)) {
			this.appendToBranch(entry);
		}
		this.ordinal = entry.ordinal;
	}

	advance(ordinal: number): void {
		if (ordinal < this.ordinal) throw new ClientFoldError(ordinal, `position is already ${this.ordinal}`);
		this.ordinal = ordinal;
	}

	finish(): ClientState {
		const basis = this.basis;
		for (const value of this.owned) {
			if (Array.isArray(value)) Object.freeze(value);
		}
		const unchanged =
			this.ordinal === basis.ordinal &&
			this.entries === basis.entries &&
			this.leafId === basis.leafId &&
			this.model === basis.model &&
			this.thinkingLevel === basis.thinkingLevel &&
			this.fastMode === basis.fastMode &&
			this.planning === basis.planning &&
			this.name === basis.name &&
			this.labels === basis.labels &&
			this.queue === basis.queue &&
			this.forkedFrom === basis.forkedFrom;
		if (unchanged) return basis;
		return Object.freeze({
			ordinal: this.ordinal,
			entries: this.entries,
			byId: this.byId,
			earlier: basis.earlier,
			leafId: this.leafId,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			fastMode: this.fastMode,
			planning: this.planning,
			name: this.name,
			labels: this.labels,
			queue: this.queue,
			forkedFrom: this.forkedFrom,
			base: basis.base,
		});
	}

	/** Name, labels, lineage, and client inputs: the records that do not depend on the branch. */
	private applyRecords(entry: ProjectedEntry): void {
		switch (entry.type) {
			case "client_input_receipt":
				if (entry.payload) this.receive(entry.payload, entry.ordinal);
				return;
			case "client_input_queued":
				if (entry.payload) this.enqueue(entry.payload, entry.ordinal);
				return;
			case "client_input_state":
				if (entry.payload) this.transition(entry.payload);
				return;
			case "message": {
				const clientMessageId = entry.payload?.clientMessageId ?? entry.view?.clientMessageId;
				if (clientMessageId !== undefined) this.removeInput(clientMessageId);
				return;
			}
			case "label":
				if (entry.payload) this.setLabel(entry.payload.targetId, entry.payload.label, entry.timestamp);
				return;
			case "session_info":
				if (entry.payload) this.name = entry.payload.name?.trim() || null;
				return;
			case "forked_from":
				if (entry.payload) this.forkedFrom = entry.payload;
				return;
			default:
				return;
		}
	}

	private moveLeaf(targetId: string | null): void {
		if (targetId === this.leafId) return;
		this.leafId = targetId;
		this.rederive();
	}

	/** A public entry becomes the leaf; extending the branch updates the branch values in place. */
	private appendToBranch(entry: ProjectedEntry): void {
		const extendsBranch = entry.parentId === this.leafId;
		this.leafId = entry.id;
		if (extendsBranch) this.applyBranchValue(entry);
		else this.rederive();
	}

	private applyBranchValue(entry: ProjectedEntry): void {
		switch (entry.type) {
			case "model_change":
				if (entry.payload) this.model = modelRef(entry.payload.provider, entry.payload.modelId);
				return;
			case "thinking_level_change":
				if (entry.payload) this.thinkingLevel = entry.payload.thinkingLevel;
				return;
			case "fast_mode_change":
				if (entry.payload) this.fastMode = entry.payload.enabled;
				return;
			case "planning_state_change":
				if (entry.payload) this.planning = entry.payload.planning;
				return;
			case "message": {
				const message = entry.payload?.message;
				if (message?.role === "assistant") this.model = modelRef(message.provider, message.model);
				return;
			}
			default:
				return;
		}
	}

	/** Branch values from scratch: `base`, then every change along the held path from the root to the leaf. */
	private rederive(): void {
		const base = this.basis.base;
		this.model = base.model;
		this.thinkingLevel = base.thinkingLevel;
		this.fastMode = base.fastMode;
		this.planning = base.planning;
		for (const entry of heldBranch(this.byId, this.leafId)) this.applyBranchValue(entry);
	}

	private receive(payload: ClientInputReceiptEntryPayload, ordinal: number): void {
		this.upsertInput(
			Object.freeze({
				clientMessageId: payload.clientMessageId,
				state: "accepted",
				ordinal,
				command: payload.command,
				...(payload.origin === undefined ? {} : { origin: payload.origin }),
				message: payload.input.message,
				imageCount: payload.input.images.length,
			}),
		);
	}

	private enqueue(payload: ClientInputQueuedEntryPayload, ordinal: number): void {
		const existing = this.queue.find((input) => input.clientMessageId === payload.clientMessageId);
		this.upsertInput(
			Object.freeze({
				clientMessageId: payload.clientMessageId,
				state: "accepted",
				ordinal,
				...(existing?.command === undefined ? {} : { command: existing.command }),
				delivery: payload.queuedInput.delivery,
				...(existing?.origin === undefined ? {} : { origin: existing.origin }),
				message: payload.queuedInput.message,
				imageCount: payload.queuedInput.images.length,
			}),
		);
	}

	private transition(payload: ClientInputStateEntryPayload): void {
		const existing = this.queue.find((input) => input.clientMessageId === payload.clientMessageId);
		if (!existing) return;
		if (payload.state === "accepted" || payload.state === "started") {
			if (existing.state !== payload.state) this.upsertInput(Object.freeze({ ...existing, state: payload.state }));
		} else {
			this.removeInput(payload.clientMessageId);
		}
	}

	/** Insert or replace an input, keeping the queue in admission order. */
	private upsertInput(input: ClientQueuedInput): void {
		const queue = this.queue.filter((candidate) => candidate.clientMessageId !== input.clientMessageId);
		this.owned.add(queue);
		const index = queue.findIndex((candidate) => candidate.ordinal > input.ordinal);
		queue.splice(index === -1 ? queue.length : index, 0, input);
		this.queue = queue;
	}

	private removeInput(clientMessageId: string): void {
		if (!this.queue.some((input) => input.clientMessageId === clientMessageId)) return;
		const queue = this.queue.filter((input) => input.clientMessageId !== clientMessageId);
		this.owned.add(queue);
		this.queue = queue;
	}

	private setLabel(targetId: string, label: string | undefined, timestamp: string): void {
		if (!label && !this.labels.has(targetId)) return;
		const labels = this.writableMap(this.labels);
		this.labels = labels;
		if (label) labels.set(targetId, Object.freeze({ label, timestamp }));
		else labels.delete(targetId);
	}

	/** `list` with `value` appended: in place when this builder owns it, otherwise as an owned copy. */
	private appended<T>(list: readonly T[], value: T): T[] {
		if (this.owned.has(list)) {
			const owned = list as T[];
			owned.push(value);
			return owned;
		}
		const next = [...list, value];
		this.owned.add(next);
		return next;
	}

	/** `map` when this builder owns it, otherwise an owned copy. */
	private writableMap<K, V>(map: ReadonlyMap<K, V>): Map<K, V> {
		if (this.owned.has(map)) return map as Map<K, V>;
		const copy = new Map(map);
		this.owned.add(copy);
		return copy;
	}
}

// ============================================================================
// Fold, snapshot, restore
// ============================================================================

/** Fold projected entries, in ordinal order, onto `initial` (an empty client by default). */
export function clientFold(entries: Iterable<ProjectedEntry>, initial: ClientState = emptyClientState()): ClientState {
	const builder = new ClientStateBuilder(initial);
	for (const entry of entries) builder.apply(entry);
	return builder.finish();
}

/** Advance the position over entries the profile hides (a `head` frame). */
export function clientAdvance(state: ClientState, ordinal: number): ClientState {
	const builder = new ClientStateBuilder(state);
	builder.advance(ordinal);
	return builder.finish();
}

/** Serialize a state; a snapshot frame carries it with the state's ordinal. */
export function clientSnapshot(state: ClientState): ClientSnapshot {
	return {
		leafId: state.leafId,
		entries: [...state.entries],
		earlier: state.earlier,
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		fastMode: state.fastMode,
		planning: state.planning,
		name: state.name,
		labels: [...state.labels].map(([targetId, value]) => ({
			targetId,
			label: value.label,
			timestamp: value.timestamp,
		})),
		queue: [...state.queue],
		...(state.forkedFrom === null ? {} : { forkedFrom: state.forkedFrom }),
	};
}

/** The state a snapshot at `ordinal` describes. Entries are adopted by reference. */
export function clientRestore(ordinal: number, snapshot: ClientSnapshot): ClientState {
	const entries: ProjectedEntry[] = [];
	const byId = new Map<string, ProjectedEntry>();
	let previous = 0;
	for (const entry of snapshot.entries) {
		if (entry.ordinal <= previous) throw new ClientFoldError(entry.ordinal, `expected an ordinal after ${previous}`);
		if (entry.ordinal > ordinal) throw new ClientFoldError(entry.ordinal, `snapshot is at ordinal ${ordinal}`);
		if (byId.has(entry.id)) throw new ClientFoldError(entry.ordinal, `duplicate entry id ${entry.id}`);
		entries.push(entry);
		byId.set(entry.id, entry);
		previous = entry.ordinal;
	}
	const values: ClientBranchValues = Object.freeze({
		model: snapshot.model === null ? null : modelRef(snapshot.model.provider, snapshot.model.modelId),
		thinkingLevel: snapshot.thinkingLevel,
		fastMode: snapshot.fastMode,
		planning: snapshot.planning,
	});
	return Object.freeze({
		ordinal,
		entries: Object.freeze(entries),
		byId,
		earlier: snapshot.earlier,
		leafId: snapshot.leafId,
		...values,
		name: snapshot.name,
		labels: new Map(
			snapshot.labels.map((label) => [
				label.targetId,
				Object.freeze({ label: label.label, timestamp: label.timestamp }),
			]),
		),
		queue: Object.freeze(
			[...snapshot.queue]
				.sort((left, right) => left.ordinal - right.ordinal)
				.map((input) => Object.freeze({ ...input })),
		),
		forkedFrom: snapshot.forkedFrom ?? null,
		base: snapshot.earlier ? values : DEFAULT_CLIENT_BRANCH_VALUES,
	});
}

/** The entries of the active branch the client holds, root first. */
export function clientActiveBranch(state: ClientState): ProjectedEntry[] {
	return heldBranch(state.byId, state.leafId);
}

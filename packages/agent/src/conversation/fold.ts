/**
 * The pure fold over a conversation log (RFC §4.3): runtime state is
 * `fold(log)`.
 *
 * The fold reads core entries and carries product entries through: every
 * entry is indexed in the tree by its envelope, and only core payloads are
 * interpreted. A `public` entry becomes the active leaf when appended (it is a
 * conversation node); a `host` entry never moves the leaf, except a `leaf`
 * entry, which is the branch pointer.
 *
 * States are immutable values. `apply` and `fold` never mutate their inputs;
 * a returned state shares unchanged parts with its basis, and its objects and
 * arrays are frozen (maps are exposed read-only). Entries and their payloads
 * are shared by reference, never copied, and must not be mutated; a
 * conversation log hands out frozen entries.
 *
 * The fold also checks the structural invariants it relies on and throws a
 * {@link ConversationFoldError} for a log that breaks them: contiguous
 * ordinals, unique ids, existing parents (a public entry's parent is public),
 * leaf and label targets, compaction and branch-summary references, and the
 * client-input lifecycle. Payload schemas are the log's concern.
 */

import type { UserMessage } from "@hansjm10/volt-ai";
import type {
	ClientInputCommand,
	ClientInputPayload,
	ClientInputQueuedPayload,
	ClientInputState,
	LogEntry,
	PlanningStateChangeEntryPayload,
} from "@hansjm10/volt-protocol/entries";
import type { AgentMessage, ThinkingLevel } from "../types.ts";
import { type ConversationLogEntry, isCoreLogEntry } from "./log.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "./messages.ts";

/** A complete branch-local Plan mode snapshot; the kernel stores it without interpreting it. */
export type PlanningSnapshot = PlanningStateChangeEntryPayload["planning"];

export interface ConversationModelRef {
	readonly provider: string;
	readonly modelId: string;
}

/** The model context of the active branch. */
export interface ConversationContext {
	/**
	 * Branch messages, root first, with the latest compaction and branch
	 * summaries applied. A client-submitted user message carries its
	 * `clientMessageId`; `convertToLlm` must drop it.
	 */
	readonly messages: readonly AgentMessage[];
	/** The latest model change or assistant message on the branch. */
	readonly model: ConversationModelRef | null;
	readonly thinkingLevel: ThinkingLevel;
	readonly fastMode: boolean;
}

export interface ConversationTree {
	/** Every entry by id, host and product entries included, in ordinal order. */
	readonly byId: ReadonlyMap<string, ConversationLogEntry>;
	/** Public child ids by parent id (`null` for roots), in ordinal order. */
	readonly children: ReadonlyMap<string | null, readonly string[]>;
}

export interface ConversationLabel {
	readonly label: string;
	/** Timestamp of the label entry that set it. */
	readonly timestamp: string;
}

/** One client input's durable lifecycle. */
export interface ClientInputRecord {
	readonly clientMessageId: string;
	readonly receiptId: string;
	readonly command: ClientInputCommand;
	/** `host` on input the host submitted itself, which may queue messages instead of a user message. */
	readonly origin?: "host";
	readonly semanticDigest: string;
	readonly input: ClientInputPayload;
	readonly queuedEntryId?: string;
	readonly queuedInput?: ClientInputQueuedPayload;
	readonly state: ClientInputState;
	/** Present only on `failed`. */
	readonly error?: string;
	/** The message entry that completed this input. */
	readonly canonicalEntryId?: string;
}

/**
 * The durable delivery queue. An input's admission ordinal is its queued
 * entry's ordinal when queued, otherwise its receipt's.
 */
export interface ClientInputQueue {
	/** Every client input in the log, by `clientMessageId`. */
	readonly inputs: ReadonlyMap<string, ClientInputRecord>;
	/** Accepted inputs with a queued intent, by admission ordinal: replayed on recovery. */
	readonly queued: readonly string[];
	/** Inputs whose dispatch started with no completion or terminal state, by admission ordinal. */
	readonly started: readonly string[];
}

/** The fold of a conversation log at one ordinal. */
export interface ConversationState {
	/** Ordinal of the newest folded entry; 0 for an empty log. */
	readonly ordinal: number;
	readonly tree: ConversationTree;
	/** The active branch tip, or `null` before the first conversation entry. */
	readonly leafId: string | null;
	/** Entry ids from the root to the leaf. */
	readonly branch: readonly string[];
	/** Ordinal of the newest entry that moved the leaf. */
	readonly branchOrdinal: number;
	/**
	 * Ordinal of the newest entry that switched the branch: a `leaf` entry
	 * that moved the leaf, or a public entry appended off the current leaf.
	 * Work captured against a branch is stale once this ordinal changes.
	 */
	readonly branchSwitchOrdinal: number;
	readonly context: ConversationContext;
	/**
	 * Ordinal of the newest entry that changed `context` or switched the
	 * branch. A request built from a state is current while this ordinal is
	 * unchanged, whatever host or metadata entries follow it.
	 */
	readonly contextOrdinal: number;
	/** The latest planning snapshot on the branch. */
	readonly planning: PlanningSnapshot | null;
	/** Labels by target entry id. */
	readonly labels: ReadonlyMap<string, ConversationLabel>;
	/** The latest non-blank conversation name, trimmed. */
	readonly name: string | null;
	readonly clientInputs: ClientInputQueue;
	/** Open work items; filled from work entries in Phase 4, always empty until then. */
	readonly openWork: readonly never[];
}

/** Automatic recovery of client inputs left behind by a previous runtime. */
export type ClientInputRecovery =
	| { readonly kind: "idle"; readonly records: readonly [] }
	/** Replay the queued inputs in order. */
	| { readonly kind: "replay"; readonly records: readonly ClientInputRecord[] }
	/**
	 * A started input has no completion: it may or may not have reached the
	 * model, so nothing is dispatched automatically past it.
	 */
	| {
			readonly kind: "blocked";
			readonly records: readonly ClientInputRecord[];
			readonly blocker: ClientInputRecord;
	  };

/** A log entry the fold cannot accept. */
export class ConversationFoldError extends Error {
	readonly entryId: string;
	readonly ordinal: number;

	constructor(entry: ConversationLogEntry, message: string) {
		super(`Log entry ${JSON.stringify(entry.id)} at ordinal ${entry.ordinal}: ${message}`);
		this.name = "ConversationFoldError";
		this.entryId = entry.id;
		this.ordinal = entry.ordinal;
	}
}

/** A serializable fold result tagged with its ordinal. */
export interface ConversationSnapshot {
	readonly ordinal: number;
	/** Every folded entry in ordinal order. */
	readonly entries: readonly ConversationLogEntry[];
	readonly leafId: string | null;
	readonly branchOrdinal: number;
	readonly branchSwitchOrdinal: number;
	readonly contextOrdinal: number;
	readonly labels: readonly (readonly [string, ConversationLabel])[];
	readonly name: string | null;
	readonly clientInputs: readonly ClientInputRecord[];
}

type CoreEntry<K extends LogEntry["type"]> = Extract<LogEntry, { type: K }>;

const NO_WORK: readonly never[] = Object.freeze([]);

interface BranchDerivation {
	readonly context: ConversationContext;
	readonly planning: PlanningSnapshot | null;
}

function emptyState(): ConversationState {
	return Object.freeze({
		ordinal: 0,
		tree: Object.freeze({ byId: new Map(), children: new Map() }),
		leafId: null,
		branch: Object.freeze([]),
		branchOrdinal: 0,
		branchSwitchOrdinal: 0,
		context: Object.freeze({ messages: Object.freeze([]), model: null, thinkingLevel: "off", fastMode: false }),
		contextOrdinal: 0,
		planning: null,
		labels: new Map(),
		name: null,
		clientInputs: Object.freeze({ inputs: new Map(), queued: Object.freeze([]), started: Object.freeze([]) }),
		openWork: NO_WORK,
	});
}

/** The model message a context-bearing branch entry contributes, if any. */
function contextMessage(entry: LogEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message": {
			const message = entry.payload.message;
			if (entry.clientMessageId === undefined || message.role !== "user") return message;
			const clientUserMessage: UserMessage & { clientMessageId: string } = {
				...message,
				clientMessageId: entry.clientMessageId,
			};
			return Object.freeze(clientUserMessage);
		}
		case "custom_message":
			return Object.freeze(
				createCustomMessage(
					entry.payload.customType,
					entry.payload.content,
					entry.payload.display,
					entry.payload.details,
					entry.timestamp,
				),
			);
		case "branch_summary":
			return entry.payload.summary
				? Object.freeze(createBranchSummaryMessage(entry.payload.summary, entry.payload.fromId, entry.timestamp))
				: undefined;
		default:
			return undefined;
	}
}

/** Context and planning of a branch, computed from scratch. */
function deriveBranch(byId: ReadonlyMap<string, ConversationLogEntry>, branch: readonly string[]): BranchDerivation {
	const path: ConversationLogEntry[] = [];
	for (const id of branch) {
		const entry = byId.get(id);
		if (entry) path.push(entry);
	}
	let model: ConversationModelRef | null = null;
	let thinkingLevel: ThinkingLevel = "off";
	let fastMode = false;
	let planning: PlanningSnapshot | null = null;
	let compaction: CoreEntry<"compaction"> | undefined;
	let compactionIndex = -1;
	for (const [index, entry] of path.entries()) {
		if (!isCoreLogEntry(entry)) continue;
		if (entry.type === "thinking_level_change") thinkingLevel = entry.payload.thinkingLevel;
		else if (entry.type === "fast_mode_change") fastMode = entry.payload.enabled;
		else if (entry.type === "model_change") model = modelRef(entry.payload.provider, entry.payload.modelId);
		else if (entry.type === "planning_state_change") planning = entry.payload.planning;
		else if (entry.type === "message" && entry.payload.message.role === "assistant") {
			model = modelRef(entry.payload.message.provider, entry.payload.message.model);
		} else if (entry.type === "compaction") {
			compaction = entry;
			compactionIndex = index;
		}
	}

	// With a compaction: its summary, then the kept entries before it, then everything after it.
	const messages: AgentMessage[] = [];
	let keptFrom = 0;
	if (compaction) {
		const { summary, tokensBefore, firstKeptEntryId } = compaction.payload;
		messages.push(Object.freeze(createCompactionSummaryMessage(summary, tokensBefore, compaction.timestamp)));
		const firstKeptIndex = path.findIndex((entry) => entry.id === firstKeptEntryId);
		keptFrom = firstKeptIndex === -1 ? compactionIndex : firstKeptIndex;
	}
	for (const [index, entry] of path.entries()) {
		if (index < keptFrom || index === compactionIndex || !isCoreLogEntry(entry)) continue;
		const message = contextMessage(entry);
		if (message) messages.push(message);
	}
	return {
		context: Object.freeze({ messages: Object.freeze(messages), model, thinkingLevel, fastMode }),
		planning,
	};
}

function modelRef(provider: string, modelId: string): ConversationModelRef {
	return Object.freeze({ provider, modelId });
}

function expectedQueuedDelivery(record: ClientInputRecord): "steer" | "follow_up" | undefined {
	if (record.command === "steer") return "steer";
	if (record.command === "follow_up") return "follow_up";
	if (record.input.streamingBehavior === "steer") return "steer";
	if (record.input.streamingBehavior === "followUp") return "follow_up";
	return undefined;
}

function withoutLifecycleFields(
	record: ClientInputRecord,
): Omit<ClientInputRecord, "state" | "error" | "canonicalEntryId"> {
	const { state: _state, error: _error, canonicalEntryId: _canonicalEntryId, ...rest } = record;
	return rest;
}

/**
 * A mutable working copy of one state. Collections are copied on first write
 * and owned copies are appended to in place, so folding a batch costs one copy
 * of each collection it touches, and the basis state is never touched.
 */
class StateBuilder {
	private readonly base: ConversationState;
	private readonly owned = new Set<object>();
	private ordinal: number;
	private byId: ReadonlyMap<string, ConversationLogEntry>;
	private children: ReadonlyMap<string | null, readonly string[]>;
	private leafId: string | null;
	private branch: readonly string[];
	private branchOrdinal: number;
	private branchSwitchOrdinal: number;
	private messages: readonly AgentMessage[];
	private model: ConversationModelRef | null;
	private thinkingLevel: ThinkingLevel;
	private fastMode: boolean;
	private contextOrdinal: number;
	private planning: PlanningSnapshot | null;
	private labels: ReadonlyMap<string, ConversationLabel>;
	private name: string | null;
	private inputs: ReadonlyMap<string, ClientInputRecord>;
	private queued: readonly string[];
	private started: readonly string[];

	constructor(base: ConversationState) {
		this.base = base;
		this.ordinal = base.ordinal;
		this.byId = base.tree.byId;
		this.children = base.tree.children;
		this.leafId = base.leafId;
		this.branch = base.branch;
		this.branchOrdinal = base.branchOrdinal;
		this.branchSwitchOrdinal = base.branchSwitchOrdinal;
		this.messages = base.context.messages;
		this.model = base.context.model;
		this.thinkingLevel = base.context.thinkingLevel;
		this.fastMode = base.context.fastMode;
		this.contextOrdinal = base.contextOrdinal;
		this.planning = base.planning;
		this.labels = base.labels;
		this.name = base.name;
		this.inputs = base.clientInputs.inputs;
		this.queued = base.clientInputs.queued;
		this.started = base.clientInputs.started;
	}

	apply(entry: ConversationLogEntry): void {
		this.validateEnvelope(entry);
		const core = isCoreLogEntry(entry) ? entry : undefined;
		if (core) this.validateReferences(core);
		const input = core ? this.nextClientInput(core) : undefined;

		const byId = this.writable(this.byId);
		this.byId = byId;
		byId.set(entry.id, entry);
		if (entry.visibility === "public") this.appendChild(entry.parentId, entry.id);
		if (input) this.setClientInput(input);
		if (core?.type === "label") this.setLabel(core);
		if (core?.type === "session_info") this.name = core.payload.name?.trim() || null;
		if (core?.type === "leaf") this.moveLeaf(core.payload.targetId, entry.ordinal);
		else if (entry.visibility === "public") this.appendToBranch(entry, core);
		this.ordinal = entry.ordinal;
	}

	finish(): ConversationState {
		const base = this.base;
		for (const value of this.owned) {
			if (Array.isArray(value)) Object.freeze(value);
		}
		Object.freeze(this.branch);
		Object.freeze(this.messages);
		const tree =
			this.byId === base.tree.byId && this.children === base.tree.children
				? base.tree
				: Object.freeze({ byId: this.byId, children: this.children });
		const context =
			this.messages === base.context.messages &&
			this.model === base.context.model &&
			this.thinkingLevel === base.context.thinkingLevel &&
			this.fastMode === base.context.fastMode
				? base.context
				: Object.freeze({
						messages: this.messages,
						model: this.model,
						thinkingLevel: this.thinkingLevel,
						fastMode: this.fastMode,
					});
		const clientInputs =
			this.inputs === base.clientInputs.inputs &&
			this.queued === base.clientInputs.queued &&
			this.started === base.clientInputs.started
				? base.clientInputs
				: Object.freeze({ inputs: this.inputs, queued: this.queued, started: this.started });
		return Object.freeze({
			ordinal: this.ordinal,
			tree,
			leafId: this.leafId,
			branch: this.branch,
			branchOrdinal: this.branchOrdinal,
			branchSwitchOrdinal: this.branchSwitchOrdinal,
			context,
			contextOrdinal: this.contextOrdinal,
			planning: this.planning,
			labels: this.labels,
			name: this.name,
			clientInputs,
			openWork: NO_WORK,
		});
	}

	private validateEnvelope(entry: ConversationLogEntry): void {
		if (entry.ordinal !== this.ordinal + 1) {
			throw new ConversationFoldError(entry, `expected ordinal ${this.ordinal + 1}`);
		}
		if (this.byId.has(entry.id)) throw new ConversationFoldError(entry, "duplicate entry id");
		if (entry.parentId === null) return;
		const parent = this.byId.get(entry.parentId);
		if (!parent) throw new ConversationFoldError(entry, `unknown parent ${JSON.stringify(entry.parentId)}`);
		if (entry.visibility === "public" && parent.visibility !== "public") {
			throw new ConversationFoldError(entry, "a public entry's parent must be a public entry");
		}
	}

	private validateReferences(entry: LogEntry): void {
		if (entry.type === "leaf" || entry.type === "label") {
			const targetId = entry.payload.targetId;
			if (targetId !== null && this.byId.get(targetId)?.visibility !== "public") {
				throw new ConversationFoldError(entry, `target ${JSON.stringify(targetId)} is not a conversation entry`);
			}
		} else if (entry.type === "compaction") {
			let currentId = entry.parentId;
			while (currentId !== null && currentId !== entry.payload.firstKeptEntryId) {
				currentId = this.byId.get(currentId)?.parentId ?? null;
			}
			if (currentId === null) throw new ConversationFoldError(entry, "first kept entry is not an ancestor");
		} else if (entry.type === "branch_summary" && entry.payload.fromId !== (entry.parentId ?? "root")) {
			throw new ConversationFoldError(entry, "branch summary source must be its parent");
		}
	}

	/** The client input record this entry produces, checked against the lifecycle. */
	private nextClientInput(entry: LogEntry): ClientInputRecord | undefined {
		if (entry.type === "client_input_receipt") {
			if (this.inputs.has(entry.payload.clientMessageId)) {
				throw new ConversationFoldError(entry, "duplicate client input receipt");
			}
			return Object.freeze({
				clientMessageId: entry.payload.clientMessageId,
				receiptId: entry.id,
				command: entry.payload.command,
				...(entry.payload.origin === undefined ? {} : { origin: entry.payload.origin }),
				semanticDigest: entry.payload.semanticDigest,
				input: entry.payload.input,
				state: "accepted",
			});
		}
		if (entry.type === "client_input_queued") {
			const existing = this.requireReceipt(entry, entry.payload.clientMessageId, entry.payload.receiptId);
			if (existing.state !== "accepted" && existing.state !== "started") {
				throw new ConversationFoldError(entry, `client input was queued after it was ${existing.state}`);
			}
			if (existing.queuedInput) throw new ConversationFoldError(entry, "client input is already queued");
			if (entry.payload.queuedInput.delivery !== expectedQueuedDelivery(existing)) {
				throw new ConversationFoldError(entry, "queued delivery conflicts with the input's command");
			}
			if (entry.payload.queuedInput.messages !== undefined && existing.origin !== "host") {
				throw new ConversationFoldError(entry, "only a host input queues messages");
			}
			return Object.freeze({
				...withoutLifecycleFields(existing),
				queuedEntryId: entry.id,
				queuedInput: entry.payload.queuedInput,
				state: "accepted",
			});
		}
		if (entry.type === "client_input_state") {
			const existing = this.requireReceipt(entry, entry.payload.clientMessageId, entry.payload.receiptId);
			const from = existing.state;
			const next = entry.payload.state;
			// accepted -> started | completed | failed | withdrawn; started -> accepted | completed | failed.
			const allowed =
				(from === "accepted" && next !== "accepted") ||
				(from === "started" && next !== "started" && next !== "withdrawn");
			if (!allowed) throw new ConversationFoldError(entry, `client input cannot move from ${from} to ${next}`);
			if (entry.payload.error !== undefined && next !== "failed") {
				throw new ConversationFoldError(entry, "only a failed client input carries an error");
			}
			return Object.freeze({
				...withoutLifecycleFields(existing),
				state: next,
				...(entry.payload.error === undefined ? {} : { error: entry.payload.error }),
			});
		}
		if (entry.type !== "message" || entry.clientMessageId === undefined) return undefined;
		const existing = this.inputs.get(entry.clientMessageId);
		if (existing?.state !== "started") {
			throw new ConversationFoldError(entry, "a client message requires a started client input");
		}
		return Object.freeze({ ...withoutLifecycleFields(existing), state: "completed", canonicalEntryId: entry.id });
	}

	private requireReceipt(entry: LogEntry, clientMessageId: string, receiptId: string): ClientInputRecord {
		const existing = this.inputs.get(clientMessageId);
		if (existing?.receiptId !== receiptId) throw new ConversationFoldError(entry, "no matching client input receipt");
		return existing;
	}

	private setClientInput(record: ClientInputRecord): void {
		const id = record.clientMessageId;
		const inputs = this.writable(this.inputs);
		this.inputs = inputs;
		inputs.set(id, record);
		const queued = record.state === "accepted" && record.queuedInput !== undefined;
		const started = record.state === "started";
		if (this.queued.includes(id) !== queued) this.queued = this.withMembership(this.queued, id, queued);
		if (this.started.includes(id) !== started) this.started = this.withMembership(this.started, id, started);
	}

	/** `ids` without `id`, or with `id` inserted by admission ordinal. */
	private withMembership(ids: readonly string[], id: string, member: boolean): string[] {
		const next = ids.filter((existing) => existing !== id);
		this.owned.add(next);
		if (!member) return next;
		const ordinal = this.admissionOrdinal(id);
		const index = next.findIndex((existing) => this.admissionOrdinal(existing) > ordinal);
		next.splice(index === -1 ? next.length : index, 0, id);
		return next;
	}

	private admissionOrdinal(clientMessageId: string): number {
		const record = this.inputs.get(clientMessageId);
		const admissionId = record?.queuedEntryId ?? record?.receiptId;
		return (admissionId === undefined ? undefined : this.byId.get(admissionId)?.ordinal) ?? Number.MAX_SAFE_INTEGER;
	}

	private setLabel(entry: CoreEntry<"label">): void {
		const labels = this.writable(this.labels);
		this.labels = labels;
		if (entry.payload.label) {
			labels.set(entry.payload.targetId, Object.freeze({ label: entry.payload.label, timestamp: entry.timestamp }));
		} else {
			labels.delete(entry.payload.targetId);
		}
	}

	private moveLeaf(targetId: string | null, ordinal: number): void {
		if (targetId === this.leafId) return;
		this.leafId = targetId;
		this.branchOrdinal = ordinal;
		this.branchSwitchOrdinal = ordinal;
		this.rederiveBranch(targetId === null ? [] : this.pathTo(targetId), ordinal);
	}

	/** A public entry becomes the leaf; extending the branch updates the context in place. */
	private appendToBranch(entry: ConversationLogEntry, core: LogEntry | undefined): void {
		const extendsBranch = entry.parentId === this.leafId;
		this.leafId = entry.id;
		this.branchOrdinal = entry.ordinal;
		if (!extendsBranch) {
			this.branchSwitchOrdinal = entry.ordinal;
			this.rederiveBranch(this.pathTo(entry.id), entry.ordinal);
			return;
		}
		this.branch = this.appended(this.branch, entry.id);
		if (!core) return;
		switch (core.type) {
			case "compaction":
				this.rederiveBranch(this.branch, entry.ordinal);
				return;
			case "planning_state_change":
				this.planning = core.payload.planning;
				return;
			case "model_change":
				this.model = modelRef(core.payload.provider, core.payload.modelId);
				break;
			case "thinking_level_change":
				this.thinkingLevel = core.payload.thinkingLevel;
				break;
			case "fast_mode_change":
				this.fastMode = core.payload.enabled;
				break;
			case "message":
			case "custom_message":
			case "branch_summary": {
				const message = contextMessage(core);
				// An empty branch summary contributes nothing.
				if (!message) return;
				if (core.type === "message" && core.payload.message.role === "assistant") {
					this.model = modelRef(core.payload.message.provider, core.payload.message.model);
				}
				this.messages = this.appended(this.messages, message);
				break;
			}
			default:
				return;
		}
		this.contextOrdinal = entry.ordinal;
	}

	private rederiveBranch(branch: readonly string[], ordinal: number): void {
		const derived = deriveBranch(this.byId, branch);
		this.branch = branch;
		this.messages = derived.context.messages;
		this.model = derived.context.model;
		this.thinkingLevel = derived.context.thinkingLevel;
		this.fastMode = derived.context.fastMode;
		this.planning = derived.planning;
		this.contextOrdinal = ordinal;
	}

	private pathTo(id: string): string[] {
		const path: string[] = [];
		for (let current: string | null = id; current !== null; current = this.byId.get(current)?.parentId ?? null) {
			path.push(current);
		}
		return path.reverse();
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

	private appendChild(parentId: string | null, id: string): void {
		const children = this.writable(this.children);
		this.children = children;
		children.set(parentId, this.appended(children.get(parentId) ?? [], id));
	}

	/** `map` when this builder owns it, otherwise an owned copy. */
	private writable<K, V>(map: ReadonlyMap<K, V>): Map<K, V> {
		if (this.owned.has(map)) return map as Map<K, V>;
		const copy = new Map(map);
		this.owned.add(copy);
		return copy;
	}
}

/** Fold entries, in ordinal order, onto `initial` (the empty conversation by default). */
export function fold(
	entries: Iterable<ConversationLogEntry>,
	initial: ConversationState = emptyState(),
): ConversationState {
	const builder = new StateBuilder(initial);
	for (const entry of entries) builder.apply(entry);
	return builder.finish();
}

/** Fold one entry onto `state`. */
export function apply(state: ConversationState, entry: ConversationLogEntry): ConversationState {
	return fold([entry], state);
}

/** The recovery plan for client inputs a previous runtime left behind. */
export function clientInputRecovery(state: ConversationState): ClientInputRecovery {
	const { inputs, queued, started } = state.clientInputs;
	const records = queued.map((id) => inputs.get(id)).filter((record) => record !== undefined);
	const blocker = started[0] === undefined ? undefined : inputs.get(started[0]);
	if (blocker) return { kind: "blocked", records, blocker };
	return records.length > 0 ? { kind: "replay", records } : { kind: "idle", records: [] };
}

/** Serialize a state; its context and planning are recomputed from the branch on restore. */
export function snapshot(state: ConversationState): ConversationSnapshot {
	return {
		ordinal: state.ordinal,
		entries: [...state.tree.byId.values()],
		leafId: state.leafId,
		branchOrdinal: state.branchOrdinal,
		branchSwitchOrdinal: state.branchSwitchOrdinal,
		contextOrdinal: state.contextOrdinal,
		labels: [...state.labels],
		name: state.name,
		clientInputs: [...state.clientInputs.inputs.values()],
	};
}

/** Rebuild the state a snapshot was taken from. Entries are adopted by reference. */
export function restore(value: ConversationSnapshot): ConversationState {
	const byId = new Map<string, ConversationLogEntry>();
	const children = new Map<string | null, string[]>();
	for (const entry of value.entries) {
		byId.set(entry.id, entry);
		if (entry.visibility !== "public") continue;
		const siblings = children.get(entry.parentId);
		if (siblings) siblings.push(entry.id);
		else children.set(entry.parentId, [entry.id]);
	}
	for (const siblings of children.values()) Object.freeze(siblings);

	const branch: string[] = [];
	for (let id = value.leafId; id !== null; id = byId.get(id)?.parentId ?? null) branch.push(id);
	branch.reverse();
	const derived = deriveBranch(byId, branch);

	const inputs = new Map(value.clientInputs.map((record) => [record.clientMessageId, Object.freeze({ ...record })]));
	const admissionOrdinal = (record: ClientInputRecord): number =>
		byId.get(record.queuedEntryId ?? record.receiptId)?.ordinal ?? Number.MAX_SAFE_INTEGER;
	const lifecycle = (member: (record: ClientInputRecord) => boolean): readonly string[] =>
		Object.freeze(
			[...inputs.values()]
				.filter(member)
				.sort((left, right) => admissionOrdinal(left) - admissionOrdinal(right))
				.map((record) => record.clientMessageId),
		);

	return Object.freeze({
		ordinal: value.ordinal,
		tree: Object.freeze({ byId, children }),
		leafId: value.leafId,
		branch: Object.freeze(branch),
		branchOrdinal: value.branchOrdinal,
		branchSwitchOrdinal: value.branchSwitchOrdinal,
		context: derived.context,
		contextOrdinal: value.contextOrdinal,
		planning: derived.planning,
		labels: new Map(value.labels.map(([targetId, label]) => [targetId, Object.freeze({ ...label })])),
		name: value.name,
		clientInputs: Object.freeze({
			inputs,
			queued: lifecycle((record) => record.state === "accepted" && record.queuedInput !== undefined),
			started: lifecycle((record) => record.state === "started"),
		}),
		openWork: NO_WORK,
	});
}

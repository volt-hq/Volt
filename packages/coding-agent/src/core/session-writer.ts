/**
 * Session writes. A `SessionManager` is a read view of one session's log; its
 * entries are written by whoever writes that log:
 *
 * - before a conversation opens the log, the manager's {@link LogWriter}
 *   (setup, seeding, handoff, and metadata a host records before it publishes
 *   the session);
 * - while a live session's conversation holds the log, that session's writer
 *   ({@link ConversationSessionWriter}), whose writes are conversation intents.
 *
 * Code that may run in either phase takes a {@link SessionWriter}. Every write
 * resolves after its entries commit, and the writer's view already holds them.
 */

import { randomUUID } from "node:crypto";
import type { ImageContent, JsonCompatibleInput, JsonValue, Message, TextContent } from "@hansjm10/volt-ai";
import { RpcGitContextSchema } from "@hansjm10/volt-protocol";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { isDeepStrictEqual } from "util";
import { resolvePath } from "../utils/paths.ts";
import { toLogEntryDraft } from "./conversation-log/entry-codec.ts";
import {
	type BashExecutionMessage,
	type ClientUserMessage,
	type CustomMessage,
	withoutClientMessageId,
} from "./messages.ts";
import { type PlanningState, parsePlanningState } from "./planning.ts";
import type { PrReviewPlacement } from "./pr-review-placement.ts";
import type { RpcGitContext } from "./rpc/types.ts";
import { digestClientInputPayload, parseSessionEntryForAdmission } from "./session-entry-codec.ts";
import type {
	BranchSummaryEntry,
	ClientInputQueuedEntry,
	ClientInputReceiptEntry,
	CompactionEntry,
	CustomEntry,
	CustomMessageEntry,
	FastModeChangeEntry,
	LabelEntry,
	ModelChangeEntry,
	PlanningStateChangeEntry,
	PrReviewBindingEntry,
	SessionEntry,
	SessionInfoEntry,
	SessionManager,
	SessionMessageEntry,
	SessionReference,
	SessionStartGitContextEntry,
	SessionWrite,
	SubagentSpawnEntry,
	ThinkingLevelChangeEntry,
} from "./session-manager.ts";

/** A durable spawn edge's fields, as `appendSubagentSpawn` takes them. */
export interface SubagentSpawnInput {
	toolCallId: string;
	subagentId: string;
	agent: string;
	childSessionId: string;
	childSessionRef?: SessionReference;
	requestKey: string;
}

/**
 * The writes of one session, before or while it is live. Each resolves after
 * its entry commits; `sessionManager` then holds it.
 */
export interface SessionWriter {
	/** The read view of the session this writer writes. */
	readonly sessionManager: SessionManager;
	/** Append a message as a child of the leaf; resolves with its entry id. */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): Promise<string>;
	/** Append extension data that never reaches the model; resolves with its entry id. */
	appendCustomEntry<T = JsonValue>(customType: string, data?: JsonCompatibleInput<T>): Promise<string>;
	/**
	 * Append an extension message that participates in model context; `display`
	 * shows it in the transcript. Resolves with its entry id.
	 */
	appendCustomMessageEntry<T = JsonValue>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: JsonCompatibleInput<T>,
		timestamp?: number,
	): Promise<string>;
	appendModelChange(provider: string, modelId: string): Promise<void>;
	appendThinkingLevelChange(thinkingLevel: ThinkingLevelChangeEntry["thinkingLevel"]): Promise<void>;
	appendFastModeChange(enabled: boolean): Promise<void>;
	/** Append one complete Plan mode snapshot. */
	appendPlanningState(planning: PlanningState): Promise<void>;
	/** Set the session's display name. */
	appendSessionInfo(name: string): Promise<void>;
	/** Set, or with an empty or missing label clear, the label of a conversation entry. */
	appendLabelChange(targetId: string, label: string | undefined): Promise<void>;
	/**
	 * Record the durable spawn edge of a subagent child whose first prompt was
	 * accepted. Host metadata: it never moves the leaf. Resolves with its entry id.
	 */
	appendSubagentSpawn(spawn: SubagentSpawnInput): Promise<string>;
	/**
	 * Record the first completed Git observation of a session this manager
	 * created. Resolves `false` when the session already has one or was not
	 * created by its manager.
	 */
	recordStartingGitContext(gitContext: RpcGitContext | null): Promise<boolean>;
	/**
	 * Record the immutable PR checkout identity of a session. Host admission
	 * awaits it before publishing the session; recording the same placement
	 * again is a no-op, and a different one is refused.
	 */
	recordPrReviewBinding(placement: PrReviewPlacement): Promise<void>;
}

/** Placeholder envelope of an entry admitted before its writer assigns its id and parent. */
const PENDING_ENTRY_ID = "pending";

const STARTING_GIT_CONTEXT = Type.Union([RpcGitContextSchema, Type.Null()]);

/**
 * Admit an entry when its write is called: the write then owns a canonical
 * copy of the caller's values, and invalid values are refused before the
 * write is queued. Its writer assigns the entry's id and parent when it commits.
 */
function admitEntry<T extends SessionEntry>(entry: T): T {
	return parseSessionEntryForAdmission(entry, `Session ${entry.type} entry`) as T;
}

function pendingEnvelope(timestamp = new Date().toISOString()): { id: string; parentId: null; timestamp: string } {
	return { id: PENDING_ENTRY_ID, parentId: null, timestamp };
}

function messageEntry(
	message: Message | ClientUserMessage | CustomMessage | BashExecutionMessage,
): SessionMessageEntry {
	return admitEntry<SessionMessageEntry>({
		type: "message",
		...pendingEnvelope(),
		// The client input identity moves from the runtime message to the entry envelope.
		...("clientMessageId" in message
			? { message: withoutClientMessageId(message), clientMessageId: message.clientMessageId }
			: { message }),
	});
}

function thinkingLevelEntry(thinkingLevel: ThinkingLevelChangeEntry["thinkingLevel"]): ThinkingLevelChangeEntry {
	return admitEntry<ThinkingLevelChangeEntry>({ type: "thinking_level_change", ...pendingEnvelope(), thinkingLevel });
}

function fastModeEntry(enabled: boolean): FastModeChangeEntry {
	return admitEntry<FastModeChangeEntry>({ type: "fast_mode_change", ...pendingEnvelope(), enabled });
}

function modelEntry(provider: string, modelId: string): ModelChangeEntry {
	return admitEntry<ModelChangeEntry>({ type: "model_change", ...pendingEnvelope(), provider, modelId });
}

function planningEntry(planning: PlanningState): PlanningStateChangeEntry {
	return admitEntry<PlanningStateChangeEntry>({
		type: "planning_state_change",
		...pendingEnvelope(),
		planning: parsePlanningState(planning),
	});
}

function customEntry(customType: string, data?: JsonValue): CustomEntry {
	return admitEntry<CustomEntry>({
		type: "custom",
		customType,
		...(data === undefined ? {} : { data }),
		...pendingEnvelope(),
	});
}

function sessionInfoEntry(name: string): SessionInfoEntry {
	return admitEntry<SessionInfoEntry>({ type: "session_info", ...pendingEnvelope(), name: name.trim() });
}

function customMessageEntry(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details?: JsonValue,
	timestamp?: number,
): CustomMessageEntry {
	return admitEntry<CustomMessageEntry>({
		type: "custom_message",
		customType,
		content,
		display,
		...(details === undefined ? {} : { details }),
		...pendingEnvelope(timestamp === undefined ? undefined : new Date(timestamp).toISOString()),
	});
}

function labelEntry(targetId: string, label: string | undefined): LabelEntry {
	return admitEntry<LabelEntry>({
		type: "label",
		...pendingEnvelope(),
		targetId,
		...(label === undefined ? {} : { label }),
	});
}

function subagentSpawnEntry(spawn: SubagentSpawnInput): SubagentSpawnEntry {
	return admitEntry<SubagentSpawnEntry>({
		type: "subagent_spawn",
		...pendingEnvelope(),
		toolCallId: spawn.toolCallId,
		subagentId: spawn.subagentId,
		agent: spawn.agent,
		childSessionId: spawn.childSessionId,
		...(spawn.childSessionRef !== undefined ? { childSessionRef: spawn.childSessionRef } : {}),
		requestKey: spawn.requestKey,
	});
}

function startingGitContextEntry(gitContext: RpcGitContext | null): SessionStartGitContextEntry {
	if (!Check(STARTING_GIT_CONTEXT, gitContext)) {
		throw new Error("Cannot record invalid starting Git context metadata");
	}
	return admitEntry<SessionStartGitContextEntry>({
		type: "session_start_git_context",
		...pendingEnvelope(),
		gitContext,
	});
}

function prReviewBindingEntry(placement: PrReviewPlacement, sessionManager: SessionManager): PrReviewBindingEntry {
	const entry = admitEntry<PrReviewBindingEntry>({ type: "pr_review_binding", ...pendingEnvelope(), placement });
	if (resolvePath(entry.placement.cwd) !== sessionManager.getCwd()) {
		throw new Error("PR review binding cwd does not match the session");
	}
	return entry;
}

/** Whether `existing` already records `entry`'s placement; throws when it records another one. */
function bindsAgain(existing: PrReviewPlacement | undefined, entry: PrReviewBindingEntry): boolean {
	if (existing === undefined) return false;
	if (!isDeepStrictEqual(existing, entry.placement)) throw new Error("PR review binding is immutable");
	return true;
}

function compactionEntry(
	summary: string,
	firstKeptEntryId: string,
	tokensBefore: number,
	details?: JsonValue,
	fromHook?: boolean,
): CompactionEntry {
	return admitEntry<CompactionEntry>({
		type: "compaction",
		...pendingEnvelope(),
		summary,
		firstKeptEntryId,
		tokensBefore,
		...(details === undefined ? {} : { details }),
		...(fromHook === undefined ? {} : { fromHook }),
	});
}

function branchSummaryEntry(
	branchFromId: string | null,
	summary: string,
	details?: JsonValue,
	fromHook?: boolean,
): BranchSummaryEntry {
	return admitEntry<BranchSummaryEntry>({
		type: "branch_summary",
		...pendingEnvelope(),
		fromId: branchFromId ?? "root",
		summary,
		...(details === undefined ? {} : { details }),
		...(fromHook === undefined ? {} : { fromHook }),
	});
}

/** A session manager's serialized commit lane, lent to its log writer. */
export interface SessionCommitLane {
	/**
	 * Build one batch against the committed view, commit it to the log, then
	 * install it in the view. Resolves with what `build` returned. An atomic
	 * batch reports a validation failure as a rolled-back `SessionAtomicAppendError`.
	 */
	commit<T>(build: (write: SessionWrite) => T, atomic?: boolean): Promise<T>;
}

/**
 * The writer of a session's log while no conversation holds it: setup before
 * a session opens, seeding, a handoff into a closed session, and metadata a
 * host records before it publishes the session. Writes run one at a time in
 * call order, each built against the committed view. While a live session's
 * conversation holds the log, every write is refused; write through that
 * session instead.
 */
export class LogWriter implements SessionWriter {
	readonly sessionManager: SessionManager;
	private readonly lane: SessionCommitLane;

	constructor(sessionManager: SessionManager, lane: SessionCommitLane) {
		this.sessionManager = sessionManager;
		this.lane = lane;
	}

	/**
	 * Does not write CompactionSummaryMessage or BranchSummaryMessage: those are
	 * top-level `compaction` and `branch_summary` entries (`appendCompaction`,
	 * `branchWithSummary`). A user message with a `clientMessageId` delivers that
	 * started client input.
	 */
	async appendMessage(message: Message | ClientUserMessage | CustomMessage | BashExecutionMessage): Promise<string> {
		const entry = messageEntry(message);
		return this.lane.commit((write) => write.message(entry));
	}

	async appendCustomEntry<T = JsonValue>(customType: string, data?: JsonCompatibleInput<T>): Promise<string> {
		const entry = customEntry(customType, data as JsonValue | undefined);
		return this.lane.commit((write) => write.place(entry));
	}

	async appendCustomMessageEntry<T = JsonValue>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: JsonCompatibleInput<T>,
		timestamp?: number,
	): Promise<string> {
		const entry = customMessageEntry(customType, content, display, details as JsonValue | undefined, timestamp);
		return this.lane.commit((write) => write.place(entry));
	}

	async appendModelChange(provider: string, modelId: string): Promise<void> {
		const entry = modelEntry(provider, modelId);
		await this.lane.commit((write) => write.place(entry));
	}

	async appendThinkingLevelChange(thinkingLevel: ThinkingLevelChangeEntry["thinkingLevel"]): Promise<void> {
		const entry = thinkingLevelEntry(thinkingLevel);
		await this.lane.commit((write) => write.place(entry));
	}

	async appendFastModeChange(enabled: boolean): Promise<void> {
		const entry = fastModeEntry(enabled);
		await this.lane.commit((write) => write.place(entry));
	}

	async appendPlanningState(planning: PlanningState): Promise<void> {
		const entry = planningEntry(planning);
		await this.lane.commit((write) => write.place(entry));
	}

	async appendSessionInfo(name: string): Promise<void> {
		const entry = sessionInfoEntry(name);
		await this.lane.commit((write) => write.place(entry));
	}

	async appendLabelChange(targetId: string, label: string | undefined): Promise<void> {
		const entry = labelEntry(targetId, label);
		await this.lane.commit((write) => write.label(entry));
	}

	async appendSubagentSpawn(spawn: SubagentSpawnInput): Promise<string> {
		const entry = subagentSpawnEntry(spawn);
		return this.lane.commit((write) => write.place(entry));
	}

	async recordStartingGitContext(gitContext: RpcGitContext | null): Promise<boolean> {
		const entry = startingGitContextEntry(gitContext);
		return this.lane.commit((write) => {
			// Checked on the lane, so of concurrent observations only the first commits.
			if (!this.sessionManager.capturesStartingGitContext()) return false;
			write.place(entry);
			return true;
		});
	}

	async recordPrReviewBinding(placement: PrReviewPlacement): Promise<void> {
		const entry = prReviewBindingEntry(placement, this.sessionManager);
		await this.lane.commit((write) => {
			if (!bindsAgain(write.state.prReviewBinding, entry)) write.place(entry);
		});
	}

	/** Append a compaction summary as a child of the leaf; resolves with its entry id. */
	async appendCompaction<T = JsonValue>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: JsonCompatibleInput<T>,
		fromHook?: boolean,
	): Promise<string> {
		const entry = compactionEntry(
			summary,
			firstKeptEntryId,
			tokensBefore,
			details as JsonValue | undefined,
			fromHook,
		);
		return this.lane.commit((write) => write.place(entry));
	}

	/**
	 * Move the leaf to an earlier entry. The next write appends a child of it,
	 * which starts a new branch; no entry is changed or removed.
	 */
	async branch(branchFromId: string): Promise<void> {
		await this.lane.commit((write) => write.branch(branchFromId));
	}

	/** Move the leaf before the first entry: the next write appends a new root. */
	async resetLeaf(): Promise<void> {
		await this.lane.commit((write) => write.leaf(null));
	}

	/**
	 * Queue host messages as one durable input with a host origin, as a live
	 * session queues extension messages: the conversation that opens the log
	 * delivers them in one turn once it recovers its durable input. Resolves
	 * with the input's client message id.
	 */
	async queueHostMessages(delivery: "steer" | "follow_up", messages: readonly CustomMessage[]): Promise<string> {
		const clientMessageId = randomUUID();
		const input = { message: "", images: [] };
		const receipt = admitEntry<ClientInputReceiptEntry>({
			type: "client_input_receipt",
			...pendingEnvelope(),
			clientMessageId,
			command: delivery,
			semanticDigest: digestClientInputPayload(delivery, input),
			input,
			origin: "host",
		});
		const queuedInput = { delivery, message: "", images: [], messages: [...messages] };
		return this.lane.commit((write) => {
			const receiptId = write.place(receipt);
			write.place(
				admitEntry<ClientInputQueuedEntry>({
					type: "client_input_queued",
					...pendingEnvelope(),
					receiptId,
					clientMessageId,
					queuedInput,
				}),
			);
			return clientMessageId;
		}, true);
	}

	/**
	 * Move the leaf to `branchFromId` and append, in the same commit, a summary
	 * of the branch left behind as its child. Resolves with the summary's id.
	 */
	async branchWithSummary<T = JsonValue>(
		branchFromId: string | null,
		summary: string,
		details?: JsonCompatibleInput<T>,
		fromHook?: boolean,
	): Promise<string> {
		const entry = branchSummaryEntry(branchFromId, summary, details as JsonValue | undefined, fromHook);
		return this.lane.commit((write) => write.branchWithSummary(branchFromId, entry));
	}
}

/** The conversation intents a live session's writer commits through. */
export interface ConversationWriteIntents {
	/** Append host entries in one batch: a product type, or a core `custom`, `custom_message`, `message`, or `subagent_spawn`. */
	append(
		entries: readonly { readonly type: string; readonly payload: unknown }[],
	): Promise<readonly { readonly id: string }[]>;
	setModel(provider: string, modelId: string): Promise<void>;
	setThinkingLevel(thinkingLevel: ThinkingLevelChangeEntry["thinkingLevel"]): Promise<void>;
	setFastMode(enabled: boolean): Promise<void>;
	setPlanning(planning: PlanningState): Promise<void>;
	setName(name: string): Promise<void>;
	setLabel(targetId: string, label: string | undefined): Promise<void>;
}

/**
 * The writer of a live session: each write is an intent of the conversation
 * that holds the session's log, so the conversation stays its only writer.
 * Structural writes (navigation, compaction) are the session's own operations.
 */
export class ConversationSessionWriter implements SessionWriter {
	readonly sessionManager: SessionManager;
	private readonly intents: ConversationWriteIntents;
	/** One starting Git context per session: set while one may still be recorded. */
	private capturesStartingGitContext: boolean;
	/** PR review bindings record one at a time, so a repeat sees the binding before it. */
	private bindings: Promise<unknown> = Promise.resolve();

	constructor(sessionManager: SessionManager, intents: ConversationWriteIntents) {
		this.sessionManager = sessionManager;
		this.intents = intents;
		this.capturesStartingGitContext = sessionManager.capturesStartingGitContext();
	}

	/** Append one admitted host entry; resolves with its id after it commits. */
	private async append(entry: SessionEntry): Promise<string> {
		const draft = toLogEntryDraft(entry);
		const [committed] = await this.intents.append([{ type: draft.type, payload: draft.payload }]);
		if (!committed) throw new Error(`Session ${entry.type} entry was not committed`);
		return committed.id;
	}

	async appendMessage(message: Message | CustomMessage | BashExecutionMessage): Promise<string> {
		const entry = messageEntry(message);
		if (entry.clientMessageId !== undefined) {
			throw new Error("A client input's message commits only with its delivery");
		}
		return this.append(entry);
	}

	async appendCustomEntry<T = JsonValue>(customType: string, data?: JsonCompatibleInput<T>): Promise<string> {
		return this.append(customEntry(customType, data as JsonValue | undefined));
	}

	async appendCustomMessageEntry<T = JsonValue>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: JsonCompatibleInput<T>,
		timestamp?: number,
	): Promise<string> {
		return this.append(customMessageEntry(customType, content, display, details as JsonValue | undefined, timestamp));
	}

	async appendModelChange(provider: string, modelId: string): Promise<void> {
		const entry = modelEntry(provider, modelId);
		await this.intents.setModel(entry.provider, entry.modelId);
	}

	async appendThinkingLevelChange(thinkingLevel: ThinkingLevelChangeEntry["thinkingLevel"]): Promise<void> {
		await this.intents.setThinkingLevel(thinkingLevelEntry(thinkingLevel).thinkingLevel);
	}

	async appendFastModeChange(enabled: boolean): Promise<void> {
		await this.intents.setFastMode(fastModeEntry(enabled).enabled);
	}

	async appendPlanningState(planning: PlanningState): Promise<void> {
		await this.intents.setPlanning(planningEntry(planning).planning);
	}

	async appendSessionInfo(name: string): Promise<void> {
		await this.intents.setName(sessionInfoEntry(name).name ?? "");
	}

	async appendLabelChange(targetId: string, label: string | undefined): Promise<void> {
		const entry = labelEntry(targetId, label);
		if (!this.sessionManager.getEntry(entry.targetId)) throw new Error(`Entry ${entry.targetId} not found`);
		await this.intents.setLabel(entry.targetId, entry.label);
	}

	async appendSubagentSpawn(spawn: SubagentSpawnInput): Promise<string> {
		return this.append(subagentSpawnEntry(spawn));
	}

	async recordStartingGitContext(gitContext: RpcGitContext | null): Promise<boolean> {
		const entry = startingGitContextEntry(gitContext);
		if (!this.capturesStartingGitContext || !this.sessionManager.capturesStartingGitContext()) return false;
		this.capturesStartingGitContext = false;
		try {
			await this.append(entry);
		} catch (error) {
			this.capturesStartingGitContext = true;
			throw error;
		}
		return true;
	}

	async recordPrReviewBinding(placement: PrReviewPlacement): Promise<void> {
		const entry = prReviewBindingEntry(placement, this.sessionManager);
		const recording = this.bindings.then(async () => {
			if (!bindsAgain(this.sessionManager.getPrReviewBinding(), entry)) await this.append(entry);
		});
		this.bindings = recording.catch(() => undefined);
		await recording;
	}
}

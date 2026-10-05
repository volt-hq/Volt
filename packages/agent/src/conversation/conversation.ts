/**
 * The `Conversation` kernel (RFC §1, §5.1): one runtime bound to one
 * conversation log for its whole life.
 *
 * It folds the log once on open and owns one serialized commit lane: every
 * batch commits with `expectedOrdinal` equal to the fold's ordinal, is folded,
 * and only then published as a `committed` event. Turns run through the
 * stateless agent loop; each delivery commits as one batch, and every message
 * the loop finalizes commits before its `message_end` is published. Retry
 * backoff and compaction run inside the turn operation, so no other operation
 * can be admitted between a failed request and its recovery.
 *
 * Client input is durable: a receipt (and, for queued input, its queue
 * intent) commits before the input is acknowledged, and the pending set is
 * seeded from the fold's durable queue on open. Messages the host queues are
 * durable inputs with a host origin.
 *
 * Work (RFC §7) is written only through `work`: each start, checkpoint, and
 * finish is one batch, and a delivered result's notice commits with its
 * finish. A notice queued without waking (`message` delivery) never makes a
 * request by itself; it rides the next request a turn makes.
 */

import {
	type Api,
	type AssistantMessage,
	applyReplayPolicy,
	type Context,
	type ImageContent,
	isContextOverflow,
	type Message,
	type Model,
	type PromptCacheRefresher,
	type SimpleStreamOptions,
	type UserMessage,
} from "@hansjm10/volt-ai";
import {
	type ClientInputCommand,
	type ClientInputPayload,
	type ClientInputQueuedPayload,
	ClientInputQueuedPayloadSchema,
	CORE_LOG_ENTRY_TYPES,
	clientInputDigestMaterial,
	type LogEntryType,
	type WorkFinishedEntryPayload,
	type WorkNoticeDetails,
} from "@hansjm10/volt-protocol/entries";
import { WORK_NOTICE_CUSTOM_TYPE, type WorkEntryPayload, workPayloadBoundsError } from "@hansjm10/volt-protocol/work";
import { Check } from "typebox/value";
import { AgentDeliverySettlementError, runAgentLoop } from "../agent-loop.ts";
import { DeliveryInbox, type DeliveryLease, type InboxDelivery } from "../delivery-inbox.ts";
import type {
	AgentAbortAcceptance,
	AgentAbortSource,
	AgentDeliveryKind,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopDelivery,
	AgentLoopDeliveryOutcome,
	AgentLoopNextAction,
	AgentLoopNextActionContext,
	AgentLoopRequestUpdate,
	AgentMessage,
	AgentRequestAuthority,
	AgentTool,
	PrepareRequestContext,
	StreamFn,
} from "../types.ts";
import {
	type ConversationAdmitOptions,
	type ConversationAgentEvent,
	type ConversationCompactionCause,
	type ConversationCompactionDecision,
	type ConversationCompactionResult,
	type ConversationDeliveryKind,
	type ConversationEnd,
	type ConversationEntryInput,
	ConversationError,
	type ConversationEvent,
	type ConversationHostOperationContext,
	type ConversationInput,
	type ConversationInputAdmission,
	type ConversationInputOutcome,
	type ConversationListener,
	type ConversationNavigationOptions,
	type ConversationNavigationResult,
	type ConversationOperationKind,
	type ConversationOperationSnapshot,
	type ConversationOptions,
	type ConversationPhase,
	type ConversationPolicy,
	type ConversationPromptCacheRefreshResult,
	type ConversationPromptOptions,
	type ConversationQueue,
	type ConversationQueueModes,
	type ConversationRequestBoundary,
	type ConversationRequestContext,
	type ConversationRequestDelivery,
	type ConversationStreamOptions,
	type ConversationSummarizer,
	type ConversationTurnReservation,
	type ConversationWork,
	type ConversationWorkCheckpoint,
	type ConversationWorkFinish,
	type ConversationWorkFinished,
	type ConversationWorkStart,
} from "./api.ts";
import { buildContext } from "./context.ts";
import { type ConversationActivityKind, OperationCoordinator, type OperationLease } from "./coordinator.ts";
import {
	type ClientInputRecord,
	ConversationFoldError,
	type ConversationSnapshot,
	type ConversationState,
	clientInputRecovery,
	fold,
	type PlanningSnapshot,
	snapshot as snapshotState,
} from "./fold.ts";
import { CONVERSATION_LOG_READ_LIMIT_MAX } from "./in-memory-log.ts";
import {
	type ConversationLog,
	type ConversationLogEntry,
	type ConversationLogEntryDraft,
	ConversationLogLostError,
	isCoreLogEntry,
} from "./log.ts";
import { type CustomMessage, convertToLlm as convertRuntimeMessages } from "./messages.ts";
import {
	cloneAgentMessages,
	cloneNextAction,
	cloneNextActionContext,
	cloneStreamOptions,
	createAbortedAssistantStream,
	createFailureMessage,
	deepFreeze,
	toError,
	withRuntimeAbortDiagnostic,
} from "./runtime-support.ts";
import { type WorkReconciliation, type WorkRecord, workReconciliation } from "./work.ts";

type EntryBody = ConversationLogEntryDraft extends infer T
	? T extends unknown
		? Omit<T, "id" | "parentId" | "timestamp">
		: never
	: never;

/** Core types a host may append directly; the rest have intents. */
const HOST_APPENDABLE_CORE_TYPES: ReadonlyMap<string, LogEntryType> = new Map(
	(["custom", "custom_message", "message"] as const).map((type) => [type, CORE_LOG_ENTRY_TYPES[type]]),
);

/** Core types `prepareDelivery` may commit with a delivery: the host-appendable ones and a planning snapshot. */
const DELIVERY_ENTRY_CORE_TYPES: ReadonlyMap<string, LogEntryType> = new Map([
	...HOST_APPENDABLE_CORE_TYPES,
	["planning_state_change", CORE_LOG_ENTRY_TYPES.planning_state_change],
]);

type ClientUserMessage = UserMessage & { clientMessageId?: string };

/** The input of a host input that queues messages instead of a user message. */
const HOST_INPUT: ClientInputPayload = { message: "", images: [] };

interface DeliveryMeta {
	readonly kind: AgentDeliveryKind;
	readonly clientMessageId?: string;
	/** User-bearing input that establishes a new request batch. */
	readonly requestInput: boolean;
	/** Quiet host input: it rides a request a turn makes anyway and never makes one itself. */
	readonly wake?: false;
}

interface InputWaiter {
	readonly promise: Promise<ConversationInputOutcome>;
	resolve(outcome: ConversationInputOutcome): void;
	reject(error: Error): void;
	delivered?: { readonly entryId: string; readonly ordinal: number };
}

interface ContinuationState {
	readonly requestAuthority: AgentRequestAuthority;
	readonly providerRequestPending: boolean;
}

interface DispatchStart {
	firstDecision: boolean;
	readonly requestAuthority: AgentRequestAuthority;
	readonly providerRequestPending: boolean;
	readonly drainFollowUpsFirst: boolean;
	/** The turn's first start: an assistant tail is checked for compaction before anything is requested. */
	readonly checkTail?: boolean;
}

interface PreparedRequest {
	/** The fold's branch messages the loop's provider context was built from. */
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly AgentTool[] | undefined;
	readonly configurationEpoch: number;
	readonly boundary: Omit<ConversationRequestBoundary, "attemptId" | "basisOrdinal">;
}

/** A compaction the turn operation runs, and the assistant message it was decided on. */
interface TurnCompaction {
	readonly cause: "overflow" | "threshold";
	readonly decision: ConversationCompactionDecision;
	readonly message: AssistantMessage;
	/** The message's entry, which a retry leaves out of its requests when it is a tool-free length stop. */
	readonly entryId: string | undefined;
	/** Before the turn's first request, between requests, or after its final message. */
	readonly at: "start" | "between" | "end";
}

/** Work the turn operation does after its loop ends, decided before the loop's terminal event. */
type TurnFollowUp =
	| { readonly kind: "retry"; readonly delayMs: number; readonly message: AssistantMessage }
	| { readonly kind: "compact"; readonly compaction: TurnCompaction };

interface TurnRun {
	readonly lease: OperationLease<ConversationOperationKind>;
	readonly signal: AbortSignal;
	/** Messages committed by this operation, by identity: delivered input and finalized loop messages. */
	readonly committedMessages: Set<AgentMessage>;
	readonly deliveredInputs: string[];
	newMessages: AgentMessage[];
	turnOpen: boolean;
	terminalSettling: boolean;
	agentEnded: boolean;
	committedDelivery: boolean;
	retryAttempt: number;
	overflowRecovered: boolean;
	retryRequest: boolean;
	followUp: TurnFollowUp | undefined;
	pendingCompaction: TurnCompaction | undefined;
	request: PreparedRequest | undefined;
	/** The newest assistant message this operation committed. */
	lastAssistantEntryId: string | undefined;
	/** A retried request runs before a pending prompt is delivered. */
	holdPrompts: boolean;
	/** A tool-free length-stopped message this operation's requests leave out. */
	dropEntryId: string | undefined;
}

interface RecordedRequest {
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options: SimpleStreamOptions;
	readonly configurationEpoch: number;
	readonly messages: readonly AgentMessage[];
	readonly modelRef: string;
	readonly thinkingLevel: string;
	readonly fastMode: boolean;
}

/** Builds one batch's drafts against a provisional leaf, so each draft's parent is the branch tip before it. */
class EntryDrafts {
	readonly drafts: ConversationLogEntryDraft[] = [];
	private leafId: string | null;
	private readonly createId: () => string;
	private readonly timestamp = new Date().toISOString();

	constructor(state: ConversationState, createId: () => string) {
		this.leafId = state.leafId;
		this.createId = createId;
	}

	add(body: EntryBody): ConversationLogEntryDraft {
		const id = this.createId();
		const draft = {
			...body,
			id,
			parentId: this.leafId,
			timestamp: this.timestamp,
			payload: structuredClone(body.payload),
		} as ConversationLogEntryDraft;
		this.drafts.push(draft);
		if (body.visibility === "public") this.leafId = id;
		return draft;
	}

	moveLeaf(targetId: string | null): void {
		this.add({ type: "leaf", visibility: "host", payload: { targetId } });
		this.leafId = targetId;
	}
}

function clientMessageIdOf(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	const id = (message as ClientUserMessage).clientMessageId;
	return typeof id === "string" ? id : undefined;
}

function withoutClientMessageId(message: AgentMessage): AgentMessage {
	if (clientMessageIdOf(message) === undefined) return message;
	const { clientMessageId: _clientMessageId, ...rest } = message as ClientUserMessage;
	return rest;
}

function clientUserMessage(text: string, images: readonly ImageContent[], clientMessageId: string): ClientUserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }, ...images.map((image) => structuredClone(image))],
		timestamp: Date.now(),
		clientMessageId,
	};
}

/** Input images in their canonical stored form. */
function canonicalImages(images: readonly ImageContent[]): ImageContent[] {
	return images.map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data }));
}

/** The default conversion: runtime messages to provider messages, without client identities. */
function convertConversationMessages(messages: AgentMessage[]): Message[] {
	return convertRuntimeMessages(messages.map(withoutClientMessageId));
}

/** A client input's `semanticDigest`: hex SHA-256 of its {@link clientInputDigestMaterial}. */
export async function clientInputDigest(command: ClientInputCommand, input: ClientInputPayload): Promise<string> {
	const bytes = new TextEncoder().encode(clientInputDigestMaterial(command, input));
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function isPrefix(prefix: readonly AgentMessage[], messages: readonly AgentMessage[]): boolean {
	return prefix.length <= messages.length && prefix.every((message, index) => messages[index] === message);
}

function isAgentEvent(event: ConversationEvent): event is ConversationAgentEvent {
	return "basedOn" in event;
}

export class Conversation<TTool extends AgentTool = AgentTool> {
	readonly conversationId: string;
	/** Resolves once, when the conversation ends: closed, or its log was lost. */
	readonly ended: Promise<ConversationEnd>;
	/** The conversation's work items: start, checkpoint, finish with delivery, and reconciliation on open. */
	readonly work: ConversationWork;
	private readonly log: ConversationLog;
	private readonly productTypes: ReadonlyMap<string, LogEntryType>;
	private readonly baseStream: StreamFn;
	private readonly resolveModelRef: ConversationOptions["resolveModel"];
	private readonly promptCacheRefresher: PromptCacheRefresher | undefined;
	private readonly summarizer: ConversationSummarizer | undefined;
	private readonly systemPromptSource: ConversationOptions["systemPrompt"];
	private readonly convertMessages: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	private readonly policy: ConversationPolicy;
	private readonly createId: () => string;
	private readonly coordinator: OperationCoordinator<ConversationOperationKind>;
	private readonly inbox: DeliveryInbox<AgentDeliveryKind, AgentMessage>;
	private readonly deliveryMeta = new Map<string, DeliveryMeta>();
	private readonly attemptIds = new Map<string, string>();
	private readonly inputWaiters = new Map<string, InputWaiter>();
	private readonly admitting = new Map<string, Promise<unknown>>();
	/** Inputs admitted without delivery in this runtime that the host may still deliver. */
	private readonly undelivered = new Set<string>();
	/** Entries `prepareDelivery` returned, by prepared delivery, committed with it. */
	private readonly deliveryEntries = new Map<string, readonly EntryBody[]>();
	private readonly listeners = new Set<ConversationListener>();
	private tools: TTool[];
	private streamOptions: ConversationStreamOptions;
	private modes: ConversationQueueModes;
	private configurationEpoch = 0;
	private foldState: ConversationState;
	private laneTail: Promise<unknown> = Promise.resolve();
	private eventTail: Promise<void> = Promise.resolve();
	private activeLease: DeliveryLease<AgentDeliveryKind, AgentMessage> | undefined;
	private reservation:
		| { readonly handle: ConversationTurnReservation; readonly lease: OperationLease<ConversationOperationKind> }
		| undefined;
	private successorTurn: ReturnType<OperationCoordinator<ConversationOperationKind>["reserveSuccessor"]>;
	private continuation: ContinuationState | undefined;
	private requestBatch: ConversationRequestBoundary["batch"];
	private pendingRequestDeliveries: ConversationRequestDelivery[] = [];
	private lastRequest: RecordedRequest | undefined;
	private endState: ConversationEnd | undefined;
	private resolveEnded: (end: ConversationEnd) => void = () => {};
	private closePromise: Promise<void> | undefined;
	private reconciliation: Promise<WorkReconciliation> | undefined;
	private workReconciled = false;

	private constructor(options: ConversationOptions<TTool>, state: ConversationState) {
		this.conversationId = options.log.conversationId;
		this.log = options.log;
		const productTypes = new Map<string, LogEntryType>();
		for (const definition of options.entryTypes ?? []) {
			if (Object.hasOwn(CORE_LOG_ENTRY_TYPES, definition.type)) {
				throw new ConversationError("invalid_argument", `Product entry type ${definition.type} is a core type`);
			}
			productTypes.set(definition.type, definition);
		}
		this.productTypes = productTypes;
		this.baseStream = options.stream;
		this.resolveModelRef = options.resolveModel;
		this.promptCacheRefresher = options.promptCacheRefresh;
		this.summarizer = options.summarizer;
		this.systemPromptSource = options.systemPrompt;
		this.convertMessages = options.convertToLlm ?? convertConversationMessages;
		this.policy = options.policy ?? {};
		this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
		this.tools = [...(options.tools ?? [])];
		this.streamOptions = cloneStreamOptions(options.streamOptions);
		this.modes = {
			steer: options.queueModes?.steer ?? "one-at-a-time",
			followUp: options.queueModes?.followUp ?? "one-at-a-time",
		};
		this.foldState = state;
		this.inbox = new DeliveryInbox(() => `conversation-delivery:${this.createId()}`);
		this.coordinator = new OperationCoordinator<ConversationOperationKind>({
			...(options.admissionGate === undefined ? {} : { admissionGate: options.admissionGate }),
			busyError: (message) => new ConversationError("busy", message),
			leaseIdPrefix: "conversation-operation",
			onPhaseChange: (phase) => void this.publish({ type: "phase_changed", phase }),
		});
		this.ended = new Promise((resolve) => {
			this.resolveEnded = resolve;
		});
		this.work = Object.freeze({
			reconcile: () => this.reconcileWork(),
			start: (work: ConversationWorkStart) => this.startWork(work),
			checkpoint: (workId: string, checkpoint: ConversationWorkCheckpoint) =>
				this.checkpointWork(workId, checkpoint),
			finish: (workId: string, finish: ConversationWorkFinish) => this.finishWork(workId, finish),
			withdrawHostInput: (clientMessageId: string) => this.withdrawHostInput(clientMessageId),
		});
		void this.log.lost.then((error) => this.handleLoss(error));
		this.seedRecoveredInputs();
	}

	/** Fold the whole log and open a conversation over it. */
	static async open<TTool extends AgentTool = AgentTool>(
		options: ConversationOptions<TTool>,
	): Promise<Conversation<TTool>> {
		const entries: ConversationLogEntry[] = [];
		for (;;) {
			const page = await options.log.read(entries.length, CONVERSATION_LOG_READ_LIMIT_MAX);
			entries.push(...page.entries);
			if (page.entries.length === 0 || entries.length >= page.lastOrdinal) break;
		}
		return new Conversation(options, fold(entries));
	}

	// ==========================================================================
	// State
	// ==========================================================================

	/** The fold of every committed entry. */
	get state(): ConversationState {
		return this.foldState;
	}

	snapshot(): ConversationSnapshot {
		return snapshotState(this.foldState);
	}

	/** The model the active branch names, resolved; undefined when unset or unknown. */
	get model(): Model<Api> | undefined {
		return this.resolveModel(this.foldState);
	}

	get phase(): ConversationPhase {
		return this.coordinator.phase;
	}

	get busy(): boolean {
		return this.coordinator.busy;
	}

	get operation(): ConversationOperationSnapshot | undefined {
		const lease = this.coordinator.current;
		if (!lease) return undefined;
		return Object.freeze({
			id: lease.id,
			kind: lease.kind,
			stage: lease.stage,
			requestAccepted: lease.requestAccepted,
			signal: lease.abortGate.signal,
			...(lease.abortSource === undefined ? {} : { abortSource: lease.abortSource }),
		});
	}

	get queue(): ConversationQueue {
		const messages = (kind: AgentDeliveryKind) =>
			cloneAgentMessages(this.inbox.list(kind).flatMap((delivery) => delivery.messages));
		return { prompt: messages("prompt"), steer: messages("steer"), followUp: messages("followUp") };
	}

	get activeTools(): readonly TTool[] {
		return [...this.tools];
	}

	setTools(tools: readonly TTool[]): void {
		this.assertActive();
		const names = new Set<string>();
		for (const tool of tools) {
			if (names.has(tool.name)) throw new ConversationError("invalid_argument", `Duplicate tool name: ${tool.name}`);
			names.add(tool.name);
		}
		this.tools = [...tools];
		this.configurationEpoch++;
	}

	get currentStreamOptions(): ConversationStreamOptions {
		return cloneStreamOptions(this.streamOptions);
	}

	setStreamOptions(streamOptions: ConversationStreamOptions): void {
		this.assertActive();
		this.streamOptions = cloneStreamOptions(streamOptions);
		this.configurationEpoch++;
	}

	get queueModes(): ConversationQueueModes {
		return this.modes;
	}

	setQueueModes(modes: Partial<ConversationQueueModes>): void {
		this.assertActive();
		this.modes = { steer: modes.steer ?? this.modes.steer, followUp: modes.followUp ?? this.modes.followUp };
	}

	subscribe(listener: ConversationListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Resolves when no exclusive operation runs and the events published before it are delivered. */
	async waitForIdle(): Promise<void> {
		await this.coordinator.waitForIdle();
		await this.eventTail;
	}

	/** Resolves when nothing is busy, activities included, and published events are delivered. */
	async waitForNotBusy(): Promise<void> {
		await this.coordinator.waitForNotBusy();
		await this.eventTail;
	}

	// ==========================================================================
	// Client input
	// ==========================================================================

	/**
	 * Admit a prompt. While a turn runs, a prompt needs `streamingBehavior` and
	 * is queued with it. With a reservation, the prompt's turn runs under it.
	 */
	async prompt(
		input: ConversationInput,
		options: ConversationPromptOptions = {},
	): Promise<ConversationInputAdmission> {
		this.assertActive();
		const reserved = options.reservation === undefined ? undefined : this.takeReservation(options.reservation);
		return await this.admit("prompt", input, { reserved });
	}

	steer(input: ConversationInput): Promise<ConversationInputAdmission> {
		return this.admit("steer", input);
	}

	followUp(input: ConversationInput): Promise<ConversationInputAdmission> {
		return this.admit("follow_up", input);
	}

	/**
	 * Claim the idle conversation for one turn while the host prepares its
	 * input; pass the reservation to `prompt`, or cancel it.
	 */
	reserve(): ConversationTurnReservation {
		this.assertActive();
		const lease = this.coordinator.reserve("turn");
		if (!lease) throw new ConversationError("busy", "The conversation is busy");
		const handle: ConversationTurnReservation = Object.freeze({
			id: lease.id,
			signal: lease.abortGate.signal,
			cancel: () => {
				if (this.reservation?.handle !== handle) return false;
				this.releaseReservation();
				if (this.hasWakingInput()) this.startTurnForQueuedInput();
				return true;
			},
		});
		this.reservation = { handle, lease };
		return handle;
	}

	/**
	 * Admit an input without delivering it, for input the host runs itself (an
	 * extension command). Mark it started before running it, then settle it, or
	 * deliver it by submitting the same input to `prompt`, `steer`, or `followUp`.
	 */
	admitInput(
		command: ClientInputCommand,
		input: ConversationInput,
		options: ConversationAdmitOptions,
	): Promise<ConversationInputAdmission> {
		return this.admit(command, input, { deliver: options.deliver });
	}

	/**
	 * Record that the host started running an accepted input it was not asked to
	 * deliver: the at-most-once fence. A started input without an outcome is
	 * never run again; after a restart it blocks recovery as ambiguous.
	 */
	async markInputStarted(clientMessageId: string): Promise<void> {
		this.assertActive();
		await this.commit((drafts, state) => {
			const record = state.clientInputs.inputs.get(clientMessageId);
			const pending = [...this.deliveryMeta.values()].some((meta) => meta.clientMessageId === clientMessageId);
			if (record?.state !== "accepted" || pending) {
				throw new ConversationError(
					"invalid_argument",
					`Client input ${JSON.stringify(clientMessageId)} cannot be marked started`,
				);
			}
			drafts.add({
				type: "client_input_state",
				visibility: "host",
				payload: { receiptId: record.receiptId, clientMessageId, state: "started" },
			});
		});
	}

	/**
	 * Queue host messages (extension messages, notices, checkpoints) as one
	 * durable input with a host origin; a turn delivers them as one batch.
	 */
	async queueMessages(
		kind: "steer" | "followUp",
		messages: readonly AgentMessage[],
	): Promise<ConversationInputAdmission> {
		this.assertActive();
		if (messages.length === 0) throw new ConversationError("invalid_argument", "A delivery needs a message");
		const owned = cloneAgentMessages(messages).map(withoutClientMessageId);
		const command = kind === "steer" ? "steer" : "follow_up";
		const queuedInput = { delivery: command, message: "", images: [], messages: owned };
		if (!Check(ClientInputQueuedPayloadSchema, queuedInput)) {
			throw new ConversationError("invalid_argument", "Host messages must be log messages");
		}
		const clientMessageId = this.createId();
		const admission = await this.enqueueLane(async (): Promise<ConversationInputAdmission> => {
			const digest = await clientInputDigest(command, HOST_INPUT);
			const entries = await this.commitInLane((drafts) => {
				this.addHostInput(drafts, clientMessageId, digest, queuedInput);
			});
			this.enqueueDelivery(kind, owned, { kind, clientMessageId, requestInput: false });
			return {
				clientMessageId,
				ordinals: entries.map((entry) => entry.ordinal),
				completion: this.createWaiter(clientMessageId).promise,
			};
		});
		this.startTurnForQueuedInput();
		return admission;
	}

	/** A host input's receipt and queue intent: its messages are delivered as one batch. */
	private addHostInput(
		drafts: EntryDrafts,
		clientMessageId: string,
		digest: string,
		queuedInput: ClientInputQueuedPayload,
	): void {
		const receipt = drafts.add({
			type: "client_input_receipt",
			visibility: "host",
			payload: {
				clientMessageId,
				command: queuedInput.delivery,
				semanticDigest: digest,
				input: HOST_INPUT,
				origin: "host",
			},
		});
		drafts.add({
			type: "client_input_queued",
			visibility: "host",
			payload: { receiptId: receipt.id, clientMessageId, queuedInput },
		});
	}

	/** Withdraw every queued steer and follow-up; durable inputs record `withdrawn`. */
	async clearQueue(): Promise<ConversationQueue> {
		this.assertActive();
		const revoked = [...this.inbox.revoke("steer"), ...this.inbox.revoke("followUp")].sort(
			(left, right) => left.sequence - right.sequence,
		);
		if (revoked.length === 0) return { prompt: [], steer: [], followUp: [] };
		const withdrawn: string[] = [];
		for (const delivery of revoked) {
			const meta = this.deliveryMeta.get(delivery.deliveryId);
			this.deliveryMeta.delete(delivery.deliveryId);
			this.attemptIds.delete(delivery.deliveryId);
			if (meta?.clientMessageId !== undefined) withdrawn.push(meta.clientMessageId);
		}
		this.publishQueue();
		if (withdrawn.length > 0) {
			await this.commit((drafts, state) => {
				for (const clientMessageId of withdrawn) {
					const record = state.clientInputs.inputs.get(clientMessageId);
					if (record?.state !== "accepted") continue;
					drafts.add({
						type: "client_input_state",
						visibility: "host",
						payload: { receiptId: record.receiptId, clientMessageId, state: "withdrawn" },
					});
				}
			});
			for (const clientMessageId of withdrawn) this.settleWaiter(clientMessageId, { state: "withdrawn" });
		}
		const messages = (kind: AgentDeliveryKind) =>
			cloneAgentMessages(
				revoked.filter((delivery) => delivery.kind === kind).flatMap((delivery) => delivery.messages),
			);
		return { prompt: [], steer: messages("steer"), followUp: messages("followUp") };
	}

	/**
	 * Record a client input's outcome without delivering it: the host handled
	 * it (`completed`), rejected it (`failed`), or took it back (`withdrawn`).
	 */
	async settleClientInput(
		clientMessageId: string,
		outcome:
			| { readonly state: "completed" }
			| { readonly state: "failed"; readonly error: string }
			| {
					readonly state: "withdrawn";
			  },
	): Promise<void> {
		this.assertActive();
		const record = this.foldState.clientInputs.inputs.get(clientMessageId);
		if (record?.state !== "accepted" && (record?.state !== "started" || outcome.state === "withdrawn")) {
			throw new ConversationError(
				"invalid_argument",
				`Client input ${JSON.stringify(clientMessageId)} cannot become ${outcome.state}`,
			);
		}
		const pending = [...this.deliveryMeta].find(([, meta]) => meta.clientMessageId === clientMessageId);
		if (pending) {
			if (!this.inbox.withdraw(pending[0])) {
				throw new ConversationError("busy", `Client input ${clientMessageId} is being delivered`);
			}
			this.deliveryMeta.delete(pending[0]);
			this.publishQueue();
		}
		const [entry] = await this.commit((drafts, state) => {
			const record = state.clientInputs.inputs.get(clientMessageId);
			if (!record) throw new ConversationError("invalid_argument", `Unknown client input ${clientMessageId}`);
			drafts.add({
				type: "client_input_state",
				visibility: "host",
				payload: {
					receiptId: record.receiptId,
					clientMessageId,
					state: outcome.state,
					...(outcome.state === "failed" ? { error: outcome.error } : {}),
				},
			});
		});
		this.undelivered.delete(clientMessageId);
		this.settleWaiter(
			clientMessageId,
			outcome.state !== "completed"
				? outcome
				: {
						state: "completed",
						entryId: entry?.id ?? clientMessageId,
						ordinal: entry?.ordinal ?? this.foldState.ordinal,
					},
		);
		this.seedRecoveredInputs();
	}

	/** Take the held reservation for a prompt; it is consumed even when admission then fails. */
	private takeReservation(handle: ConversationTurnReservation): OperationLease<ConversationOperationKind> {
		const held = this.reservation;
		if (held?.handle !== handle) throw new ConversationError("invalid_state", "The turn reservation is not held");
		this.reservation = undefined;
		return held.lease;
	}

	/** Release the held reservation, if any: cancelled by the host, or revoked. */
	private releaseReservation(): void {
		const held = this.reservation;
		this.reservation = undefined;
		if (held) this.coordinator.finish(held.lease);
	}

	private async admit(
		command: ClientInputCommand,
		input: ConversationInput,
		options: {
			readonly reserved?: OperationLease<ConversationOperationKind> | undefined;
			readonly deliver?: boolean;
		} = {},
	): Promise<ConversationInputAdmission> {
		const reserved = options.reserved;
		const deliver = options.deliver !== false;
		let lease = reserved;
		let clientMessageId: string;
		let payload: ClientInputPayload;
		let immediate: boolean;
		try {
			this.assertActive();
			if (command !== "prompt" && input.streamingBehavior !== undefined) {
				throw new ConversationError("invalid_argument", "Only a prompt may set streamingBehavior");
			}
			if (reserved && !this.coordinator.canStart(reserved)) {
				throw new ConversationError("busy", "Operation admission was revoked");
			}
			clientMessageId = input.clientMessageId ?? this.createId();
			const inFlight = this.admitting.get(clientMessageId);
			if (inFlight) {
				await inFlight.catch(() => undefined);
				return await this.admit(command, input, options);
			}
			payload = {
				message: input.message,
				images: canonicalImages(input.images ?? []),
				...(input.streamingBehavior === undefined ? {} : { streamingBehavior: input.streamingBehavior }),
			};
			const existing = this.foldState.clientInputs.inputs.get(clientMessageId);
			// A new input, or one admitted without delivery that the host now delivers.
			const deliverable = deliver && (existing === undefined || this.undelivered.has(clientMessageId));
			immediate = deliverable && command === "prompt" && (reserved !== undefined || !this.coordinator.current);
			if (deliverable && command === "prompt" && !immediate && input.streamingBehavior === undefined) {
				throw new ConversationError("busy", "The conversation is busy; queue the prompt with a streaming behavior");
			}
			if (immediate) {
				this.requireModel();
				lease ??= this.coordinator.reserve("turn");
				if (!lease) throw new ConversationError("ended", "The conversation has ended");
			}
		} catch (error) {
			if (lease) this.coordinator.finish(lease);
			throw error;
		}
		const origin = input.origin === "host" ? "host" : undefined;
		const queuedDelivery =
			command === "prompt" ? (input.streamingBehavior === "steer" ? "steer" : "follow_up") : command;
		const delivery = immediate ? undefined : queuedDelivery;
		const kind: AgentDeliveryKind = delivery === undefined ? "prompt" : delivery === "steer" ? "steer" : "followUp";
		const prepared = input.prepared ?? { message: input.message, images: payload.images };
		const preparedImages = canonicalImages(prepared.images ?? []);
		const attachments = cloneAgentMessages(input.attachments ?? []);
		const admission = this.enqueueLane(
			async (): Promise<{ admission: ConversationInputAdmission; delivered: boolean }> => {
				const digest = await clientInputDigest(command, payload);
				const record = this.foldState.clientInputs.inputs.get(clientMessageId);
				const pendingHostRun =
					record !== undefined &&
					this.undelivered.has(clientMessageId) &&
					(record.state === "accepted" || record.state === "started");
				if (record && (!deliver || !pendingHostRun)) {
					return { admission: this.readmit(record, command, origin, digest), delivered: false };
				}
				if (record) this.assertSameInput(record, command, origin, digest);
				const entries = await this.commitInLane((drafts) => {
					const receiptId =
						record?.receiptId ??
						drafts.add({
							type: "client_input_receipt",
							visibility: "host",
							payload: {
								clientMessageId,
								command,
								semanticDigest: digest,
								input: payload,
								...(origin === undefined ? {} : { origin }),
							},
						}).id;
					if (deliver && delivery !== undefined) {
						drafts.add({
							type: "client_input_queued",
							visibility: "host",
							payload: {
								receiptId,
								clientMessageId,
								queuedInput: { delivery, message: prepared.message, images: preparedImages },
							},
						});
					}
				});
				if (deliver) {
					this.undelivered.delete(clientMessageId);
					this.enqueueDelivery(
						kind,
						[clientUserMessage(prepared.message, preparedImages, clientMessageId), ...attachments],
						{ kind, clientMessageId, requestInput: true },
					);
				} else {
					this.undelivered.add(clientMessageId);
				}
				const waiter = this.inputWaiters.get(clientMessageId) ?? this.createWaiter(clientMessageId);
				return {
					admission: {
						clientMessageId,
						ordinals: entries.map((entry) => entry.ordinal),
						completion: waiter.promise,
					},
					delivered: deliver,
				};
			},
		);
		this.admitting.set(clientMessageId, admission);
		let result: Awaited<typeof admission>;
		try {
			result = await admission;
		} catch (error) {
			if (lease) this.coordinator.finish(lease);
			throw error;
		} finally {
			if (this.admitting.get(clientMessageId) === admission) this.admitting.delete(clientMessageId);
		}
		if (lease) {
			if (!result.delivered) {
				this.coordinator.finish(lease);
			} else {
				// A new prompt starts fresh: a paused continuation does not carry over to it.
				this.continuation = undefined;
				void this.runTurn(lease, this.continueStart()).catch(() => undefined);
			}
		} else if (result.delivered) {
			this.startTurnForQueuedInput();
		}
		return result.admission;
	}

	private assertSameInput(
		record: ClientInputRecord,
		command: ClientInputCommand,
		origin: ClientInputRecord["origin"],
		digest: string,
	): void {
		if (record.command !== command || record.origin !== origin || record.semanticDigest !== digest) {
			throw new ConversationError(
				"client_input_conflict",
				`Client message ${JSON.stringify(record.clientMessageId)} was already used for different input`,
			);
		}
	}

	private readmit(
		record: ClientInputRecord,
		command: ClientInputCommand,
		origin: ClientInputRecord["origin"],
		digest: string,
	): ConversationInputAdmission {
		this.assertSameInput(record, command, origin, digest);
		const resolved = (outcome: ConversationInputOutcome): ConversationInputAdmission => ({
			clientMessageId: record.clientMessageId,
			ordinals: [],
			completion: Promise.resolve(outcome),
		});
		if (record.state === "completed") {
			const entry = this.foldState.tree.byId.get(record.canonicalEntryId ?? record.receiptId);
			return resolved({ state: "completed", entryId: entry?.id ?? record.receiptId, ordinal: entry?.ordinal ?? 0 });
		}
		if (record.state === "failed") return resolved({ state: "failed", error: record.error ?? "Client input failed" });
		if (record.state === "withdrawn") return resolved({ state: "withdrawn" });
		const waiter = this.inputWaiters.get(record.clientMessageId) ?? this.createWaiter(record.clientMessageId);
		return { clientMessageId: record.clientMessageId, ordinals: [], completion: waiter.promise };
	}

	private createWaiter(clientMessageId: string): InputWaiter {
		let resolve: (outcome: ConversationInputOutcome) => void = () => {};
		let reject: (error: Error) => void = () => {};
		const promise = new Promise<ConversationInputOutcome>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		void promise.catch(() => undefined);
		const waiter: InputWaiter = { promise, resolve, reject };
		this.inputWaiters.set(clientMessageId, waiter);
		return waiter;
	}

	private settleWaiter(clientMessageId: string, outcome: ConversationInputOutcome): void {
		this.inputWaiters.get(clientMessageId)?.resolve(outcome);
		this.inputWaiters.delete(clientMessageId);
	}

	private enqueueDelivery(kind: AgentDeliveryKind, messages: readonly AgentMessage[], meta: DeliveryMeta): string {
		const delivery = this.inbox.enqueue(kind, messages);
		this.deliveryMeta.set(delivery.deliveryId, meta);
		this.publishQueue();
		return delivery.deliveryId;
	}

	/** Pending durable inputs a previous runtime left queued; nothing past a started input is replayed. */
	private seedRecoveredInputs(): void {
		const recovery = clientInputRecovery(this.foldState);
		if (recovery.kind !== "replay") return;
		const pending = new Set([...this.deliveryMeta.values()].map((meta) => meta.clientMessageId));
		for (const record of recovery.records) {
			const queued = record.queuedInput;
			if (!queued || pending.has(record.clientMessageId)) continue;
			const kind = queued.delivery === "steer" ? "steer" : "followUp";
			const messages = queued.messages
				? cloneAgentMessages(queued.messages)
				: [clientUserMessage(queued.message, queued.images, record.clientMessageId)];
			this.enqueueDelivery(kind, messages, {
				kind,
				clientMessageId: record.clientMessageId,
				requestInput: queued.messages === undefined,
				...(queued.wake === false ? { wake: false } : {}),
			});
		}
	}

	/** Start a turn for newly queued input when nothing will deliver it: idle, or behind a non-turn or settling operation. */
	private startTurnForQueuedInput(): void {
		if (
			!this.coordinator.isOpen ||
			!this.coordinator.admissionOpen ||
			this.resolveModel(this.foldState) === undefined
		) {
			return;
		}
		const current = this.coordinator.current;
		if (!current) {
			const lease = this.coordinator.reserve("turn");
			if (lease) void this.runTurn(lease, this.continueStart()).catch(() => undefined);
			return;
		}
		if (current.kind === "turn" && (current.stage === "admitted" || current.stage === "executing")) return;
		if (this.successorTurn) return;
		const successor = this.coordinator.reserveSuccessor("turn");
		if (!successor) return;
		this.successorTurn = successor;
		void successor.ready.then(() => {
			if (this.successorTurn === successor) this.successorTurn = undefined;
			if (this.coordinator.current !== successor.lease) return;
			if (!this.hasWakingInput()) {
				// The previous turn delivered the input after all.
				this.coordinator.finish(successor.lease);
				return;
			}
			void this.runTurn(successor.lease, this.continueStart()).catch(() => undefined);
		});
	}

	/** Whether a pending delivery starts or extends a turn; quiet host input never does. */
	private wakes(delivery: InboxDelivery<AgentDeliveryKind, AgentMessage>): boolean {
		return this.deliveryMeta.get(delivery.deliveryId)?.wake !== false;
	}

	private hasWakingInput(kind?: AgentDeliveryKind): boolean {
		return this.inbox.list(kind).some((delivery) => this.wakes(delivery));
	}

	// ==========================================================================
	// Turns
	// ==========================================================================

	/**
	 * Run a turn over pending input, a paused continuation, or a context that
	 * ends with input. A context ending with an assistant message and nothing
	 * pending completes without a request.
	 */
	async continue(): Promise<void> {
		this.assertActive();
		const lease = this.coordinator.reserve("turn");
		if (!lease) throw new ConversationError("busy", "The conversation is busy");
		const tail = this.foldState.context.messages.at(-1);
		const pending = this.hasWakingInput();
		if (!tail && !pending) {
			this.coordinator.finish(lease);
			throw new ConversationError("invalid_state", "No messages to continue from");
		}
		if (tail?.role === "assistant" && !pending && !this.policy.nextAction && this.continuation === undefined) {
			this.coordinator.finish(lease);
			return;
		}
		try {
			this.requireModel();
		} catch (error) {
			this.coordinator.finish(lease);
			throw error;
		}
		await this.runTurn(lease, this.continueStart());
	}

	/**
	 * Abort the active operation, revoking a held reservation. Queued input
	 * stays pending until it is delivered or cleared.
	 */
	abort(source?: AgentAbortSource): AgentAbortAcceptance {
		this.successorTurn?.cancel();
		this.successorTurn = undefined;
		const acceptance = this.coordinator.requestAbort(source);
		this.releaseReservation();
		return acceptance;
	}

	/** Revoke observational input identity for the next request boundary. */
	invalidateRequestBoundary(): void {
		this.requestBatch = undefined;
		this.pendingRequestDeliveries = [];
	}

	private continueStart(): DispatchStart {
		const tail = this.foldState.context.messages.at(-1);
		const continuation = this.continuation;
		return {
			firstDecision: true,
			requestAuthority: continuation?.requestAuthority ?? "provider",
			providerRequestPending:
				continuation?.providerRequestPending ?? (tail !== undefined && tail.role !== "assistant"),
			drainFollowUpsFirst: tail?.role === "assistant",
		};
	}

	private async runTurn(lease: OperationLease<ConversationOperationKind>, initial: DispatchStart): Promise<void> {
		this.coordinator.start(lease);
		const run: TurnRun = {
			lease,
			signal: lease.abortGate.signal,
			committedMessages: new Set(),
			deliveredInputs: [],
			newMessages: [],
			turnOpen: false,
			terminalSettling: false,
			agentEnded: false,
			committedDelivery: false,
			retryAttempt: 0,
			overflowRecovered: false,
			retryRequest: false,
			followUp: undefined,
			pendingCompaction: undefined,
			request: undefined,
			lastAssistantEntryId: undefined,
			holdPrompts: false,
			dropEntryId: undefined,
		};
		try {
			let start: DispatchStart = { ...initial, checkTail: true };
			for (;;) {
				const model = this.resolveModel(this.foldState);
				if (!model) break;
				await this.runLoop(run, start, model);
				if (run.signal.aborted || !this.coordinator.isOpen) break;
				const next = await this.afterLoop(run);
				if (!next) break;
				start = next;
			}
		} finally {
			if (run.retryAttempt > 0) void this.publishRetryEnd(run, false, "Retry cancelled");
			for (const clientMessageId of run.deliveredInputs) {
				const waiter = this.inputWaiters.get(clientMessageId);
				if (waiter?.delivered) {
					waiter.resolve({ state: "completed", ...waiter.delivered });
					this.inputWaiters.delete(clientMessageId);
				}
			}
			this.coordinator.finish(lease);
		}
	}

	/** Retry backoff and compaction after a loop ends; returns how to continue, or undefined to finish. */
	private async afterLoop(run: TurnRun): Promise<DispatchStart | undefined> {
		const next = await this.nextStart(run);
		if (next || !run.holdPrompts) return next;
		// The retry that ran before a pending prompt ended without a paused continuation: deliver the prompt.
		run.holdPrompts = false;
		return this.continuation === undefined && this.inbox.hasPending("prompt") ? this.continueStart() : undefined;
	}

	private async nextStart(run: TurnRun): Promise<DispatchStart | undefined> {
		const pendingCompaction = run.pendingCompaction;
		run.pendingCompaction = undefined;
		if (pendingCompaction) return await this.compactAndResume(run, pendingCompaction);
		const followUp = run.followUp;
		run.followUp = undefined;
		if (!followUp) {
			if (run.retryAttempt > 0) void this.publishRetryEnd(run, true);
			return undefined;
		}
		if (followUp.kind === "retry") {
			run.retryAttempt++;
			void this.publish({
				type: "retry_start",
				attempt: run.retryAttempt,
				delayMs: followUp.delayMs,
				error: followUp.message.error ?? { kind: "unknown", retryable: true, message: "Request failed" },
			});
			if (!(await sleep(followUp.delayMs, run.signal))) {
				void this.publishRetryEnd(run, false, "Retry cancelled");
				return undefined;
			}
			run.retryRequest = true;
			return this.retryStart();
		}
		return await this.compactAndResume(run, followUp.compaction);
	}

	/**
	 * Compact inside the turn, then resume as decided. A compaction that fails
	 * before the turn's first request lets the turn proceed without it.
	 */
	private async compactAndResume(run: TurnRun, compaction: TurnCompaction): Promise<DispatchStart | undefined> {
		const { cause, decision, message, at } = compaction;
		const result = await this.runCompaction(run.signal, cause, decision.instructions, false);
		if (result.status === "aborted" || run.signal.aborted) return undefined;
		if (result.status !== "compacted") return at === "start" ? this.continueStart() : undefined;
		const resume = cause === "overflow" ? "retry" : (decision.resume ?? (at === "end" ? undefined : "continue"));
		// A length stop without tool calls is retried without it.
		const lengthStop =
			message.stopReason === "length" && !message.content.some((content) => content.type === "toolCall");
		if (resume === "retry" && (lengthStop || message.stopReason === "error" || message.stopReason === "aborted")) {
			run.retryRequest = true;
			run.holdPrompts = at === "start";
			if (lengthStop) run.dropEntryId = compaction.entryId;
			return this.retryStart();
		}
		return resume === undefined ? undefined : this.continueStart();
	}

	private publishRetryEnd(run: TurnRun, success: boolean, error?: string): Promise<void> {
		const attempt = run.retryAttempt;
		run.retryAttempt = 0;
		return this.publish({ type: "retry_end", attempt, success, ...(error === undefined ? {} : { error }) });
	}

	private retryStart(): DispatchStart {
		return {
			firstDecision: true,
			requestAuthority: this.continuation?.requestAuthority ?? "provider",
			providerRequestPending: true,
			drainFollowUpsFirst: false,
		};
	}

	private async runLoop(run: TurnRun, start: DispatchStart, model: Model<Api>): Promise<void> {
		run.newMessages = [];
		run.agentEnded = false;
		run.turnOpen = false;
		run.terminalSettling = false;
		try {
			await runAgentLoop(
				[],
				{ systemPrompt: "", messages: [...this.foldState.context.messages], tools: [...this.tools] },
				this.loopConfig(run, start, model),
				async (event) => await this.handleAgentEvent(event, run),
				run.signal,
				this.requestStream(run),
			);
		} catch (error) {
			this.rollbackLease();
			await this.settleLoopFailure(run, model, error);
		} finally {
			this.rollbackLease();
			this.deliveryEntries.clear();
		}
	}

	private loopConfig(run: TurnRun, start: DispatchStart, model: Model<Api>): AgentLoopConfig {
		const policy = this.policy;
		const transformContext = policy.transformContext;
		const thinkingLevel = this.foldState.context.thinkingLevel;
		return {
			model,
			...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			convertToLlm: async (messages) => applyReplayPolicy(await this.convertMessages(messages)),
			...(transformContext === undefined
				? {}
				: {
						transformContext: async (messages: AgentMessage[], signal?: AbortSignal) =>
							await transformContext(cloneAgentMessages(messages), signal),
					}),
			...(policy.beforeToolCall === undefined ? {} : { beforeToolCall: policy.beforeToolCall }),
			...(policy.afterToolCall === undefined ? {} : { afterToolCall: policy.afterToolCall }),
			nextAction: async (context) => await this.resolveNextAction(run, context, start),
			beginDelivery: async (delivery) => await this.beginDelivery(run, delivery),
			prepareRequest: async (request) => await this.prepareRequest(run, request),
		};
	}

	private async resolveNextAction(
		run: TurnRun,
		context: AgentLoopNextActionContext,
		start: DispatchStart,
	): Promise<AgentLoopNextAction> {
		const firstDecision = start.firstDecision;
		start.firstDecision = false;
		const requestAuthority = firstDecision ? start.requestAuthority : context.requestAuthority;
		const runtimeAction = context.defaultAction;
		const providerRequestPending = firstDecision ? start.providerRequestPending : runtimeAction.type === "request";
		if (run.signal.aborted) {
			this.continuation = { requestAuthority, providerRequestPending };
			return { type: "pause", requestAuthority };
		}

		if (requestAuthority === "final_response") {
			const suggested: AgentLoopNextAction =
				runtimeAction.type === "request" ? { type: "request", reason: "final_response" } : runtimeAction;
			const { action } = await this.reduceNextAction(run, { ...context, requestAuthority }, suggested);
			const resolved: AgentLoopNextAction =
				action.type === "pause" ? { ...action, requestAuthority } : { type: "request", reason: "final_response" };
			await this.publish({ type: "next_action_resolved", action: resolved, requestAuthority });
			this.continuation = {
				requestAuthority,
				providerRequestPending: action.type === "pause" ? providerRequestPending : true,
			};
			return resolved;
		}

		const hasIndependentRequest = runtimeAction.type === "request" && providerRequestPending;
		// A retried request and its continuation run before a pending prompt is delivered.
		if (!hasIndependentRequest) run.holdPrompts = false;
		const prompts = run.holdPrompts ? [] : this.inbox.select("prompt", "all");
		let selected = [...prompts, ...this.inbox.select("steer", this.modes.steer)];
		const followUps = (firstDecision && start.drainFollowUpsFirst) || !hasIndependentRequest;
		if (selected.length === 0 && followUps) {
			selected = [...this.inbox.select("followUp", this.modes.followUp)];
		}
		// Quiet host input rides a request the turn makes anyway; alone it never makes one.
		const requesting =
			hasIndependentRequest ||
			selected.some((delivery) => this.wakes(delivery)) ||
			this.hasWakingInput("steer") ||
			(followUps && this.inbox.hasPending("followUp"));
		if (!requesting) selected = [];
		const suggested: AgentLoopNextAction =
			selected.length > 0
				? { type: "request", reason: hasIndependentRequest ? "continuation" : "delivery" }
				: hasIndependentRequest
					? runtimeAction
					: { type: "stop" };

		if (firstDecision && start.checkTail && (await this.shouldCompactTail(run, suggested.type === "request"))) {
			return { type: "pause", requestAuthority };
		}
		// A turn that would continue past the threshold pauses to compact, unless policy acts instead
		// (a host that needs a final report first): policy sees the pause as the default action.
		const midTurn =
			suggested.type === "request" && context.completedTurn
				? await this.thresholdCompaction(run, context.completedTurn.message, true, "between")
				: undefined;
		const defaultAction: AgentLoopNextAction = midTurn ? { type: "pause" } : suggested;
		const { action, policyOverride } = await this.reduceNextAction(
			run,
			{ ...context, requestAuthority, defaultAction },
			defaultAction,
		);
		if (midTurn && action.type === "pause") {
			run.pendingCompaction = midTurn;
			this.continuation = { requestAuthority, providerRequestPending: hasIndependentRequest };
			return { type: "pause", requestAuthority };
		}
		await this.publish({
			type: "next_action_resolved",
			action: cloneNextAction(action),
			requestAuthority,
			...(action.type === "stop"
				? {
						stopReason: policyOverride
							? "policy"
							: context.completedTurn?.disposition === "stop"
								? "tool"
								: "completion",
					}
				: {}),
		});
		if (action.type === "pause") {
			const authority = action.requestAuthority ?? requestAuthority;
			this.continuation = { requestAuthority: authority, providerRequestPending: hasIndependentRequest };
			return { ...action, requestAuthority: authority };
		}
		this.continuation = undefined;
		if (action.type === "stop") {
			// A turn a tool batch ended still compacts past the threshold, measured with its tool results.
			const completed = context.completedTurn;
			if (completed && completed.message.stopReason === "toolUse" && !run.pendingCompaction) {
				run.pendingCompaction = await this.thresholdCompaction(run, completed.message, false, "end");
			}
			return action;
		}
		const deliveries = [
			...(selected.length > 0 ? await this.prepareLeasedDeliveries(run, selected) : []),
			...(await this.preparePolicyDeliveries(run, action.deliveries ?? [])),
		];
		return { type: "request", reason: action.reason, ...(deliveries.length > 0 ? { deliveries } : {}) };
	}

	/**
	 * The threshold compaction policy decides on a completed request: between
	 * requests of a continuing turn, or at the end of a turn a tool batch
	 * stopped. Undefined when it does not compact.
	 */
	private async thresholdCompaction(
		run: TurnRun,
		message: AssistantMessage,
		continuing: boolean,
		at: "between" | "end",
	): Promise<TurnCompaction | undefined> {
		const hook = this.policy.compaction;
		if (!hook || !this.summarizer) return undefined;
		if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
		const model = this.resolveModel(this.foldState);
		if (!model || message.provider !== model.provider || message.model !== model.id) return undefined;
		const decision = await hook(message.usage, "threshold", {
			message,
			model,
			state: this.foldState,
			continuing,
		});
		if (!decision || run.signal.aborted) return undefined;
		return { cause: "threshold", decision, message, entryId: run.lastAssistantEntryId, at };
	}

	/**
	 * A turn's first decision over a context that ends with an assistant
	 * message (an earlier turn's overflow, abort, or large response): compact
	 * before anything is requested when policy asks.
	 */
	private async shouldCompactTail(run: TurnRun, continuing: boolean): Promise<boolean> {
		const hook = this.policy.compaction;
		const state = this.foldState;
		const message = state.context.messages.at(-1);
		const model = this.resolveModel(state);
		if (!hook || !this.summarizer || !model || message?.role !== "assistant") return false;
		const sameModel = message.provider === model.provider && message.model === model.id;
		const cause = sameModel && isContextOverflow(message, model.contextWindow) ? "overflow" : "threshold";
		const decision = await hook(message.usage, cause, { message, model, state, continuing });
		if (!decision || run.signal.aborted) return false;
		if (cause === "overflow") run.overflowRecovered = true;
		let entryId: string | undefined;
		for (let index = state.branch.length - 1; index >= 0 && entryId === undefined; index--) {
			const entry = state.tree.byId.get(state.branch[index] ?? "");
			if (entry && isCoreLogEntry(entry) && entry.type === "message" && entry.payload.message === message) {
				entryId = entry.id;
			}
		}
		run.pendingCompaction = { cause, decision, message, entryId, at: "start" };
		return true;
	}

	private async reduceNextAction(
		run: TurnRun,
		context: AgentLoopNextActionContext,
		suggested: AgentLoopNextAction,
	): Promise<{ action: AgentLoopNextAction; policyOverride: boolean }> {
		const hook = this.policy.nextAction;
		if (!hook) return { action: cloneNextAction(suggested), policyOverride: false };
		// Clone a synchronous result before yielding, so later mutation by the host cannot leak in.
		const pending = hook(cloneNextActionContext(context, suggested), run.signal);
		const result = pending instanceof Promise ? await pending : pending;
		return result === undefined
			? { action: cloneNextAction(suggested), policyOverride: false }
			: { action: cloneNextAction(result), policyOverride: true };
	}

	private async prepareLeasedDeliveries(
		run: TurnRun,
		selected: readonly InboxDelivery<AgentDeliveryKind, AgentMessage>[],
	): Promise<AgentLoopDelivery[]> {
		const lease = this.inbox.lease(selected);
		this.activeLease = lease;
		const deliveries: AgentLoopDelivery[] = [];
		for (const delivery of lease.deliveries) {
			const attempt = lease.prepare(delivery.deliveryId);
			if (!attempt) continue;
			this.attemptIds.set(delivery.deliveryId, attempt.attemptId);
			let messages: AgentMessage[];
			try {
				messages = await this.prepareDelivery(run, delivery.deliveryId, delivery.kind, delivery.messages);
			} catch (error) {
				lease.completePreparation(delivery.deliveryId, attempt.attemptId, "retained");
				throw error;
			}
			if (!lease.completePreparation(delivery.deliveryId, attempt.attemptId, "prepared")) continue;
			deliveries.push({ deliveryId: delivery.deliveryId, messages });
		}
		return deliveries;
	}

	private async preparePolicyDeliveries(
		run: TurnRun,
		deliveries: readonly AgentLoopDelivery[],
	): Promise<AgentLoopDelivery[]> {
		const prepared: AgentLoopDelivery[] = [];
		for (const delivery of deliveries) {
			if (delivery.messages.length === 0) continue;
			const deliveryId = `policy-delivery:${this.createId()}`;
			prepared.push({
				deliveryId,
				messages: await this.prepareDelivery(run, deliveryId, "policy", delivery.messages),
			});
		}
		return prepared;
	}

	/**
	 * `messageEnd` on each delivered message, then `prepareDelivery`: the
	 * messages to commit. Entries the policy returns commit with them.
	 */
	private async prepareDelivery(
		run: TurnRun,
		deliveryId: string,
		kind: ConversationDeliveryKind,
		messages: readonly AgentMessage[],
	): Promise<AgentMessage[]> {
		const reduced = await this.reduceMessages(run, messages);
		const hook = this.policy.prepareDelivery;
		if (!hook) return reduced;
		const clientMessageId = this.deliveryMeta.get(deliveryId)?.clientMessageId;
		const record =
			clientMessageId === undefined ? undefined : this.foldState.clientInputs.inputs.get(clientMessageId);
		const prepared = await hook(
			{
				kind,
				...(clientMessageId === undefined ? {} : { clientMessageId }),
				...(record === undefined ? {} : { origin: record.origin ?? "client" }),
				messages: cloneAgentMessages(reduced),
			},
			run.signal,
		);
		if (prepared === undefined) return reduced;
		const owned = cloneAgentMessages(prepared.messages);
		if (owned.length === 0) throw new ConversationError("invalid_argument", "A delivery needs a message");
		const identified = (list: readonly AgentMessage[]) =>
			list.filter((message) => clientMessageIdOf(message) === clientMessageId).length;
		if (clientMessageId !== undefined && identified(owned) !== identified(reduced)) {
			throw new ConversationError("invalid_argument", "prepareDelivery must keep the client input's user message");
		}
		const entries = (prepared.entries ?? []).map((entry) => this.entryBody(entry, DELIVERY_ENTRY_CORE_TYPES));
		if (entries.length > 0) this.deliveryEntries.set(deliveryId, entries);
		return owned;
	}

	/** Apply `messageEnd` to delivered messages before they commit; client identities survive replacement. */
	private async reduceMessages(run: TurnRun, messages: readonly AgentMessage[]): Promise<AgentMessage[]> {
		const reduced: AgentMessage[] = [];
		for (const message of messages) {
			let current = structuredClone(message);
			const hook = this.policy.messageEnd;
			if (hook) {
				const replacement = await hook(structuredClone(current), run.signal, "delivery");
				if (replacement !== undefined) {
					if (replacement.role !== current.role) {
						throw new ConversationError("invalid_argument", "messageEnd must preserve the message role");
					}
					const clientMessageId = clientMessageIdOf(current);
					const owned = structuredClone(replacement);
					if (clientMessageId === undefined || owned.role !== "user") {
						current = owned;
					} else {
						const identified: ClientUserMessage = { ...owned, clientMessageId };
						current = identified;
					}
				}
			}
			reduced.push(current);
		}
		return reduced;
	}

	private async beginDelivery(run: TurnRun, delivery: AgentLoopDelivery): Promise<AgentLoopDeliveryOutcome> {
		if (!this.coordinator.isOpen) return { outcome: "revoked" };
		const deliveryId = delivery.deliveryId ?? `policy-delivery:${this.createId()}`;
		const meta = this.deliveryMeta.get(deliveryId) ?? { kind: "steer", requestInput: false };
		const attemptId = this.attemptIds.get(deliveryId);
		const lease = this.activeLease;
		if (attemptId !== undefined && !lease?.beginCommit(deliveryId, attemptId)) return { outcome: "revoked" };
		const prepared = this.deliveryEntries.get(deliveryId) ?? [];
		this.deliveryEntries.delete(deliveryId);
		let entries: readonly ConversationLogEntry[];
		try {
			entries = await this.commit((drafts, state) =>
				this.addDeliveryDrafts(drafts, state, delivery.messages, meta, prepared),
			);
		} catch (error) {
			const retained = error instanceof ConversationError && error.code === "commit_rolled_back";
			if (attemptId !== undefined)
				lease?.settleCommit(deliveryId, attemptId, retained ? "retained" : "terminally_failed");
			this.attemptIds.delete(deliveryId);
			if (!retained) this.deliveryMeta.delete(deliveryId);
			return { outcome: retained ? "retained" : "terminally_failed", error: toError(error) };
		}
		if (attemptId !== undefined) {
			lease?.settleCommit(deliveryId, attemptId, "committed");
			this.publishQueue();
		}
		this.attemptIds.delete(deliveryId);
		this.deliveryMeta.delete(deliveryId);
		run.lease.requestAccepted = true;
		run.committedDelivery = true;
		for (const message of delivery.messages) run.committedMessages.add(message);
		if (meta.clientMessageId !== undefined) {
			const clientMessageId = meta.clientMessageId;
			const entry = entries.find(
				(candidate) =>
					isCoreLogEntry(candidate) &&
					((candidate.type === "message" && candidate.clientMessageId === clientMessageId) ||
						(candidate.type === "client_input_state" &&
							candidate.payload.clientMessageId === clientMessageId &&
							candidate.payload.state === "completed")),
			);
			const waiter = this.inputWaiters.get(clientMessageId);
			if (entry && waiter) waiter.delivered = { entryId: entry.id, ordinal: entry.ordinal };
			run.deliveredInputs.push(meta.clientMessageId);
		}
		const users = delivery.messages.filter((message): message is UserMessage => message.role === "user");
		if (meta.requestInput && users.length > 0) {
			this.pendingRequestDeliveries.push({
				deliveryId,
				kind: meta.kind,
				...(meta.clientMessageId === undefined ? {} : { clientMessageId: meta.clientMessageId }),
				messages: users.map((message) => structuredClone(withoutClientMessageId(message)) as UserMessage),
			});
		}
		return { outcome: "committed" };
	}

	/**
	 * One delivery's batch: the input's `started` transition, the prepared
	 * entries, then its messages. An input delivered without its own user
	 * message (queued host messages) completes with an explicit `completed`.
	 */
	private addDeliveryDrafts(
		drafts: EntryDrafts,
		state: ConversationState,
		messages: readonly AgentMessage[],
		meta: DeliveryMeta,
		entries: readonly EntryBody[],
	): void {
		const clientMessageId = meta.clientMessageId;
		const record = clientMessageId === undefined ? undefined : state.clientInputs.inputs.get(clientMessageId);
		const identified = messages.some((message) => clientMessageIdOf(message) === clientMessageId);
		if (record && identified && record.state === "accepted") {
			drafts.add({
				type: "client_input_state",
				visibility: "host",
				payload: { receiptId: record.receiptId, clientMessageId: record.clientMessageId, state: "started" },
			});
		}
		for (const entry of entries) drafts.add(entry);
		for (const message of messages) {
			if (clientMessageId === undefined || clientMessageIdOf(message) !== clientMessageId) {
				drafts.add(this.messageEntryBody(message));
				continue;
			}
			drafts.add({
				type: "message",
				visibility: "public",
				clientMessageId,
				payload: { message: withoutClientMessageId(message) as UserMessage },
			});
		}
		if (record && !identified && record.state === "accepted") {
			drafts.add({
				type: "client_input_state",
				visibility: "host",
				payload: { receiptId: record.receiptId, clientMessageId: record.clientMessageId, state: "completed" },
			});
		}
	}

	private messageEntryBody(message: AgentMessage): EntryBody {
		if (message.role === "custom") {
			return {
				type: "custom_message",
				visibility: "public",
				payload: {
					customType: message.customType,
					content: message.content,
					display: message.display,
					...(message.details === undefined ? {} : { details: message.details }),
				},
			};
		}
		if (message.role === "branchSummary" || message.role === "compactionSummary") {
			throw new ConversationError("invalid_argument", `A ${message.role} message is not a log message`);
		}
		return {
			type: "message",
			visibility: "public",
			payload: {
				message: withoutClientMessageId(message) as Extract<EntryBody, { type: "message" }>["payload"]["message"],
			},
		};
	}

	private rollbackLease(): void {
		const lease = this.activeLease;
		if (!lease) return;
		for (const delivery of this.inbox.rollbackActiveLease()) {
			this.attemptIds.delete(delivery.deliveryId);
			lease.settleRollback(delivery.deliveryId, "retained");
		}
		this.activeLease = undefined;
		this.publishQueue();
	}

	private async prepareRequest(run: TurnRun, request: PrepareRequestContext): Promise<AgentLoopRequestUpdate> {
		const systemPrompt = await this.resolveSystemPrompt(run.signal);
		const state = this.foldState;
		const model = this.requireModel();
		const tools = [...this.tools];
		const newInput = this.pendingRequestDeliveries.length > 0;
		if (newInput) {
			this.requestBatch = {
				id: `conversation-input:${this.createId()}`,
				deliveries: this.pendingRequestDeliveries.splice(0),
			};
		}
		const cause = newInput
			? "input"
			: request.completedTurn?.toolResults.length
				? "tools"
				: !request.completedTurn && run.retryRequest
					? "retry"
					: "continuation";
		run.retryRequest = false;
		run.request = {
			messages: state.context.messages,
			tools,
			configurationEpoch: this.configurationEpoch,
			boundary: {
				...(this.requestBatch === undefined ? {} : { batch: this.requestBatch }),
				newInput,
				requestAuthority: request.reason === "final_response" ? "final_response" : request.requestAuthority,
				cause,
			},
		};
		return {
			context: { systemPrompt, messages: [...this.requestMessages(run, state)], tools },
			model,
			thinkingLevel: state.context.thinkingLevel,
		};
	}

	/** The branch messages a turn requests with: without a length-stopped message its retry leaves out. */
	private requestMessages(run: TurnRun, state: ConversationState): readonly AgentMessage[] {
		const entry = run.dropEntryId === undefined ? undefined : state.tree.byId.get(run.dropEntryId);
		if (!entry || !isCoreLogEntry(entry) || entry.type !== "message") return state.context.messages;
		const dropped = entry.payload.message;
		return state.context.messages.filter((message) => message !== dropped);
	}

	private async resolveSystemPrompt(signal: AbortSignal): Promise<string> {
		const source = this.systemPromptSource;
		if (typeof source === "string") return source;
		if (!source) return "You are a helpful assistant.";
		return await source(signal);
	}

	/** Provider admission: request boundary, final context, and options, read at the last moment. */
	private requestStream(run: TurnRun): StreamFn {
		return async (model, context, loopOptions) => {
			const signal = loopOptions?.signal;
			if (signal?.aborted) return createAbortedAssistantStream(model);
			const prepared = run.request;
			let messages = context.messages;
			let basis = prepared?.messages ?? this.foldState.context.messages;
			for (;;) {
				const state = this.foldState;
				if (state.context.messages !== basis) {
					const appended = isPrefix(basis, state.context.messages)
						? state.context.messages.slice(basis.length)
						: undefined;
					messages = appended
						? [...messages, ...(await this.convertMessages(cloneAgentMessages(appended)))]
						: await buildContext(
								{ ...state, context: { ...state.context, messages: this.requestMessages(run, state) } },
								this.contextOptions(signal),
							);
					basis = state.context.messages;
					if (signal?.aborted) return createAbortedAssistantStream(model);
					continue;
				}
				const epoch = this.configurationEpoch;
				const admittedModel = this.resolveModel(state) ?? model;
				const tools =
					prepared !== undefined && context.tools === prepared.tools && epoch !== prepared.configurationEpoch
						? [...this.tools]
						: context.tools;
				let admitted: Context = {
					systemPrompt: context.systemPrompt ?? "",
					messages,
					...(tools === undefined ? {} : { tools: [...tools] }),
				};
				const batch = this.requestBatch;
				let optional: ConversationRequestContext | undefined;
				let settled = false;
				const settle = (include: boolean): void => {
					if (settled || !optional) return;
					settled = true;
					optional.authorization.settle(include);
				};
				try {
					if (prepared && this.policy.requestBoundary) {
						const { batch: boundaryBatch, ...boundary } = prepared.boundary;
						optional = await this.policy.requestBoundary(
							{
								...boundary,
								newInput: boundary.newInput && boundaryBatch === batch,
								...(boundaryBatch !== undefined && boundaryBatch === batch
									? { batch: structuredClone(boundaryBatch) }
									: {}),
								attemptId: `conversation-request:${this.createId()}`,
								basisOrdinal: state.ordinal,
							},
							{ ...admitted, messages: structuredClone(admitted.messages) },
							signal,
						);
						if (signal?.aborted) return createAbortedAssistantStream(admittedModel);
						if (this.foldState.context !== state.context || epoch !== this.configurationEpoch) continue;
					}
					const include =
						optional !== undefined &&
						optional.messages.length > 0 &&
						this.requestBatch === batch &&
						optional.authorization.isCurrent();
					admitted = {
						...admitted,
						messages: applyReplayPolicy(
							include && optional
								? [...admitted.messages, ...structuredClone(optional.messages)]
								: admitted.messages,
						),
					};
					settle(include);
					const options = this.requestOptions(state, signal, loopOptions);
					this.recordRequest(admittedModel, admitted, options, state, epoch);
					return this.baseStream(admittedModel, admitted, options);
				} finally {
					settle(false);
				}
			}
		};
	}

	private contextOptions(signal: AbortSignal | undefined) {
		const transformContext = this.policy.transformContext;
		return {
			convertToLlm: this.convertMessages,
			...(transformContext === undefined ? {} : { transformContext }),
			...(signal === undefined ? {} : { signal }),
		};
	}

	/** Options for a turn request: curated stream options, fast mode and thinking from the log, and policy hooks. */
	private requestOptions(
		state: ConversationState,
		signal: AbortSignal | undefined,
		loopOptions: SimpleStreamOptions | undefined,
	): SimpleStreamOptions {
		const thinkingLevel = state.context.thinkingLevel;
		return {
			...this.baseOptions(),
			inferenceSpeed: state.context.fastMode ? "fast" : "standard",
			...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			...(loopOptions?.maxTokens === undefined ? {} : { maxTokens: loopOptions.maxTokens }),
			...(loopOptions?.temperature === undefined ? {} : { temperature: loopOptions.temperature }),
			...(signal === undefined ? {} : { signal }),
		};
	}

	private baseOptions(): SimpleStreamOptions {
		const policy = this.policy;
		const beforeProviderPayload = policy.beforeProviderPayload;
		const afterProviderResponse = policy.afterProviderResponse;
		return {
			...cloneStreamOptions(this.streamOptions),
			sessionId: this.conversationId,
			...(beforeProviderPayload === undefined
				? {}
				: {
						onPayload: async (payload: unknown, model: Model<Api>) => await beforeProviderPayload(payload, model),
					}),
			...(afterProviderResponse === undefined
				? {}
				: {
						onResponse: async (
							response: { status: number; headers: Record<string, string> },
							model: Model<Api>,
						) =>
							await afterProviderResponse({ status: response.status, headers: { ...response.headers } }, model),
					}),
		};
	}

	/** Requests for summaries and host operations: stream options and payload hooks, caller-chosen reasoning. */
	private structuralStream(): StreamFn {
		return async (model, context, options) => {
			if (options?.signal?.aborted) return createAbortedAssistantStream(model);
			return this.baseStream(model, context, { ...options, ...this.baseOptions() });
		};
	}

	private recordRequest(
		model: Model<Api>,
		context: Context,
		options: SimpleStreamOptions,
		state: ConversationState,
		configurationEpoch: number,
	): void {
		const { signal: _signal, onPayload: _onPayload, onResponse: _onResponse, ...replayOptions } = options;
		this.lastRequest = {
			model,
			context: {
				...context,
				messages: [...context.messages],
				...(context.tools === undefined ? {} : { tools: [...context.tools] }),
			},
			options: replayOptions,
			configurationEpoch,
			messages: state.context.messages,
			modelRef: `${state.context.model?.provider}/${state.context.model?.modelId}`,
			thinkingLevel: state.context.thinkingLevel,
			fastMode: state.context.fastMode,
		};
	}

	private async handleAgentEvent(event: AgentEvent, run: TurnRun): Promise<AgentMessage | undefined> {
		switch (event.type) {
			case "message_end": {
				if (run.committedMessages.has(event.message)) {
					await this.publishAgent(event);
					return undefined;
				}
				const terminal = event.message.role === "assistant" && event.message.stopReason !== "toolUse";
				run.terminalSettling = terminal && !this.hasWakingInput();
				let message = this.withAbortDiagnostic(event.message, run);
				const hook = this.policy.messageEnd;
				if (hook) {
					const replacement = await hook(structuredClone(message), run.signal, "loop");
					if (replacement !== undefined) {
						if (replacement.role !== message.role) {
							throw new ConversationError("invalid_argument", "messageEnd must preserve the message role");
						}
						message = this.withAbortDiagnostic(replacement, run);
					}
				}
				const [entry] = await this.commit((drafts) => drafts.add(this.messageEntryBody(message)));
				if (message.role === "assistant") run.lastAssistantEntryId = entry?.id;
				run.committedMessages.add(message);
				run.newMessages.push(message);
				if (run.terminalSettling && message.role === "assistant" && !run.signal.aborted) {
					run.followUp = await this.decideFollowUp(run, message);
					if (!run.followUp) this.coordinator.sealTerminal(run.lease);
				}
				await this.publishAgent({ ...event, message });
				return message;
			}
			case "turn_start":
				run.turnOpen = true;
				run.lease.requestAccepted = true;
				break;
			case "turn_end":
				run.turnOpen = false;
				run.terminalSettling = false;
				break;
			case "agent_end":
				run.agentEnded = true;
				if (!run.followUp && !run.pendingCompaction) this.coordinator.beginNotifications(run.lease);
				break;
			default:
				break;
		}
		await this.publishAgent(event);
		return undefined;
	}

	/** Whether the operation retries or compacts after this terminal message. */
	private async decideFollowUp(run: TurnRun, message: AssistantMessage): Promise<TurnFollowUp | undefined> {
		const model = this.resolveModel(this.foldState);
		const sameModel = model !== undefined && message.provider === model.provider && message.model === model.id;
		const compactionHook = this.summarizer ? this.policy.compaction : undefined;
		if (message.stopReason === "error") {
			if (
				model &&
				sameModel &&
				compactionHook &&
				!run.overflowRecovered &&
				isContextOverflow(message, model.contextWindow)
			) {
				run.overflowRecovered = true;
				const decision = await compactionHook(message.usage, "overflow", {
					message,
					model,
					state: this.foldState,
					continuing: false,
				});
				return decision
					? {
							kind: "compact",
							compaction: { cause: "overflow", decision, message, entryId: run.lastAssistantEntryId, at: "end" },
						}
					: undefined;
			}
			const delayMs = message.error ? this.policy.retry?.(message.error, run.retryAttempt + 1, message) : undefined;
			if (delayMs !== undefined) return { kind: "retry", delayMs, message };
			if (run.retryAttempt > 0) void this.publishRetryEnd(run, false, message.error?.message);
			return undefined;
		}
		if (message.stopReason === "aborted" || !model || !sameModel || !compactionHook) return undefined;
		const decision = await compactionHook(message.usage, "threshold", {
			message,
			model,
			state: this.foldState,
			continuing: false,
		});
		return decision
			? {
					kind: "compact",
					compaction: { cause: "threshold", decision, message, entryId: run.lastAssistantEntryId, at: "end" },
				}
			: undefined;
	}

	private withAbortDiagnostic(message: AgentMessage, run: TurnRun): AgentMessage {
		const { abortSource, diagnosticTimestamp } = run.lease;
		if (
			message.role !== "assistant" ||
			(message.stopReason !== "aborted" && !run.terminalSettling) ||
			!run.signal.aborted ||
			abortSource === undefined ||
			diagnosticTimestamp === undefined
		) {
			return message;
		}
		return withRuntimeAbortDiagnostic(message, abortSource, diagnosticTimestamp);
	}

	/** A loop that threw ends with a failure message, unless it never reached the provider or the log is gone. */
	private async settleLoopFailure(run: TurnRun, model: Model<Api>, error: unknown): Promise<void> {
		const attempt = async (event: AgentEvent): Promise<AgentMessage | undefined> => {
			try {
				return await this.handleAgentEvent(event, run);
			} catch {
				return undefined;
			}
		};
		const retainedBeforeCommit =
			error instanceof AgentDeliverySettlementError && error.outcome === "retained" && !run.committedDelivery;
		const aborted = run.signal.aborted;
		if (this.endState === undefined && !retainedBeforeCommit && !(aborted && !run.lease.requestAccepted)) {
			if (!run.turnOpen) await attempt({ type: "turn_start" });
			const failure = createFailureMessage(model, aborted ? new Error("Request was aborted") : error, aborted);
			await attempt({ type: "message_start", message: failure });
			const finalized = (await attempt({ type: "message_end", message: failure })) ?? failure;
			await attempt({ type: "turn_end", message: finalized, toolResults: [] });
		}
		if (!run.agentEnded) await attempt({ type: "agent_end", messages: [...run.newMessages] });
		// A retry the failed loop was running ends unsuccessfully.
		if (run.retryAttempt > 0) {
			void this.publishRetryEnd(run, false, error instanceof Error ? error.message : String(error));
		}
	}

	// ==========================================================================
	// Compaction and navigation
	// ==========================================================================

	/** Compact the active branch now, preempting a turn that is still running. */
	async compact(options: { readonly instructions?: string } = {}): Promise<ConversationCompactionResult> {
		this.assertActive();
		if (!this.summarizer) throw new ConversationError("invalid_state", "The conversation has no summarizer");
		const lease = await this.acquireStructural("compaction");
		try {
			this.coordinator.start(lease);
			return await this.runCompaction(lease.abortGate.signal, "manual", options.instructions, true);
		} finally {
			this.coordinator.finish(lease);
		}
	}

	/**
	 * Move the active branch to `targetId` (`null` for before the first entry),
	 * optionally committing a summary of the abandoned branch in the same batch.
	 * `prepare` runs inside the operation first and may cancel the move, supply
	 * the summary, or override the label and instructions. A turn whose request
	 * was accepted cannot be preempted.
	 */
	async navigate(
		targetId: string | null,
		options: ConversationNavigationOptions = {},
	): Promise<ConversationNavigationResult> {
		this.assertActive();
		if (targetId !== null && this.foldState.tree.byId.get(targetId)?.visibility !== "public") {
			throw new ConversationError("invalid_argument", `Unknown conversation entry ${JSON.stringify(targetId)}`);
		}
		const summarize = options.summarize === true;
		if (summarize && !this.summarizer && !options.prepare) {
			throw new ConversationError("invalid_state", "The conversation has no summarizer");
		}
		const lease = await this.acquireStructural("navigation");
		try {
			this.coordinator.start(lease);
			const signal = lease.abortGate.signal;
			const state = this.foldState;
			const moving = targetId !== state.leafId;
			const abandoned = abandonedBranch(state, targetId);
			const plan = options.prepare
				? await options.prepare({
						state,
						fromLeafId: state.leafId,
						targetId,
						...abandoned,
						summarize,
						...(options.instructions === undefined ? {} : { instructions: options.instructions }),
						...(options.label === undefined ? {} : { label: options.label }),
						signal,
					})
				: undefined;
			if (signal.aborted) return { status: "aborted", leafId: this.foldState.leafId };
			if (plan?.cancel) return { status: "cancelled", leafId: this.foldState.leafId };
			const label = plan?.label ?? options.label;
			const instructions = plan?.instructions ?? options.instructions;
			let summary = moving ? plan?.summary : undefined;
			if (!summary && summarize && moving) {
				const summarizer = this.summarizer;
				if (!summarizer) throw new ConversationError("invalid_state", "The conversation has no summarizer");
				summary = await summarizer.summarizeBranch({
					state,
					model: this.requireModel(),
					thinkingLevel: state.context.thinkingLevel,
					...(instructions === undefined ? {} : { instructions }),
					signal,
					stream: this.structuralStream(),
					fromLeafId: state.leafId,
					targetId,
					...abandoned,
				});
			}
			if (signal.aborted) return { status: "aborted", leafId: this.foldState.leafId };
			let summaryEntryId: string | undefined;
			await this.commit((drafts, current) => {
				if (current.leafId !== targetId) drafts.moveLeaf(targetId);
				if (summary) {
					summaryEntryId = drafts.add({
						type: "branch_summary",
						visibility: "public",
						payload: {
							fromId: targetId ?? "root",
							summary: summary.summary,
							...(summary.details === undefined ? {} : { details: summary.details }),
							...(summary.fromHook === undefined ? {} : { fromHook: summary.fromHook }),
						},
					}).id;
				}
				const labelTarget = summaryEntryId ?? targetId;
				if (label !== undefined && labelTarget !== null) {
					drafts.add({
						type: "label",
						visibility: "public",
						payload: { targetId: labelTarget, label },
					});
				}
			});
			return {
				status: "navigated",
				leafId: this.foldState.leafId,
				...(summaryEntryId === undefined ? {} : { summaryEntryId }),
			};
		} finally {
			this.coordinator.finish(lease);
		}
	}

	/** Reserve a structural operation now, or as the successor of a preemptible operation that is then aborted. */
	private async acquireStructural(
		kind: "compaction" | "navigation",
	): Promise<OperationLease<ConversationOperationKind>> {
		const current = this.coordinator.current;
		if (!current) {
			const lease = this.coordinator.reserve(kind);
			if (!lease) throw new ConversationError("ended", "The conversation has ended");
			return lease;
		}
		if (
			current.kind === "host" ||
			(kind === "navigation" &&
				(current.kind === "navigation" || (current.kind === "turn" && current.requestAccepted)))
		) {
			throw new ConversationError("busy", `The active ${current.kind} operation cannot be preempted`);
		}
		const pendingTurn = this.successorTurn;
		const successor =
			(pendingTurn ? this.coordinator.reserveSuccessorReplacing("turn", kind) : undefined) ??
			this.coordinator.reserveSuccessor(kind);
		if (!successor) throw new ConversationError("busy", "A successor operation is already reserved");
		if (pendingTurn) this.successorTurn = undefined;
		this.coordinator.requestAbort("host_action");
		// A held reservation has done no conversation work yet; revoking it hands over at once.
		this.releaseReservation();
		await successor.ready;
		if (this.coordinator.current !== successor.lease || !this.coordinator.isOpen) {
			throw new ConversationError("busy", `The ${kind} reservation was cancelled`);
		}
		return successor.lease;
	}

	private async runCompaction(
		signal: AbortSignal,
		cause: ConversationCompactionCause,
		instructions: string | undefined,
		rethrow: boolean,
	): Promise<ConversationCompactionResult> {
		const summarizer = this.summarizer;
		if (!summarizer) return { status: "skipped" };
		void this.publish({ type: "compaction_start", cause });
		const end = (status: "compacted" | "skipped" | "aborted" | "failed", error?: string): void =>
			void this.publish({ type: "compaction_end", cause, status, ...(error === undefined ? {} : { error }) });
		try {
			const state = this.foldState;
			const summary = await summarizer.compact({
				cause,
				state,
				model: this.requireModel(),
				thinkingLevel: state.context.thinkingLevel,
				...(instructions === undefined ? {} : { instructions }),
				signal,
				stream: this.structuralStream(),
			});
			if (signal.aborted) {
				end("aborted");
				return { status: "aborted" };
			}
			if (!summary) {
				end("skipped");
				return { status: "skipped" };
			}
			const [entry] = await this.commit((drafts) => {
				drafts.add({
					type: "compaction",
					visibility: "public",
					payload: {
						summary: summary.summary,
						firstKeptEntryId: summary.firstKeptEntryId,
						tokensBefore: summary.tokensBefore,
						...(summary.details === undefined ? {} : { details: summary.details }),
						...(summary.fromHook === undefined ? {} : { fromHook: summary.fromHook }),
					},
				});
				for (const message of summary.messages ?? []) drafts.add(this.messageEntryBody(message));
			});
			end("compacted");
			return { status: "compacted", ...(entry === undefined ? {} : { entryId: entry.id }) };
		} catch (error) {
			if (signal.aborted) {
				end("aborted");
				return { status: "aborted" };
			}
			end("failed", toError(error).message);
			if (rethrow) throw error;
			return { status: "skipped" };
		}
	}

	// ==========================================================================
	// Durable settings and host entries
	// ==========================================================================

	async setModel(model: Model<Api>): Promise<void> {
		this.assertActive();
		if (!this.resolveModelRef(model.provider, model.id)) {
			throw new ConversationError("invalid_argument", `Unknown model ${model.provider}/${model.id}`);
		}
		await this.commit((drafts) =>
			drafts.add({
				type: "model_change",
				visibility: "public",
				payload: { provider: model.provider, modelId: model.id },
			}),
		);
	}

	async setThinkingLevel(thinkingLevel: ConversationState["context"]["thinkingLevel"]): Promise<void> {
		this.assertActive();
		await this.commit((drafts) =>
			drafts.add({ type: "thinking_level_change", visibility: "public", payload: { thinkingLevel } }),
		);
	}

	async setFastMode(enabled: boolean): Promise<void> {
		this.assertActive();
		await this.commit((drafts) =>
			drafts.add({ type: "fast_mode_change", visibility: "public", payload: { enabled } }),
		);
	}

	async setPlanning(planning: PlanningSnapshot): Promise<void> {
		this.assertActive();
		await this.commit((drafts) =>
			drafts.add({ type: "planning_state_change", visibility: "public", payload: { planning } }),
		);
	}

	async setName(name: string): Promise<void> {
		this.assertActive();
		await this.commit((drafts) => drafts.add({ type: "session_info", visibility: "public", payload: { name } }));
	}

	/** Set or, with no label, clear the label of a conversation entry. */
	async setLabel(targetId: string, label?: string): Promise<void> {
		this.assertActive();
		if (this.foldState.tree.byId.get(targetId)?.visibility !== "public") {
			throw new ConversationError("invalid_argument", `Unknown conversation entry ${JSON.stringify(targetId)}`);
		}
		await this.commit((drafts) =>
			drafts.add({
				type: "label",
				visibility: "public",
				payload: { targetId, ...(label === undefined ? {} : { label }) },
			}),
		);
	}

	/**
	 * Append host entries in one batch: registered product types, or core
	 * `custom`, `custom_message`, or `message`. Work entries are rejected;
	 * `work` writes them.
	 */
	async append(entries: readonly ConversationEntryInput[]): Promise<readonly ConversationLogEntry[]> {
		this.assertActive();
		const bodies = entries.map((entry) => this.entryBody(entry, HOST_APPENDABLE_CORE_TYPES));
		if (bodies.length === 0) return [];
		return await this.commit((drafts) => {
			for (const body of bodies) drafts.add(body);
		});
	}

	/** A host entry checked against its type: one of `coreTypes`, or a registered product type. */
	private entryBody(entry: ConversationEntryInput, coreTypes: ReadonlyMap<string, LogEntryType>): EntryBody {
		const definition = coreTypes.get(entry.type) ?? this.productTypes.get(entry.type);
		if (definition === undefined) {
			throw new ConversationError("invalid_argument", `Entry type ${entry.type} cannot be appended`);
		}
		if (!Check(definition.payload, entry.payload)) {
			throw new ConversationError("invalid_argument", `Entry payload does not match type ${entry.type}`);
		}
		return { type: entry.type, visibility: definition.visibility, payload: entry.payload } as EntryBody;
	}

	/** Run exclusive host work that may append entries; it cannot start while another operation runs. */
	async runHostOperation<T>(operation: (context: ConversationHostOperationContext) => Promise<T> | T): Promise<T> {
		this.assertActive();
		const lease = this.coordinator.reserve("host");
		if (!lease) throw new ConversationError("busy", "The conversation is busy");
		try {
			this.coordinator.start(lease);
			return await operation(
				Object.freeze({
					signal: lease.abortGate.signal,
					stream: this.structuralStream(),
					state: () => this.foldState,
					append: (entries: readonly ConversationEntryInput[]) => this.append(entries),
				}),
			);
		} finally {
			this.coordinator.finish(lease);
		}
	}

	/** Count non-exclusive work toward `busy` until the returned release runs. */
	beginActivity(kind: ConversationActivityKind): () => void {
		this.assertActive();
		return this.coordinator.beginActivity(kind);
	}

	// ==========================================================================
	// Work
	// ==========================================================================

	private async reconcileWork(): Promise<WorkReconciliation> {
		this.assertActive();
		this.reconciliation ??= this.enqueueLane(async () => {
			const reconciliation = workReconciliation(this.foldState);
			await this.commitInLane((drafts) => {
				for (const workId of reconciliation.interrupt) {
					drafts.add({ type: "work_finished", visibility: "host", payload: { workId, outcome: "interrupted" } });
				}
			});
			this.workReconciled = true;
			return reconciliation;
		});
		const pending = this.reconciliation;
		try {
			return await pending;
		} catch (error) {
			// A batch that did not commit may be retried.
			if (this.reconciliation === pending) this.reconciliation = undefined;
			throw error;
		}
	}

	private async startWork(work: ConversationWorkStart): Promise<WorkRecord> {
		this.assertActive();
		if (!this.workReconciled) {
			throw new ConversationError("invalid_state", "Open work must be reconciled before new work starts");
		}
		const { workId, state, ...rest } = work;
		return await this.commitWork({
			type: "work_started",
			payload: { ...rest, workId: workId ?? this.createId(), state: state ?? "running" },
		});
	}

	private async checkpointWork(workId: string, checkpoint: ConversationWorkCheckpoint): Promise<WorkRecord> {
		this.assertActive();
		return await this.commitWork({ type: "work_checkpoint", payload: { ...checkpoint, workId } });
	}

	/** Commit one work entry; the fold rejects one that breaks the work lifecycle. */
	private async commitWork(entry: WorkEntryPayload): Promise<WorkRecord> {
		this.assertWorkPayload(entry);
		return await this.enqueueLane(async () => {
			await this.commitInLane((drafts) => {
				drafts.add({ type: entry.type, visibility: "host", payload: entry.payload } as EntryBody);
			});
			return this.workRecord(entry.payload.workId);
		});
	}

	private assertWorkPayload(entry: WorkEntryPayload): void {
		if (!Check(CORE_LOG_ENTRY_TYPES[entry.type].payload, entry.payload)) {
			throw new ConversationError("invalid_argument", `Work payload does not match ${entry.type}`);
		}
		const bounds = workPayloadBoundsError(entry);
		if (bounds !== undefined) throw new ConversationError("invalid_argument", bounds);
	}

	private workRecord(workId: string): WorkRecord {
		const record = this.foldState.work.get(workId);
		if (!record) throw new ConversationError("invalid_argument", `Unknown work ${JSON.stringify(workId)}`);
		return record;
	}

	/**
	 * Finish open work. A completed or failed result of a delivering kind
	 * commits its notice in the same batch, as a host steer; a `wake` notice
	 * then starts a turn on an idle conversation.
	 */
	private async finishWork(workId: string, finish: ConversationWorkFinish): Promise<ConversationWorkFinished> {
		this.assertActive();
		const { deliver, ...rest } = finish;
		const payload: WorkFinishedEntryPayload = { ...rest, workId };
		this.assertWorkPayload({ type: "work_finished", payload });
		const finished = await this.enqueueLane(async (): Promise<ConversationWorkFinished> => {
			const record = this.foldState.work.get(workId);
			if (!record || record.outcome !== undefined) {
				throw new ConversationError("invalid_argument", `Work ${JSON.stringify(workId)} is not open`);
			}
			const notice =
				deliver !== false &&
				record.delivery !== "none" &&
				(payload.outcome === "completed" || payload.outcome === "failed")
					? workNotice(record, payload, deliver?.text)
					: undefined;
			if (!notice) {
				await this.commitInLane((drafts) => {
					drafts.add({ type: "work_finished", visibility: "host", payload });
				});
				return { record: this.workRecord(workId) };
			}
			const wake = record.delivery === "wake";
			const queuedInput: ClientInputQueuedPayload = {
				delivery: "steer",
				message: "",
				images: [],
				messages: [notice],
				...(wake ? {} : { wake: false }),
			};
			if (!Check(ClientInputQueuedPayloadSchema, queuedInput)) {
				throw new ConversationError("invalid_argument", "The work notice must be a log message");
			}
			const clientMessageId = this.createId();
			const digest = await clientInputDigest("steer", HOST_INPUT);
			await this.commitInLane((drafts) => {
				drafts.add({ type: "work_finished", visibility: "host", payload });
				this.addHostInput(drafts, clientMessageId, digest, queuedInput);
			});
			this.enqueueDelivery("steer", [notice], {
				kind: "steer",
				clientMessageId,
				requestInput: false,
				...(wake ? {} : { wake: false }),
			});
			return { record: this.workRecord(workId), notice: { clientMessageId, wake } };
		});
		if (finished.notice?.wake) this.startTurnForQueuedInput();
		return finished;
	}

	private async withdrawHostInput(clientMessageId: string): Promise<boolean> {
		this.assertActive();
		const record = this.foldState.clientInputs.inputs.get(clientMessageId);
		if (record?.origin !== "host") {
			throw new ConversationError("invalid_argument", `${JSON.stringify(clientMessageId)} is not a host input`);
		}
		if (record.state !== "accepted") return false;
		const pending = [...this.deliveryMeta].find(([, meta]) => meta.clientMessageId === clientMessageId);
		if (pending) {
			// A delivery a turn already leased is being delivered.
			if (!this.inbox.withdraw(pending[0])) return false;
			this.deliveryMeta.delete(pending[0]);
			this.publishQueue();
		}
		const entries = await this.commit((drafts, state) => {
			const current = state.clientInputs.inputs.get(clientMessageId);
			if (current?.state !== "accepted") return;
			drafts.add({
				type: "client_input_state",
				visibility: "host",
				payload: { receiptId: current.receiptId, clientMessageId, state: "withdrawn" },
			});
		});
		if (entries.length === 0) return false;
		this.settleWaiter(clientMessageId, { state: "withdrawn" });
		return true;
	}

	// ==========================================================================
	// Prompt cache
	// ==========================================================================

	/** Whether `refreshPromptCache` would replay the latest turn request now. Sends nothing. */
	canRefreshPromptCache(): boolean {
		const refresher = this.promptCacheRefresher;
		const target = this.lastRequest;
		return (
			refresher !== undefined &&
			target !== undefined &&
			this.staleness(target) === undefined &&
			refresher.supportsPromptCacheRefresh(target.model, target.options)
		);
	}

	/** Replay the latest turn request as a no-output cache refresh, unless the branch or configuration changed. */
	async refreshPromptCache(signal?: AbortSignal): Promise<ConversationPromptCacheRefreshResult> {
		this.assertActive();
		const refresher = this.promptCacheRefresher;
		if (!refresher) return { status: "unavailable", reason: "no_refresh_function" };
		const target = this.lastRequest;
		if (!target) return { status: "unavailable", reason: "no_request" };
		const stale = this.staleness(target);
		if (stale) return { status: "unavailable", reason: stale };
		signal?.throwIfAborted();
		const beforeProviderPayload = this.policy.beforeProviderPayload;
		const result = await refresher.refreshPromptCache(target.model, target.context, {
			...target.options,
			...(beforeProviderPayload === undefined
				? {}
				: {
						onPayload: async (payload: unknown, model: Model<Api>) => await beforeProviderPayload(payload, model),
					}),
			...(signal === undefined ? {} : { signal }),
		});
		return { ...result, model: target.model };
	}

	private staleness(target: RecordedRequest): "configuration_changed" | "branch_changed" | undefined {
		const context = this.foldState.context;
		if (!isPrefix(target.messages, context.messages)) return "branch_changed";
		if (
			target.configurationEpoch !== this.configurationEpoch ||
			target.modelRef !== `${context.model?.provider}/${context.model?.modelId}` ||
			target.thinkingLevel !== context.thinkingLevel ||
			target.fastMode !== context.fastMode
		) {
			return "configuration_changed";
		}
		return undefined;
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	/** Abort work, wait for it to settle, and close the log. Idempotent. */
	close(): Promise<void> {
		this.closePromise ??= (async () => {
			this.successorTurn?.cancel();
			this.successorTurn = undefined;
			this.coordinator.requestClose("disposal");
			this.releaseReservation();
			await this.coordinator.waitForClosed();
			await this.laneTail;
			await this.log.close();
			await this.ended;
			await this.eventTail;
		})();
		return this.closePromise;
	}

	private handleLoss(error: ConversationLogLostError): void {
		if (this.endState) return;
		const end: ConversationEnd = Object.freeze({ reason: error.reason, error });
		this.endState = end;
		this.successorTurn?.cancel();
		this.successorTurn = undefined;
		this.coordinator.requestClose("disposal");
		this.releaseReservation();
		for (const waiter of this.inputWaiters.values()) {
			waiter.reject(new ConversationError("ended", "The conversation ended before the input settled", error));
		}
		this.inputWaiters.clear();
		void this.publish({ type: "ended", reason: error.reason, error });
		this.resolveEnded(end);
	}

	private assertActive(): void {
		if (this.endState || !this.coordinator.isOpen) {
			throw new ConversationError("ended", "The conversation has ended", this.endState?.error);
		}
	}

	private resolveModel(state: ConversationState): Model<Api> | undefined {
		const ref = state.context.model;
		return ref ? this.resolveModelRef(ref.provider, ref.modelId) : undefined;
	}

	private requireModel(): Model<Api> {
		const model = this.resolveModel(this.foldState);
		if (!model) throw new ConversationError("invalid_state", "No model set for the conversation");
		return model;
	}

	// ==========================================================================
	// Commit lane and events
	// ==========================================================================

	private enqueueLane<T>(job: () => Promise<T>): Promise<T> {
		const next = this.laneTail.then(job, job);
		this.laneTail = next.catch(() => undefined);
		return next;
	}

	/** Commit one batch built against the current fold, then fold and publish it. */
	private commit(
		build: (drafts: EntryDrafts, state: ConversationState) => void,
	): Promise<readonly ConversationLogEntry[]> {
		return this.enqueueLane(() => this.commitInLane(build));
	}

	private async commitInLane(
		build: (drafts: EntryDrafts, state: ConversationState) => void,
	): Promise<readonly ConversationLogEntry[]> {
		if (this.endState) throw new ConversationError("ended", "The conversation has ended", this.endState.error);
		const state = this.foldState;
		const drafts = new EntryDrafts(state, this.createId);
		build(drafts, state);
		if (drafts.drafts.length === 0) return [];
		const entries = drafts.drafts.map(
			(draft, index) => deepFreeze({ ...draft, ordinal: state.ordinal + index + 1 }) as ConversationLogEntry,
		);
		let next: ConversationState;
		try {
			next = fold(entries, state);
		} catch (error) {
			if (error instanceof ConversationFoldError || error instanceof TypeError) {
				throw new ConversationError("invalid_argument", error.message, error);
			}
			throw error;
		}
		let result: Awaited<ReturnType<ConversationLog["append"]>>;
		try {
			result = await this.log.append({
				expectedOrdinal: state.ordinal,
				commitId: `conversation-commit:${this.createId()}`,
				entries: drafts.drafts,
			});
		} catch (error) {
			if (error instanceof ConversationLogLostError) {
				this.handleLoss(error);
				throw new ConversationError("ended", error.message, error);
			}
			throw error;
		}
		if (result.status === "rolled_back") {
			throw new ConversationError("commit_rolled_back", result.error.message, result.error);
		}
		this.foldState = next;
		void this.publish({ type: "committed", entries, ordinal: result.last });
		return entries;
	}

	private publishAgent(event: AgentEvent): Promise<void> {
		return this.publish({ ...event, basedOn: this.foldState.ordinal } as ConversationAgentEvent);
	}

	private publishQueue(): void {
		void this.publish({ type: "queue_changed", queue: this.queue });
	}

	/** Deliver one event to every listener in publication order; listener failures are isolated. */
	private publish(event: ConversationEvent): Promise<void> {
		const deliver = async (): Promise<void> => {
			for (const listener of [...this.listeners]) {
				try {
					await listener(isAgentEvent(event) ? structuredClone(event) : event);
				} catch {
					// Listeners observe; they cannot change the conversation.
				}
			}
		};
		const delivery = this.eventTail.then(deliver);
		this.eventTail = delivery;
		return delivery;
	}
}

/** The notice a delivered result queues: a custom message carrying the result's metadata, never its output. */
function workNotice(record: WorkRecord, payload: WorkFinishedEntryPayload, text: string | undefined): CustomMessage {
	const { summary, child, output } = payload.result ?? {};
	const details: WorkNoticeDetails = {
		workId: record.workId,
		kind: record.kind,
		title: record.title,
		outcome: payload.outcome === "failed" ? "failed" : "completed",
		...(summary === undefined ? {} : { summary }),
		...(payload.error === undefined ? {} : { error: payload.error }),
		...(child === undefined ? {} : { child }),
		...(output === undefined ? {} : { output: { truncated: output.truncated } }),
	};
	const lines = [`${record.title} (${record.kind} ${record.workId}) ${details.outcome}.`];
	if (summary) lines.push(summary);
	if (payload.error) lines.push(`Error: ${payload.error}`);
	return {
		role: "custom",
		customType: WORK_NOTICE_CUSTOM_TYPE,
		content: text ?? lines.join("\n"),
		display: true,
		details,
		timestamp: Date.now(),
	};
}

/** The abandoned branch after its common ancestor with `targetId`, oldest first. */
function abandonedBranch(
	state: ConversationState,
	targetId: string | null,
): { commonAncestorId: string | null; entries: readonly ConversationLogEntry[] } {
	const targetPath = new Set<string>();
	for (let id = targetId; id !== null; id = state.tree.byId.get(id)?.parentId ?? null) targetPath.add(id);
	const entries: ConversationLogEntry[] = [];
	let commonAncestorId: string | null = null;
	for (let index = state.branch.length - 1; index >= 0; index--) {
		const id = state.branch[index];
		if (id === undefined) continue;
		if (targetPath.has(id)) {
			commonAncestorId = id;
			break;
		}
		const entry = state.tree.byId.get(id);
		if (entry) entries.push(entry);
	}
	return { commonAncestorId, entries: entries.reverse() };
}

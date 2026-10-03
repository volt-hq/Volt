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
 * seeded from the fold's durable queue on open.
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
	CORE_LOG_ENTRY_TYPES,
	type LogEntryType,
} from "@hansjm10/volt-protocol/entries";
import { Check } from "typebox/value";
import { AgentDeliverySettlementError, runAgentLoop } from "../agent-loop.ts";
import { DeliveryInbox, type DeliveryLease, type InboxDelivery } from "../delivery-inbox.ts";
import { convertToLlm as convertRuntimeMessages } from "../harness/messages.ts";
import { toError } from "../harness/types.ts";
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
	type ConversationAgentEvent,
	type ConversationBranchSummary,
	type ConversationCompactionCause,
	type ConversationCompactionDecision,
	type ConversationCompactionResult,
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
	type ConversationQueue,
	type ConversationQueueModes,
	type ConversationRequestBoundary,
	type ConversationRequestContext,
	type ConversationRequestDelivery,
	type ConversationStreamOptions,
	type ConversationSummarizer,
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
} from "./log.ts";
import {
	cloneAgentMessages,
	cloneNextAction,
	cloneNextActionContext,
	cloneStreamOptions,
	createAbortedAssistantStream,
	createFailureMessage,
	deepFreeze,
	withRuntimeAbortDiagnostic,
} from "./runtime-support.ts";

type EntryBody = ConversationLogEntryDraft extends infer T
	? T extends unknown
		? Omit<T, "id" | "parentId" | "timestamp">
		: never
	: never;

/** Core types a host may append directly; the rest have intents. */
const HOST_APPENDABLE_CORE_TYPES: ReadonlyMap<string, LogEntryType> = new Map(
	(["custom", "custom_message", "message", "subagent_spawn"] as const).map((type) => [
		type,
		CORE_LOG_ENTRY_TYPES[type],
	]),
);

type ClientUserMessage = UserMessage & { clientMessageId?: string };

interface DeliveryMeta {
	readonly kind: AgentDeliveryKind;
	readonly clientMessageId?: string;
	/** User-bearing input that establishes a new request batch. */
	readonly requestInput: boolean;
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
}

interface PreparedRequest {
	/** The fold's branch messages the loop's provider context was built from. */
	readonly messages: readonly AgentMessage[];
	readonly tools: readonly AgentTool[] | undefined;
	readonly configurationEpoch: number;
	readonly boundary: Omit<ConversationRequestBoundary, "attemptId" | "basisOrdinal">;
}

/** Work the turn operation does after its loop ends, decided before the loop's terminal event. */
type TurnFollowUp =
	| { readonly kind: "retry"; readonly delayMs: number; readonly message: AssistantMessage }
	| {
			readonly kind: "compact";
			readonly cause: "overflow" | "threshold";
			readonly decision: ConversationCompactionDecision;
	  };

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
	pendingCompaction: ConversationCompactionDecision | undefined;
	request: PreparedRequest | undefined;
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

/** The default conversion: runtime messages to provider messages, without client identities. */
function convertConversationMessages(messages: AgentMessage[]): Message[] {
	return convertRuntimeMessages(messages.map(withoutClientMessageId));
}

async function semanticDigest(command: ClientInputCommand, input: ClientInputPayload): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify({ command, ...input }));
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
	private readonly admitting = new Map<string, Promise<ConversationInputAdmission>>();
	private readonly listeners = new Set<ConversationListener>();
	private tools: TTool[];
	private streamOptions: ConversationStreamOptions;
	private modes: ConversationQueueModes;
	private configurationEpoch = 0;
	private foldState: ConversationState;
	private laneTail: Promise<unknown> = Promise.resolve();
	private eventTail: Promise<void> = Promise.resolve();
	private activeLease: DeliveryLease<AgentDeliveryKind, AgentMessage> | undefined;
	private successorTurn: ReturnType<OperationCoordinator<ConversationOperationKind>["reserveSuccessor"]>;
	private continuation: ContinuationState | undefined;
	private requestBatch: ConversationRequestBoundary["batch"];
	private pendingRequestDeliveries: ConversationRequestDelivery[] = [];
	private lastRequest: RecordedRequest | undefined;
	private endState: ConversationEnd | undefined;
	private resolveEnded: (end: ConversationEnd) => void = () => {};
	private closePromise: Promise<void> | undefined;

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

	/** Admit a prompt. While a turn runs, a prompt needs `streamingBehavior` and is queued with it. */
	prompt(input: ConversationInput): Promise<ConversationInputAdmission> {
		return this.admitInput("prompt", input);
	}

	steer(input: ConversationInput): Promise<ConversationInputAdmission> {
		return this.admitInput("steer", input);
	}

	followUp(input: ConversationInput): Promise<ConversationInputAdmission> {
		return this.admitInput("follow_up", input);
	}

	/**
	 * Queue host messages (extension or background notices) that are not client
	 * input. They stay in memory until a turn delivers them as one batch.
	 */
	queueMessages(kind: "steer" | "followUp", messages: readonly AgentMessage[]): string {
		this.assertActive();
		if (messages.length === 0) throw new ConversationError("invalid_argument", "A delivery needs a message");
		const deliveryId = this.enqueueDelivery(kind, cloneAgentMessages(messages), { kind, requestInput: false });
		this.startTurnForQueuedInput();
		return deliveryId;
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

	private async admitInput(
		command: ClientInputCommand,
		input: ConversationInput,
	): Promise<ConversationInputAdmission> {
		this.assertActive();
		if (command !== "prompt" && input.streamingBehavior !== undefined) {
			throw new ConversationError("invalid_argument", "Only a prompt may set streamingBehavior");
		}
		const clientMessageId = input.clientMessageId ?? this.createId();
		const inFlight = this.admitting.get(clientMessageId);
		if (inFlight) {
			await inFlight.catch(() => undefined);
			return await this.admitInput(command, input);
		}
		const images = (input.images ?? []).map((image) => structuredClone(image));
		const payload: ClientInputPayload = {
			message: input.message,
			images,
			...(input.streamingBehavior === undefined ? {} : { streamingBehavior: input.streamingBehavior }),
		};
		const existing = this.foldState.clientInputs.inputs.get(clientMessageId);
		const immediate = command === "prompt" && existing === undefined && this.coordinator.current === undefined;
		if (command === "prompt" && !immediate && existing === undefined && input.streamingBehavior === undefined) {
			throw new ConversationError("busy", "The conversation is busy; queue the prompt with a streaming behavior");
		}
		let lease: OperationLease<ConversationOperationKind> | undefined;
		if (immediate) {
			this.requireModel();
			lease = this.coordinator.reserve("turn");
			if (!lease) throw new ConversationError("ended", "The conversation has ended");
		}
		const queuedDelivery =
			command === "prompt" ? (input.streamingBehavior === "steer" ? "steer" : "follow_up") : command;
		const delivery = immediate ? undefined : queuedDelivery;
		const kind: AgentDeliveryKind = delivery === undefined ? "prompt" : delivery === "steer" ? "steer" : "followUp";
		const prepared = input.prepared ?? { message: input.message, images };
		const preparedImages = (prepared.images ?? []).map((image) => structuredClone(image));
		const attachments = cloneAgentMessages(input.attachments ?? []);
		const admission = this.enqueueLane(async (): Promise<ConversationInputAdmission> => {
			const digest = await semanticDigest(command, payload);
			const record = this.foldState.clientInputs.inputs.get(clientMessageId);
			if (record) return this.readmit(record, command, digest);
			const entries = await this.commitInLane((drafts) => {
				const receipt = drafts.add({
					type: "client_input_receipt",
					visibility: "host",
					payload: { clientMessageId, command, semanticDigest: digest, input: payload },
				});
				if (delivery !== undefined) {
					drafts.add({
						type: "client_input_queued",
						visibility: "host",
						payload: {
							receiptId: receipt.id,
							clientMessageId,
							queuedInput: { delivery, message: prepared.message, images: preparedImages },
						},
					});
				}
			});
			this.enqueueDelivery(
				kind,
				[clientUserMessage(prepared.message, preparedImages, clientMessageId), ...attachments],
				{
					kind,
					clientMessageId,
					requestInput: true,
				},
			);
			return {
				clientMessageId,
				ordinals: entries.map((entry) => entry.ordinal),
				completion: this.createWaiter(clientMessageId).promise,
			};
		});
		this.admitting.set(clientMessageId, admission);
		let result: ConversationInputAdmission;
		try {
			result = await admission;
		} catch (error) {
			if (lease) this.coordinator.finish(lease);
			throw error;
		} finally {
			if (this.admitting.get(clientMessageId) === admission) this.admitting.delete(clientMessageId);
		}
		if (lease) {
			if (result.ordinals.length === 0) {
				this.coordinator.finish(lease);
			} else {
				// A new prompt starts fresh: a paused continuation does not carry over to it.
				this.continuation = undefined;
				void this.runTurn(lease, this.continueStart()).catch(() => undefined);
			}
		} else if (result.ordinals.length > 0) {
			this.startTurnForQueuedInput();
		}
		return result;
	}

	private readmit(record: ClientInputRecord, command: ClientInputCommand, digest: string): ConversationInputAdmission {
		if (record.command !== command || record.semanticDigest !== digest) {
			throw new ConversationError(
				"client_input_conflict",
				`Client message ${JSON.stringify(record.clientMessageId)} was already used for different input`,
			);
		}
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
			this.enqueueDelivery(kind, [clientUserMessage(queued.message, queued.images, record.clientMessageId)], {
				kind,
				clientMessageId: record.clientMessageId,
				requestInput: true,
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
			if (!this.inbox.hasPending()) {
				// The previous turn delivered the input after all.
				this.coordinator.finish(successor.lease);
				return;
			}
			void this.runTurn(successor.lease, this.continueStart()).catch(() => undefined);
		});
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
		const pending = this.inbox.hasPending();
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

	/** Abort the active operation. Queued input stays pending until it is delivered or cleared. */
	abort(source?: AgentAbortSource): AgentAbortAcceptance {
		this.successorTurn?.cancel();
		this.successorTurn = undefined;
		return this.coordinator.requestAbort(source);
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
		};
		try {
			let start = initial;
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
		const pendingCompaction = run.pendingCompaction;
		run.pendingCompaction = undefined;
		if (pendingCompaction) {
			const result = await this.runCompaction(run.signal, "threshold", pendingCompaction.instructions, false);
			return result.status === "compacted" ? this.continueStart() : undefined;
		}
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
		const result = await this.runCompaction(run.signal, followUp.cause, followUp.decision.instructions, false);
		if (result.status !== "compacted") return undefined;
		if (followUp.cause === "overflow") {
			run.retryRequest = true;
			return this.retryStart();
		}
		return followUp.decision.resume ? this.continueStart() : undefined;
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

		const prompts = this.inbox.select("prompt", "all");
		let selected = [...prompts, ...this.inbox.select("steer", this.modes.steer)];
		const hasIndependentRequest = runtimeAction.type === "request" && providerRequestPending;
		if (selected.length === 0 && ((firstDecision && start.drainFollowUpsFirst) || !hasIndependentRequest)) {
			selected = [...this.inbox.select("followUp", this.modes.followUp)];
		}
		const suggested: AgentLoopNextAction =
			selected.length > 0
				? { type: "request", reason: hasIndependentRequest ? "continuation" : "delivery" }
				: hasIndependentRequest
					? runtimeAction
					: { type: "stop" };

		if (suggested.type === "request" && context.completedTurn && (await this.shouldCompactMidTurn(run, context))) {
			this.continuation = { requestAuthority, providerRequestPending: hasIndependentRequest };
			return { type: "pause", requestAuthority };
		}

		const { action, policyOverride } = await this.reduceNextAction(
			run,
			{ ...context, requestAuthority, defaultAction: suggested },
			suggested,
		);
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
		if (action.type === "stop") return action;
		const deliveries = [
			...(selected.length > 0 ? await this.prepareLeasedDeliveries(run, selected) : []),
			...(await this.preparePolicyDeliveries(run, action.deliveries ?? [])),
		];
		return { type: "request", reason: action.reason, ...(deliveries.length > 0 ? { deliveries } : {}) };
	}

	private async shouldCompactMidTurn(run: TurnRun, context: AgentLoopNextActionContext): Promise<boolean> {
		const hook = this.policy.compaction;
		const message = context.completedTurn?.message;
		if (!hook || !message || !this.summarizer) return false;
		if (message.stopReason === "error" || message.stopReason === "aborted") return false;
		const model = this.resolveModel(this.foldState);
		if (!model || message.provider !== model.provider || message.model !== model.id) return false;
		const decision = await hook(message.usage, "threshold", {
			message,
			model,
			state: this.foldState,
			continuing: true,
		});
		if (!decision || run.signal.aborted) return false;
		run.pendingCompaction = decision;
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
				messages = await this.reduceMessages(run, delivery.messages);
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
			prepared.push({ deliveryId, messages: await this.reduceMessages(run, delivery.messages) });
		}
		return prepared;
	}

	/** Apply `messageEnd` to delivered messages before they commit; client identities survive replacement. */
	private async reduceMessages(run: TurnRun, messages: readonly AgentMessage[]): Promise<AgentMessage[]> {
		const reduced: AgentMessage[] = [];
		for (const message of messages) {
			let current = structuredClone(message);
			const hook = this.policy.messageEnd;
			if (hook) {
				const replacement = await hook(structuredClone(current), run.signal);
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
		let entries: readonly ConversationLogEntry[];
		try {
			entries = await this.commit((drafts, state) => this.addDeliveryDrafts(drafts, state, delivery.messages, meta));
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
			const entry = entries.find(
				(candidate) =>
					candidate.type === "message" &&
					"clientMessageId" in candidate &&
					candidate.clientMessageId === meta.clientMessageId,
			);
			const waiter = this.inputWaiters.get(meta.clientMessageId);
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

	private addDeliveryDrafts(
		drafts: EntryDrafts,
		state: ConversationState,
		messages: readonly AgentMessage[],
		meta: DeliveryMeta,
	): void {
		for (const message of messages) {
			const clientMessageId = clientMessageIdOf(message);
			if (clientMessageId === undefined || clientMessageId !== meta.clientMessageId) {
				drafts.add(this.messageEntryBody(message));
				continue;
			}
			const record = state.clientInputs.inputs.get(clientMessageId);
			if (record?.state === "accepted") {
				drafts.add({
					type: "client_input_state",
					visibility: "host",
					payload: { receiptId: record.receiptId, clientMessageId, state: "started" },
				});
			}
			drafts.add({
				type: "message",
				visibility: "public",
				clientMessageId,
				payload: { message: withoutClientMessageId(message) as UserMessage },
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
			context: { systemPrompt, messages: [...state.context.messages], tools },
			model,
			thinkingLevel: state.context.thinkingLevel,
		};
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
						: await buildContext(state, this.contextOptions(signal));
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
				run.terminalSettling = terminal && !this.inbox.hasPending();
				let message = this.withAbortDiagnostic(event.message, run);
				const hook = this.policy.messageEnd;
				if (hook) {
					const replacement = await hook(structuredClone(message), run.signal);
					if (replacement !== undefined) {
						if (replacement.role !== message.role) {
							throw new ConversationError("invalid_argument", "messageEnd must preserve the message role");
						}
						message = this.withAbortDiagnostic(replacement, run);
					}
				}
				await this.commit((drafts) => drafts.add(this.messageEntryBody(message)));
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
				return decision ? { kind: "compact", cause: "overflow", decision } : undefined;
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
		return decision ? { kind: "compact", cause: "threshold", decision } : undefined;
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
	 * A turn whose request was accepted cannot be preempted.
	 */
	async navigate(
		targetId: string | null,
		options: ConversationNavigationOptions = {},
	): Promise<ConversationNavigationResult> {
		this.assertActive();
		if (targetId !== null && this.foldState.tree.byId.get(targetId)?.visibility !== "public") {
			throw new ConversationError("invalid_argument", `Unknown conversation entry ${JSON.stringify(targetId)}`);
		}
		const summarizer = options.summarize ? this.summarizer : undefined;
		if (options.summarize && !summarizer) {
			throw new ConversationError("invalid_state", "The conversation has no summarizer");
		}
		const lease = await this.acquireStructural("navigation");
		try {
			this.coordinator.start(lease);
			const signal = lease.abortGate.signal;
			const state = this.foldState;
			let summary: ConversationBranchSummary | undefined;
			if (summarizer && targetId !== state.leafId) {
				const model = this.requireModel();
				const abandoned = abandonedBranch(state, targetId);
				summary = await summarizer.summarizeBranch({
					state,
					model,
					thinkingLevel: state.context.thinkingLevel,
					...(options.instructions === undefined ? {} : { instructions: options.instructions }),
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
				if (options.label !== undefined && labelTarget !== null) {
					drafts.add({
						type: "label",
						visibility: "public",
						payload: { targetId: labelTarget, label: options.label },
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
			const [entry] = await this.commit((drafts) =>
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
				}),
			);
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

	/** Append host entries in one batch: registered product types, or core `custom`, `custom_message`, `message`, `subagent_spawn`. */
	async append(entries: readonly ConversationEntryInput[]): Promise<readonly ConversationLogEntry[]> {
		this.assertActive();
		const bodies = entries.map((entry): EntryBody => {
			const definition = HOST_APPENDABLE_CORE_TYPES.get(entry.type) ?? this.productTypes.get(entry.type);
			if (definition === undefined) {
				throw new ConversationError("invalid_argument", `Entry type ${entry.type} cannot be appended`);
			}
			if (!Check(definition.payload, entry.payload)) {
				throw new ConversationError("invalid_argument", `Entry payload does not match type ${entry.type}`);
			}
			return { type: entry.type, visibility: definition.visibility, payload: entry.payload } as EntryBody;
		});
		if (bodies.length === 0) return [];
		return await this.commit((drafts) => {
			for (const body of bodies) drafts.add(body);
		});
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

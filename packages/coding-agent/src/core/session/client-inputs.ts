/**
 * The session's client inputs ({@link SessionClientInputs}): durable input
 * identities and their admission (normalization, the semantic digest that
 * detects conflicting reuse, the side-effect boundary that makes an outcome
 * ambiguous), the live admissions a retry joins, the recovery fence that
 * keeps fresh input behind input a previous runtime left queued, and the
 * queue: the fold's queued client inputs, published as they change.
 */

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentHarnessAdmissionGate,
	AgentMessage,
	AgentTool,
	Conversation,
	ConversationInput,
	ConversationInputAdmission,
	ConversationQueue,
} from "@hansjm10/volt-agent-core";
import { ConversationError, clientInputDigest, clientInputRecovery } from "@hansjm10/volt-agent-core";
import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import type {
	AgentSessionEvent,
	AgentSessionQueuedMessage,
	PromptAdmissionOutcome,
	PromptPreflightResult,
} from "../agent-session.ts";
import { getClientMessageId } from "../messages.ts";
import { boundClientInputError, normalizeClientInputPayload } from "../session-entry-codec.ts";
import { CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES, type ClientInputCommand } from "../session-manager.ts";
import type { SessionEvents } from "./events.ts";

/**
 * Prefix of the durable identity the session gives input that arrives without
 * one (local TUI, SDK, and extension input). Every input is durable; outcomes
 * are reported only for caller-supplied identities.
 */
const LOCAL_CLIENT_INPUT_ID_PREFIX = "local-";

export function createLocalClientInputId(): string {
	return `${LOCAL_CLIENT_INPUT_ID_PREFIX}${randomUUID()}`;
}

function isLocalClientInputId(clientMessageId: string): boolean {
	return clientMessageId.startsWith(LOCAL_CLIENT_INPUT_ID_PREFIX);
}

function messageText(content: AgentMessage): string {
	if (!("content" in content)) return "";
	const value = content.content;
	if (typeof value === "string") return value;
	return value
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** The queue identity projection retains every admitted entry inside its wire budget. */
export const AGENT_SESSION_MAX_QUEUED_MESSAGES = CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES;

/**
 * A client input this runtime admitted and has not settled: a retry with the
 * same identity joins it. `accepted` settles when the input is admitted (its
 * user message committed, or it was queued or handled); `done` when it
 * completes.
 */
export interface LiveClientInput {
	readonly command: ClientInputCommand;
	readonly input: ConversationInput;
	readonly accepted: PromiseWithResolvers<PromptAdmissionOutcome>;
	readonly done: PromiseWithResolvers<void>;
	/** The turn operation it was admitted to start: that turn delivers it, or it fails once that turn ended. */
	operationId: string | undefined;
	/**
	 * Input without a caller identity (local input, a message that triggers a
	 * turn): when its turn or the session stops before delivering it, it is
	 * withdrawn and its caller resolves, as a cancelled run does.
	 */
	local: boolean;
}

export class ClientInputConflictError extends Error {
	readonly code = "client_input_conflict";
}

export class ClientInputOutcomeAmbiguousError extends Error {
	readonly code = "client_input_outcome_ambiguous";
}

/**
 * Raised when {@link AgentSession.clearQueue} revoked the runtime queues but their
 * cancellation could not be made durable. The queues are already gone, so the
 * captured text is carried on the error: it is the only remaining copy of what the
 * user typed, and callers restoring input to an editor must recover it from here.
 */
export class QueueClearPersistenceError extends Error {
	readonly code = "queue_clear_persistence_failed";
	readonly steering: string[];
	readonly followUp: string[];

	constructor(cause: Error, queues: { steering: string[]; followUp: string[] }) {
		super(cause.message, { cause });
		this.steering = queues.steering;
		this.followUp = queues.followUp;
	}
}

export interface SessionClientInputsHost {
	readonly admissionGate: AgentHarnessAdmissionGate;
	conversation(): Conversation<AgentTool>;
	events(): SessionEvents;
	isDisposed(): boolean;
	/** Whether the session lost its log. */
	isLost(): boolean;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	/** Whether an operation or conversation activity holds the conversation. */
	isBusy(): boolean;
	/** Whether the session is a review finding discussion. */
	isReviewDiscussion(): boolean;
	/** The admission revision a stop advances: work admitted under an older one was aborted. */
	abortGeneration(): number;
	/** Track work that must settle before the session's resources close. */
	trackAncillaryWork<T>(work: Promise<T>): Promise<T>;
	emit(event: AgentSessionEvent): void;
}

export class SessionClientInputs {
	private readonly host: SessionClientInputsHost;
	/** Client inputs this runtime admitted and has not settled, by client message id. */
	readonly live = new Map<string, LiveClientInput>();
	/** Blocks newer input from overtaking durable queue entries restored at open. */
	private recoveredReplayPending = false;
	private resumePromise: Promise<void> | undefined;
	/** Queued input whose admission is committing: `waitForIdle` joins the turn it starts. */
	private readonly admissions = new Set<Promise<unknown>>();
	/** The queue the session last published, serialized, so it publishes only changes. */
	private publishedQueue: string | undefined;
	/**
	 * Queue text handed back once the queue can no longer be cleared durably:
	 * captured by the synchronous dispose fence, or by the first clear after
	 * the log is lost. Once it is set, the session shows no queue.
	 */
	private disposedQueueHandback: { steering: string[]; followUp: string[] } | undefined;

	constructor(host: SessionClientInputsHost) {
		this.host = host;
	}

	/** Whether recovered input still has to replay before fresh input is admitted. */
	get replayPending(): boolean {
		return this.recoveredReplayPending;
	}

	/** Queued input whose admission is committing. */
	get queueAdmissions(): ReadonlySet<Promise<unknown>> {
		return this.admissions;
	}

	/** Fence fresh input behind the input a previous runtime left to replay. */
	fenceRecovered(): void {
		this.recoveredReplayPending = clientInputRecovery(this.host.conversation().state).kind !== "idle";
	}

	private ambiguousRecoveredError(clientMessageId: string): ClientInputOutcomeAmbiguousError {
		return new ClientInputOutcomeAmbiguousError(
			`client_input_outcome_ambiguous: ${JSON.stringify(clientMessageId)} crossed its durable dispatch boundary before restart but has no canonical or terminal record; later queued input remains fenced`,
		);
	}

	/**
	 * The queue: the fold's queued client inputs with a client origin, in
	 * admission order, that the conversation holds for delivery. Input being
	 * delivered or withdrawn has left it. Recovered input fenced behind an
	 * ambiguous predecessor stays visible, though nothing delivers it. Host
	 * messages are queued too, but show no text.
	 */
	queueView(): { steering: AgentSessionQueuedMessage[]; followUp: AgentSessionQueuedMessage[] } {
		const steering: AgentSessionQueuedMessage[] = [];
		const followUp: AgentSessionQueuedMessage[] = [];
		if (this.disposedQueueHandback) return { steering, followUp };
		const state = this.host.conversation().state;
		const queue = this.host.conversation().queue;
		const held = new Set([...queue.steer, ...queue.followUp].flatMap((message) => getClientMessageId(message) ?? []));
		const fenced = clientInputRecovery(state).kind === "blocked";
		for (const clientMessageId of state.clientInputs.queued) {
			const record = state.clientInputs.inputs.get(clientMessageId);
			const queued = record?.queuedInput;
			if (!queued || record.origin === "host" || (!fenced && !held.has(clientMessageId))) continue;
			(queued.delivery === "steer" ? steering : followUp).push({ clientMessageId, text: queued.message });
		}
		return { steering, followUp };
	}

	/** Publish the queue when it changed since the session last published it. */
	publishQueue(): void {
		const queue = this.queueView();
		const serialized = JSON.stringify(queue);
		if (serialized === this.publishedQueue) return;
		this.publishedQueue = serialized;
		this.host.emit({ type: "queue_update", ...queue });
	}

	/** The queue's text, as an editor takes it back. */
	private queueText(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.queueView();
		return { steering: steering.map((entry) => entry.text), followUp: followUp.map((entry) => entry.text) };
	}

	/** The disposal fence: the queue's text is handed back from here on, and the session shows no queue. */
	handBackQueue(): void {
		this.disposedQueueHandback = this.queueText();
	}

	/**
	 * Clear all queued messages and return them. Every queued input is
	 * withdrawn durably; a persistence failure carries the text back on
	 * {@link QueueClearPersistenceError}.
	 */
	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		if (this.host.isDisposed() || this.host.isLost()) {
			const handback = this.disposedQueueHandback ?? this.queueText();
			this.disposedQueueHandback = { steering: [], followUp: [] };
			return { steering: [...handback.steering], followUp: [...handback.followUp] };
		}
		// Input still being admitted is part of the queue being cleared.
		await Promise.allSettled([...this.admissions]);
		const queued = this.queueText();
		let cleared: ConversationQueue;
		try {
			cleared = await this.host.conversation().clearQueue();
		} catch (error) {
			// The conversation no longer holds the input, so the thrown error carries its text back.
			throw new QueueClearPersistenceError(error instanceof Error ? error : new Error(String(error)), queued);
		}
		// Client input delivers a user message with its identity; host messages show no text.
		const text = (messages: readonly AgentMessage[]) =>
			messages.flatMap((message) => (getClientMessageId(message) === undefined ? [] : [messageText(message)]));
		return { steering: text(cleared.steer), followUp: text(cleared.followUp) };
	}

	/** Track queued input while its admission commits, so `waitForIdle` joins the turn it starts. */
	trackQueueAdmission<T>(admission: Promise<T>): Promise<T> {
		this.admissions.add(admission);
		const settle = () => {
			this.admissions.delete(admission);
		};
		void admission.then(settle, settle);
		return admission;
	}

	/** The durable queue holds at most {@link AGENT_SESSION_MAX_QUEUED_MESSAGES} inputs, host messages included. */
	assertQueueCapacity(): void {
		if (this.host.conversation().state.clientInputs.queued.length >= AGENT_SESSION_MAX_QUEUED_MESSAGES) {
			throw new Error(`Agent queue is limited to ${AGENT_SESSION_MAX_QUEUED_MESSAGES} messages`);
		}
	}

	/**
	 * Report the outcome of an identified input its client was told is queued:
	 * when its admission completes withdrawn or failed, the client learns it
	 * from `client_input_outcome`. Local input has no client to tell.
	 */
	reportQueuedOutcome(admission: ConversationInputAdmission): void {
		const clientMessageId = admission.clientMessageId;
		if (isLocalClientInputId(clientMessageId)) return;
		void admission.completion.then(
			(outcome) => {
				if (outcome.state === "completed") return;
				this.host.emit({
					type: "client_input_outcome",
					clientMessageId,
					outcome: "failed",
					reason: outcome.state === "withdrawn" ? "queue_cleared" : "dispatch_failed",
				});
			},
			// A conversation that ended first reports no outcome; the input stays recoverable.
			() => undefined,
		);
	}

	/**
	 * Admit again, as idempotent resubmissions that record nothing, the
	 * identified inputs a previous runtime left queued or mid-dispatch, so
	 * their clients learn their outcomes like those of input queued now.
	 */
	async readmitRecovered(): Promise<void> {
		const { inputs, queued, started } = this.host.conversation().state.clientInputs;
		for (const clientMessageId of [...started, ...queued]) {
			const record = inputs.get(clientMessageId);
			if (!record || record.origin !== undefined || isLocalClientInputId(clientMessageId)) continue;
			const { message, images, streamingBehavior } = record.input;
			const admission = await this.host
				.conversation()
				.admitInput(
					record.command,
					{ clientMessageId, message, images, ...(streamingBehavior === undefined ? {} : { streamingBehavior }) },
					{ deliver: false },
				);
			this.reportQueuedOutcome(admission);
		}
	}

	/**
	 * Record a client input's failure: its pending delivery is withdrawn and a
	 * prompt that admitted it rejects. A client told its input was queued
	 * learns the outcome from the input's admission.
	 */
	async fail(clientMessageId: string, error: Error, interrupted = false): Promise<void> {
		const live = this.live.get(clientMessageId);
		const state = this.host.conversation().state.clientInputs.inputs.get(clientMessageId)?.state;
		// Local input a stop interrupted before delivery is withdrawn, as a cancelled run is.
		const withdraw = interrupted && live?.local === true && state === "accepted";
		let reported: Error | undefined = error;
		if (state === "accepted" || state === "started") {
			try {
				await this.host
					.conversation()
					.settleClientInput(
						clientMessageId,
						withdraw ? { state: "withdrawn" } : { state: "failed", error: boundClientInputError(error.message) },
					);
				if (withdraw) reported = undefined;
			} catch (settleError) {
				reported = settleError instanceof Error ? settleError : new Error(String(settleError));
			}
		}
		if (!live) return;
		this.live.delete(clientMessageId);
		if (reported === undefined) {
			live.accepted.resolve("admitted");
			live.done.resolve();
			return;
		}
		live.accepted.reject(reported);
		live.done.reject(reported);
	}

	/** The session lost its log: no live input can settle any more. */
	lost(error: Error): void {
		const lostInputError = new Error("The session lost its log before the client input settled", { cause: error });
		for (const live of this.live.values()) {
			live.accepted.reject(lostInputError);
			live.done.reject(lostInputError);
		}
		this.live.clear();
	}

	/** Settle the client inputs this runtime admitted once the conversation stopped for disposal. */
	settleOnDisposal(): void {
		const disposalError = new Error("Session disposed before client input completed");
		for (const [clientMessageId, live] of this.live) {
			// A local run the disposal cancels ends quietly, as does a delivered input; an undelivered identified input reports it.
			if (
				live.local ||
				this.host.conversation().state.clientInputs.inputs.get(clientMessageId)?.state === "completed"
			) {
				live.accepted.resolve("admitted");
				live.done.resolve();
				continue;
			}
			live.accepted.reject(disposalError);
			live.done.reject(disposalError);
		}
		this.live.clear();
	}

	/** A client input as the conversation admits it, normalized like the session log stores it. */
	conversationInput(
		command: ClientInputCommand,
		clientMessageId: string,
		text: string,
		images: readonly ImageContent[] | undefined,
		streamingBehavior?: "steer" | "followUp",
	): ConversationInput {
		const payload = normalizeClientInputPayload(command, {
			message: text,
			...(images === undefined ? {} : { images }),
			...(streamingBehavior === undefined ? {} : { streamingBehavior }),
		});
		return {
			clientMessageId,
			message: payload.message,
			images: payload.images,
			...(payload.streamingBehavior === undefined ? {} : { streamingBehavior: payload.streamingBehavior }),
		};
	}

	createLive(command: ClientInputCommand, input: ConversationInput, local = false): LiveClientInput {
		const live: LiveClientInput = {
			command,
			input,
			accepted: Promise.withResolvers<PromptAdmissionOutcome>(),
			done: Promise.withResolvers<void>(),
			operationId: undefined,
			local,
		};
		void live.accepted.promise.catch(() => {});
		void live.done.promise.catch(() => {});
		return live;
	}

	/** Map a conversation's input errors to the session's. */
	inputError(error: unknown): Error {
		if (error instanceof ConversationError && error.code === "client_input_conflict") {
			return new ClientInputConflictError(`client_input_conflict: ${error.message}`);
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	/**
	 * The outcome of an identified input an earlier admission already recorded,
	 * when this runtime holds no live admission of it: completed, still queued
	 * (`admitted`), or an error. Undefined for a new input.
	 */
	async existing(command: ClientInputCommand, input: ConversationInput): Promise<PromptAdmissionOutcome | undefined> {
		const clientMessageId = input.clientMessageId;
		if (clientMessageId === undefined) return undefined;
		const record = this.host.conversation().state.clientInputs.inputs.get(clientMessageId);
		if (!record) return undefined;
		const digest = await clientInputDigest(command, {
			message: input.message,
			images: [...(input.images ?? [])],
			...(input.streamingBehavior === undefined ? {} : { streamingBehavior: input.streamingBehavior }),
		});
		if (record.command !== command || record.origin !== undefined || record.semanticDigest !== digest) {
			throw new ClientInputConflictError(
				`client_input_conflict: ${JSON.stringify(clientMessageId)} was already used for different input`,
			);
		}
		switch (record.state) {
			case "completed":
				return "completed";
			case "failed":
				throw new Error(record.error ?? "client_input_failed: the original input failed before commit");
			case "withdrawn":
				throw new Error("client_input_failed: queued input was cleared before canonical consumption");
			case "started":
				throw new ClientInputOutcomeAmbiguousError(
					`client_input_outcome_ambiguous: ${JSON.stringify(clientMessageId)} started before the host restarted but has no durable terminal record; it was not replayed`,
				);
			case "accepted": {
				// A queued input is delivered in order.
				if (record.queuedInput) return "admitted";
				// An earlier runtime admitted it and stopped before any side effect or delivery.
				const error = new Error(
					"client_input_failed: the input was interrupted before it was delivered; submit it again",
				);
				await this.host.conversation().settleClientInput(clientMessageId, {
					state: "failed",
					error: boundClientInputError(error.message),
				});
				throw error;
			}
		}
	}

	/**
	 * Admit an identified prompt before its preflight: a durable receipt that a
	 * retry with the same identity joins, conflicts with, or reads the outcome
	 * of. The input stays undelivered until the prompt delivers or settles it.
	 */
	async admit(
		input: ConversationInput,
	): Promise<
		{ kind: "completed" } | { kind: "live"; live: LiveClientInput } | { kind: "start"; live: LiveClientInput }
	> {
		const clientMessageId = input.clientMessageId!;
		const join = (live: LiveClientInput): { kind: "live"; live: LiveClientInput } => {
			if (live.command !== "prompt" || !isDeepStrictEqual(live.input, input)) {
				throw new ClientInputConflictError(
					`client_input_conflict: ${JSON.stringify(clientMessageId)} was already used for different input`,
				);
			}
			return { kind: "live", live };
		};
		const live = this.live.get(clientMessageId);
		if (live) return join(live);
		const abortGeneration = this.host.abortGeneration();
		const existing = await this.existing("prompt", input);
		// A duplicate whose admission started while this one checked the log is joined.
		const concurrent = this.live.get(clientMessageId);
		if (concurrent) return join(concurrent);
		if (existing === "completed") return { kind: "completed" };
		if (existing === "admitted") {
			const queued = this.createLive("prompt", input);
			queued.accepted.resolve("admitted");
			queued.done.resolve();
			return { kind: "live", live: queued };
		}
		// Registered before the receipt commits, so a retry meanwhile joins it.
		const started = this.createLive("prompt", input);
		this.live.set(clientMessageId, started);
		try {
			await this.host.conversation().admitInput("prompt", input, { deliver: false });
			if (this.host.isDisposed()) throw new Error("Session disposed before client input admission completed");
			if (abortGeneration !== this.host.abortGeneration()) {
				throw new Error("Client input admission was aborted before its receipt became durable");
			}
		} catch (error) {
			const admissionError = this.inputError(error);
			if (this.live.get(clientMessageId) === started) {
				await this.fail(clientMessageId, admissionError);
			}
			started.accepted.reject(admissionError);
			started.done.reject(admissionError);
			throw admissionError;
		}
		return { kind: "start", live: started };
	}

	/**
	 * Record that an identified input reached a side-effect boundary (an
	 * extension command, input hook, or `before_agent_start`): after a restart
	 * it is ambiguous and never run again.
	 */
	async markStarted(clientMessageId: string | undefined, abortGeneration: number): Promise<void> {
		if (clientMessageId === undefined) return;
		if (this.host.isDisposed()) throw new Error("Session disposed before client input dispatch");
		if (abortGeneration !== this.host.abortGeneration()) {
			throw new Error("Client input was aborted before its dispatch boundary");
		}
		if (this.host.conversation().state.clientInputs.inputs.get(clientMessageId)?.state !== "accepted") return;
		await this.host.conversation().markInputStarted(clientMessageId);
		if (this.host.isDisposed()) throw new Error("Session disposed before client input dispatch");
		if (abortGeneration !== this.host.abortGeneration()) {
			throw new Error("Client input was aborted while persisting its dispatch boundary");
		}
	}

	complete(clientMessageId: string, outcome: PromptAdmissionOutcome): void {
		const live = this.live.get(clientMessageId);
		if (!live) return;
		this.live.delete(clientMessageId);
		live.accepted.resolve(outcome);
		live.done.resolve();
	}

	observeLivePrompt(
		live: LiveClientInput,
		preflightResult: ((result: PromptPreflightResult) => void) | undefined,
	): Promise<void> {
		void live.accepted.promise.then(
			(outcome) => preflightResult?.({ success: true, outcome }),
			() => preflightResult?.({ success: false }),
		);
		return live.accepted.promise.then(() => live.done.promise);
	}

	/**
	 * Replays recoverable queued client input after the runtime is fully ready:
	 * one turn delivers the recovered steering input, then the follow-ups, in
	 * their admission order. Interrupted provider/tool work is never resumed. A
	 * started input without an outcome blocks the replay as ambiguous. Finding
	 * discussions never replay: their interrupted inputs fail.
	 */
	resumeRecovered(): Promise<void> {
		this.host.assertActive();
		if (this.resumePromise) {
			return this.resumePromise;
		}
		if (this.host.isBusy() || this.host.isDisposed()) {
			return Promise.reject(new Error("Cannot resume recovered client input while the agent runtime is busy"));
		}
		if (!this.host.admissionGate.isOpen) {
			return Promise.reject(new Error("Operation admission is suspended"));
		}
		const abortGeneration = this.host.abortGeneration();
		if (this.host.isReviewDiscussion()) this.recoveredReplayPending = true;
		const resume = (async () => {
			if (this.host.isDisposed() || abortGeneration !== this.host.abortGeneration()) {
				throw new Error("Recovered client input resume was aborted before it started");
			}
			const conversation = this.host.conversation();
			if (this.host.isReviewDiscussion()) {
				const interrupted = [...conversation.state.clientInputs.inputs.values()].filter(
					(record) => record.state === "accepted" || record.state === "started",
				);
				for (const record of interrupted) {
					await conversation.settleClientInput(record.clientMessageId, {
						state: "failed",
						error: "Review discussion interrupted; submit a new prompt to retry explicitly.",
					});
					this.host.assertActive();
					if (abortGeneration !== this.host.abortGeneration()) throw new Error("Review recovery was aborted");
				}
				this.recoveredReplayPending = false;
				return;
			}
			const recovery = clientInputRecovery(conversation.state);
			if (recovery.kind === "blocked") {
				this.recoveredReplayPending = true;
				throw this.ambiguousRecoveredError(recovery.blocker.clientMessageId);
			}
			if (recovery.kind === "idle") {
				this.recoveredReplayPending = false;
				return;
			}
			const replay = conversation.continue();
			const operationId = conversation.operation?.id;
			await replay;
			await conversation.waitForIdle();
			// A hook that failed the replayed delivery reports to the resume caller.
			const fatalError = operationId === undefined ? undefined : this.host.events().turnFatalError(operationId);
			if (fatalError) throw fatalError;
			const remaining = clientInputRecovery(conversation.state);
			this.recoveredReplayPending = remaining.kind !== "idle";
			if (remaining.kind === "blocked") {
				throw this.ambiguousRecoveredError(remaining.blocker.clientMessageId);
			}
			if (remaining.kind === "replay") {
				throw new Error("Recovered client input stopped before the durable queue fully drained");
			}
		})();
		const tracked = this.host.trackAncillaryWork(resume);
		this.resumePromise = tracked;
		void tracked.catch(() => {
			if (this.resumePromise === tracked) {
				this.resumePromise = undefined;
			}
		});
		return tracked;
	}

	assertRecoveredOrdering(clientMessageId: string | undefined): void {
		if (!this.recoveredReplayPending) return;
		if (this.host.isReviewDiscussion() && this.resumePromise) {
			throw new Error("Review discussion input recovery must settle before another prompt is admitted");
		}
		const recovery = clientInputRecovery(this.host.conversation().state);
		if (recovery.kind === "idle") {
			// Queue cancellation/terminalization is authoritative and releases the
			// fence even after a previous replay attempt failed.
			this.recoveredReplayPending = false;
			return;
		}
		// Idempotent retries for an already-restored receipt may still join/replay
		// their original outcome. Only a distinct input could overtake the queue.
		if (
			clientMessageId !== undefined &&
			(recovery.records.some((record) => record.clientMessageId === clientMessageId) ||
				(recovery.kind === "blocked" && recovery.blocker.clientMessageId === clientMessageId))
		) {
			return;
		}
		if (recovery.kind === "blocked") {
			throw new Error(
				`Ambiguous recovered client input ${JSON.stringify(recovery.blocker.clientMessageId)} must be resolved before later or fresh input can be admitted`,
			);
		}
		throw new Error("Recovered client input must finish replaying before fresh input can be admitted");
	}
}

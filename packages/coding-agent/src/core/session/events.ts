/**
 * The session's events ({@link SessionEvents}): publication to session
 * observers, the conversation's events mapped onto the session's runtime
 * projection (streaming message, pending tool executions, run timing), the
 * extension hooks of loop events, and turn settlement. A turn that ends
 * fails the inputs it never delivered, with the fatal error a hook recorded
 * for it or the delivery a message hook rejected.
 */

import type {
	AgentAbortSource,
	AgentEvent,
	AgentMessage,
	AgentTool,
	Conversation,
	ConversationEvent,
	ConversationPhase,
	PendingToolExecution,
} from "@hansjm10/volt-agent-core";
import type { JsonValue } from "@hansjm10/volt-ai";
import type { ActiveAgentRun, AgentSessionEvent, AgentSessionEventListener } from "../agent-session.ts";
import type { BackgroundJobDiagnostics } from "../background-job-diagnostics.ts";
import type { BackgroundJobManager } from "../background-jobs.ts";
import { cloneCanonicalData } from "../canonical-data.ts";
import type {
	ExtensionRunner,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../extensions/index.ts";
import type { GitContextProvider } from "../git-context-provider.ts";
import { getClientMessageId } from "../messages.ts";
import type { ToolProgressDiagnostics } from "../tool-progress-diagnostics.ts";
import type { SessionBackgroundContinuation } from "./background-continuation.ts";
import type { SessionBash } from "./bash.ts";
import type { SessionClientInputs } from "./client-inputs.ts";
import type { SessionCompaction } from "./compaction.ts";
import type { SessionExtensionServices } from "./extension-services.ts";
import type { SessionPromptCache } from "./prompt-cache.ts";
import type { SessionPrompting } from "./prompting.ts";
import type { SessionRetry } from "./retry-policy.ts";
import { extractUserMessageText, type SessionInfo } from "./session-info.ts";
import type { SessionTurnPolicy } from "./turn-policy.ts";

function isAgentEvent(event: { type: string }): event is AgentEvent {
	return (
		event.type === "agent_start" ||
		event.type === "agent_end" ||
		event.type === "delivery_start" ||
		event.type === "turn_start" ||
		event.type === "turn_end" ||
		event.type === "message_start" ||
		event.type === "message_update" ||
		event.type === "message_end" ||
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	);
}

export interface SessionEventsHost {
	readonly gitContextProvider: GitContextProvider;
	readonly toolProgressDiagnostics: ToolProgressDiagnostics;
	readonly backgroundDiagnostics: BackgroundJobDiagnostics;
	readonly backgroundJobs: BackgroundJobManager;
	readonly retry: SessionRetry;
	conversation(): Conversation<AgentTool>;
	extensionRunner(): ExtensionRunner;
	extensionServices(): SessionExtensionServices;
	background(): SessionBackgroundContinuation;
	promptCache(): SessionPromptCache;
	turnPolicy(): SessionTurnPolicy;
	bash(): SessionBash;
	sessionInfo(): SessionInfo;
	clientInputs(): SessionClientInputs;
	prompting(): SessionPrompting;
	compaction(): SessionCompaction;
	isDisposed(): boolean;
	/** Whether the session lost its log. */
	isLost(): boolean;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	/** An `isBusy` or `hasBackgroundJobs` input changed. */
	activityChanged(): void;
	/** Admitted work began or settled. */
	bumpActivityRevision(): void;
	/** The session lost its log. */
	lose(error: Error): void;
	/** A branch-local mutation lease: throws once the branch generation changed. */
	captureGenerationAssertion(): () => void;
}

export class SessionEvents {
	private readonly host: SessionEventsHost;
	private listeners: AgentSessionEventListener[] = [];
	private readonly listenerGitObservations = new Set<() => void>();
	private streaming: AgentMessage | undefined;
	private readonly toolExecutions = new Map<string, PendingToolExecution>();
	private errorMessage: string | undefined;
	/** When the active operation's abort source was first observed, for diagnostics. */
	private abortObserved: { operationId: string; timestamp: number } | undefined;
	private turnIndex = 0;
	/** Per-run identity for background waits and provider-result acknowledgement fences. */
	private run: ActiveAgentRun | undefined = undefined;
	/** Public elapsed timing spans every run and recovery phase before operation settlement. */
	private operation: ActiveAgentRun | undefined = undefined;
	/** The exclusive operation the conversation last published. */
	private phase: ConversationPhase["operation"] = null;
	/** Distinguishes handler-owned prompts that already completed a custom turn. */
	private settlementRevisionValue = 0;
	/** Inputs whose delivery an extension message hook rejected; they fail when their turn ends. */
	private readonly failedDeliveryInputs = new Map<string, Error>();
	/** Fatal host errors extension hooks raised, by the turn operation they ran in; its prompt rejects with it. */
	private readonly turnFatalErrors = new Map<string, Error>();

	constructor(host: SessionEventsHost) {
		this.host = host;
	}

	/** The message the running turn is streaming. */
	get streamingMessage(): AgentMessage | undefined {
		return this.streaming;
	}

	/** The running turn's tool executions, by tool call. */
	get pendingToolExecutions(): ReadonlyMap<string, PendingToolExecution> {
		return this.toolExecutions;
	}

	/** The error of the last turn that ended with one. */
	get runtimeErrorMessage(): string | undefined {
		return this.errorMessage;
	}

	/** The running agent run. */
	get activeAgentRun(): ActiveAgentRun | undefined {
		return this.run;
	}

	/** The logical operation's timing, retained through recovery until settlement. */
	get activeAgentOperation(): ActiveAgentRun | undefined {
		return this.operation;
	}

	/** The exclusive operation the conversation last published. */
	get phaseOperation(): ConversationPhase["operation"] {
		return this.phase;
	}

	/** Changes whenever the session publishes `agent_settled`. */
	get settlementRevision(): number {
		return this.settlementRevisionValue;
	}

	/** The fatal hook error recorded for a turn operation. */
	turnFatalError(operationId: string): Error | undefined {
		return this.turnFatalErrors.get(operationId);
	}

	/** A delivered input whose message hook failed: it fails when its turn ends. */
	failDelivery(clientMessageId: string, error: Error): void {
		this.failedDeliveryInputs.set(clientMessageId, error);
	}

	/** The disposal fence: the session reports no running operation. */
	endOperation(): void {
		this.operation = undefined;
	}

	/** The disposal fence: the session reports no streaming message or tool executions. */
	clearStreamingState(): void {
		this.streaming = undefined;
		this.toolExecutions.clear();
	}

	private reportProjectionFailure(eventType: AgentSessionEvent["type"], error: unknown): void {
		try {
			this.host.extensionRunner()?.emitError({
				extensionPath: "<runtime>",
				event: "session_event_projection",
				error: `Could not project AgentSession ${eventType} event: ${error instanceof Error ? error.message : String(error)}`,
				...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
			});
		} catch {
			// Runtime diagnostics are passive. Their observers cannot alter an
			// already-committed session outcome or revive an invalid projection.
		}
	}

	/** The active operation's abort source, for tool progress diagnostics. */
	private diagnosticRun(): { source?: AgentAbortSource; diagnosticTimestamp?: number } | undefined {
		const operation = this.host.conversation()?.operation;
		if (operation?.abortSource === undefined) return undefined;
		if (this.abortObserved?.operationId !== operation.id) {
			this.abortObserved = { operationId: operation.id, timestamp: Date.now() };
		}
		return { source: operation.abortSource, diagnosticTimestamp: this.abortObserved.timestamp };
	}

	/** Publish an isolated passive projection to every public session observer. */
	emit(event: AgentSessionEvent): void {
		if (this.host.isLost()) return;
		if (isAgentEvent(event)) {
			try {
				this.host.toolProgressDiagnostics.observe(event, this.diagnosticRun());
			} catch {
				// Diagnostics are passive and cannot change the session outcome.
			}
		}
		if (event.type === "agent_start" || event.type === "agent_end") {
			this.host.background().recordRunDiagnostic(event.type === "agent_start" ? "run_start" : "run_end");
		} else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			this.host.background().recordDiagnostic({
				kind: event.type === "tool_execution_start" ? "tool_start" : "tool_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
			});
		}
		if (event.type === "tool_execution_end" || event.type === "agent_settled") {
			this.host.gitContextProvider.scheduleRefresh();
		}
		if (event.type === "agent_settled") this.host.backgroundDiagnostics.flush();
		this.dispatch(event);
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.host.promptCache().requestStarted(event.message);
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			this.host.promptCache().requestEnded(event.message);
		}
		if (
			event.type === "agent_start" ||
			event.type === "agent_settled" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end" ||
			event.type === "tool_execution_start"
		) {
			this.host.activityChanged();
		}
		if (event.type === "agent_settled" || event.type === "compaction_end") this.host.promptCache().publish();
	}

	private dispatch(event: AgentSessionEvent): void {
		const listeners = [...this.listeners];
		const description = `AgentSession ${event.type} event`;
		let canonicalEvent: AgentSessionEvent;
		try {
			canonicalEvent = cloneCanonicalData(event, description);
		} catch (error) {
			this.reportProjectionFailure(event.type, error);
			return;
		}

		for (const listener of listeners) {
			let snapshot: AgentSessionEvent;
			try {
				snapshot = cloneCanonicalData(canonicalEvent, description);
			} catch (error) {
				this.reportProjectionFailure(event.type, error);
				continue;
			}
			try {
				void Promise.resolve(listener(snapshot)).catch(() => {});
			} catch {
				// Public subscribers are passive projections. Their failure or mutation
				// cannot alter session state or suppress a later subscriber.
			}
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener, options: { monitorGitContext?: boolean } = {}): () => void {
		this.listeners.push(listener);
		const releaseGitObservation =
			options.monitorGitContext === false ? undefined : this.host.gitContextProvider.retainObservation();
		if (releaseGitObservation) this.listenerGitObservations.add(releaseGitObservation);
		let unsubscribed = false;

		// Return unsubscribe function for this specific listener
		return () => {
			if (unsubscribed) return;
			unsubscribed = true;
			const index = this.listeners.indexOf(listener);
			if (index !== -1) {
				this.listeners.splice(index, 1);
			}
			if (releaseGitObservation) {
				this.listenerGitObservations.delete(releaseGitObservation);
				releaseGitObservation();
			}
		};
	}

	/** Release the git context observations session observers retained. */
	releaseGitObservations(): void {
		for (const releaseObservation of this.listenerGitObservations) releaseObservation();
		this.listenerGitObservations.clear();
	}

	/** Drop every session observer. */
	clearListeners(): void {
		this.listeners = [];
	}

	subscribeRuntimeEvents(listener: (event: AgentEvent) => Promise<void> | void): () => void {
		return this.host.conversation().subscribe(async (event) => {
			if (!isAgentEvent(event)) return;
			const { basedOn: _basedOn, ...agentEvent } = event;
			await listener(agentEvent as AgentEvent);
		});
	}

	/** Every conversation event, in publication order. */
	async onConversationEvent(event: ConversationEvent): Promise<void> {
		if (this.host.isDisposed()) return;
		switch (event.type) {
			case "committed":
				// The session manager's view already includes the batch. A client input's
				// state can change the queue without the conversation's queue changing.
				if (event.entries.some((entry) => entry.type.startsWith("client_input_"))) {
					this.host.clientInputs().publishQueue();
				}
				return;
			case "queue_changed":
				this.host.backgroundJobs.setSteeringPending(event.queue.steer.length > 0);
				this.host.clientInputs().publishQueue();
				return;
			case "phase_changed":
				await this.onPhaseChanged(event.phase);
				return;
			case "next_action_resolved":
				if (event.stopReason === "policy" || event.stopReason === "tool")
					this.host.extensionServices().invalidate();
				this.host.background().nextActionResolved(event);
				return;
			case "retry_start":
				this.host.retry.started(event);
				return;
			case "retry_end":
				this.host.retry.ended(event);
				return;
			case "compaction_start":
				this.host.compaction().started(event.cause);
				return;
			case "compaction_end":
				await this.host.compaction().ended(event.cause, event.status, event.error);
				return;
			case "ended":
				// Only the session's own disposal closes its log; any other end loses it.
				if (event.reason !== "closed" || !this.host.isDisposed()) this.host.lose(event.error);
				return;
			default: {
				const { basedOn: _basedOn, ...agentEvent } = event;
				await this.handleAgentEvent(agentEvent as AgentEvent);
			}
		}
	}

	/** The conversation's operation changed; a turn that ended settles here. */
	private async onPhaseChanged(phase: ConversationPhase): Promise<void> {
		const previous = this.phase;
		this.phase = phase.operation;
		this.host.bumpActivityRevision();
		if (previous === "turn" && phase.operation !== "turn") await this.settleTurn();
		if (phase.operation === null) this.host.prompting().clearTurnSystemPrompts();
		this.host.activityChanged();
	}

	/**
	 * A turn operation ended: inputs it reserved but never delivered fail,
	 * deferred bash output commits, and a turn that ran publishes
	 * `agent_settled`.
	 */
	private async settleTurn(): Promise<void> {
		const ran = this.operation !== undefined;
		this.run = undefined;
		this.operation = undefined;
		this.streaming = undefined;
		this.toolExecutions.clear();
		this.host.retry.reset();
		if (this.host.isLost()) return;
		for (const [clientMessageId, error] of [...this.failedDeliveryInputs]) {
			this.failedDeliveryInputs.delete(clientMessageId);
			await this.host.clientInputs().fail(clientMessageId, error);
		}
		this.host.prompting().pruneSettledExtensionInputs();
		const activeOperationId = this.host.conversation().operation?.id;
		for (const [clientMessageId, live] of [...this.host.clientInputs().live]) {
			// An input its turn ended without delivering: nothing else will.
			const state = this.host.conversation().state.clientInputs.inputs.get(clientMessageId)?.state;
			if (live.operationId === undefined || live.operationId === activeOperationId) continue;
			if (state !== "accepted" && state !== "started") continue;
			// A hook that failed the turn fails its input; otherwise the turn stopped before delivering it.
			const fatalError = this.turnFatalErrors.get(live.operationId);
			await this.host
				.clientInputs()
				.fail(
					clientMessageId,
					fatalError ?? new Error("Client input stopped before its canonical user message committed"),
					fatalError === undefined,
				);
		}
		try {
			await this.host.bash().flushPending();
		} catch {
			// Deferred bash output is best-effort once its turn ended.
		}
		if (!ran || this.host.isDisposed()) return;
		this.host.extensionServices().invalidate();
		this.settlementRevisionValue += 1;
		this.emit({ type: "agent_settled" });
		this.host.background().schedule();
	}

	/** A handled command or input hook ran no turn: publish the settlement a turn would have. */
	emitHandledSettlement(): void {
		if (this.host.conversation().operation !== undefined) return;
		this.host.extensionServices().invalidate();
		this.settlementRevisionValue += 1;
		this.emit({ type: "agent_settled" });
		this.host.background().schedule();
	}

	/** A loop event of the active turn, after its messages committed. */
	private async handleAgentEvent(event: AgentEvent): Promise<void> {
		if (this.host.isDisposed()) return;
		if (event.type === "agent_start") {
			this.errorMessage = undefined;
			this.host.retry.runStarted();
			this.run = { startedAt: Date.now() };
			this.operation ??= { ...this.run };
		}
		if (event.type === "agent_end") {
			// Aborted tool calls can skip afterToolCall, leaving their plan-mode
			// authorization records behind; no record outlives its run.
			this.host.turnPolicy().clearRunRecords();
			this.host.background().clearRunRecords();
		}
		if (event.type === "turn_start") this.host.compaction().recordRequest(this.host.conversation().operation?.id);
		if (this.host.isLost()) return;

		// Delivered messages ran their extension message hooks as they were prepared.
		const delivered = "deliveryId" in event && event.deliveryId !== undefined;
		if (!delivered && event.type !== "message_end" && event.type !== "delivery_start") {
			await this.emitExtensionEvent(event);
			if (this.host.isDisposed() || this.host.isLost()) return;
		}

		if (event.type === "message_start" || event.type === "message_update") {
			this.streaming = event.message;
		} else if (event.type === "message_end") {
			this.streaming = undefined;
		} else if (event.type === "tool_execution_start") {
			this.toolExecutions.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
		} else if (event.type === "tool_execution_update") {
			const existing = this.toolExecutions.get(event.toolCallId);
			const details = (event.partialResult as { details?: unknown } | undefined)?.details;
			if (existing && details !== undefined) {
				this.toolExecutions.set(event.toolCallId, {
					...existing,
					latestDetails: details as JsonValue,
				});
			}
		} else if (event.type === "tool_execution_end") {
			this.toolExecutions.delete(event.toolCallId);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && event.message.error) {
				this.errorMessage = event.message.error.message;
			}
		} else if (event.type === "agent_end") {
			this.streaming = undefined;
			this.toolExecutions.clear();
		}

		// Every continuation carries the original operation timestamp so remote
		// clients retain elapsed time across recovery and delayed delivery.
		if (event.type === "agent_start") {
			this.emit({ type: "agent_start", startedAt: this.operation!.startedAt });
		} else if (event.type === "agent_end") {
			const willRetry = this.host.retry.takeScheduled();
			this.emit({ ...event, willRetry });
			this.run = undefined;
		} else {
			this.emit(event);
		}

		if (event.type === "delivery_start") {
			const userMessage = event.messages.find((message) => message.role === "user");
			if (userMessage) {
				// Admitted user input independently authorizes this request even if its wake job is cancelled.
				this.host.background().userInputDelivered();
				this.host
					.sessionInfo()
					.maybeGenerateName(extractUserMessageText(userMessage.content), this.host.captureGenerationAssertion());
			}
		}
		if (event.type === "message_end" && delivered) {
			this.host.background().acknowledgeDeliveredNotice(event.message);
			const clientMessageId = getClientMessageId(event.message);
			if (clientMessageId !== undefined)
				this.host.clientInputs().live.get(clientMessageId)?.accepted.resolve("admitted");
		}
	}

	/** Emit extension events based on agent events */
	async emitExtensionEvent(event: AgentEvent): Promise<AgentMessage | undefined> {
		this.host.assertActive();
		const extensionRunner = this.host.extensionRunner();
		if (event.type === "agent_start") {
			this.turnIndex = 0;
			await extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.turnIndex,
				timestamp: Date.now(),
			};
			await extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await extensionRunner.emit(extensionEvent);
			this.turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: cloneCanonicalData(event.message, "Extension message_start input"),
			};
			await extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent = cloneCanonicalData(
				{
					type: "message_update" as const,
					message: event.message,
					assistantMessageEvent: event.assistantMessageEvent,
				} satisfies MessageUpdateEvent,
				"Extension message_update input",
			);
			await extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const message = cloneCanonicalData(event.message, `Agent ${event.message.role} message`);
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message,
			};
			const replacement = await extensionRunner.emitMessageEnd(extensionEvent);
			return replacement ?? message;
		} else if (event.type === "tool_execution_start") {
			const extensionEvent = cloneCanonicalData(
				{
					type: "tool_execution_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				} as const,
				"Extension tool_execution_start input",
			) as ToolExecutionStartEvent;
			await extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent = cloneCanonicalData(
				{
					type: "tool_execution_update",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					partialResult: event.partialResult,
				} as const,
				"Extension tool_execution_update input",
			) as ToolExecutionUpdateEvent;
			await extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent = cloneCanonicalData(
				{
					type: "tool_execution_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				} as const,
				"Extension tool_execution_end input",
			) as ToolExecutionEndEvent;
			await extensionRunner.emit(extensionEvent);
		}
		return undefined;
	}

	/** Record the first fatal hook error of the running turn; a few recent turns are kept. */
	recordTurnFatalError(error: Error): void {
		const operationId = this.host.conversation().operation?.id;
		if (operationId === undefined || this.turnFatalErrors.has(operationId)) return;
		this.turnFatalErrors.set(operationId, error);
		const oldest = this.turnFatalErrors.keys().next().value;
		if (this.turnFatalErrors.size > 16 && oldest !== undefined) this.turnFatalErrors.delete(oldest);
	}
}

/**
 * Automatic retry of failed provider requests: which failures retry, the
 * backoff before each attempt, and the context a retried request is built
 * from, as pure functions of their inputs; and the session's retry state
 * while a turn retries ({@link SessionRetry}).
 */

import type { AgentMessage, AgentTool, Conversation, ConversationEvent } from "@hansjm10/volt-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageDiagnostic,
	createRejectedToolCallFeedback,
	isContextOverflow,
	type Model,
} from "@hansjm10/volt-ai";
import type { AgentSessionEvent } from "../agent-session.ts";
import type { SettingsManager } from "../settings-manager.ts";

export interface RetrySettings {
	readonly enabled: boolean;
	/** Retries after the first failure; attempt numbers run from 1 to this. */
	readonly maxRetries: number;
	/** Backoff before the first retry; each later retry waits twice as long. */
	readonly baseDelayMs: number;
}

/** Local stream limits and processing failures: a new attempt would repeat them unchanged. */
const NON_RETRYABLE_STREAM_DIAGNOSTICS: ReadonlySet<string> = new Set([
	"tool_argument_generation_limit",
	"assistant_stream_queue_limit",
	"assistant_stream_processing_error",
]);

export function hasLocalStreamFailure(diagnostics?: readonly AssistantMessageDiagnostic[]): boolean {
	return diagnostics?.some((diagnostic) => NON_RETRYABLE_STREAM_DIAGNOSTICS.has(diagnostic.type)) === true;
}

/**
 * Whether a response failed only because its tool calls were rejected before execution. Unlike a
 * transient failure, repeating the request would not help; a new attempt must carry the rejection
 * feedback so the model can correct its arguments.
 */
export function isRejectedToolCallResponse(diagnostics?: readonly AssistantMessageDiagnostic[]): boolean {
	return (
		diagnostics?.some((diagnostic) => diagnostic.type === "invalid_tool_arguments") === true &&
		!hasLocalStreamFailure(diagnostics)
	);
}

/**
 * Whether a failed response retries: provider failures classified as retryable (rate limits, overload,
 * server, network, and timeout errors) or tool calls rejected before execution, which retry with
 * feedback explaining the rejection. Context overflow is never retryable; compaction handles it, and
 * a local stream limit or processing failure would repeat unchanged.
 */
export function isRetryableError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.error || hasLocalStreamFailure(message.diagnostics)) return false;
	return message.error.retryable || isRejectedToolCallResponse(message.diagnostics);
}

/**
 * The backoff before retry `attempt` (counting from 1) of the request that
 * produced `message`, or undefined when it does not retry. Exponential from
 * `baseDelayMs`; a rejected tool call retries at once, since feedback, not
 * waiting, corrects it.
 */
export function retryDelayMs(message: AssistantMessage, attempt: number, settings: RetrySettings): number | undefined {
	if (!settings.enabled || attempt > settings.maxRetries || !isRetryableError(message)) return undefined;
	return isRejectedToolCallResponse(message.diagnostics) ? 0 : settings.baseDelayMs * 2 ** (attempt - 1);
}

/**
 * Whether a run whose messages end with `messages` retries after `attempts`
 * retries already ran: its last response must be retryable, and must not
 * report a failed delivery transaction.
 */
export function willRetryAfterRun(
	messages: readonly AgentMessage[],
	attempts: number,
	settings: RetrySettings,
): boolean {
	if (!settings.enabled || attempts >= settings.maxRetries) return false;
	const last = messages.findLast((message) => message.role === "assistant");
	if (last?.role !== "assistant") return false;
	if (last.diagnostics?.some((diagnostic) => diagnostic.type === "delivery_transaction_failure")) return false;
	return isRetryableError(last);
}

/**
 * The context a retried request is built from. Trailing failed responses
 * stay in history but leave the request; a rejected tool call is replaced by
 * the feedback provider replay shows, so the model can correct it.
 */
export function retryContextMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	let end = messages.length;
	while (end > 0) {
		const candidate = messages[end - 1];
		if (candidate?.role !== "assistant" || candidate.stopReason !== "error") break;
		end--;
	}
	const feedback = messages.slice(end).flatMap((failed) => {
		const note = failed.role === "assistant" ? createRejectedToolCallFeedback(failed) : undefined;
		return note ? [note] : [];
	});
	return [...messages.slice(0, end), ...feedback];
}

export interface SessionRetryHost {
	readonly settingsManager: SettingsManager;
	conversation(): Conversation<AgentTool>;
	/** The model the active branch names. */
	model(): Model<Api> | undefined;
	/** The turn operation that compacted to recover from a context overflow. */
	overflowRecoveredOperationId(): string | undefined;
	emit(event: AgentSessionEvent): void;
}

/**
 * The session's retry state: the retry policy the conversation consults, the
 * retry it scheduled, and the backoff that runs until the retried request.
 * The conversation's retry events are published as `auto_retry_*`.
 */
export class SessionRetry {
	private readonly host: SessionRetryHost;
	/** The retry policy scheduled a retry of the turn's last failed request. */
	private scheduled = false;
	private currentAttempt = 0;
	/** Between a retry's start and its request: the backoff is running. */
	private retrying = false;

	constructor(host: SessionRetryHost) {
		this.host = host;
	}

	/** Current retry attempt (0 if not retrying) */
	get attempt(): number {
		return this.currentAttempt;
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this.retrying;
	}

	/**
	 * The retry policy: the backoff before the turn retries its failed request,
	 * or undefined to stop. Retries run inside the turn, so nothing else is
	 * admitted between a failure and its retry. An overflow the turn already
	 * compacted for once is reported as exhausted recovery.
	 */
	delay(message: AssistantMessage, attempt: number): number | undefined {
		const operationId = this.host.conversation().operation?.id;
		const model = this.host.model();
		if (
			operationId !== undefined &&
			this.host.overflowRecoveredOperationId() === operationId &&
			model !== undefined &&
			message.provider === model.provider &&
			message.model === model.id &&
			isContextOverflow(message, model.contextWindow)
		) {
			this.host.emit({
				type: "compaction_end",
				reason: "overflow",
				aborted: false,
				willRetry: false,
				errorMessage:
					"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
			});
		}
		const delayMs = retryDelayMs(message, attempt, this.host.settingsManager.getRetrySettings());
		this.scheduled = delayMs !== undefined;
		return delayMs;
	}

	/** The conversation started a retry: its backoff runs. */
	started(event: Extract<ConversationEvent, { type: "retry_start" }>): void {
		this.scheduled = false;
		this.retrying = true;
		this.currentAttempt = event.attempt;
		this.host.emit({
			type: "auto_retry_start",
			attempt: event.attempt,
			maxAttempts: this.host.settingsManager.getRetrySettings().maxRetries,
			delayMs: event.delayMs,
			errorMessage: event.error.message || "Unknown error",
		});
	}

	/** The conversation's retries ended, successfully or not. */
	ended(event: Extract<ConversationEvent, { type: "retry_end" }>): void {
		this.retrying = false;
		this.currentAttempt = 0;
		this.host.emit({
			type: "auto_retry_end",
			success: event.success,
			attempt: event.attempt,
			...(event.error === undefined ? {} : { finalError: event.error }),
		});
	}

	/** A run started: the backoff before it is over. */
	runStarted(): void {
		this.retrying = false;
	}

	/** Whether the run that just ended retries; reading it consumes the schedule. */
	takeScheduled(): boolean {
		const scheduled = this.scheduled;
		this.scheduled = false;
		return scheduled;
	}

	/** The turn settled: no retry is pending or backing off. */
	reset(): void {
		this.retrying = false;
		this.scheduled = false;
	}

	/** Cancel in-progress retry: the turn waiting to retry stops. */
	abort(): void {
		if (this.retrying) this.host.conversation().abort("host_action");
	}
}

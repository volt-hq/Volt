/**
 * Automatic retry of failed provider requests: which failures retry, the
 * backoff before each attempt, and the context a retried request is built
 * from. Pure functions of their inputs.
 */

import type { AgentMessage } from "@hansjm10/volt-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageDiagnostic,
	createRejectedToolCallFeedback,
} from "@hansjm10/volt-ai";

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

import type { AssistantMessageDiagnostic } from "@hansjm10/volt-ai";

const NON_RETRYABLE_PROVIDER_LIMIT_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

const TRANSIENT_PROVIDER_ERROR_PATTERN =
	/overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
const TRANSIENT_PROVIDER_STATUS_PATTERN =
	/\b(?:http(?:\/[\d.]+)?(?:\s+status)?|status(?:\s+code)?|response\s+status|error\s+code)\s*[:=]?\s*(?:429|500|502|503|504)\b/i;

/** Local stream limits and processing failures: a new attempt would repeat them unchanged. */
const NON_RETRYABLE_STREAM_DIAGNOSTICS: ReadonlySet<string> = new Set([
	"tool_argument_generation_limit",
	"assistant_stream_queue_limit",
	"assistant_stream_processing_error",
]);

export function isNonRetryableProviderLimitError(errorMessage: string): boolean {
	return NON_RETRYABLE_PROVIDER_LIMIT_PATTERN.test(errorMessage);
}

export function isTransientProviderError(
	errorMessage: string,
	diagnostics?: readonly AssistantMessageDiagnostic[],
): boolean {
	if (diagnostics?.some((diagnostic) => NON_RETRYABLE_STREAM_DIAGNOSTICS.has(diagnostic.type))) return false;
	return (
		!diagnostics?.some((diagnostic) => diagnostic.type === "invalid_tool_arguments") &&
		!isNonRetryableProviderLimitError(errorMessage) &&
		(TRANSIENT_PROVIDER_ERROR_PATTERN.test(errorMessage) || TRANSIENT_PROVIDER_STATUS_PATTERN.test(errorMessage))
	);
}

/**
 * Whether a response failed only because its tool calls were rejected before execution. Unlike a
 * transient failure, repeating the request would not help; a new attempt must carry the rejection
 * feedback so the model can correct its arguments.
 */
export function isRejectedToolCallResponse(diagnostics?: readonly AssistantMessageDiagnostic[]): boolean {
	return (
		diagnostics?.some((diagnostic) => diagnostic.type === "invalid_tool_arguments") === true &&
		!diagnostics.some((diagnostic) => NON_RETRYABLE_STREAM_DIAGNOSTICS.has(diagnostic.type))
	);
}

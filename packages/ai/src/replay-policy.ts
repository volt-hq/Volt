import { createRejectedToolCallFeedback } from "./stream/invalid-tool-arguments.ts";
import { EMPTY_RESPONSE_CODE } from "./stream/provider-errors.ts";
import type { AssistantMessage, Message, ToolCall, UserMessage } from "./types.ts";

/**
 * Tell the model that its turn ended without content. Asking again with an unchanged request tends
 * to produce the same empty turn, so the retried request must say what went wrong.
 */
function createEmptyReplyFeedback(message: AssistantMessage): UserMessage | undefined {
	if (message.stopReason !== "error" || message.error?.providerCode !== EMPTY_RESPONSE_CODE) return undefined;
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: "Your previous response was empty, so the user received no reply. Continue from the tool results above: reply to the user now, or call a tool if more work is needed.",
			},
		],
		timestamp: message.timestamp,
	};
}

/**
 * The provider-agnostic replay policy: the messages a provider request should contain for a
 * conversation history. Apply it to the message list before streaming; providers apply only
 * model-dependent normalization (image downgrade, tool call IDs, cross-model thinking).
 *
 * - Errored and aborted assistant turns are dropped together with the results of their tool calls.
 *   They may hold partial content that providers reject on replay, and the model should retry from
 *   the last valid state. A later completed call may reuse an interrupted call's ID.
 * - A tool result is kept only when it answers a call of the completed turn directly before it that
 *   has no result yet. Any other result is dropped: providers reject a result without its call in the
 *   previous message, and a history can hold one when the turn that made the call was dropped or
 *   compacted away while the result stayed.
 * - A turn dropped because its tool call arguments were rejected is replaced by user feedback that
 *   explains why none of its tool calls ran. A turn dropped because it was empty is replaced by user
 *   feedback that asks for the missing reply.
 * - Every tool call of a completed turn gets a result: a missing one is synthesized as an error
 *   result before the next user or assistant message, or at the end.
 *
 * Pure: the input is not mutated, and the same input always yields an equal output. Retained
 * messages are returned by reference. Applying it to its own output changes nothing.
 */
export function applyReplayPolicy(messages: readonly Message[]): Message[] {
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let pendingTimestamp = 0;
	let existingToolResultIds = new Set<string>();
	const insertSyntheticToolResults = () => {
		for (const toolCall of pendingToolCalls) {
			if (existingToolResultIds.has(toolCall.id)) continue;
			result.push({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: pendingTimestamp,
			});
		}
		pendingToolCalls = [];
		existingToolResultIds = new Set();
	};

	for (const message of messages) {
		if (message.role === "assistant") {
			insertSyntheticToolResults();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const feedback = createRejectedToolCallFeedback(message) ?? createEmptyReplyFeedback(message);
				if (feedback) result.push(feedback);
				continue;
			}
			const toolCalls = message.content.filter((block) => block.type === "toolCall");
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				pendingTimestamp = message.timestamp;
				existingToolResultIds = new Set();
			}
			result.push(message);
		} else if (message.role === "toolResult") {
			const answersPendingCall =
				!existingToolResultIds.has(message.toolCallId) &&
				pendingToolCalls.some((toolCall) => toolCall.id === message.toolCallId);
			if (!answersPendingCall) continue;
			existingToolResultIds.add(message.toolCallId);
			result.push(message);
		} else {
			// A user message interrupts the tool flow: synthesize results for calls still missing one.
			insertSyntheticToolResults();
			result.push(message);
		}
	}
	insertSyntheticToolResults();
	return result;
}

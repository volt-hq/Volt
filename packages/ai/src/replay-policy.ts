import { createRejectedToolCallFeedback } from "./stream/invalid-tool-arguments.ts";
import type { Message, ToolCall } from "./types.ts";

/**
 * The provider-agnostic replay policy: the messages a provider request should contain for a
 * conversation history. Apply it to the message list before streaming; providers apply only
 * model-dependent normalization (image downgrade, tool call IDs, cross-model thinking).
 *
 * - Errored and aborted assistant turns are dropped together with the results of their tool calls.
 *   They may hold partial content that providers reject on replay, and the model should retry from
 *   the last valid state. A later completed call may reuse an interrupted call's ID.
 * - A turn dropped because its tool call arguments were rejected is replaced by user feedback that
 *   explains why none of its tool calls ran.
 * - Every tool call of a completed turn gets a result: a missing one is synthesized as an error
 *   result before the next user or assistant message, or at the end.
 *
 * Pure: the input is not mutated, and the same input always yields an equal output. Retained
 * messages are returned by reference. Applying it to its own output changes nothing.
 */
export function applyReplayPolicy(messages: readonly Message[]): Message[] {
	const result: Message[] = [];
	const omittedToolCallIds = new Set<string>();
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
				for (const block of message.content) {
					if (block.type === "toolCall") omittedToolCallIds.add(block.id);
				}
				const feedback = createRejectedToolCallFeedback(message);
				if (feedback) result.push(feedback);
				continue;
			}
			const toolCalls = message.content.filter((block) => block.type === "toolCall");
			for (const toolCall of toolCalls) omittedToolCallIds.delete(toolCall.id);
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				pendingTimestamp = message.timestamp;
				existingToolResultIds = new Set();
			}
			result.push(message);
		} else if (message.role === "toolResult") {
			if (omittedToolCallIds.has(message.toolCallId)) continue;
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

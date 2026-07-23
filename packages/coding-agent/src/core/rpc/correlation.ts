import { Buffer } from "node:buffer";
import { RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES } from "./wire-limits.ts";

export interface RpcErrorResponseTarget {
	id: string | undefined;
	command: string;
}

/**
 * Runtime mirror of RpcConversationIdentifierSchema, including its layered
 * UTF-8 byte bound.
 */
export function isUsableRpcConversationIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		Buffer.byteLength(value, "utf8") <= RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES
	);
}

/**
 * Selects the correlation target for a command-level error. A known
 * invoke_ui_action request is only correlated when its required id is usable;
 * otherwise it becomes an uncorrelated validation response and must not carry
 * the invoke_ui_action discriminator.
 */
export function getRpcErrorResponseTarget(value: unknown): RpcErrorResponseTarget {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { id: undefined, command: "unknown" };
	}
	const command = value as Record<string, unknown>;
	const type = typeof command.type === "string" ? command.type : "unknown";
	if (type === "invoke_ui_action" && !isUsableRpcConversationIdentifier(command.id)) {
		return { id: undefined, command: "invalid" };
	}
	return {
		id: typeof command.id === "string" ? command.id : undefined,
		command: type,
	};
}

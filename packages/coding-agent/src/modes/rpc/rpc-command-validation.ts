import { Buffer } from "node:buffer";
import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { ImageContent } from "@hansjm10/volt-ai";
import { RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES } from "../../core/rpc/types.ts";

export const RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES = 512 * 1024;
export const RPC_CONVERSATION_INPUT_MAX_IMAGES = 8;
export const RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES = 1024 * 1024;
export const RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES = 1536 * 1024;
export const RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

const RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES = 256;

const RPC_QUEUE_MODES = ["all", "one-at-a-time"] as const;
const RPC_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];
const RPC_STREAMING_BEHAVIORS = ["steer", "followUp"] as const;
const RPC_UI_ACTION_SCOPES = ["primary", "palette", "all"] as const;
const RPC_CONVERSATION_DISCONTINUITY_REASONS = ["cursor_gap", "assistant_position_gap", "reducer_divergence"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isMcpAuthFlow(value: unknown): value is "browser" | "device" {
	return value === "browser" || value === "device";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isSafeNonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAssistantStreamPosition(value: unknown): boolean {
	return isRecord(value) && isSafeNonnegativeInteger(value.epoch) && isSafeNonnegativeInteger(value.seq);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && allowed.some((allowedValue) => allowedValue === value);
}

function isRpcQueueMode(value: unknown): value is (typeof RPC_QUEUE_MODES)[number] {
	return isOneOf(value, RPC_QUEUE_MODES);
}

function isRpcThinkingLevel(value: unknown): value is ThinkingLevel {
	return isOneOf(value, RPC_THINKING_LEVELS);
}

function isRpcStreamingBehavior(value: unknown): value is (typeof RPC_STREAMING_BEHAVIORS)[number] {
	return isOneOf(value, RPC_STREAMING_BEHAVIORS);
}

function isRpcUiActionScope(value: unknown): value is (typeof RPC_UI_ACTION_SCOPES)[number] {
	return isOneOf(value, RPC_UI_ACTION_SCOPES);
}

function isRpcImageContent(value: unknown): value is ImageContent {
	return (
		isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
	);
}

function isRpcImageContentArray(value: unknown): value is ImageContent[] {
	return Array.isArray(value) && value.every(isRpcImageContent);
}

function isRpcLiveActivityRegistration(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.activityId === "string" &&
		typeof value.pushToken === "string" &&
		(value.tokenHash === undefined || typeof value.tokenHash === "string") &&
		(value.tokenEnvironment === undefined ||
			value.tokenEnvironment === "development" ||
			value.tokenEnvironment === "production")
	);
}

function isRpcRegisterPushTargetArgs(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.provider === "fcm" &&
		value.platform === "ios" &&
		typeof value.pushTargetId === "string" &&
		typeof value.pushTargetAuthToken === "string" &&
		typeof value.enabled === "boolean" &&
		(value.relayUrl === undefined || typeof value.relayUrl === "string") &&
		(value.tokenHash === undefined || typeof value.tokenHash === "string") &&
		(value.liveActivity === undefined || isRpcLiveActivityRegistration(value.liveActivity))
	);
}

function validateRequiredField(
	command: Record<string, unknown>,
	field: string,
	isValid: (value: unknown) => boolean,
	expected: string,
): string | undefined {
	if (command[field] === undefined) {
		return `Invalid RPC command payload: "${field}" is required`;
	}
	if (!isValid(command[field])) {
		return `Invalid RPC command payload: "${field}" must be ${expected}`;
	}
	return undefined;
}

function validateOptionalField(
	command: Record<string, unknown>,
	field: string,
	isValid: (value: unknown) => boolean,
	expected: string,
): string | undefined {
	if (command[field] !== undefined && !isValid(command[field])) {
		return `Invalid RPC command payload: "${field}" must be ${expected}`;
	}
	return undefined;
}

function validateConversationInputResourceBounds(command: Record<string, unknown>): string | undefined {
	if (typeof command.message !== "string") {
		return undefined;
	}
	const messageBytes = Buffer.byteLength(command.message, "utf8");
	if (messageBytes > RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES) {
		return `Invalid RPC command payload: "message" exceeds the ${RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES}-byte UTF-8 limit`;
	}
	if (command.images === undefined) {
		return undefined;
	}
	if (!isRpcImageContentArray(command.images)) {
		return undefined;
	}
	if (command.images.length > RPC_CONVERSATION_INPUT_MAX_IMAGES) {
		return `Invalid RPC command payload: "images" exceeds the ${RPC_CONVERSATION_INPUT_MAX_IMAGES}-image limit`;
	}
	let imagePayloadBytes = 0;
	for (let index = 0; index < command.images.length; index++) {
		const image = command.images[index]!;
		const mimeTypeBytes = Buffer.byteLength(image.mimeType, "utf8");
		if (mimeTypeBytes > RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES) {
			return `Invalid RPC command payload: "images[${index}].mimeType" exceeds the ${RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES}-byte UTF-8 limit`;
		}
		const dataBytes = Buffer.byteLength(image.data, "utf8");
		if (dataBytes > RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES) {
			return `Invalid RPC command payload: "images[${index}].data" exceeds the ${RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES}-byte UTF-8 limit`;
		}
		imagePayloadBytes += mimeTypeBytes + dataBytes;
		if (imagePayloadBytes > RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES) {
			return `Invalid RPC command payload: "images" exceeds the ${RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES}-byte UTF-8 payload limit`;
		}
	}
	const serializedBytes = Buffer.byteLength(
		JSON.stringify({ message: command.message, images: command.images }),
		"utf8",
	);
	if (serializedBytes > RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES) {
		return `Invalid RPC command payload: conversation input exceeds the ${RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES}-byte serialized limit`;
	}
	return undefined;
}

function validateConversationIdentifierResourceBound(
	command: Record<string, unknown>,
	field: string,
): string | undefined {
	const value = command[field];
	if (typeof value !== "string") return undefined;
	if (value !== value.trim()) {
		return `Invalid RPC command payload: "${field}" must not contain surrounding whitespace`;
	}
	if (Buffer.byteLength(value, "utf8") <= RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES) return undefined;
	return `Invalid RPC command payload: "${field}" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`;
}

export function validateRpcCommandPayload(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	switch (value.type) {
		case "prompt": {
			const shapeError =
				validateRequiredField(value, "clientMessageId", isNonEmptyString, "a non-empty string") ??
				validateConversationIdentifierResourceBound(value, "clientMessageId") ??
				validateRequiredField(value, "message", isString, "a string") ??
				validateOptionalField(value, "images", isRpcImageContentArray, "an array of image objects") ??
				validateOptionalField(value, "streamingBehavior", isRpcStreamingBehavior, '"steer" or "followUp"');
			return shapeError ?? validateConversationInputResourceBounds(value);
		}
		case "steer":
		case "follow_up": {
			const shapeError =
				validateRequiredField(value, "clientMessageId", isNonEmptyString, "a non-empty string") ??
				validateConversationIdentifierResourceBound(value, "clientMessageId") ??
				validateRequiredField(value, "message", isString, "a string") ??
				validateOptionalField(value, "images", isRpcImageContentArray, "an array of image objects");
			return shapeError ?? validateConversationInputResourceBounds(value);
		}
		case "new_session":
			return validateOptionalField(value, "parentSession", isString, "a string");
		case "set_client_capabilities":
			return validateRequiredField(value, "features", isStringArray, "an array of strings");
		case "report_stream_discontinuity":
			return (
				validateRequiredField(value, "id", isNonEmptyString, "a non-empty string") ??
				validateConversationIdentifierResourceBound(value, "id") ??
				validateRequiredField(value, "sessionId", isNonEmptyString, "a non-empty string") ??
				validateConversationIdentifierResourceBound(value, "sessionId") ??
				validateRequiredField(value, "subscriptionId", isNonEmptyString, "a non-empty string") ??
				validateConversationIdentifierResourceBound(value, "subscriptionId") ??
				validateRequiredField(
					value,
					"lastAppliedCursor",
					isSafeNonnegativeInteger,
					"a safe non-negative integer",
				) ??
				validateOptionalField(
					value,
					"assistantPosition",
					isAssistantStreamPosition,
					"a safe non-negative epoch/seq position",
				) ??
				validateRequiredField(
					value,
					"reason",
					(entry) => isOneOf(entry, RPC_CONVERSATION_DISCONTINUITY_REASONS),
					'"cursor_gap", "assistant_position_gap", or "reducer_divergence"',
				)
			);
		case "get_ui_actions":
			return validateOptionalField(value, "scope", isRpcUiActionScope, '"primary", "palette", or "all"');
		case "get_ui_action_completions":
			return (
				validateRequiredField(value, "action", isString, "a string") ??
				validateRequiredField(value, "argument", isString, "a string") ??
				validateOptionalField(value, "prefix", isString, "a string")
			);
		case "invoke_ui_action":
			return (
				validateRequiredField(value, "action", isString, "a string") ??
				validateOptionalField(value, "args", isRecord, "an object") ??
				validateOptionalField(value, "streamingBehavior", isRpcStreamingBehavior, '"steer" or "followUp"')
			);
		case "register_push_target":
			return validateRequiredField(value, "args", isRpcRegisterPushTargetArgs, "a push target registration object");
		case "unregister_workspace":
			return (
				validateRequiredField(
					value,
					"name",
					(entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
					"a non-empty workspace name",
				) ??
				validateOptionalField(value, "path", () => false, "omitted") ??
				validateOptionalField(value, "workspacePath", () => false, "omitted")
			);
		case "get_mcp_server":
		case "connect_mcp_server":
		case "disconnect_mcp_server":
		case "refresh_mcp_server":
		case "poll_mcp_server_auth":
		case "cancel_mcp_server_auth":
		case "logout_mcp_server":
		case "list_mcp_tools":
			return validateRequiredField(value, "server", isString, "a string");
		case "list_mcp_resources":
		case "list_mcp_prompts":
			return (
				validateRequiredField(value, "server", isString, "a string") ??
				validateOptionalField(value, "cursor", isString, "a string")
			);
		case "set_mcp_server_enabled":
			return (
				validateRequiredField(value, "server", isString, "a string") ??
				validateRequiredField(value, "enabled", isBoolean, "a boolean")
			);
		case "start_mcp_server_auth":
			return (
				validateRequiredField(value, "server", isString, "a string") ??
				validateOptionalField(value, "flow", isMcpAuthFlow, '"browser" or "device"') ??
				validateOptionalField(value, "redirectUrl", isString, "a string")
			);
		case "complete_mcp_server_auth":
			return (
				validateRequiredField(value, "server", isString, "a string") ??
				validateRequiredField(value, "redirectUrl", isString, "a string") ??
				validateRequiredField(value, "code", isString, "a string") ??
				validateOptionalField(value, "state", isString, "a string")
			);
		case "get_mcp_tool":
			return (
				validateRequiredField(value, "server", isString, "a string") ??
				validateRequiredField(value, "tool", isString, "a string")
			);
		case "read_mcp_resource":
			return (
				validateRequiredField(value, "server", isString, "a string") ??
				validateRequiredField(value, "resourceUri", isString, "a string")
			);
		case "get_mcp_prompt":
			return (
				validateRequiredField(value, "server", isString, "a string") ??
				validateRequiredField(value, "prompt", isString, "a string") ??
				validateOptionalField(value, "arguments", isRecord, "an object") ??
				validateOptionalField(value, "argumentsJson", isString, "a string")
			);
		case "list_mcp_recent_calls":
			return validateOptionalField(value, "server", isString, "a string");
		case "get_transcript":
			return (
				validateOptionalField(value, "beforeEntryId", isString, "a string") ??
				validateOptionalField(value, "limit", isNumber, "a number") ??
				validateOptionalField(value, "branchEpoch", isString, "a string") ??
				validateConversationIdentifierResourceBound(value, "branchEpoch")
			);
		case "get_message_images":
			return (
				validateRequiredField(value, "entryId", isString, "a string") ??
				validateOptionalField(value, "startImageIndex", isNumber, "a number")
			);
		case "subagent_start":
			return (
				validateRequiredField(value, "agent", isString, "a string") ??
				validateRequiredField(value, "prompt", isString, "a string")
			);
		case "subagent_abort":
		case "subagent_get_state":
		case "subagent_dispose":
			return validateRequiredField(value, "subagentId", isString, "a string");
		case "subagent_get_transcript":
			return (
				validateRequiredField(value, "subagentId", isString, "a string") ??
				validateOptionalField(value, "beforeEntryId", isString, "a string") ??
				validateOptionalField(value, "limit", isNumber, "a number")
			);
		case "set_model":
			return (
				validateRequiredField(value, "provider", isString, "a string") ??
				validateRequiredField(value, "modelId", isString, "a string") ??
				validateOptionalField(value, "persistDefault", isBoolean, "a boolean")
			);
		case "set_thinking_level":
			return (
				validateRequiredField(value, "level", isRpcThinkingLevel, "a supported thinking level") ??
				validateOptionalField(value, "persistDefault", isBoolean, "a boolean")
			);
		case "set_steering_mode":
		case "set_follow_up_mode":
			return validateRequiredField(value, "mode", isRpcQueueMode, '"all" or "one-at-a-time"');
		case "compact":
			return validateOptionalField(value, "customInstructions", isString, "a string");
		case "set_auto_compaction":
		case "set_auto_retry":
			return validateRequiredField(value, "enabled", isBoolean, "a boolean");
		case "bash":
			return (
				validateRequiredField(value, "command", isString, "a string") ??
				validateOptionalField(value, "excludeFromContext", isBoolean, "a boolean")
			);
		case "export_html":
			return validateOptionalField(value, "outputPath", isString, "a string");
		case "switch_session":
			return validateRequiredField(value, "sessionPath", isString, "a string");
		case "switch_session_by_id":
			return validateRequiredField(value, "sessionId", isString, "a string");
		case "fork":
			return validateRequiredField(value, "entryId", isString, "a string");
		case "set_session_name":
			return validateRequiredField(value, "name", isString, "a string");
		default:
			return undefined;
	}
}

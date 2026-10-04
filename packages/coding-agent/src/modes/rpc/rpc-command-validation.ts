/**
 * Inbound RPC command validation, derived from the TypeBox contract schemas.
 *
 * Structure comes from `RPC_COMMAND_SCHEMAS` (compiled lazily per command
 * type); only the checks JSON Schema cannot express stay hand-written: UTF-8
 * byte budgets and the exact `conversationAuthority` prose. The permissive
 * posture is deliberate and unchanged: non-objects and unknown command types
 * return `undefined` so the dispatcher owns their error paths.
 */

import { Buffer } from "node:buffer";
import type { ImageContent } from "@hansjm10/volt-ai";
import {
	RPC_COMMAND_SCHEMAS,
	RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_MAX_IMAGES,
	RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES,
	RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
} from "@hansjm10/volt-protocol";
import { Compile, type Validator } from "typebox/compile";
import { formatSchemaError } from "../../core/protocol/schema-errors.ts";

export {
	RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_MAX_IMAGES,
	RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES,
	RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
} from "@hansjm10/volt-protocol";

const ERROR_PREFIX = "Invalid RPC command payload";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcImageContent(value: unknown): value is ImageContent {
	return (
		isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
	);
}

function isRpcImageContentArray(value: unknown): value is ImageContent[] {
	return Array.isArray(value) && value.every(isRpcImageContent);
}

// ============================================================================
// Compiled structural validation
// ============================================================================

type RpcCommandSchemaKey = keyof typeof RPC_COMMAND_SCHEMAS;

const compiledCommandValidators = new Map<RpcCommandSchemaKey, Validator>();

function isKnownCommandType(type: string): type is RpcCommandSchemaKey {
	return Object.hasOwn(RPC_COMMAND_SCHEMAS, type);
}

function getCommandValidator(type: RpcCommandSchemaKey): Validator {
	let validator = compiledCommandValidators.get(type);
	if (validator === undefined) {
		validator = Compile(RPC_COMMAND_SCHEMAS[type]);
		compiledCommandValidators.set(type, validator);
	}
	return validator;
}

// ============================================================================
// Layered checks: UTF-8 byte budgets JSON Schema cannot express
// ============================================================================

function validateConversationInputResourceBounds(command: Record<string, unknown>): string | undefined {
	if (typeof command.message !== "string") {
		return undefined;
	}
	const messageBytes = Buffer.byteLength(command.message, "utf8");
	if (messageBytes > RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES) {
		return `${ERROR_PREFIX}: "message" exceeds the ${RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES}-byte UTF-8 limit`;
	}
	if (command.images !== undefined && !isRpcImageContentArray(command.images)) {
		return undefined;
	}
	const images = command.images ?? [];
	if (images.length > RPC_CONVERSATION_INPUT_MAX_IMAGES) {
		return `${ERROR_PREFIX}: "images" exceeds the ${RPC_CONVERSATION_INPUT_MAX_IMAGES}-image limit`;
	}
	let imagePayloadBytes = 0;
	for (let index = 0; index < images.length; index++) {
		const image = images[index]!;
		const mimeTypeBytes = Buffer.byteLength(image.mimeType, "utf8");
		if (mimeTypeBytes > RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES) {
			return `${ERROR_PREFIX}: "images[${index}].mimeType" exceeds the ${RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES}-byte UTF-8 limit`;
		}
		const dataBytes = Buffer.byteLength(image.data, "utf8");
		if (dataBytes > RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES) {
			return `${ERROR_PREFIX}: "images[${index}].data" exceeds the ${RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES}-byte UTF-8 limit`;
		}
		imagePayloadBytes += mimeTypeBytes + dataBytes;
		if (imagePayloadBytes > RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES) {
			return `${ERROR_PREFIX}: "images" exceeds the ${RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES}-byte UTF-8 payload limit`;
		}
	}
	const serializedBytes = Buffer.byteLength(JSON.stringify({ message: command.message, images }), "utf8");
	if (serializedBytes > RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES) {
		return `${ERROR_PREFIX}: conversation input exceeds the ${RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES}-byte serialized limit`;
	}
	return undefined;
}

function validateConversationIdentifierResourceBound(
	command: Record<string, unknown>,
	field: string,
): string | undefined {
	return validateConversationIdentifierValueResourceBound(command[field], field);
}

function validateConversationIdentifierValueResourceBound(value: unknown, field: string): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value !== value.trim()) {
		return `${ERROR_PREFIX}: "${field}" must not contain surrounding whitespace`;
	}
	if (Buffer.byteLength(value, "utf8") <= RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES) return undefined;
	return `${ERROR_PREFIX}: "${field}" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`;
}

function validateConversationIdentifierArrayResourceBounds(
	command: Record<string, unknown>,
	field: string,
): string | undefined {
	const values = command[field];
	if (!Array.isArray(values)) return undefined;
	for (let index = 0; index < values.length; index++) {
		const error = validateConversationIdentifierValueResourceBound(values[index], `${field}[${index}]`);
		if (error) return error;
	}
	return undefined;
}

const RPC_CONVERSATION_AUTHORITY_FIELDS = ["sessionId", "subscriptionId", "branchEpoch"] as const;

/**
 * Runs for every record payload — including unknown command types — before
 * structural validation, preserving the legacy authority error prose and the
 * byte bounds the schema only annotates.
 */
function validateConversationAuthority(command: Record<string, unknown>): string | undefined {
	const authority = command.conversationAuthority;
	if (authority === undefined) return undefined;
	if (!isRecord(authority)) {
		return `${ERROR_PREFIX}: "conversationAuthority" must be an object`;
	}
	const keys = Object.keys(authority);
	if (
		keys.length !== RPC_CONVERSATION_AUTHORITY_FIELDS.length ||
		keys.some((key) => !RPC_CONVERSATION_AUTHORITY_FIELDS.some((field) => field === key))
	) {
		return `${ERROR_PREFIX}: "conversationAuthority" must contain exactly "sessionId", "subscriptionId", and "branchEpoch"`;
	}
	for (const field of RPC_CONVERSATION_AUTHORITY_FIELDS) {
		const value = authority[field];
		if (typeof value !== "string" || value.length === 0) {
			return `${ERROR_PREFIX}: "conversationAuthority.${field}" must be a non-empty string`;
		}
		if (value !== value.trim()) {
			return `${ERROR_PREFIX}: "conversationAuthority.${field}" must not contain surrounding whitespace`;
		}
		if (Buffer.byteLength(value, "utf8") > RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES) {
			return `${ERROR_PREFIX}: "conversationAuthority.${field}" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`;
		}
	}
	return undefined;
}

function validateLayeredResourceBounds(type: RpcCommandSchemaKey, command: Record<string, unknown>) {
	switch (type) {
		case "prompt":
		case "steer":
		case "follow_up":
			return validateConversationInputResourceBounds(command);
		case "report_stream_discontinuity":
			return (
				validateConversationIdentifierResourceBound(command, "id") ??
				validateConversationIdentifierResourceBound(command, "sessionId") ??
				validateConversationIdentifierResourceBound(command, "subscriptionId")
			);
		case "invoke_ui_action":
			return validateConversationIdentifierResourceBound(command, "id");
		case "new_session":
			return (
				validateConversationIdentifierResourceBound(command, "preserveReviewRunId") ??
				validateConversationIdentifierResourceBound(command, "parentSessionId")
			);
		case "read_job":
		case "cancel_job":
			return validateConversationIdentifierResourceBound(command, "jobId");
		case "cancel_workflow":
			return validateConversationIdentifierResourceBound(command, "workflowId");
		case "list_review_discussions":
		case "get_review_general":
		case "get_review_result":
		case "acknowledge_review":
		case "rerun_review":
		case "publish_review":
			return validateConversationIdentifierResourceBound(command, "runId");
		case "reset_review_discussion":
			return (
				validateConversationIdentifierResourceBound(command, "discussionId") ??
				validateConversationIdentifierResourceBound(command, "expectedSessionId") ??
				validateConversationIdentifierResourceBound(command, "requestId")
			);
		case "start_review_discussions":
			return (
				validateConversationIdentifierResourceBound(command, "runId") ??
				validateConversationIdentifierArrayResourceBounds(command, "findingIds") ??
				validateConversationIdentifierResourceBound(command, "requestId")
			);
		case "open_review_session":
			return (
				validateConversationIdentifierResourceBound(command, "runId") ??
				validateConversationIdentifierArrayResourceBounds(command, "findingIds")
			);
		case "record_review_finding_outcome":
			return (
				validateConversationIdentifierResourceBound(command, "runId") ??
				validateConversationIdentifierResourceBound(command, "findingId")
			);
		case "get_transcript":
			return validateConversationIdentifierResourceBound(command, "branchEpoch");
		default:
			return undefined;
	}
}

// ============================================================================
// Entry point
// ============================================================================

export function validateRpcCommandPayload(value: unknown): string | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const authorityError = validateConversationAuthority(value);
	if (authorityError) return authorityError;

	const type = value.type;
	if (typeof type !== "string" || !isKnownCommandType(type)) {
		return undefined;
	}
	const validator = getCommandValidator(type);
	if (!validator.Check(value)) {
		return `${ERROR_PREFIX}: ${formatSchemaError(RPC_COMMAND_SCHEMAS[type], validator.Errors(value))}`;
	}
	return validateLayeredResourceBounds(type, value);
}

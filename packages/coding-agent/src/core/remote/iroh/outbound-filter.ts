import { TextDecoder } from "node:util";
import type { RpcCloseHandler, RpcLineHandler, RpcTransport } from "../../rpc/index.ts";
import {
	createIrohRemoteProjectionSanitizer,
	type IrohRemoteProjectionSanitizer,
	type IrohRemoteSanitizerOptions,
	type IrohRemoteSanitizerValuePreserver,
} from "./sanitizer.ts";

export {
	createIrohRemoteProjectionSanitizer,
	IROH_REMOTE_REDACTED_BASH_OUTPUT_PATH,
	IROH_REMOTE_REDACTED_EXPORT_PATH,
	IROH_REMOTE_REDACTED_SESSION_FILE,
	type IrohRemoteProjectionSanitizer,
	type IrohRemoteSanitizerOptions,
} from "./sanitizer.ts";

export type IrohRemoteOutboundValueDecorator = (value: object) => object;

export interface IrohRemoteOutboundSanitizerOptions extends IrohRemoteSanitizerOptions {
	decorate?: IrohRemoteOutboundValueDecorator;
}

export interface IrohRemoteOutboundFilterOptions extends IrohRemoteOutboundSanitizerOptions {
	transport: RpcTransport;
}

export interface IrohRemoteOutboundJsonlReadablePipeOptions extends IrohRemoteOutboundSanitizerOptions {
	onLine?: (line: string) => void;
	writeLine: (line: string) => Promise<void> | void;
}

const PROJECTED_MESSAGE_FRAME_FIELDS = new Set(["type", "stream", "message", "delivery"]);
const PROJECTED_MESSAGE_UPDATE_FRAME_FIELDS = new Set([
	"type",
	"stream",
	"assistantMessageEvent",
	"message",
	"toolState",
	"delivery",
]);
const PROJECTED_STREAM_POSITION_FIELDS = new Set(["epoch", "seq"]);
const CONVERSATION_DELIVERY_POSITION_FIELDS = new Set(["subscriptionId", "cursor"]);
const CONVERSATION_BOOTSTRAP_FIELDS = new Set([
	"type",
	"delivery",
	"conversation",
	"state",
	"transcript",
	"activeAssistant",
	"activeWorkflows",
	"reason",
	"requestId",
]);
const SENSITIVE_CONVERSATION_SIGNATURE_FIELDS = new Set([
	"textSignature",
	"thinkingSignature",
	"thoughtSignature",
	"signatureDelta",
]);

export function createIrohRemoteOutboundFilteredRpcTransport(options: IrohRemoteOutboundFilterOptions): RpcTransport {
	const sanitizer = createIrohRemoteProjectionSanitizer(options);
	return {
		write(value) {
			return options.transport.write(sanitizeOutboundValue(value, options.decorate, sanitizer));
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine(handler);
		},
		onClose(handler: RpcCloseHandler): () => void {
			return options.transport.onClose?.(handler) ?? (() => {});
		},
		async waitForBackpressure() {
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			await options.transport.flush?.();
		},
		close() {
			return options.transport.close();
		},
	};
}

export function sanitizeIrohRemoteOutbound(value: object, options: IrohRemoteOutboundSanitizerOptions): object {
	const sanitizer = createIrohRemoteProjectionSanitizer(options);
	return sanitizeOutboundValue(value, options.decorate, sanitizer);
}

export function sanitizeIrohRemoteOutboundJsonLine(line: string, options: IrohRemoteOutboundSanitizerOptions): string {
	const sanitizer = createIrohRemoteProjectionSanitizer(options);
	const hasTrailingNewline = line.endsWith("\n");
	const rawLine = hasTrailingNewline ? line.slice(0, -1) : line;
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawLine);
	} catch {
		return `${sanitizer.sanitizeText(rawLine)}${hasTrailingNewline ? "\n" : ""}`;
	}
	if (!isRecord(parsed) && !Array.isArray(parsed)) {
		return `${sanitizer.sanitizeText(rawLine)}${hasTrailingNewline ? "\n" : ""}`;
	}
	const sanitized = sanitizeOutboundValue(parsed, options.decorate, sanitizer);
	return `${JSON.stringify(sanitized)}${hasTrailingNewline ? "\n" : ""}`;
}

export async function pipeIrohRemoteOutboundJsonlReadable(
	readable: AsyncIterable<string | Uint8Array>,
	options: IrohRemoteOutboundJsonlReadablePipeOptions,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";

	for await (const chunk of readable) {
		buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		await flushBufferedLines(buffer, options, (rest) => {
			buffer = rest;
		});
	}

	buffer += decoder.decode();
	if (buffer.length > 0) {
		await writeSanitizedJsonLine(buffer, options);
	}
}

function sanitizeOutboundValue(
	value: object,
	decorate: IrohRemoteOutboundValueDecorator | undefined,
	sanitizer: IrohRemoteProjectionSanitizer,
): object {
	const decorated = decorate ? decorate(value) : value;
	if (isProjectedAssistantMessageFrame(decorated)) {
		return decorated;
	}
	if (isConversationBootstrapEnvelope(decorated)) {
		return sanitizeConversationBootstrapEnvelope(decorated, sanitizer);
	}
	const sanitized = sanitizer.sanitizeValue(decorated, preserveProjectedAssistantSubagentMessage);
	return isRecord(sanitized) || Array.isArray(sanitized) ? sanitized : {};
}

function sanitizeConversationBootstrapEnvelope(
	value: Record<string, unknown>,
	sanitizer: IrohRemoteProjectionSanitizer,
): object {
	const sanitized: Record<string, unknown> = Object.create(null);
	for (const key of CONVERSATION_BOOTSTRAP_FIELDS) {
		if (!Object.hasOwn(value, key)) {
			continue;
		}
		const entry = value[key];
		if (key === "type") {
			sanitized.type = "conversation_bootstrap";
			continue;
		}
		if (key === "delivery") {
			sanitized.delivery = sanitizeConversationDeliveryPosition(entry);
			continue;
		}
		if ((key === "requestId" || key === "reason") && typeof entry === "string") {
			sanitized[key] = entry;
			continue;
		}
		const sanitizedEntry = stripSensitiveConversationSignatures(sanitizer.sanitizeValue(entry));
		if (sanitizedEntry !== undefined) {
			sanitized[key] = sanitizedEntry;
		}
	}
	return sanitized;
}

function sanitizeConversationDeliveryPosition(value: unknown): object {
	if (!isRecord(value)) {
		return {};
	}
	const sanitized: Record<string, unknown> = Object.create(null);
	if (typeof value.subscriptionId === "string") {
		sanitized.subscriptionId = value.subscriptionId;
	}
	if (typeof value.cursor === "number" && Number.isSafeInteger(value.cursor) && value.cursor >= 0) {
		sanitized.cursor = value.cursor;
	}
	return sanitized;
}

function stripSensitiveConversationSignatures(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stripSensitiveConversationSignatures);
	}
	if (!isRecord(value)) {
		return value;
	}
	const stripped: Record<string, unknown> = Object.create(null);
	for (const [key, entry] of Object.entries(value)) {
		if (!SENSITIVE_CONVERSATION_SIGNATURE_FIELDS.has(key)) {
			stripped[key] = stripSensitiveConversationSignatures(entry);
		}
	}
	return stripped;
}

const preserveProjectedAssistantSubagentMessage: IrohRemoteSanitizerValuePreserver = (record, key, value) =>
	record.type === "subagent_event" && key === "event" && isProjectedAssistantMessageFrame(value);

function isProjectedAssistantMessageFrame(value: unknown): boolean {
	if (!isRecord(value) || !isProjectedStreamPosition(value.stream)) {
		return false;
	}
	if ("delivery" in value && !isConversationDeliveryPosition(value.delivery)) {
		return false;
	}
	if (value.type === "message_start" || value.type === "message_end") {
		return hasOnlyFields(value, PROJECTED_MESSAGE_FRAME_FIELDS) && isAssistantMessage(value.message);
	}
	if (
		value.type !== "message_update" ||
		!hasOnlyFields(value, PROJECTED_MESSAGE_UPDATE_FRAME_FIELDS) ||
		!isRecord(value.assistantMessageEvent)
	) {
		return false;
	}
	if ("message" in value) {
		return isAssistantMessage(value.message);
	}
	return true;
}

function isConversationBootstrapEnvelope(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && value.type === "conversation_bootstrap";
}

function isAssistantMessage(value: unknown): boolean {
	return isRecord(value) && value.role === "assistant" && Array.isArray(value.content);
}

function isProjectedStreamPosition(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyFields(value, PROJECTED_STREAM_POSITION_FIELDS) &&
		typeof value.epoch === "number" &&
		Number.isSafeInteger(value.epoch) &&
		value.epoch >= 0 &&
		typeof value.seq === "number" &&
		Number.isSafeInteger(value.seq) &&
		value.seq >= 0
	);
}

function isConversationDeliveryPosition(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasOnlyFields(value, CONVERSATION_DELIVERY_POSITION_FIELDS) &&
		typeof value.subscriptionId === "string" &&
		value.subscriptionId.length > 0 &&
		typeof value.cursor === "number" &&
		Number.isSafeInteger(value.cursor) &&
		value.cursor >= 0
	);
}

function hasOnlyFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

async function flushBufferedLines(
	buffer: string,
	options: IrohRemoteOutboundJsonlReadablePipeOptions,
	setRest: (rest: string) => void,
): Promise<void> {
	let rest = buffer;
	while (true) {
		const newlineIndex = rest.indexOf("\n");
		if (newlineIndex === -1) {
			setRest(rest);
			return;
		}
		const line = rest.slice(0, newlineIndex + 1);
		rest = rest.slice(newlineIndex + 1);
		await writeSanitizedJsonLine(line, options);
	}
}

async function writeSanitizedJsonLine(
	line: string,
	options: IrohRemoteOutboundJsonlReadablePipeOptions,
): Promise<void> {
	const sanitizedLine = sanitizeIrohRemoteOutboundJsonLine(line, options);
	await options.writeLine(sanitizedLine);
	options.onLine?.(sanitizedLine);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { ProviderError, ProviderErrorKind } from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { isContextOverflowText } from "../utils/overflow.ts";

const RETRYABLE_KINDS: ReadonlySet<ProviderErrorKind> = new Set([
	"rate_limit",
	"overloaded",
	"server",
	"network",
	"timeout",
]);

/** Provider error codes and types whose meaning does not depend on the HTTP status. */
const PROVIDER_CODE_KINDS: ReadonlyMap<string, ProviderErrorKind> = new Map([
	// Anthropic error types
	["overloaded_error", "overloaded"],
	["rate_limit_error", "rate_limit"],
	["api_error", "server"],
	["timeout_error", "timeout"],
	["authentication_error", "auth"],
	["permission_error", "auth"],
	["billing_error", "quota"],
	["request_too_large", "context_overflow"],
	// OpenAI error codes
	["insufficient_quota", "quota"],
	["rate_limit_exceeded", "rate_limit"],
	["context_length_exceeded", "context_overflow"],
	["server_error", "server"],
	["invalid_api_key", "auth"],
	// ChatGPT subscription (Codex) limits
	["usage_limit_reached", "quota"],
	["usage_not_included", "quota"],
	// OpenCode subscription limits
	["GoUsageLimitError", "quota"],
	["FreeUsageLimitError", "quota"],
]);

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"ENETDOWN",
	"EHOSTUNREACH",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	"UND_ERR_CONNECT",
	"ERR_HTTP2_STREAM_ERROR",
	"ERR_HTTP2_SESSION_ERROR",
	"ERR_HTTP2_GOAWAY_SESSION",
]);

const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);

const NETWORK_ERROR_NAMES: ReadonlySet<string> = new Set(["ConnectionError", "SocketError", "FetchError"]);
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set([
	"TimeoutError",
	"RequestTimeoutError",
	"ConnectTimeoutError",
	"HeadersTimeoutError",
	"BodyTimeoutError",
]);

/** Build a provider error. `retryable` defaults by kind: transient kinds retry, all others do not. */
export function createProviderError(
	kind: ProviderErrorKind,
	message: string,
	options: { retryable?: boolean; providerCode?: string } = {},
): ProviderError {
	return {
		kind,
		retryable: options.retryable ?? RETRYABLE_KINDS.has(kind),
		...(options.providerCode === undefined ? {} : { providerCode: options.providerCode }),
		message,
	};
}

/**
 * A failure whose classification the provider already knows. Providers throw it from request
 * building, sending, or parsing; the stream runner reports its error without reclassifying it.
 */
export class ProviderStreamError extends Error {
	readonly providerError: ProviderError;
	readonly diagnostics: AssistantMessageDiagnostic[] | undefined;
	readonly retryAfterMs: number | undefined;

	constructor(
		kind: ProviderErrorKind,
		message: string,
		options: {
			retryable?: boolean;
			providerCode?: string;
			diagnostics?: AssistantMessageDiagnostic[];
			retryAfterMs?: number;
			cause?: unknown;
		} = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ProviderStreamError";
		this.providerError = createProviderError(kind, message, options);
		this.diagnostics = options.diagnostics;
		this.retryAfterMs = options.retryAfterMs;
	}
}

/** Classify an HTTP error response from its status and, when present, the provider's error code or type. */
export function classifyHttpStatus(status: number, message: string, providerCode?: string): ProviderError {
	const options = { providerCode: providerCode ?? String(status) };
	const coded = providerCode === undefined ? undefined : PROVIDER_CODE_KINDS.get(providerCode);
	if (coded) return createProviderError(coded, message, options);
	if (status === 429) return createProviderError("rate_limit", message, options);
	if (status === 402) return createProviderError("quota", message, options);
	if (status === 413 || isContextOverflowText(message))
		return createProviderError("context_overflow", message, options);
	if (status === 401 || status === 403) return createProviderError("auth", message, options);
	if (status === 408 || status === 504) return createProviderError("timeout", message, options);
	if (status === 503 || status === 529) return createProviderError("overloaded", message, options);
	if (status === 409 || status >= 500) return createProviderError("server", message, options);
	return createProviderError("invalid_request", message, options);
}

/**
 * Classify a thrown provider failure from its structured fields: HTTP status, provider error
 * code or type, and transport error codes along its cause chain. Error text is consulted only
 * for context overflow, which many OpenAI-compatible backends report as text alone.
 */
export function classifyProviderError(error: unknown, options: { message?: string } = {}): ProviderError {
	if (error instanceof ProviderStreamError) return error.providerError;
	const message = options.message ?? formatProviderErrorMessage(error);
	const status = readStatus(error);
	const providerCode = readProviderCode(error);
	if (status !== undefined) return classifyHttpStatus(status, message, providerCode);
	const codeOption = providerCode === undefined ? {} : { providerCode };
	const coded = providerCode === undefined ? undefined : PROVIDER_CODE_KINDS.get(providerCode);
	if (coded) return createProviderError(coded, message, codeOption);
	const transport = classifyTransportError(error);
	if (transport) return createProviderError(transport, message, codeOption);
	if (isContextOverflowText(message)) return createProviderError("context_overflow", message, codeOption);
	return createProviderError("unknown", message, codeOption);
}

/** Classify a provider error code or type reported without an HTTP status, such as a mid-stream error event. */
export function classifyProviderCode(providerCode: string | undefined, message: string): ProviderError {
	const codeOption = providerCode ? { providerCode } : {};
	const coded = providerCode ? PROVIDER_CODE_KINDS.get(providerCode) : undefined;
	if (coded) return createProviderError(coded, message, codeOption);
	if (isContextOverflowText(message)) return createProviderError("context_overflow", message, codeOption);
	return createProviderError("unknown", message, codeOption);
}

/** Network or timeout kind for transport failures, found by error code or name along the cause chain. */
export function classifyTransportError(error: unknown): "network" | "timeout" | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") {
			if (TIMEOUT_ERROR_CODES.has(code)) return "timeout";
			if (NETWORK_ERROR_CODES.has(code)) return "network";
		}
		const name = (current as { name?: unknown }).name;
		if (typeof name === "string") {
			if (TIMEOUT_ERROR_NAMES.has(name)) return "timeout";
			if (NETWORK_ERROR_NAMES.has(name)) return "network";
		}
		// Undici reports connection failures and truncated bodies as these TypeErrors.
		if (current instanceof TypeError && (current.message === "fetch failed" || current.message === "terminated")) {
			return "network";
		}
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/** The server-requested retry delay carried by an HTTP error's `retry-after-ms` or `retry-after` header. */
export function readRetryAfterMs(error: unknown): number | undefined {
	if (error instanceof ProviderStreamError) return error.retryAfterMs;
	if (error === null || typeof error !== "object") return undefined;
	const headers = (error as { headers?: unknown }).headers;
	const read = (name: string): string | undefined => {
		if (headers instanceof Headers) return headers.get(name) ?? undefined;
		if (headers !== null && typeof headers === "object") {
			const value = (headers as Record<string, unknown>)[name];
			return typeof value === "string" ? value : undefined;
		}
		return undefined;
	};
	return parseRetryAfterMs(read("retry-after-ms"), read("retry-after"));
}

/** Parse `retry-after-ms` (milliseconds) or `retry-after` (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfterMs(
	retryAfterMs: string | undefined,
	retryAfter: string | undefined,
): number | undefined {
	if (retryAfterMs !== undefined) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) return Math.max(0, millis);
	}
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(retryAfter);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function formatProviderErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error) ?? String(error);
	} catch {
		return String(error);
	}
}

function readStatus(error: unknown): number | undefined {
	if (error === null || typeof error !== "object") return undefined;
	const candidate = error as { status?: unknown; statusCode?: unknown };
	const status = typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
	return typeof status === "number" && status >= 400 && status < 600 ? status : undefined;
}

function readProviderCode(error: unknown): string | undefined {
	if (error === null || typeof error !== "object") return undefined;
	const candidate = error as { code?: unknown; type?: unknown };
	for (const value of [candidate.code, candidate.type]) {
		if (
			typeof value === "string" &&
			value.length > 0 &&
			!NETWORK_ERROR_CODES.has(value) &&
			!TIMEOUT_ERROR_CODES.has(value)
		) {
			return value;
		}
	}
	return undefined;
}

/** The failure for a request that has no API key. */
export function missingApiKeyError(provider: string): ProviderStreamError {
	return new ProviderStreamError("auth", `No API key for provider: ${provider}`);
}

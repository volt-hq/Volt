import { decodeBridgeValue } from "./codec.ts";
import {
	MAX_BINDING_NAME_LENGTH,
	MAX_BRIDGE_JSON_DEPTH,
	MAX_IMAGE_REF_LENGTH,
	MAX_SCRIPT_ERROR_CHARS,
	MAX_SCRIPT_ERROR_NAME_CHARS,
	MAX_SCRIPT_ERROR_SUMMARY_CHARS,
} from "./limits.ts";
import type { CodeModeBinding, CodeModeErrorDescription, PreludeConfig } from "./prelude.ts";

/**
 * Messages between the host and a code mode worker (section 5.8 of docs/code-mode-design.md). They are
 * plain objects with string and number fields, so a process backend could carry the same messages as
 * JSON frames. The host validates every message as if the worker were untrusted.
 */

/**
 * A worker whose protocol version differs fails closed; this catches stale worker files, not old clients. Bump it
 * whenever a message shape or the prelude's script API changes.
 */
export const CODE_MODE_PROTOCOL_VERSION = 3;

/**
 * Shared memory between the host and one worker. The host writes the id of a script it wants stopped;
 * the worker publishes when its VM started executing and how much compute the script has used, which
 * the host's watchdog reads.
 */
export const CONTROL_BUFFER_BYTES = 24;
/** Int32 index: id of the script the host asked to stop. */
export const CONTROL_STOP_INDEX = 0;
/**
 * BigInt64 index: `process.hrtime.bigint()` when the VM started executing, or 0 while it is idle. The
 * clock is monotonic and shared by every thread of the process, unlike `Date.now()`.
 */
export const CONTROL_COMPUTING_SINCE_INDEX = 1;
/** BigInt64 index: milliseconds of compute the current script used before the current execution. */
export const CONTROL_COMPUTE_USED_INDEX = 2;

/**
 * A compiled `WebAssembly.Module`, passed through as an opaque handle. The package's TypeScript libraries
 * declare no WebAssembly types, and the module has no members the runtime uses.
 */
export type CompiledWasm = object;

export interface CodeModeWorkerData {
	wasm: CompiledWasm;
	memoryLimitBytes: number;
	control: SharedArrayBuffer;
	prelude: PreludeConfig;
}

export type HostToWorkerMessage =
	| {
			type: "start";
			id: number;
			code: string;
			bindings: CodeModeBinding[];
			computeBudgetMs: number;
			maxReportedRejections: number;
			maxArgumentBytes: number;
			/** The conversation's stored values when the script starts: keys and the codec text of their values. */
			stored: [string, string][];
	  }
	/** `imageRefs` lists the images the host issued with the value, which the script may then pass to `image()`. */
	| { type: "result"; id: number; seq: number; ok: boolean; payload: string; imageRefs: string[] }
	| { type: "stop"; id: number };

export type WorkerToHostMessage =
	| { type: "ready"; protocol: number; engine: string }
	| { type: "call"; id: number; payload: string }
	| { type: "output"; id: number; payload: string }
	| { type: "done"; id: number; payload: string }
	/** A write to the conversation's stored values (section 5.17). */
	| { type: "store"; id: number; payload: string }
	| { type: "stopped"; id: number; reason: "stop" | "compute_budget" }
	| { type: "stalled"; id: number }
	| { type: "crash"; id: number; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isId(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validates a message from a worker. Returns undefined for anything malformed. */
export function parseWorkerMessage(value: unknown): WorkerToHostMessage | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.type) {
		case "ready":
			return typeof value.protocol === "number" && typeof value.engine === "string"
				? { type: "ready", protocol: value.protocol, engine: value.engine }
				: undefined;
		case "call":
		case "output":
		case "done":
		case "store":
			return isId(value.id) && typeof value.payload === "string"
				? { type: value.type, id: value.id, payload: value.payload }
				: undefined;
		case "stopped":
			return isId(value.id) && (value.reason === "stop" || value.reason === "compute_budget")
				? { type: "stopped", id: value.id, reason: value.reason }
				: undefined;
		case "stalled":
			return isId(value.id) ? { type: "stalled", id: value.id } : undefined;
		case "crash":
			return isId(value.id) && typeof value.reason === "string"
				? { type: "crash", id: value.id, reason: value.reason.slice(0, 1000) }
				: undefined;
		default:
			return undefined;
	}
}

/** Thrown for a payload the prelude could not have produced. The host treats it as a protocol violation. */
export class CodeModeProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodeModeProtocolError";
	}
}

export interface ParsedCall {
	seq: number;
	binding: string;
	/** The decoded arguments; a plain object unless the frame was forged. */
	args: unknown;
}

/** Parses the payload of a `call` message: `{"seq":N,"binding":"name","args":<codec text>}`. */
export function parseCallPayload(payload: string): ParsedCall {
	let envelope: unknown;
	try {
		// The envelope adds one level around the arguments.
		envelope = decodeBridgeValue(payload, MAX_BRIDGE_JSON_DEPTH + 1);
	} catch (error) {
		throw new CodeModeProtocolError(`invalid call frame: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(envelope)) throw new CodeModeProtocolError("invalid call frame");
	const { seq, binding, args } = envelope;
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
		throw new CodeModeProtocolError("invalid call seq");
	}
	if (typeof binding !== "string" || binding.length === 0 || binding.length > MAX_BINDING_NAME_LENGTH) {
		throw new CodeModeProtocolError("invalid call binding");
	}
	return { seq, binding, args };
}

/** Returns whether a decoded value is a plain object, as tool arguments must be. */
export function isPlainArguments(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value);
}

/** One item of a script's output stream, in the order the script produced it (section 5.10). */
export type CodeModeOutputItem =
	| { type: "text"; text: string }
	| { type: "console"; level: "log" | "info" | "debug" | "warn" | "error"; text: string }
	| { type: "image"; ref: string };

const CONSOLE_LEVELS = new Set(["log", "info", "debug", "warn", "error"]);

/** Parses the payload of an `output` message. */
export function parseOutputPayload(payload: string): CodeModeOutputItem {
	let item: unknown;
	try {
		item = JSON.parse(payload);
	} catch {
		throw new CodeModeProtocolError("invalid output frame");
	}
	if (!isRecord(item)) throw new CodeModeProtocolError("invalid output frame");
	if (item.type === "text" && typeof item.text === "string") return { type: "text", text: item.text };
	if (item.type === "console" && typeof item.text === "string" && typeof item.level === "string") {
		if (CONSOLE_LEVELS.has(item.level)) {
			return { type: "console", level: item.level as "log" | "info" | "debug" | "warn" | "error", text: item.text };
		}
	}
	if (item.type === "image" && typeof item.ref === "string" && item.ref.length <= MAX_IMAGE_REF_LENGTH) {
		return { type: "image", ref: item.ref };
	}
	throw new CodeModeProtocolError("invalid output frame");
}

/** A write to the conversation's stored values: a key and the codec text of its value, or the key's deletion. */
export type ParsedStore = { key: string; value: string } | { key: string; deleted: true };

/**
 * Parses the payload of a `store` message, as the prelude writes it: `{"key":...,"value":...}` with the value as
 * codec text, or `{"key":...,"delete":true}`. The value is kept as the exact text the prelude encoded, whose bytes
 * the prelude counted, after checking it decodes on its own. Anything else is a protocol violation.
 */
export function parseStorePayload(payload: string): ParsedStore {
	let envelope: unknown;
	try {
		envelope = decodeBridgeValue(payload, MAX_BRIDGE_JSON_DEPTH + 1);
	} catch (error) {
		throw new CodeModeProtocolError(`invalid store frame: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(envelope) || typeof envelope.key !== "string") throw new CodeModeProtocolError("invalid store frame");
	const key = JSON.stringify(envelope.key);
	if (payload === `{"key":${key},"delete":true}`) return { key: envelope.key, deleted: true };
	const prefix = `{"key":${key},"value":`;
	if (!payload.startsWith(prefix) || !payload.endsWith("}") || Object.keys(envelope).length !== 2) {
		throw new CodeModeProtocolError("invalid store frame");
	}
	const value = payload.slice(prefix.length, -1);
	try {
		decodeBridgeValue(value);
	} catch {
		throw new CodeModeProtocolError("invalid store frame: the value is not codec text");
	}
	return { key: envelope.key, value };
}

export type ParsedDone =
	| { ok: true; hasValue: boolean; value?: unknown }
	| { ok: false; phase: "evaluate" | "run"; error: CodeModeErrorDescription };

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * Parses an error description produced by the prelude's describe step. The prelude bounds and escapes these
 * fields; the host enforces the same rules, because a forged description could otherwise inject lines into
 * status text and results.
 */
export function parseErrorDescription(value: unknown): CodeModeErrorDescription {
	if (
		!isRecord(value) ||
		typeof value.name !== "string" ||
		typeof value.summary !== "string" ||
		typeof value.text !== "string" ||
		typeof value.outOfMemory !== "boolean"
	) {
		throw new CodeModeProtocolError("invalid error description");
	}
	if (
		value.name.length > MAX_SCRIPT_ERROR_NAME_CHARS ||
		value.summary.length > MAX_SCRIPT_ERROR_SUMMARY_CHARS ||
		value.text.length > MAX_SCRIPT_ERROR_CHARS ||
		LINE_TERMINATOR.test(value.name) ||
		LINE_TERMINATOR.test(value.summary)
	) {
		throw new CodeModeProtocolError("error description exceeds its limits");
	}
	return { name: value.name, summary: value.summary, text: value.text, outOfMemory: value.outOfMemory };
}

/** Parses the payload of a `done` message: `{"ok":true,"value"?:...}` or `{"ok":false,"error":{...}}`. */
export function parseDonePayload(payload: string): ParsedDone {
	let envelope: unknown;
	try {
		envelope = decodeBridgeValue(payload, MAX_BRIDGE_JSON_DEPTH + 1);
	} catch (error) {
		throw new CodeModeProtocolError(`invalid done frame: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(envelope)) throw new CodeModeProtocolError("invalid done frame");
	if (envelope.ok === true) {
		return Object.hasOwn(envelope, "value")
			? { ok: true, hasValue: true, value: envelope.value }
			: { ok: true, hasValue: false };
	}
	if (envelope.ok === false && (envelope.phase === "evaluate" || envelope.phase === "run")) {
		return { ok: false, phase: envelope.phase, error: parseErrorDescription(envelope.error) };
	}
	throw new CodeModeProtocolError("invalid done frame");
}

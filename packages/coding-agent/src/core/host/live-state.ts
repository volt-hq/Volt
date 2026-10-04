/**
 * A conversation's live state (RFC §6.1): the keyed values of its live lane,
 * its transient items, and its pending host requests.
 *
 * Keyed values (extension status, widgets, and title; pending host requests;
 * host action progress) persist until the host clears or replaces them.
 * Notices and editor directives reach the clients attached when they are
 * raised and are not kept. A client attached with `attach` first receives the
 * current values as a reset, then every change in order; detaching it, or
 * closing the live state, delivers an empty reset.
 *
 * Host requests (dialogs, forms, approvals, MCP authorization) are keyed
 * values `host_request/<requestId>` until they end. A request reaches only the
 * attached clients that accept its kind, and only such a client may answer it:
 * the first valid answer wins. A request ends when it is answered, when its
 * requester aborts it, when it times out, or when the conversation closes. It
 * outlives the clients that saw it, so a client that attaches later, or
 * reconnects, finds it again. Host action progress (`host_action/<id>`)
 * reaches the clients that accept approvals.
 *
 * Streaming items (the streaming assistant message and running tools) are
 * part of the state until the entry that commits them is applied
 * (`commit`). Every delivery carries `basedOn`, the log position when it was
 * published; a delivery whose `basedOn` differs from the previous one while
 * something streams repeats the streaming state first, so a client that
 * discards streaming items on a new `basedOn` (RFC §6.1) holds the same state
 * as the host (see live-fold.ts).
 */

import { randomUUID } from "node:crypto";
import {
	type HostRequest,
	type HostRequestKind,
	type HostResponse,
	HostResponseSchema,
	LIVE_KEY_ID_MAX_CHARS,
	LIVE_KEYED_KINDS,
	LIVE_SINGLETON_KINDS,
	type LiveItem,
	type LiveValue,
	LiveValueSchema,
	type UiNodeFormField,
} from "@hansjm10/volt-protocol";
import { Compile, type Validator } from "typebox/compile";
import type { HostActionDecision, HostActionRequest, HostActionUpdate, HostInteraction } from "../host-interaction.ts";
import {
	emptyLiveFold,
	foldLiveCommit,
	foldLiveItems,
	isLiveStreaming,
	type LiveCommit,
	type LiveFoldState,
	liveStreamingItems,
} from "../protocol/live-fold.ts";

/** A change to a client's live state; with `reset`, `items` replace everything the client held. */
export interface LiveUpdate {
	readonly reset: boolean;
	/** The log position when the change was published: what its streaming items build on. */
	readonly basedOn: number;
	readonly items: readonly LiveItem[];
}

export interface LiveStateOptions {
	/** The conversation's log position; 0 by default. */
	readonly head?: () => number;
}

/** A client's view of a conversation's live state. */
export interface LiveClient {
	/** Whether the client shows and may answer host requests of `kind`; read at every delivery and answer. */
	acceptsHostRequest(kind: HostRequestKind): boolean;
	/** Receives the live state: the current values as a reset when attached, then every change. */
	apply(update: LiveUpdate): void;
}

/** Why a host request ended without an answer. */
export type HostRequestCancelReason =
	/** No attached client accepted its kind when it was asked. */
	| "unavailable"
	/** Its requester aborted it. */
	| "aborted"
	| "timeout"
	/** The conversation closed. */
	| "closed";

/** How a host request ended: answered by an attached client, or cancelled. */
export type HostRequestOutcome =
	| { readonly status: "answered"; readonly response: HostResponse; readonly clientId: string }
	| { readonly status: "cancelled"; readonly reason: HostRequestCancelReason };

/** The result of an answer: accepted (it won), or why it was refused. */
export type HostAnswerResult = "accepted" | "unknown" | "not_allowed" | "invalid";

export interface HostRequestOptions {
	/**
	 * The request id; minted when omitted. Asking with the id of a pending
	 * request rejects: an answer to that one must never answer another.
	 */
	readonly id?: string;
	readonly signal?: AbortSignal;
	/**
	 * Ask even when no attached client accepts the request's kind, for a flow
	 * already under way such as an MCP authorization. Otherwise such a request
	 * ends at once as unavailable.
	 */
	readonly unattended?: boolean;
}

/** A pending host request. */
export interface PendingHostRequest {
	readonly requestId: string;
	readonly request: HostRequest;
}

interface PendingEntry extends PendingHostRequest {
	readonly resolve: (outcome: HostRequestOutcome) => void;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: () => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	settled: boolean;
}

interface AttachedClient {
	readonly id: string;
	readonly client: LiveClient;
	/** Changes published from this sequence number on reach the client; earlier ones are in its reset. */
	readonly since: number;
	/** Gated keys (host requests, host action progress) the client holds. */
	readonly shown: Set<string>;
}

const HOST_ACTION_TERMINAL_STATUSES: ReadonlySet<HostActionUpdate["status"]> = new Set([
	"completed",
	"failed",
	"cancelled",
]);
const IDENTIFIER_MAX_UTF8_BYTES = 256;

let liveValueValidator: Validator | undefined;
let hostResponseValidator: Validator | undefined;

function isLiveValue(value: LiveValue): boolean {
	liveValueValidator ??= Compile(LiveValueSchema);
	return liveValueValidator.Check(value);
}

function isHostResponse(response: HostResponse): boolean {
	hostResponseValidator ??= Compile(HostResponseSchema);
	return hostResponseValidator.Check(response);
}

/** A keyed live key's id: 1 to 256 characters without control characters. */
function isKeyId(id: string): boolean {
	let length = 0;
	for (const char of id) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
		length++;
	}
	return length >= 1 && length <= LIVE_KEY_ID_MAX_CHARS;
}

function isRequestId(id: string): boolean {
	return isKeyId(id) && id.trim() === id && Buffer.byteLength(id, "utf8") <= IDENTIFIER_MAX_UTF8_BYTES;
}

const SINGLETON_KINDS: ReadonlySet<string> = new Set(LIVE_SINGLETON_KINDS);
const KEYED_KINDS: ReadonlySet<string> = new Set(LIVE_KEYED_KINDS);

/** The key of a keyed value: `<kind>/<id>`. */
export function liveKey(kind: (typeof LIVE_KEYED_KINDS)[number], id: string): string {
	return `${kind}/${id}`;
}

/** Whether `key` is a well-formed key for `value`'s family. */
function keyFits(key: string, value: LiveValue): boolean {
	if (SINGLETON_KINDS.has(value.kind)) return key === value.kind;
	if (!KEYED_KINDS.has(value.kind) || !key.startsWith(`${value.kind}/`)) return false;
	return isKeyId(key.slice(value.kind.length + 1));
}

/** Whether `client` accepts `kind`; a client whose check throws accepts nothing. */
function acceptsKind(client: LiveClient, kind: HostRequestKind): boolean {
	try {
		return client.acceptsHostRequest(kind) === true;
	} catch {
		return false;
	}
}

function isGatedKey(key: string): boolean {
	return key.startsWith("host_request/") || key.startsWith("host_action/");
}

/** The host request kind a client must accept to see `value` under `key`, if the key is gated. */
function gateOf(key: string, value: LiveValue): HostRequestKind | undefined {
	if (value.kind === "host_request") return value.request.kind;
	if (key.startsWith("host_action/")) return "approval";
	return undefined;
}

/** Longest form field pattern, in characters. */
const FORM_PATTERN_MAX_CHARS = 512;
/** Longest value a form field pattern is tested against, in characters. */
export const FORM_PATTERN_VALUE_MAX_CHARS = 256;
/** Most repeating quantifiers (`*`, `+`, `{n,}`, `{n,m}`) a form field pattern holds. */
const FORM_PATTERN_MAX_REPEATS = 3;
/** Most choice points (quantifiers, `?`, and `|` alternatives) a form field pattern holds. */
const FORM_PATTERN_MAX_CHOICES = 4;

/** Characters, as sorted, disjoint, inclusive code point ranges. */
type CharSet = readonly (readonly [number, number])[];

const ANY_CHAR: CharSet = [[0, 0x10ffff]];
/** What `.` matches without the `s` flag. */
const DOT_CHARS: CharSet = complement([
	[0x0a, 0x0a],
	[0x0d, 0x0d],
	[0x2028, 0x2029],
]);
const DIGIT_CHARS: CharSet = [[0x30, 0x39]];
const WORD_CHARS: CharSet = [
	[0x30, 0x39],
	[0x41, 0x5a],
	[0x5f, 0x5f],
	[0x61, 0x7a],
];
const SPACE_CHARS: CharSet = [
	[0x09, 0x0d],
	[0x20, 0x20],
	[0xa0, 0xa0],
	[0x1680, 0x1680],
	[0x2000, 0x200a],
	[0x2028, 0x2029],
	[0x202f, 0x202f],
	[0x205f, 0x205f],
	[0x3000, 0x3000],
	[0xfeff, 0xfeff],
];
const CLASS_ESCAPES: ReadonlyMap<string, CharSet> = new Map([
	["d", DIGIT_CHARS],
	["D", complement(DIGIT_CHARS)],
	["w", WORD_CHARS],
	["W", complement(WORD_CHARS)],
	["s", SPACE_CHARS],
	["S", complement(SPACE_CHARS)],
]);
/** Escapes for one character other than itself; `\b` is a backspace only in a class. */
const CHARACTER_ESCAPES: ReadonlyMap<string, number> = new Map([
	["0", 0x00],
	["b", 0x08],
	["t", 0x09],
	["n", 0x0a],
	["v", 0x0b],
	["f", 0x0c],
	["r", 0x0d],
]);

function charSet(ranges: readonly (readonly [number, number])[]): CharSet {
	const merged: [number, number][] = [];
	for (const [low, high] of ranges.toSorted(([a], [b]) => a - b)) {
		const last = merged.at(-1);
		if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
		else merged.push([low, high]);
	}
	return merged;
}

function complement(chars: CharSet): CharSet {
	const result: [number, number][] = [];
	let next = 0;
	for (const [low, high] of chars) {
		if (low > next) result.push([next, low - 1]);
		next = high + 1;
	}
	if (next <= 0x10ffff) result.push([next, 0x10ffff]);
	return result;
}

function intersect(a: CharSet, b: CharSet): CharSet {
	const result: [number, number][] = [];
	for (let i = 0, j = 0; i < a.length && j < b.length; ) {
		const low = Math.max(a[i]![0], b[j]![0]);
		const high = Math.min(a[i]![1], b[j]![1]);
		if (low <= high) result.push([low, high]);
		if (a[i]![1] < b[j]![1]) i++;
		else j++;
	}
	return result;
}

/** A step of one path through a pattern: a character, or a group without choices inside, as quantified. */
interface PatternStep {
	/** What each character of one repetition matches, in order. */
	readonly chars: readonly CharSet[];
	/** Whether it may match nothing. */
	readonly optional: boolean;
	/** Whether it repeats a varying number of times: `*`, `+`, `{n,}`, or `{n,m}`. */
	readonly repeating: boolean;
}

/**
 * A parsed part of a pattern: its paths, one per combination of alternatives
 * and optional groups, and whether it holds a quantifier or an alternation.
 */
interface PatternPart {
	readonly paths: PatternStep[][];
	readonly holds: boolean;
}

interface PatternScan {
	readonly source: string;
	index: number;
	repeats: number;
	choices: number;
}

interface Quantifier {
	/** `?`, `*`, `+`, or `{`; empty when unquantified. */
	readonly symbol: string;
	readonly optional: boolean;
	readonly repeating: boolean;
}

const UNQUANTIFIED: Quantifier = { symbol: "", optional: false, repeating: false };

function choose(scan: PatternScan): boolean {
	scan.choices++;
	return scan.choices <= FORM_PATTERN_MAX_CHOICES;
}

/*
 * The parsers below read a pattern that compiles with the `u` flag; each
 * returns undefined when the pattern is refused.
 */

function parseAlternatives(scan: PatternScan): PatternPart | undefined {
	const paths: PatternStep[][] = [];
	let holds = false;
	for (;;) {
		const sequence = parseSequence(scan);
		if (!sequence) return undefined;
		paths.push(...sequence.paths);
		holds ||= sequence.holds;
		if (scan.source[scan.index] !== "|") return { paths, holds };
		scan.index++;
		holds = true;
		if (!choose(scan)) return undefined;
	}
}

function parseSequence(scan: PatternScan): PatternPart | undefined {
	const { source } = scan;
	let paths: PatternStep[][] = [[]];
	let holds = false;
	while (scan.index < source.length && source[scan.index] !== "|" && source[scan.index] !== ")") {
		const term = parseTerm(scan);
		if (!term) return undefined;
		holds ||= term.holds;
		if (term.paths.length === 1) for (const path of paths) path.push(...term.paths[0]!);
		else paths = paths.flatMap((path) => term.paths.map((steps) => [...path, ...steps]));
	}
	return { paths, holds };
}

function parseTerm(scan: PatternScan): PatternPart | undefined {
	const { source } = scan;
	const char = source[scan.index];
	if (char === "^" || char === "$") {
		scan.index++;
		return { paths: [[]], holds: false };
	}
	if (char === "\\" && (source[scan.index + 1] === "b" || source[scan.index + 1] === "B")) {
		scan.index += 2;
		return { paths: [[]], holds: false };
	}
	if (char === "(") return parseGroup(scan);
	let chars: CharSet | undefined;
	if (char === "[") chars = parseClass(scan);
	else if (char === ".") {
		scan.index++;
		chars = DOT_CHARS;
	} else chars = parseCharacter(scan);
	if (!chars) return undefined;
	const quantifier = parseQuantifier(scan);
	if (!quantifier) return undefined;
	return {
		paths: [[{ chars: [chars], optional: quantifier.optional, repeating: quantifier.repeating }]],
		holds: quantifier !== UNQUANTIFIED,
	};
}

function parseGroup(scan: PatternScan): PatternPart | undefined {
	const { source } = scan;
	scan.index++;
	if (source[scan.index] === "?") {
		// Non-capturing and named groups only: no lookarounds or modifiers.
		if (source[scan.index + 1] === ":") scan.index += 2;
		else if (/^<[^=!]/.test(source.slice(scan.index + 1, scan.index + 3))) {
			const close = source.indexOf(">", scan.index);
			if (close === -1) return undefined;
			scan.index = close + 1;
		} else return undefined;
	}
	const inner = parseAlternatives(scan);
	if (!inner || source[scan.index] !== ")") return undefined;
	scan.index++;
	const quantifier = parseQuantifier(scan);
	if (!quantifier) return undefined;
	if (quantifier === UNQUANTIFIED) return inner;
	if (!inner.holds) {
		// One path of single characters, quantified as a whole.
		const chars = inner.paths[0]!.flatMap((step) => step.chars);
		return { paths: [[{ chars, optional: quantifier.optional, repeating: quantifier.repeating }]], holds: true };
	}
	// A group holding a choice may only be optional: repeating one (`(a+)+`, `(a|ab)*`) backtracks exponentially.
	if (quantifier.symbol !== "?") return undefined;
	return { paths: [...inner.paths, []], holds: true };
}

function parseQuantifier(scan: PatternScan): Quantifier | undefined {
	const { source } = scan;
	const symbol = source[scan.index];
	let quantifier: Quantifier;
	if (symbol === "?" || symbol === "*" || symbol === "+") {
		scan.index++;
		quantifier = { symbol, optional: symbol !== "+", repeating: symbol !== "?" };
	} else if (symbol === "{") {
		const bounds = /^\{(\d+)(,\d*)?\}/.exec(source.slice(scan.index));
		if (!bounds) return undefined;
		scan.index += bounds[0].length;
		quantifier = { symbol, optional: Number(bounds[1]) === 0, repeating: bounds[2] !== undefined };
	} else return UNQUANTIFIED;
	if (quantifier.repeating && ++scan.repeats > FORM_PATTERN_MAX_REPEATS) return undefined;
	if ((quantifier.repeating || symbol === "?") && !choose(scan)) return undefined;
	if (source[scan.index] === "?") {
		// Lazy: one more choice point.
		scan.index++;
		if (!choose(scan)) return undefined;
	}
	return quantifier;
}

/** A class holding a Unicode property is taken, negated or not, to match any character. */
function parseClass(scan: PatternScan): CharSet | undefined {
	const { source } = scan;
	scan.index++;
	const negated = source[scan.index] === "^";
	if (negated) scan.index++;
	const ranges: (readonly [number, number])[] = [];
	let property = false;
	while (source[scan.index] !== "]") {
		if (scan.index >= source.length) return undefined;
		property ||= /^\\[pP]/.test(source.slice(scan.index, scan.index + 2));
		const low = parseCharacter(scan);
		if (!low) return undefined;
		if (
			source[scan.index] === "-" &&
			source[scan.index + 1] !== "]" &&
			low.length === 1 &&
			low[0]![0] === low[0]![1]
		) {
			scan.index++;
			const high = parseCharacter(scan);
			if (!high) return undefined;
			ranges.push([low[0]![0], high.at(-1)![1]]);
		} else ranges.push(...low);
	}
	scan.index++;
	if (property) return ANY_CHAR;
	return negated ? complement(charSet(ranges)) : charSet(ranges);
}

/** A literal character or an escape; a Unicode property is taken to match any character. */
function parseCharacter(scan: PatternScan): CharSet | undefined {
	const { source } = scan;
	if (source[scan.index] !== "\\") {
		const code = source.codePointAt(scan.index)!;
		scan.index += code > 0xffff ? 2 : 1;
		return [[code, code]];
	}
	const kind = source[scan.index + 1]!;
	scan.index += 2;
	const escaped = CLASS_ESCAPES.get(kind);
	if (escaped) return escaped;
	if (/[1-9k]/.test(kind)) return undefined; // a backreference
	if (kind === "p" || kind === "P") {
		const close = source.indexOf("}", scan.index);
		if (close === -1) return undefined;
		scan.index = close + 1;
		return ANY_CHAR;
	}
	let code = CHARACTER_ESCAPES.get(kind) ?? kind.codePointAt(0)!;
	if (kind === "c") code = source.charCodeAt(scan.index++) % 32;
	else if (kind === "x" || kind === "u") {
		const parsed = parseHexEscape(scan, kind);
		if (parsed === undefined) return undefined;
		code = parsed;
	}
	return [[code, code]];
}

/** The code point of a `\xHH`, `\uHHHH`, or `\u{H...}` escape, after its `x` or `u`. */
function parseHexEscape(scan: PatternScan, kind: "x" | "u"): number | undefined {
	const { source } = scan;
	if (kind === "u" && source[scan.index] === "{") {
		const close = source.indexOf("}", scan.index);
		if (close === -1) return undefined;
		const code = Number.parseInt(source.slice(scan.index + 1, close), 16);
		scan.index = close + 1;
		return code;
	}
	const digits = kind === "x" ? 2 : 4;
	const code = Number.parseInt(source.slice(scan.index, scan.index + digits), 16);
	scan.index += digits;
	if (kind === "x" || code < 0xd800 || code > 0xdbff) return code;
	// An escaped surrogate pair is one character.
	const trail = /^\\u(d[c-f][0-9a-f]{2})/i.exec(source.slice(scan.index, scan.index + 6));
	if (!trail) return code;
	scan.index += 6;
	return 0x10000 + ((code - 0xd800) << 10) + (Number.parseInt(trail[1]!, 16) - 0xdc00);
}

/**
 * Whether two repeating steps of a path can trade characters: some character
 * matches both, and every step between them may match nothing or such a
 * character. A value that fails such a path is backtracked through every way
 * of splitting a run of those characters among the steps (`a*a*`, `\w+.\w+`),
 * quadratic in the value's length for two steps and cubic for three.
 */
function tradesCharacters(path: readonly PatternStep[]): boolean {
	for (let first = 0; first < path.length; first++) {
		if (!path[first]!.repeating) continue;
		const firstChars = charSet(path[first]!.chars.flat());
		for (let second = first + 1; second < path.length; second++) {
			if (!path[second]!.repeating) continue;
			const shared = intersect(firstChars, charSet(path[second]!.chars.flat()));
			if (shared.length === 0) continue;
			const passable = path
				.slice(first + 1, second)
				.every((step) => step.optional || step.chars.every((chars) => intersect(chars, shared).length > 0));
			if (passable) return true;
		}
	}
	return false;
}

/**
 * Whether a form field pattern is cheap to test against any value a client
 * may send. It must compile, have no backreferences or lookarounds, repeat no
 * group that itself repeats or alternates (no `(a+)+`, `(a|ab)*`), hold at
 * most four choice points (quantifiers, optionals, and alternatives), at most
 * three of them repeating, and no path through it may hold two repeating
 * steps that trade characters (no `a*a*`, `a+.a+`; see `tradesCharacters`).
 * Then any prefix of a value matches the pattern's start in a number of ways
 * bounded by the pattern alone, so backtracking stays linear in the value's
 * length (at most 256 characters). A client answers forms with values of its
 * choosing, so another pattern is refused when the form is asked.
 */
export function isSafeFormPattern(pattern: string): boolean {
	if (pattern.length > FORM_PATTERN_MAX_CHARS) return false;
	try {
		new RegExp(`^(?:${pattern})$`, "u");
	} catch {
		return false;
	}
	const scan: PatternScan = { source: pattern, index: 0, repeats: 0, choices: 0 };
	const parsed = parseAlternatives(scan);
	return parsed !== undefined && scan.index === pattern.length && !parsed.paths.some(tradesCharacters);
}

function isFormValue(field: UiNodeFormField, value: string | boolean | number): boolean {
	switch (field.kind) {
		case "string": {
			if (typeof value !== "string") return false;
			const length = [...value].length;
			if (field.minLength !== undefined && length < field.minLength) return false;
			if (field.maxLength !== undefined && length > field.maxLength) return false;
			if (field.pattern === undefined) return true;
			if (length > FORM_PATTERN_VALUE_MAX_CHARS || !isSafeFormPattern(field.pattern)) return false;
			try {
				return new RegExp(`^(?:${field.pattern})$`, "u").test(value);
			} catch {
				return false;
			}
		}
		case "boolean":
			return typeof value === "boolean";
		case "enum":
			return typeof value === "string" && field.options.some((option) => option.value === value);
		case "integer":
			return (
				Number.isSafeInteger(value) &&
				(field.min === undefined || (value as number) >= field.min) &&
				(field.max === undefined || (value as number) <= field.max)
			);
	}
}

function isFormAnswer(
	fields: readonly UiNodeFormField[],
	values: Readonly<Record<string, string | boolean | number>>,
): boolean {
	const byId = new Map(fields.map((field) => [field.id, field]));
	for (const [id, value] of Object.entries(values)) {
		const field = byId.get(id);
		if (!field || !isFormValue(field, value)) return false;
	}
	return fields.every((field) => field.kind === "boolean" || !field.required || Object.hasOwn(values, field.id));
}

/** Whether `response` answers `request`: a cancellation, or an answer of the request's shape. */
function answers(request: HostRequest, response: HostResponse): boolean {
	if (!isHostResponse(response)) return false;
	if ("cancelled" in response) return true;
	switch (request.kind) {
		case "select":
			return "value" in response && request.options.includes(response.value);
		case "input":
		case "editor":
			return "value" in response;
		case "confirm":
			return "confirmed" in response;
		case "approval":
			return "decision" in response;
		case "form":
			return "values" in response && isFormAnswer(request.fields, response.values);
		case "mcp_auth":
			// An authorization completes through its own intents; a client can only dismiss it.
			return false;
	}
}

const HOST_ACTION_CANCEL_MESSAGES: Record<Exclude<HostRequestCancelReason, "unavailable">, string> = {
	aborted: "Host action cancelled",
	timeout: "Host action timed out",
	closed: "The conversation closed",
};

/** A whole-millisecond timeout, or none for an absent, non-positive, or non-finite one. */
export function hostRequestTimeout(timeout: number | undefined): { timeoutMs?: number } {
	return timeout !== undefined && Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: Math.ceil(timeout) } : {};
}

const STREAMING_ITEM_TYPES: ReadonlySet<LiveItem["type"]> = new Set([
	"assistant_start",
	"assistant_delta",
	"assistant_end",
	"tool",
]);

export class LiveState {
	private readonly head: () => number;
	private fold: LiveFoldState = emptyLiveFold();
	/** The `basedOn` of the last published batch. */
	private publishedBasedOn = -1;
	private readonly clients = new Map<string, AttachedClient>();
	private readonly pending = new Map<string, PendingEntry>();
	/** Published batches not yet delivered to every client, in order. */
	private readonly outbox: Array<{
		readonly seq: number;
		readonly basedOn: number;
		readonly items: readonly LiveItem[];
	}> = [];
	private nextSeq = 0;
	private delivering = false;
	private closed = false;
	private interaction: HostInteraction | undefined;

	constructor(options: LiveStateOptions = {}) {
		this.head = options.head ?? (() => 0);
	}

	/** The current value under `key`. */
	get(key: string): LiveValue | undefined {
		return this.fold.values.get(key);
	}

	/** Every current value, in the order its key was first set. */
	entries(): Array<[string, LiveValue]> {
		return [...this.fold.values];
	}

	/** The whole state: keyed values and what streams, as of the last published change. */
	snapshot(): LiveFoldState {
		return this.fold;
	}

	/**
	 * Attach a client under `clientId`: it receives the current values it may
	 * see as a reset, then every change. The returned function detaches it.
	 */
	attach(clientId: string, client: LiveClient): () => void {
		if (this.clients.has(clientId)) throw new Error(`Live client ${clientId} is already attached`);
		const attached: AttachedClient = { id: clientId, client, since: this.nextSeq, shown: new Set() };
		if (this.closed) {
			this.deliver(attached, { reset: true, basedOn: this.readHead(), items: [] });
			return () => {};
		}
		this.clients.set(clientId, attached);
		const items: LiveItem[] = [];
		for (const [key, value] of this.fold.values) {
			const gate = gateOf(key, value);
			if (gate !== undefined) {
				if (!acceptsKind(client, gate)) continue;
				attached.shown.add(key);
			}
			items.push({ type: "set", key, value });
		}
		items.push(...liveStreamingItems(this.fold));
		this.deliver(attached, { reset: true, basedOn: this.readHead(), items });
		return () => {
			if (this.clients.get(clientId) !== attached) return;
			this.clients.delete(clientId);
			this.deliver(attached, { reset: true, basedOn: this.readHead(), items: [] });
		};
	}

	/** Whether an attached client accepts host requests of `kind`. */
	accepts(kind: HostRequestKind): boolean {
		for (const attached of this.clients.values()) {
			if (acceptsKind(attached.client, kind)) return true;
		}
		return false;
	}

	/** Set or replace the value under `key`. Host requests are set through `request`. */
	set(key: string, value: LiveValue): void {
		if (value.kind === "host_request") throw new TypeError("Host requests are asked through request()");
		if (!keyFits(key, value)) throw new TypeError(`Invalid live key ${JSON.stringify(key)} for ${value.kind}`);
		if (!isLiveValue(value)) throw new TypeError(`Invalid ${value.kind} live value`);
		if (this.closed) return;
		this.publish([{ type: "set", key, value }]);
	}

	/** Remove the value under `key`, if any. A pending host request ends through its own lifecycle. */
	clear(key: string): void {
		if (key.startsWith("host_request/")) throw new TypeError("Host requests end when answered or cancelled");
		if (this.closed || !this.fold.values.has(key)) return;
		this.publish([{ type: "clear", key }]);
	}

	/** Remove every value whose key starts with one of `prefixes`. */
	clearMatching(prefixes: readonly string[]): void {
		if (this.closed) return;
		const items: LiveItem[] = [];
		for (const key of this.fold.values.keys()) {
			if (!key.startsWith("host_request/") && prefixes.some((prefix) => key.startsWith(prefix))) {
				items.push({ type: "clear", key });
			}
		}
		if (items.length > 0) this.publish(items);
	}

	/** Tell the attached clients something: a notification or an error. */
	notice(level: "info" | "warning" | "error", message: string, source?: string): void {
		if (this.closed) return;
		this.publish([{ type: "notice", level, message, ...(source === undefined ? {} : { source }) }]);
	}

	/** Ask the attached interactive clients to replace their editor text. */
	setEditorText(text: string): void {
		if (this.closed) return;
		this.publish([{ type: "directive", directive: "set_editor_text", text }]);
	}

	/** Publish streaming items: the streaming assistant message and tool progress. */
	stream(items: readonly LiveItem[]): void {
		if (items.some((item) => !STREAMING_ITEM_TYPES.has(item.type))) {
			throw new TypeError("Only assistant and tool items stream");
		}
		if (this.closed || items.length === 0) return;
		this.publish(items);
	}

	/**
	 * An entry committed what streamed: the assistant message, or a tool's
	 * result. It leaves the streaming state without a delivery, as each client
	 * drops it when it applies the entry.
	 */
	commit(commit: LiveCommit): void {
		if (this.closed) return;
		this.fold = foldLiveCommit(this.fold, commit);
	}

	/**
	 * Ask the attached clients that accept `request`'s kind. Resolves with the
	 * first valid answer, or cancelled. Rejects for a malformed request or the
	 * id of a pending one.
	 */
	request(request: HostRequest, options: HostRequestOptions = {}): Promise<HostRequestOutcome> {
		const requestId = options.id ?? randomUUID();
		if (!isRequestId(requestId)) {
			return Promise.reject(new TypeError(`Invalid host request id ${JSON.stringify(requestId)}`));
		}
		const value: LiveValue = { kind: "host_request", requestId, request };
		if (!isLiveValue(value)) return Promise.reject(new TypeError(`Invalid ${request.kind} host request`));
		if (
			request.kind === "form" &&
			request.fields.some(
				(field) => field.kind === "string" && field.pattern !== undefined && !isSafeFormPattern(field.pattern),
			)
		) {
			return Promise.reject(
				new TypeError("A form field pattern must not repeat a repeating group or use backreferences"),
			);
		}
		if (this.closed) return Promise.resolve({ status: "cancelled", reason: "closed" });
		const signal = options.signal;
		if (signal?.aborted) return Promise.resolve({ status: "cancelled", reason: "aborted" });
		if (options.unattended !== true && !this.accepts(request.kind)) {
			return Promise.resolve({ status: "cancelled", reason: "unavailable" });
		}
		if (this.pending.has(requestId)) {
			return Promise.reject(new Error(`Host request ${JSON.stringify(requestId)} is already pending`));
		}
		return new Promise((resolve) => {
			const entry: PendingEntry = {
				requestId,
				request,
				resolve,
				signal,
				onAbort: () => this.settle(entry, { status: "cancelled", reason: "aborted" }),
				timer: undefined,
				settled: false,
			};
			signal?.addEventListener("abort", entry.onAbort, { once: true });
			const timeoutMs = "timeoutMs" in request ? request.timeoutMs : undefined;
			if (timeoutMs !== undefined && timeoutMs > 0) {
				entry.timer = setTimeout(() => this.settle(entry, { status: "cancelled", reason: "timeout" }), timeoutMs);
				entry.timer.unref?.();
			}
			this.pending.set(requestId, entry);
			this.publish([{ type: "set", key: liveKey("host_request", requestId), value }]);
		});
	}

	/** The pending host request `requestId`, if any. */
	pendingRequest(requestId: string): PendingHostRequest | undefined {
		const entry = this.pending.get(requestId);
		return entry === undefined ? undefined : { requestId: entry.requestId, request: entry.request };
	}

	/** Every pending host request, oldest first. */
	pendingRequests(): PendingHostRequest[] {
		return [...this.pending.values()].map((entry) => ({ requestId: entry.requestId, request: entry.request }));
	}

	/**
	 * Answer `requestId` for the attached client `clientId`. The client must
	 * accept the request's kind and the response must fit the request; the first
	 * accepted answer ends the request, and later answers find it unknown.
	 */
	answer(requestId: string, response: HostResponse, clientId: string): HostAnswerResult {
		const attached = this.clients.get(clientId);
		if (!attached) return "not_allowed";
		const entry = this.pending.get(requestId);
		if (!entry) return "unknown";
		if (!acceptsKind(attached.client, entry.request.kind)) return "not_allowed";
		if (!answers(entry.request, response)) return "invalid";
		this.settle(entry, { status: "answered", response, clientId });
		return "accepted";
	}

	/**
	 * Approvals and host action progress through this live state: a request is
	 * an `approval` host request under the action's id, and progress is
	 * `host_action/<id>`, cleared once the action finished.
	 */
	get hostInteraction(): HostInteraction {
		this.interaction ??= {
			requestAction: (request, options) => this.requestAction(request, options?.signal),
			updateAction: (update) => this.updateAction(update),
		};
		return this.interaction;
	}

	private async requestAction(
		request: HostActionRequest,
		signal: AbortSignal | undefined,
	): Promise<HostActionDecision> {
		const outcome = await this.request(
			{
				kind: "approval",
				action: request.action,
				title: request.title,
				...(request.message === undefined ? {} : { message: request.message }),
				...(request.confirmLabel === undefined ? {} : { confirmLabel: request.confirmLabel }),
				...(request.cancelLabel === undefined ? {} : { cancelLabel: request.cancelLabel }),
				...(request.commandPreview === undefined ? {} : { commandPreview: request.commandPreview }),
				...(request.blocking === undefined ? {} : { blocking: request.blocking }),
				...(request.destructive === undefined ? {} : { destructive: request.destructive }),
				...(request.metadata === undefined ? {} : { metadata: request.metadata }),
				...hostRequestTimeout(request.timeoutMs),
			},
			{ id: request.id, ...(signal === undefined ? {} : { signal }) },
		);
		if (outcome.status === "cancelled") {
			return outcome.reason === "unavailable"
				? { decision: "unavailable" }
				: { decision: "dismissed", message: HOST_ACTION_CANCEL_MESSAGES[outcome.reason] };
		}
		const response = outcome.response;
		if (!("decision" in response)) return { decision: "dismissed" };
		return { decision: response.decision, ...(response.message === undefined ? {} : { message: response.message }) };
	}

	private updateAction(update: HostActionUpdate): void {
		const key = liveKey("host_action", update.id);
		const value: LiveValue = {
			kind: "host_action",
			action: update.action,
			status: update.status,
			...(update.message === undefined ? {} : { message: update.message }),
			...(update.exitCode === undefined ? {} : { exitCode: update.exitCode }),
		};
		if (!keyFits(key, value) || !isLiveValue(value)) throw new TypeError(`Invalid host action update ${update.id}`);
		if (this.closed) return;
		// A finished action's last status reaches the clients; nothing of it stays.
		this.publish(
			HOST_ACTION_TERMINAL_STATUSES.has(update.status)
				? [
						{ type: "set", key, value },
						{ type: "clear", key },
					]
				: [{ type: "set", key, value }],
		);
	}

	/** End every pending request, clear every value, and detach every client. Later calls do nothing. */
	close(): void {
		if (this.closed) return;
		for (const entry of [...this.pending.values()]) this.settle(entry, { status: "cancelled", reason: "closed" });
		this.closed = true;
		this.fold = emptyLiveFold(this.fold.basedOn);
		const clients = [...this.clients.values()];
		this.clients.clear();
		const basedOn = this.readHead();
		for (const attached of clients) this.deliver(attached, { reset: true, basedOn, items: [] });
	}

	private settle(entry: PendingEntry, outcome: HostRequestOutcome): void {
		if (entry.settled) return;
		entry.settled = true;
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.signal?.removeEventListener("abort", entry.onAbort);
		try {
			if (this.pending.get(entry.requestId) === entry) {
				this.pending.delete(entry.requestId);
				this.publish([{ type: "clear", key: liveKey("host_request", entry.requestId) }]);
			}
		} finally {
			// The requester learns the outcome whatever happens to its delivery.
			entry.resolve(outcome);
		}
	}

	/**
	 * Apply `items` and deliver them to every attached client. A client that
	 * answers or changes the state while a batch is delivered sees its own
	 * change after that batch, as every other client does.
	 */
	private publish(items: readonly LiveItem[]): void {
		const basedOn = this.readHead();
		// Clients discard streaming items when `basedOn` changes: repeat what still streams.
		const resync =
			basedOn !== this.publishedBasedOn && isLiveStreaming(this.fold) ? liveStreamingItems(this.fold) : [];
		this.publishedBasedOn = basedOn;
		this.fold = foldLiveItems({ ...this.fold, basedOn }, items);
		this.outbox.push({ seq: this.nextSeq++, basedOn, items: resync.length === 0 ? items : [...resync, ...items] });
		if (this.delivering) return;
		this.delivering = true;
		try {
			for (let batch = this.outbox.shift(); batch !== undefined; batch = this.outbox.shift()) {
				for (const attached of [...this.clients.values()]) {
					if (batch.seq < attached.since || this.clients.get(attached.id) !== attached) continue;
					const visible = this.visible(attached, batch.items);
					if (visible.length > 0) {
						this.deliver(attached, { reset: false, basedOn: batch.basedOn, items: visible });
					}
				}
			}
		} finally {
			this.delivering = false;
		}
	}

	/** The log position; a failing source reads as the last published position. */
	private readHead(): number {
		try {
			return this.head();
		} catch {
			return Math.max(0, this.publishedBasedOn);
		}
	}

	/** The part of `items` `attached` may see; a gated value it no longer may see is cleared for it. */
	private visible(attached: AttachedClient, items: readonly LiveItem[]): LiveItem[] {
		const visible: LiveItem[] = [];
		for (const item of items) {
			if (item.type === "set") {
				const gate = gateOf(item.key, item.value);
				if (gate === undefined) {
					visible.push(item);
				} else if (acceptsKind(attached.client, gate)) {
					attached.shown.add(item.key);
					visible.push(item);
				} else if (attached.shown.delete(item.key)) {
					visible.push({ type: "clear", key: item.key });
				}
			} else if (item.type === "clear" && isGatedKey(item.key)) {
				if (attached.shown.delete(item.key)) visible.push(item);
			} else {
				visible.push(item);
			}
		}
		return visible;
	}

	private deliver(attached: AttachedClient, update: LiveUpdate): void {
		try {
			attached.client.apply(update);
		} catch {
			// A client's failure to show live state never reaches the host or the other clients.
		}
	}
}

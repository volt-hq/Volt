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

/** A change to a client's live state; with `reset`, `items` replace everything the client held. */
export interface LiveUpdate {
	readonly reset: boolean;
	readonly items: readonly LiveItem[];
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
	/** Every client that could answer it stopped accepting its kind. */
	| "declined"
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

function isFormValue(field: UiNodeFormField, value: string | boolean | number): boolean {
	switch (field.kind) {
		case "string": {
			if (typeof value !== "string") return false;
			const length = [...value].length;
			if (field.minLength !== undefined && length < field.minLength) return false;
			if (field.maxLength !== undefined && length > field.maxLength) return false;
			if (field.pattern === undefined) return true;
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
	declined: "No client accepts host actions",
	aborted: "Host action cancelled",
	timeout: "Host action timed out",
	closed: "The conversation closed",
};

/** A whole-millisecond timeout, or none for an absent, non-positive, or non-finite one. */
export function hostRequestTimeout(timeout: number | undefined): { timeoutMs?: number } {
	return timeout !== undefined && Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: Math.ceil(timeout) } : {};
}

export class LiveState {
	private readonly values = new Map<string, LiveValue>();
	private readonly clients = new Map<string, AttachedClient>();
	private readonly pending = new Map<string, PendingEntry>();
	/** Published batches not yet delivered to every client, in order. */
	private readonly outbox: Array<{ readonly seq: number; readonly items: readonly LiveItem[] }> = [];
	private nextSeq = 0;
	private delivering = false;
	private closed = false;
	private interaction: HostInteraction | undefined;

	/** The current value under `key`. */
	get(key: string): LiveValue | undefined {
		return this.values.get(key);
	}

	/** Every current value, in the order its key was first set. */
	entries(): Array<[string, LiveValue]> {
		return [...this.values];
	}

	/**
	 * Attach a client under `clientId`: it receives the current values it may
	 * see as a reset, then every change. The returned function detaches it.
	 */
	attach(clientId: string, client: LiveClient): () => void {
		if (this.clients.has(clientId)) throw new Error(`Live client ${clientId} is already attached`);
		const attached: AttachedClient = { id: clientId, client, since: this.nextSeq, shown: new Set() };
		if (this.closed) {
			this.deliver(attached, { reset: true, items: [] });
			return () => {};
		}
		this.clients.set(clientId, attached);
		const items: LiveItem[] = [];
		for (const [key, value] of this.values) {
			const gate = gateOf(key, value);
			if (gate !== undefined) {
				if (!acceptsKind(client, gate)) continue;
				attached.shown.add(key);
			}
			items.push({ type: "set", key, value });
		}
		this.deliver(attached, { reset: true, items });
		return () => {
			if (this.clients.get(clientId) !== attached) return;
			this.clients.delete(clientId);
			this.deliver(attached, { reset: true, items: [] });
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
		if (this.closed || !this.values.has(key)) return;
		this.publish([{ type: "clear", key }]);
	}

	/** Remove every value whose key starts with one of `prefixes`. */
	clearMatching(prefixes: readonly string[]): void {
		if (this.closed) return;
		const items: LiveItem[] = [];
		for (const key of this.values.keys()) {
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

	/** End the pending requests (of `kind`, or every kind) that no attached client accepts any more. */
	cancelUnanswerable(kind?: HostRequestKind): void {
		for (const entry of [...this.pending.values()]) {
			if (entry.request.kind === "mcp_auth" || (kind !== undefined && entry.request.kind !== kind)) continue;
			if (!this.accepts(entry.request.kind)) this.settle(entry, { status: "cancelled", reason: "declined" });
		}
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
		this.values.clear();
		const clients = [...this.clients.values()];
		this.clients.clear();
		for (const attached of clients) this.deliver(attached, { reset: true, items: [] });
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
		for (const item of items) {
			if (item.type === "set") this.values.set(item.key, item.value);
			else if (item.type === "clear") this.values.delete(item.key);
		}
		this.outbox.push({ seq: this.nextSeq++, items });
		if (this.delivering) return;
		this.delivering = true;
		try {
			for (let batch = this.outbox.shift(); batch !== undefined; batch = this.outbox.shift()) {
				for (const attached of [...this.clients.values()]) {
					if (batch.seq < attached.since || this.clients.get(attached.id) !== attached) continue;
					const visible = this.visible(attached, batch.items);
					if (visible.length > 0) this.deliver(attached, { reset: false, items: visible });
				}
			}
		} finally {
			this.delivering = false;
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

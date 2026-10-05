/**
 * The work a hosted conversation runs (RFC §7): one registry per
 * conversation.
 *
 * A kind declares how its work behaves: its notice delivery, whether a
 * client may cancel it, whether it survives a restart (a kind that can
 * `resume`), how many items run at once, its title, what of its input the
 * log keeps, and how a client opens it. `start` records the work, then runs
 * its executor; every change is a `work_*` entry the conversation's kernel
 * writes, so only the host writes work. The registry holds the executors of
 * the work this runtime runs; open work without one is suspended (resumable
 * work after a restart) until `resume` attaches an executor or `cancel`
 * finishes it.
 *
 * Durable checkpoints are coarse: a state transition (cancelling, resumed)
 * is written at once, a kind phase at most once every
 * {@link WORK_CHECKPOINT_INTERVAL_MS} (a later phase replaces one still
 * waiting, and a finish drops it). Fine-grained progress and output reach
 * clients through the live `work/<workId>` value (live.ts); a finished
 * item's notice follows its kind's delivery (delivery.ts).
 *
 * Closing the conversation stops every executor: resumable work stays open,
 * suspended on the next open, and other work finishes `interrupted`. A
 * runtime that ended without closing leaves its work open for the next open
 * to reconcile.
 */

import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
	ConversationError,
	type ConversationState,
	type ConversationWork,
	type ConversationWorkFinish,
	type WorkRecord,
} from "@hansjm10/volt-agent-core";
import type { JsonValue } from "@hansjm10/volt-ai";
import {
	BUILTIN_WORK_KINDS,
	EXTENSION_WORK_KIND_PATTERN,
	type UiNode,
	WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
	WORK_OUTPUT_MAX_UTF8_BYTES,
	WORK_TEXT_MAX_CHARS,
	WORK_TITLE_MAX_CHARS,
	type WorkChild,
	type WorkDelivery,
	type WorkKind,
	type WorkProgress,
	type WorkResult,
	workPayloadBoundsError,
} from "@hansjm10/volt-protocol";
import type { ConversationHost } from "../host/conversation-host.ts";
import type { LiveState } from "../host/live-state.ts";
import type { HostClient } from "../host/targets.ts";
import { WorkDeliveries } from "./delivery.ts";
import { WorkLiveFeed } from "./live.ts";

/** The least time between two durable phase checkpoints of one item. */
export const WORK_CHECKPOINT_INTERVAL_MS = 10_000;

/** How long closing waits for executors to stop before it finishes their work without them. */
export const WORK_CLOSE_GRACE_MS = 2_000;

/** Work ids the registry accepts: they name live keys and appear in notices. */
const WORK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const EXTENSION_WORK_KIND = new RegExp(EXTENSION_WORK_KIND_PATTERN);
const BUILTIN_KINDS: ReadonlySet<string> = new Set(BUILTIN_WORK_KINDS);

// ============================================================================
// Kinds and executors
// ============================================================================

/** How an executor ended the work. Only the registry ends work `interrupted`. */
export interface WorkExecution {
	readonly outcome: "completed" | "failed" | "cancelled";
	readonly result?: WorkResult;
	readonly error?: string;
}

/** What an executor reports through. */
export interface WorkContext {
	readonly workId: string;
	/** Aborted when the work is cancelled or the conversation closes. */
	readonly signal: AbortSignal;
	/** Fine-grained progress: the live value only, coalesced. */
	progress(progress: WorkProgress, detail?: UiNode): void;
	/** A kind phase: live at once, and durable as a coarse checkpoint at most every {@link WORK_CHECKPOINT_INTERVAL_MS}. */
	checkpoint(progress: WorkProgress, detail?: UiNode): void;
	/** Output: its newest {@link WORK_OUTPUT_MAX_UTF8_BYTES} become the result's output unless the execution names its own. */
	output(text: string): void;
}

export type WorkExecutor = (ctx: WorkContext) => Promise<WorkExecution>;

/** Who opens work: the client and the host it is attached through. */
export interface WorkOpenContext {
	readonly host: ConversationHost;
	readonly client: HostClient;
	/** Recheck the caller's authority before a mutation; throws when stale. */
	readonly assertCurrent?: () => void;
}

/**
 * What opening work did: named the conversation the work runs in for the
 * client to subscribe to, moved the client to a conversation, or was
 * cancelled.
 */
export type WorkOpened = { readonly conversation: string; readonly moved: boolean } | { readonly cancelled: true };

export interface WorkKindDefinition {
	readonly kind: WorkKind;
	readonly delivery: WorkDelivery;
	/** Whether a client may cancel the kind's work. */
	readonly cancellable: boolean;
	/** The kind's work starts awaiting approval instead of running. */
	readonly approval?: boolean;
	/** `tool_grant`: the kind's work starts only from a tool call, under that call's grant. */
	readonly scoped?: "tool_grant";
	/** Most items of the kind running at once in the conversation. */
	readonly maxActive: number;
	/** The one-line title lists and notices show. */
	title(input: JsonValue): string;
	/** The input the log keeps, when it must not be what the executor took. */
	redactInput?(input: JsonValue): JsonValue;
	/** Open the conversation an item runs in or produced. */
	open?(item: WorkRecord, ctx: WorkOpenContext): Promise<WorkOpened>;
	/**
	 * Continue suspended work. A kind that declares it is resumable: its open
	 * work survives a restart suspended instead of interrupted.
	 */
	resume?(item: WorkRecord): WorkExecutor;
	/** Output of running work the kind keeps itself instead of reporting it through `output`. */
	output?(workId: string): string | undefined;
}

export interface WorkStartOptions {
	/** The work that started this one. */
	readonly parentWorkId?: string;
	/** The tool call that started it. */
	readonly toolCallId?: string;
	/** The conversation it runs in. */
	readonly child?: WorkChild;
	/** A caller's id, such as a subagent's; generated by default. */
	readonly workId?: string;
	/** `awaiting_approval` by default for kinds that need approval, else `running`. */
	readonly state?: "running" | "awaiting_approval";
}

export type WorkErrorCode =
	| "unknown_kind"
	| "unknown_work"
	| "invalid"
	| "limit"
	| "finished"
	| "running"
	| "not_cancellable"
	| "not_resumable"
	| "unavailable"
	| "closed";

export class WorkError extends Error {
	readonly code: WorkErrorCode;

	constructor(code: WorkErrorCode, message: string) {
		super(message);
		this.name = "WorkError";
		this.code = code;
	}
}

/** A work item's output: what running work produced so far, or what its result kept. */
export interface WorkOutput {
	readonly text: string;
	/** Older output was dropped; only the newest is kept. */
	readonly truncated: boolean;
	/** The work finished: its output no longer changes. */
	readonly final: boolean;
}

/** What a registry reads and writes through. */
export interface WorkRegistryHost {
	/** The conversation kernel's work writes. */
	work(): ConversationWork;
	/** The conversation's fold, which holds the work records. */
	state(): Pick<ConversationState, "work">;
	/** The live state the `work/<workId>` values go to. */
	live(): LiveState;
	/** The turn running now: work started meanwhile belongs to it, and a stop of it fences its notices. */
	turnId(): string | undefined;
}

// ============================================================================
// Text and output bounds
// ============================================================================

/** `text` within `max` UTF-16 code units, an ellipsis marking a cut. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${text.slice(0, end)}…`;
}

/** Text a client renders: no terminal control sequences, at most `max` characters. */
export function workText(text: string, max = WORK_TEXT_MAX_CHARS): string {
	const plain = stripVTControlCharacters(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
	return truncate(plain, max);
}

/** One non-empty line without control characters, at most {@link WORK_TITLE_MAX_CHARS}. */
function workTitle(text: string, fallback: string): string {
	const line = stripVTControlCharacters(text)
		.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, " ")
		.trim();
	return truncate(line.length > 0 ? line : fallback, WORK_TITLE_MAX_CHARS);
}

/** The newest {@link WORK_OUTPUT_MAX_UTF8_BYTES} of `text`, starting at a character. */
function outputTail(text: string, truncated: boolean): { text: string; truncated: boolean } {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= WORK_OUTPUT_MAX_UTF8_BYTES) return { text, truncated };
	let start = buffer.byteLength - WORK_OUTPUT_MAX_UTF8_BYTES;
	while (start < buffer.byteLength && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++;
	return { text: buffer.subarray(start).toString("utf8"), truncated: true };
}

/** The output running work reported, kept to its newest bytes. */
class OutputTail {
	private text = "";
	private bytes = 0;
	private truncated = false;
	/** Every byte reported, older output included. */
	received = 0;

	append(text: string): void {
		if (text.length === 0) return;
		const bytes = Buffer.byteLength(text, "utf8");
		this.received += bytes;
		this.text += text;
		this.bytes += bytes;
		// Cut in batches, so a stream of small writes stays linear.
		if (this.bytes > 2 * WORK_OUTPUT_MAX_UTF8_BYTES) this.cut();
	}

	snapshot(): { text: string; truncated: boolean } {
		this.cut();
		return { text: this.text, truncated: this.truncated };
	}

	private cut(): void {
		if (this.bytes <= WORK_OUTPUT_MAX_UTF8_BYTES) return;
		const tail = outputTail(this.text, true);
		this.text = tail.text;
		this.bytes = Buffer.byteLength(tail.text, "utf8");
		this.truncated = true;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whether an executor returned an execution: kinds may be extension code. */
function isExecution(value: unknown): value is WorkExecution {
	if (typeof value !== "object" || value === null) return false;
	const outcome = (value as { readonly outcome?: unknown }).outcome;
	return outcome === "completed" || outcome === "failed" || outcome === "cancelled";
}

// ============================================================================
// Registry
// ============================================================================

interface Phase {
	readonly progress: WorkProgress;
	readonly detail?: UiNode;
}

/** Work this runtime runs: its executor and what the registry tracks for it. */
interface ActiveWork {
	readonly workId: string;
	readonly definition: WorkKindDefinition;
	readonly controller: AbortController;
	readonly turnId: string | undefined;
	readonly output: OutputTail;
	readonly done: PromiseWithResolvers<void>;
	/** The registry's writes of this item, in order: a cancel's checkpoint commits before the finish. */
	writes: Promise<unknown>;
	/** A cancel was requested. */
	cancelling: boolean;
	/** The conversation is closing: a cancelled execution leaves resumable work open and interrupts other work. */
	closing: boolean;
	/** Its turn was fenced: the work finishes without a notice. */
	fenced: boolean;
	/** The executor's outcome no longer counts: the work is being finished, or was left. */
	detached: boolean;
	lastCheckpoint: number;
	pendingPhase?: Phase;
	checkpointTimer?: ReturnType<typeof setTimeout>;
}

export class WorkRegistry {
	private readonly host: WorkRegistryHost;
	private readonly kinds = new Map<string, WorkKindDefinition>();
	private readonly active = new Map<string, ActiveWork>();
	/** Starts admitted but not yet attached, by kind: they count against `maxActive`. */
	private readonly starting = new Map<string, number>();
	private readonly deliveries = new WorkDeliveries();
	private readonly liveFeed: WorkLiveFeed;
	private closed = false;

	constructor(host: WorkRegistryHost) {
		this.host = host;
		this.liveFeed = new WorkLiveFeed(() => host.live());
	}

	/** Register a kind; the returned function removes it. Work it runs keeps running. */
	register(definition: WorkKindDefinition): () => void {
		if (!BUILTIN_KINDS.has(definition.kind) && !EXTENSION_WORK_KIND.test(definition.kind)) {
			throw new WorkError("invalid", `Invalid work kind ${JSON.stringify(definition.kind)}`);
		}
		if (!Number.isSafeInteger(definition.maxActive) || definition.maxActive < 1) {
			throw new WorkError("invalid", `Work kind ${definition.kind} must allow at least one running item`);
		}
		if (this.kinds.has(definition.kind)) {
			throw new WorkError("invalid", `Work kind ${definition.kind} is already registered`);
		}
		this.kinds.set(definition.kind, definition);
		return () => {
			if (this.kinds.get(definition.kind) === definition) this.kinds.delete(definition.kind);
		};
	}

	/**
	 * Settle the open work a previous runtime left (once per runtime): the
	 * conversation's kernel finishes non-resumable work as `interrupted`, and
	 * resumable work stays suspended. Hosts run it before `session_start`;
	 * `start`, `cancel`, and `resume` run it first too.
	 */
	async reconcile(): Promise<void> {
		await this.host.work().reconcile();
	}

	/** Record `kind` work started with `input`, then run `execute`. Resolves with the started record. */
	async start(
		kind: string,
		input: JsonValue,
		execute: WorkExecutor,
		options: WorkStartOptions = {},
	): Promise<WorkRecord> {
		this.assertOpen();
		const definition = this.kinds.get(kind);
		if (!definition) throw new WorkError("unknown_kind", `Work kind ${JSON.stringify(kind)} is not registered`);
		if (definition.scoped === "tool_grant" && options.toolCallId === undefined) {
			throw new WorkError("invalid", `${kind} work starts only from a tool call`);
		}
		const workId = options.workId ?? randomUUID();
		if (!WORK_ID_PATTERN.test(workId)) throw new WorkError("invalid", `Invalid work id ${JSON.stringify(workId)}`);
		const title = workTitle(definition.title(input), definition.kind);
		const stored = definition.redactInput ? definition.redactInput(input) : input;
		this.reserve(definition);
		try {
			await this.reconcile();
			this.assertOpen();
			const record = await this.host.work().start({
				workId,
				kind: definition.kind,
				title,
				...(options.parentWorkId === undefined ? {} : { parentWorkId: options.parentWorkId }),
				input: stored,
				cancellable: definition.cancellable,
				delivery: definition.delivery,
				resume: definition.resume !== undefined,
				state: options.state ?? (definition.approval === true ? "awaiting_approval" : "running"),
				...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
				...(options.child === undefined ? {} : { child: options.child }),
			});
			this.run(this.attach(record, definition), execute);
			return record;
		} finally {
			this.release(definition);
		}
	}

	/**
	 * Cancel open work of a cancellable kind. Running work checkpoints
	 * `cancelling` and its executor is aborted; it finishes with whatever its
	 * executor returns. Suspended work finishes `cancelled` at once.
	 */
	async cancel(workId: string): Promise<WorkRecord> {
		this.assertOpen();
		await this.reconcile();
		const record = this.requireOpen(workId);
		if (!record.cancellable) throw new WorkError("not_cancellable", `Work ${workId} cannot be cancelled`);
		const active = this.active.get(workId);
		if (active) {
			if (!active.cancelling && !active.detached) {
				active.cancelling = true;
				try {
					if (record.state !== "cancelling") {
						await this.write(active, () => this.host.work().checkpoint(workId, { state: "cancelling" }));
					}
				} catch (error) {
					// Work that finished meanwhile needs no cancelling.
					if (this.get(workId)?.outcome === undefined) throw error;
				} finally {
					active.controller.abort(new Error("Work cancelled"));
				}
			}
			return this.get(workId) ?? record;
		}
		try {
			await this.host.work().finish(workId, { outcome: "cancelled" });
		} catch (error) {
			// A concurrent cancel finished it first.
			if (this.get(workId)?.outcome === undefined) throw error;
		}
		return this.get(workId) ?? record;
	}

	/**
	 * Continue suspended work: open running work of a resumable kind that no
	 * executor runs. A `running` checkpoint records that it runs again.
	 */
	async resume(workId: string): Promise<WorkRecord> {
		this.assertOpen();
		await this.reconcile();
		const record = this.requireOpen(workId);
		if (this.active.has(workId)) throw new WorkError("running", `Work ${workId} is running`);
		if (!record.resume) throw new WorkError("not_resumable", `Work ${workId} cannot resume`);
		if (record.state !== "running") throw new WorkError("not_resumable", `Work ${workId} is ${record.state}`);
		const definition = this.kinds.get(record.kind);
		if (!definition?.resume) {
			throw new WorkError("unavailable", `Work of kind ${record.kind} cannot resume in this host`);
		}
		let execute: WorkExecutor;
		try {
			execute = definition.resume(record);
		} catch (error) {
			throw new WorkError("unavailable", `Work ${workId} cannot resume: ${errorMessage(error)}`);
		}
		this.reserve(definition);
		let active: ActiveWork;
		try {
			active = this.attach(record, definition);
		} finally {
			this.release(definition);
		}
		try {
			await this.write(active, () => this.host.work().checkpoint(workId, { state: "running" }));
		} catch (error) {
			active.detached = true;
			this.detach(active);
			throw error;
		}
		this.run(active, execute);
		return this.get(workId) ?? record;
	}

	/** Open the conversation `workId` runs in or produced, as its kind does; finished work included. */
	async open(workId: string, ctx: WorkOpenContext): Promise<WorkOpened> {
		this.assertOpen();
		const record = this.get(workId);
		if (!record) throw new WorkError("unknown_work", `Unknown work ${JSON.stringify(workId)}`);
		const definition = this.kinds.get(record.kind);
		if (!definition?.open) throw new WorkError("unavailable", `Work of kind ${record.kind} has nothing to open`);
		return await definition.open(record, ctx);
	}

	/** The record of `workId`, open or finished. */
	get(workId: string): WorkRecord | undefined {
		return this.host.state().work.get(workId);
	}

	/** Every work record of the conversation, in start order. */
	list(): WorkRecord[] {
		return [...this.host.state().work.values()];
	}

	/** The work this runtime runs: open work with an executor. */
	running(): WorkRecord[] {
		return [...this.active.keys()].flatMap((workId) => this.get(workId) ?? []);
	}

	/** The output of `workId`, or undefined for unknown work. */
	output(workId: string): WorkOutput | undefined {
		const record = this.get(workId);
		if (!record) return undefined;
		if (record.outcome !== undefined) {
			const output = record.result?.output;
			return { text: output?.text ?? "", truncated: output?.truncated ?? false, final: true };
		}
		const active = this.active.get(workId);
		if (active && active.output.received > 0) return { ...active.output.snapshot(), final: false };
		const own = (active?.definition ?? this.kinds.get(record.kind))?.output?.(workId);
		return own === undefined
			? { text: "", truncated: false, final: false }
			: { ...outputTail(own, false), final: false };
	}

	/**
	 * Fence the delivery of the work `turnId` started, when that turn stopped
	 * on a final response, a policy, or a tool: running items finish without
	 * a notice, and notices finished items queued that no turn took yet are
	 * withdrawn.
	 */
	async suppressDelivery(turnId: string): Promise<void> {
		for (const active of this.active.values()) {
			if (active.turnId === turnId) active.fenced = true;
		}
		const notices = this.deliveries.fence(turnId);
		await Promise.all(
			notices.map((clientMessageId) =>
				// A notice a turn already took is delivered; a lost log is reconciled by the next open.
				this.host
					.work()
					.withdrawHostInput(clientMessageId)
					.catch(() => false),
			),
		);
	}

	/** Resolves once no executor runs. */
	async waitForIdle(): Promise<void> {
		while (this.active.size > 0) {
			await Promise.all([...this.active.values()].map((active) => active.done.promise));
		}
	}

	/**
	 * Stop every executor. `cancelled` cancels each cancellable running item
	 * as `cancel` does. `closed` (the conversation closes; no work starts
	 * afterwards) aborts every executor and waits up to
	 * {@link WORK_CLOSE_GRACE_MS}: resumable work stays open, suspended on
	 * the next open, and other work finishes `interrupted` unless it completed
	 * or failed meanwhile.
	 */
	async cancelAll(reason: "cancelled" | "closed"): Promise<void> {
		if (reason === "cancelled") {
			const cancellable = [...this.active.values()].filter((active) => active.definition.cancellable);
			await Promise.allSettled(cancellable.map((active) => this.cancel(active.workId)));
			return;
		}
		if (this.closed) return;
		this.closed = true;
		const stopping = [...this.active.values()];
		for (const active of stopping) {
			active.closing = true;
			this.clearCheckpoint(active);
			active.controller.abort(new Error("The conversation closed"));
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, WORK_CLOSE_GRACE_MS);
			timer.unref?.();
		});
		await Promise.race([Promise.all(stopping.map((active) => active.done.promise)), grace]);
		if (timer !== undefined) clearTimeout(timer);
		// Executors that ignored the abort are left behind; their work ends without them.
		for (const active of stopping) {
			if (active.detached) continue;
			active.detached = true;
			try {
				await active.writes.catch(() => undefined);
				if (active.definition.resume === undefined && this.get(active.workId)?.outcome === undefined) {
					await this.host.work().finish(active.workId, { outcome: "interrupted" });
				}
			} catch {
				// A lost log is reconciled by the next open.
			} finally {
				this.detach(active);
			}
		}
		this.liveFeed.close();
	}

	private assertOpen(): void {
		if (this.closed) throw new WorkError("closed", "The conversation is closed");
	}

	private requireOpen(workId: string): WorkRecord {
		const record = this.get(workId);
		if (!record) throw new WorkError("unknown_work", `Unknown work ${JSON.stringify(workId)}`);
		if (record.outcome !== undefined) throw new WorkError("finished", `Work ${workId} already finished`);
		return record;
	}

	/** Count a start against its kind's `maxActive`, or refuse it. */
	private reserve(definition: WorkKindDefinition): void {
		let running = this.starting.get(definition.kind) ?? 0;
		for (const active of this.active.values()) if (active.definition.kind === definition.kind) running++;
		if (running >= definition.maxActive) {
			throw new WorkError("limit", `At most ${definition.maxActive} ${definition.kind} work items run at once`);
		}
		this.starting.set(definition.kind, (this.starting.get(definition.kind) ?? 0) + 1);
	}

	private release(definition: WorkKindDefinition): void {
		const starting = (this.starting.get(definition.kind) ?? 1) - 1;
		if (starting > 0) this.starting.set(definition.kind, starting);
		else this.starting.delete(definition.kind);
	}

	private attach(record: WorkRecord, definition: WorkKindDefinition): ActiveWork {
		const active: ActiveWork = {
			workId: record.workId,
			definition,
			controller: new AbortController(),
			turnId: this.host.turnId(),
			output: new OutputTail(),
			done: Promise.withResolvers<void>(),
			writes: Promise.resolve(),
			cancelling: false,
			closing: false,
			fenced: false,
			detached: false,
			lastCheckpoint: Number.NEGATIVE_INFINITY,
		};
		this.active.set(record.workId, active);
		this.liveFeed.attach(record.workId);
		if (this.closed) {
			// The conversation closed while the work started: it ends as the closing left it.
			active.closing = true;
			active.controller.abort(new Error("The conversation closed"));
		}
		return active;
	}

	private detach(active: ActiveWork): void {
		this.clearCheckpoint(active);
		if (this.active.get(active.workId) === active) this.active.delete(active.workId);
		this.liveFeed.detach(active.workId);
		active.done.resolve();
	}

	/** Run `write` after the item's earlier writes. */
	private write<T>(active: ActiveWork, write: () => Promise<T>): Promise<T> {
		const result = active.writes.then(write, write);
		active.writes = result.catch(() => undefined);
		return result;
	}

	private run(active: ActiveWork, execute: WorkExecutor): void {
		const ctx: WorkContext = {
			workId: active.workId,
			signal: active.controller.signal,
			progress: (progress, detail) => {
				if (!active.detached) this.liveFeed.progress(active.workId, progress, detail);
			},
			checkpoint: (progress, detail) => {
				if (active.detached) return;
				this.liveFeed.progress(active.workId, progress, detail);
				this.schedulePhase(active, { progress, ...(detail === undefined ? {} : { detail }) });
			},
			output: (text) => {
				if (active.detached || typeof text !== "string") return;
				active.output.append(text);
				this.liveFeed.output(active.workId, active.output.received);
			},
		};
		void (async () => {
			let execution: unknown;
			try {
				// The executor runs after `start` resolved.
				await Promise.resolve();
				execution = await execute(ctx);
			} catch (error) {
				execution = active.controller.signal.aborted
					? { outcome: "cancelled" }
					: { outcome: "failed", error: errorMessage(error) };
			}
			await this.settle(active, execution);
		})();
	}

	/** The executor returned: finish the work, unless closing leaves it open or it was already left. */
	private async settle(active: ActiveWork, execution: unknown): Promise<void> {
		if (active.detached) return;
		active.detached = true;
		this.clearCheckpoint(active);
		try {
			await active.writes.catch(() => undefined);
			if (this.get(active.workId)?.outcome !== undefined) return;
			const finish = this.finishOf(active, execution);
			if (finish) await this.finish(active, finish);
		} finally {
			this.detach(active);
		}
	}

	private finishOf(active: ActiveWork, execution: unknown): ConversationWorkFinish | undefined {
		const known = isExecution(execution) ? execution : undefined;
		let outcome: ConversationWorkFinish["outcome"] = known?.outcome ?? "failed";
		if (active.closing && outcome === "cancelled") {
			// Closing stopped it: resumable work stays open for the next open.
			if (active.definition.resume !== undefined) return undefined;
			outcome = "interrupted";
		}
		const given = known?.result;
		const output =
			given?.output !== undefined
				? outputTail(given.output.text, given.output.truncated)
				: active.output.received > 0
					? active.output.snapshot()
					: undefined;
		const kept: WorkResult = {
			...(given?.summary === undefined ? {} : { summary: workText(given.summary) }),
			...(output === undefined ? {} : { output }),
			...(given?.child === undefined ? {} : { child: given.child }),
		};
		const withData: WorkResult = given?.data === undefined ? kept : { ...kept, data: given.data };
		// Data over its bound is dropped; the rest of the result stays.
		const result =
			workPayloadBoundsError({
				type: "work_finished",
				payload: { workId: active.workId, outcome, result: withData },
			}) === undefined
				? withData
				: kept;
		const error = known ? known.error : "The work's executor returned no outcome";
		return {
			outcome,
			...(Object.keys(result).length === 0 ? {} : { result }),
			...(error === undefined ? {} : { error: workText(error) }),
			...(active.fenced || !this.deliveries.delivers(active.turnId) ? { deliver: false as const } : {}),
		};
	}

	private async finish(active: ActiveWork, finish: ConversationWorkFinish): Promise<void> {
		try {
			const finished = await this.host.work().finish(active.workId, finish);
			if (finished.notice) this.deliveries.queued(active.workId, active.turnId, finished.notice.clientMessageId);
		} catch (error) {
			if (!(error instanceof ConversationError && error.code === "invalid_argument")) return;
			// A result the log cannot hold still ends the work.
			await this.host
				.work()
				.finish(active.workId, {
					outcome: finish.outcome === "completed" ? "failed" : finish.outcome,
					error: "The work's result could not be recorded",
					deliver: false,
				})
				.catch(() => undefined);
		}
	}

	/** Write a phase now, or once {@link WORK_CHECKPOINT_INTERVAL_MS} passed since the last one. */
	private schedulePhase(active: ActiveWork, phase: Phase): void {
		active.pendingPhase = phase;
		if (active.checkpointTimer !== undefined) return;
		const wait = active.lastCheckpoint + WORK_CHECKPOINT_INTERVAL_MS - Date.now();
		if (wait <= 0) {
			this.writePhase(active);
			return;
		}
		active.checkpointTimer = setTimeout(() => {
			active.checkpointTimer = undefined;
			this.writePhase(active);
		}, wait);
		active.checkpointTimer.unref?.();
	}

	private writePhase(active: ActiveWork): void {
		const phase = active.pendingPhase;
		active.pendingPhase = undefined;
		if (!phase || active.detached) return;
		active.lastCheckpoint = Date.now();
		// A phase over the checkpoint bound drops its detail, then its steps.
		const { steps: _steps, ...stepless } = phase.progress;
		const checkpoint = [
			{ progress: phase.progress, ...(phase.detail === undefined ? {} : { detail: phase.detail }) },
			{ progress: phase.progress },
			{ progress: stepless },
		].find(
			(candidate) =>
				Buffer.byteLength(JSON.stringify({ workId: active.workId, ...candidate }), "utf8") <=
				WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
		);
		if (!checkpoint) return;
		// A phase the log refuses is dropped; the live value showed it.
		void this.write(active, () => this.host.work().checkpoint(active.workId, checkpoint)).catch(() => undefined);
	}

	private clearCheckpoint(active: ActiveWork): void {
		if (active.checkpointTimer !== undefined) clearTimeout(active.checkpointTimer);
		active.checkpointTimer = undefined;
		active.pendingPhase = undefined;
	}
}

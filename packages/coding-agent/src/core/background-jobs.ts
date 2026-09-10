import { randomUUID } from "node:crypto";
import type { AgentToolResult, AgentToolUpdateCallback } from "@hansjm10/volt-agent-core";
import { cloneCanonicalData } from "./canonical-data.ts";
import { truncateTail } from "./tools/truncate.ts";

export type BackgroundToolName = "bash" | "subagent";
export type BackgroundJobStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export const BACKGROUND_JOB_MAX_ACTIVE = 8;
export const BACKGROUND_JOB_MAX_RETAINED = 64;
export const BACKGROUND_JOB_MAX_OUTPUT_BYTES = 50 * 1024;
export const BACKGROUND_JOB_MAX_WAIT_MS = 30_000;
export const BACKGROUND_JOB_NOTIFICATION_TYPE = "background_job_notification";

export interface BackgroundJobSummary {
	id: string;
	toolName: BackgroundToolName;
	toolCallId: string;
	label: string;
	status: BackgroundJobStatus;
	startedAt: number;
	endedAt?: number;
}

export interface BackgroundJobSnapshot extends BackgroundJobSummary {
	/** Latest bounded output snapshot, not a destructive read or a stream delta. */
	output: string;
	outputTruncated: boolean;
	/** Time the retained output last changed. Absent until the worker produces output. */
	lastOutputAt?: number;
}

export interface BackgroundJobManagerOptions {
	/** Host-owned capability check, including the jobs control tool. */
	isToolAllowed: (name: BackgroundToolName | "jobs") => boolean;
	/** Changes on branch navigation, but not on ordinary turns or compaction. */
	getGeneration: () => number;
}

export interface BackgroundJobStart {
	toolName: BackgroundToolName;
	toolCallId: string;
	label: string;
	execute: (signal: AbortSignal, onUpdate: AgentToolUpdateCallback<unknown>) => Promise<AgentToolResult<unknown>>;
}

interface JobRecord {
	snapshot: BackgroundJobSnapshot;
	generation: number;
	controller: AbortController;
	settled: Promise<void>;
	notified: boolean;
	collected: boolean;
	/** Native terminal reads awaiting delivery in a model request; never worker-supplied metadata. */
	resultReads: Set<string>;
}

/** Session-owned work. Completion never starts an inference request or writes a transcript. */
export class BackgroundJobManager {
	private readonly options: BackgroundJobManagerOptions;
	private readonly records = new Map<string, JobRecord>();
	private closed = false;
	private readonly listeners = new Set<() => void>();

	constructor(options: BackgroundJobManagerOptions) {
		this.options = options;
	}

	/** UI observers receive no output payload and cannot affect worker settlement. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emitChange(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Presentation failures must not fail or cancel background work.
			}
		}
	}

	get hasActive(): boolean {
		return [...this.records.values()].some((record) => record.snapshot.endedAt === undefined);
	}

	assertCanStart(toolName: BackgroundToolName): void {
		if (this.closed) throw new Error("Background jobs are closed for this session.");
		if (!this.options.isToolAllowed("jobs") || !this.options.isToolAllowed(toolName)) {
			throw new Error(`Background ${toolName} requires both ${toolName} and jobs to be active.`);
		}
		const active = [...this.records.values()].filter((record) => record.snapshot.endedAt === undefined).length;
		if (active >= BACKGROUND_JOB_MAX_ACTIVE) {
			throw new Error(`At most ${BACKGROUND_JOB_MAX_ACTIVE} background jobs may run in one session.`);
		}
	}

	start(work: BackgroundJobStart): BackgroundJobSnapshot {
		this.assertCanStart(work.toolName);
		while (this.records.size >= BACKGROUND_JOB_MAX_RETAINED) {
			const oldest = [...this.records.values()].find((record) => record.snapshot.endedAt !== undefined);
			if (!oldest) throw new Error("Background job retention is full.");
			this.records.delete(oldest.snapshot.id);
		}
		const record: JobRecord = {
			snapshot: {
				id: `job_${randomUUID()}`,
				toolName: work.toolName,
				toolCallId: work.toolCallId,
				label: work.label.slice(0, 200),
				status: "running",
				startedAt: Date.now(),
				output: "",
				outputTruncated: false,
			},
			generation: this.options.getGeneration(),
			controller: new AbortController(),
			settled: Promise.resolve(),
			notified: false,
			collected: false,
			resultReads: new Set(),
		};
		this.records.set(record.snapshot.id, record);
		// Defer dispatch until the handle is registered. Cancellation before that
		// microtask must prevent the work from starting, not merely hide its result.
		record.settled = Promise.resolve().then(() => this.run(record, work));
		this.emitChange();
		return { ...record.snapshot };
	}

	list(): BackgroundJobSummary[] {
		return [...this.records.values()]
			.filter((record) => this.hasAccess(record))
			.reverse()
			.map((record) => {
				const {
					output: _output,
					outputTruncated: _truncated,
					lastOutputAt: _lastOutputAt,
					...summary
				} = record.snapshot;
				return summary;
			});
	}

	/** Active work and terminal results not yet delivered to the model. History stays in list(). */
	listUncollected(): BackgroundJobSummary[] {
		return this.list().filter((job) => !this.records.get(job.id)?.collected);
	}

	/** Native read/wait execution alone does not prove that the model received the result. */
	recordResultRead(toolCallId: string, snapshot: BackgroundJobSnapshot): void {
		const record = this.requireRecord(snapshot.id);
		if (record.collected || snapshot.endedAt === undefined || snapshot.endedAt !== record.snapshot.endedAt) return;
		record.resultReads.add(toolCallId);
		// SDK callers can inspect repeatedly without ever submitting a model request.
		if (record.resultReads.size > BACKGROUND_JOB_MAX_RETAINED) {
			record.resultReads.delete(record.resultReads.values().next().value!);
		}
	}

	/** Host acknowledgement after a native terminal snapshot survives policy and enters a model request. */
	acknowledgeResult(toolCallId: string, snapshot: BackgroundJobSnapshot): void {
		const record = this.records.get(snapshot.id);
		if (
			!record ||
			!this.hasAccess(record) ||
			record.collected ||
			!record.resultReads.has(toolCallId) ||
			snapshot.endedAt === undefined ||
			snapshot.endedAt !== record.snapshot.endedAt ||
			snapshot.startedAt !== record.snapshot.startedAt ||
			snapshot.status !== record.snapshot.status ||
			snapshot.toolName !== record.snapshot.toolName ||
			snapshot.toolCallId !== record.snapshot.toolCallId
		)
			return;
		record.collected = true;
		record.resultReads.clear();
		this.emitChange();
	}

	get(id: string): BackgroundJobSnapshot {
		return { ...this.requireRecord(id).snapshot };
	}

	async wait(
		id: string,
		timeoutMs = BACKGROUND_JOB_MAX_WAIT_MS,
		signal?: AbortSignal,
	): Promise<BackgroundJobSnapshot> {
		if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > BACKGROUND_JOB_MAX_WAIT_MS) {
			throw new Error(`Job wait timeoutMs must be an integer from 0 to ${BACKGROUND_JOB_MAX_WAIT_MS}.`);
		}
		if (signal?.aborted) throw new Error("Job wait aborted.");
		const record = this.requireRecord(id);
		if (record.snapshot.endedAt !== undefined || timeoutMs === 0) return { ...record.snapshot };
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			await Promise.race([
				record.settled,
				new Promise<void>((resolve, reject) => {
					timer = setTimeout(resolve, timeoutMs);
					onAbort = () => reject(new Error("Job wait aborted."));
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
		return this.get(id);
	}

	/** Requests cancellation; cancelling is not terminal until the worker settles. */
	cancel(id: string): BackgroundJobSnapshot {
		const record = this.requireRecord(id);
		this.cancelRecord(record);
		return { ...record.snapshot };
	}

	/** Non-cancelling host join, including revoked jobs and work admitted during the wait. */
	async waitForIdle(): Promise<void> {
		for (;;) {
			const active = [...this.records.values()].filter((record) => record.snapshot.endedAt === undefined);
			if (active.length === 0) return;
			await Promise.all(active.map((record) => record.settled));
		}
	}

	/** Host operation: fence every running job synchronously, then join settlement. */
	cancelAll(): Promise<void> {
		const records = [...this.records.values()];
		for (const record of records) this.cancelRecord(record);
		return Promise.all(records.map((record) => record.settled)).then(() => {});
	}

	/** Revoke running work when its tool grant or branch ownership changes. */
	cancelInaccessible(): void {
		for (const record of this.records.values()) {
			if (!this.hasAccess(record)) this.cancelRecord(record);
		}
		this.emitChange();
	}

	close(): Promise<void> {
		this.closed = true;
		this.emitChange();
		return this.cancelAll();
	}

	/** Metadata only. The host acknowledges these after committing a notification. */
	pendingNotifications(): BackgroundJobSummary[] {
		return this.list().filter((summary) => summary.endedAt !== undefined && !this.records.get(summary.id)?.notified);
	}

	acknowledgeNotifications(ids: readonly string[]): void {
		for (const id of ids) {
			const record = this.records.get(id);
			if (record?.snapshot.endedAt !== undefined) record.notified = true;
		}
	}

	private hasAccess(record: JobRecord): boolean {
		return (
			!this.closed &&
			record.generation === this.options.getGeneration() &&
			this.options.isToolAllowed("jobs") &&
			this.options.isToolAllowed(record.snapshot.toolName)
		);
	}

	private requireRecord(id: string): JobRecord {
		const record = this.records.get(id);
		if (!record || !this.hasAccess(record)) {
			throw new Error(
				`Unknown or inaccessible background job: ${id}. Jobs do not survive runtime restart or branch changes.`,
			);
		}
		return record;
	}

	private cancelRecord(record: JobRecord): void {
		if (record.snapshot.endedAt !== undefined || record.controller.signal.aborted) return;
		record.snapshot.status = "cancelling";
		record.controller.abort();
		this.emitChange();
	}

	private captureOutput(record: JobRecord, result: AgentToolResult<unknown>): void {
		const text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const bounded = truncateTail(text, { maxBytes: BACKGROUND_JOB_MAX_OUTPUT_BYTES });
		const changed = record.snapshot.output !== bounded.content;
		if (changed && bounded.content) record.snapshot.lastOutputAt = Date.now();
		record.snapshot.output = bounded.content;
		record.snapshot.outputTruncated = bounded.truncated;
		if (changed) this.emitChange();
	}

	private async run(record: JobRecord, work: BackgroundJobStart): Promise<void> {
		let acceptingUpdates = true;
		let invalidUpdate: Error | undefined;
		try {
			if (record.controller.signal.aborted || !this.hasAccess(record)) {
				this.cancelRecord(record);
				throw new Error("Background job cancelled before execution.");
			}
			const result = await work.execute(record.controller.signal, (update) => {
				if (!acceptingUpdates || invalidUpdate) return;
				try {
					this.captureOutput(record, cloneCanonicalData(update, "Background job progress"));
				} catch (error) {
					invalidUpdate = error instanceof Error ? error : new Error(String(error));
					record.controller.abort(invalidUpdate);
				}
			});
			acceptingUpdates = false;
			if (invalidUpdate) throw invalidUpdate;
			this.captureOutput(record, cloneCanonicalData(result, "Background job result"));
			record.snapshot.status = record.controller.signal.aborted
				? "cancelled"
				: result.isError
					? "failed"
					: "completed";
		} catch (error) {
			const failure = invalidUpdate ?? error;
			const message = failure instanceof Error ? failure.message : String(failure);
			// A failed finalization policy must not re-expose pre-policy progress.
			this.captureOutput(record, { content: [{ type: "text", text: message }] });
			record.snapshot.status = invalidUpdate ? "failed" : record.controller.signal.aborted ? "cancelled" : "failed";
		} finally {
			acceptingUpdates = false;
			record.snapshot.endedAt = Date.now();
			this.emitChange();
		}
	}
}

/** Host UI access; does not admit work or widen the manager's tool/branch grants. */
export type BackgroundJobSource = Pick<
	BackgroundJobManager,
	"list" | "listUncollected" | "get" | "cancel" | "subscribe"
>;

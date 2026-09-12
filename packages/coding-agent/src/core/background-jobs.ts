import { randomUUID } from "node:crypto";
import {
	AgentHarnessAdmissionGate,
	type AgentToolResult,
	type AgentToolUpdateCallback,
} from "@hansjm10/volt-agent-core";
import type { BackgroundJobDiagnosticEvent } from "./background-job-diagnostics.ts";
import { cloneCanonicalData } from "./canonical-data.ts";
import { truncateTail } from "./tools/truncate.ts";

export type BackgroundToolName = "bash" | "subagent";
export type BackgroundJobStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export const BACKGROUND_JOB_MAX_ACTIVE = 8;
export const BACKGROUND_JOB_MAX_RETAINED = 64;
export const BACKGROUND_JOB_MAX_OUTPUT_BYTES = 50 * 1024;
export const BACKGROUND_JOB_MAX_WAIT_MS = 300_000;
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

export interface BackgroundJobWaitSummary {
	id: string;
	toolCallId?: string;
	ids: string[];
	mode: "any" | "all";
	startedAt: number;
}

export interface BackgroundJobWaitResult extends BackgroundJobWaitSummary {
	reason: "terminal" | "steered" | "timeout";
	endedAt: number;
	results: BackgroundJobSnapshot[];
	pending: BackgroundJobSummary[];
}

export interface BackgroundJobWaitOptions {
	mode?: "any" | "all";
	timeoutMs?: number;
	signal?: AbortSignal;
	toolCallId?: string;
}

export interface BackgroundJobManagerOptions {
	/** Shared execution admission; job inspection and cleanup remain available while suspended. */
	admissionGate?: AgentHarnessAdmissionGate;
	/** Host-owned capability check, including the jobs control tool. */
	isToolAllowed: (name: BackgroundToolName | "jobs") => boolean;
	/** Changes on branch navigation, but not on ordinary turns or compaction. */
	getGeneration: () => number;
	getRunIdentity?: () => unknown;
	recordDiagnostic?: (event: BackgroundJobDiagnosticEvent) => void;
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
	admissionRevision: number;
	controller: AbortController;
	settled: Promise<void>;
	notified: boolean;
	collected: boolean;
	/** Native terminal reads awaiting delivery in a model request; never worker-supplied metadata. */
	resultReads: Set<string>;
	pins: number;
	outputRevision: number;
}

/** Session-owned work. Completion never starts an inference request or writes a transcript. */
export class BackgroundJobManager {
	private readonly options: BackgroundJobManagerOptions;
	private readonly admissionGate: AgentHarnessAdmissionGate;
	private readonly records = new Map<string, JobRecord>();
	private closed = false;
	private readonly listeners = new Set<() => void>();
	private readonly waits = new Map<string, BackgroundJobWaitSummary>();
	private steeringPending = false;

	setSteeringPending(pending: boolean): void {
		this.steeringPending = pending;
		this.emitChange();
	}

	listWaits(): BackgroundJobWaitSummary[] {
		return [...this.waits.values()].map((wait) => ({ ...wait, ids: [...wait.ids] }));
	}

	private diagnose(event: BackgroundJobDiagnosticEvent): void {
		try {
			this.options.recordDiagnostic?.(event);
		} catch {
			// Optional diagnostics cannot change execution.
		}
	}

	constructor(options: BackgroundJobManagerOptions) {
		this.options = options;
		this.admissionGate = options.admissionGate ?? new AgentHarnessAdmissionGate();
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
		this.admissionGate.assertOpen();
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
			const oldest = [...this.records.values()].find(
				(record) => record.snapshot.endedAt !== undefined && record.pins === 0,
			);
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
			admissionRevision: this.admissionGate.revision,
			controller: new AbortController(),
			settled: Promise.resolve(),
			notified: false,
			collected: false,
			resultReads: new Set(),
			pins: 0,
			outputRevision: 0,
		};
		this.records.set(record.snapshot.id, record);
		this.diagnose({
			kind: "job_start",
			jobId: record.snapshot.id,
			toolCallId: work.toolCallId,
			toolName: work.toolName,
			status: "running",
		});
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
	recordResultRead(toolCallId: string, snapshot: BackgroundJobSnapshot, action: "read" | "wait" = "read"): void {
		const record = this.requireRecord(snapshot.id);
		this.diagnose({
			kind: "job_read",
			toolCallId,
			jobId: snapshot.id,
			action,
			status: snapshot.status,
			outputBytes: Buffer.byteLength(snapshot.output),
			outputRevision: record.outputRevision,
		});
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
		this.diagnose({ kind: "job_collected", jobId: snapshot.id, toolCallId });
		this.emitChange();
	}

	get(id: string): BackgroundJobSnapshot {
		return { ...this.requireRecord(id).snapshot };
	}

	async wait(ids: readonly string[], options: BackgroundJobWaitOptions = {}): Promise<BackgroundJobWaitResult> {
		const { timeoutMs, signal, toolCallId } = options;
		const mode = options.mode ?? "any";
		if (
			!Array.isArray(ids) ||
			ids.length < 1 ||
			ids.length > BACKGROUND_JOB_MAX_RETAINED ||
			new Set(ids).size !== ids.length
		) {
			throw new Error("Job wait requires 1–64 unique accessible ids.");
		}
		if (mode !== "any" && mode !== "all") throw new Error("Job wait mode must be any or all.");
		if (
			timeoutMs !== undefined &&
			(!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > BACKGROUND_JOB_MAX_WAIT_MS)
		) {
			throw new Error(`Job wait timeoutMs must be an integer from 0 to ${BACKGROUND_JOB_MAX_WAIT_MS}.`);
		}
		if (signal?.aborted) throw new Error("Job wait aborted.");
		if (this.waits.size >= BACKGROUND_JOB_MAX_RETAINED) throw new Error("At most 64 job waits may be active.");
		const records = ids.map((id) => this.requireRecord(id));
		const generation = this.options.getGeneration();
		const runIdentity = this.options.getRunIdentity?.();
		const wait: BackgroundJobWaitSummary = {
			id: `wait_${randomUUID()}`,
			ids: [...ids],
			mode,
			startedAt: Date.now(),
			...(toolCallId === undefined ? {} : { toolCallId }),
		};
		const diagnostic = {
			waitId: wait.id,
			jobIds: wait.ids,
			mode,
			...(toolCallId === undefined ? {} : { toolCallId }),
		};
		for (const record of records) record.pins++;
		this.waits.set(wait.id, wait);
		this.diagnose({ kind: "wait_start", ...diagnostic });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;
		let onAbort: (() => void) | undefined;
		let expired = timeoutMs === 0;
		try {
			const reason = await new Promise<BackgroundJobWaitResult["reason"]>((resolve, reject) => {
				const check = () => {
					if (signal?.aborted) return reject(new Error("Job wait aborted."));
					if (
						generation !== this.options.getGeneration() ||
						runIdentity !== this.options.getRunIdentity?.() ||
						records.some((record) => !this.hasAccess(record))
					) {
						return reject(new Error("Job wait belongs to an inaccessible runtime, branch, or run."));
					}
					const terminal = records.filter((record) => record.snapshot.endedAt !== undefined).length;
					if (mode === "all" ? terminal === records.length : terminal > 0) resolve("terminal");
					else if (this.steeringPending) resolve("steered");
					else if (expired) resolve("timeout");
				};
				unsubscribe = this.subscribe(check);
				onAbort = check;
				signal?.addEventListener("abort", check, { once: true });
				if (timeoutMs !== undefined && timeoutMs > 0)
					timer = setTimeout(() => {
						expired = true;
						check();
					}, timeoutMs);
				this.emitChange();
				check();
			});
			// Recheck ownership after promise scheduling, before copying any output.
			if (signal?.aborted) throw new Error("Job wait aborted.");
			if (generation !== this.options.getGeneration() || runIdentity !== this.options.getRunIdentity?.())
				throw new Error("Job wait belongs to a stale run.");
			const snapshots = wait.ids.map((id) => this.get(id));
			const result: BackgroundJobWaitResult = {
				...wait,
				reason,
				endedAt: Date.now(),
				results: snapshots.filter((job) => job.endedAt !== undefined),
				pending: snapshots
					.filter((job) => job.endedAt === undefined)
					.map(
						({ output: _output, outputTruncated: _truncated, lastOutputAt: _lastOutput, ...summary }) => summary,
					),
			};
			this.diagnose({ kind: "wait_end", ...diagnostic, reason });
			return result;
		} catch (error) {
			this.diagnose({ kind: "wait_end", ...diagnostic, reason: signal?.aborted ? "aborted" : "revoked" });
			throw error;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			unsubscribe?.();
			if (onAbort) signal?.removeEventListener("abort", onAbort);
			for (const record of records) record.pins--;
			this.waits.delete(wait.id);
			this.emitChange();
		}
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
		this.diagnose({ kind: "job_cancel", jobId: record.snapshot.id, status: "cancelling" });
		record.controller.abort();
		this.emitChange();
	}

	private captureOutput(record: JobRecord, result: AgentToolResult<unknown>): void {
		let text = result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
		const byteTruncated = Buffer.byteLength(text, "utf-8") > BACKGROUND_JOB_MAX_OUTPUT_BYTES;
		if (byteTruncated) {
			// Bound bytes before lines so a Bash footer cannot displace the entire output line.
			const buffer = Buffer.from(text, "utf-8");
			let start = buffer.length - BACKGROUND_JOB_MAX_OUTPUT_BYTES;
			while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
			text = buffer.subarray(start).toString("utf-8");
		}
		const bounded = truncateTail(text, { maxBytes: BACKGROUND_JOB_MAX_OUTPUT_BYTES });
		const details = result.details;
		const truncation =
			details && typeof details === "object" && "truncation" in details ? details.truncation : undefined;
		// Bash progress is already bounded, so its metadata can be the only evidence of dropped output.
		const upstreamTruncated =
			truncation !== null &&
			typeof truncation === "object" &&
			"truncated" in truncation &&
			truncation.truncated === true;
		const outputTruncated = upstreamTruncated || byteTruncated || bounded.truncated;
		const changed = record.snapshot.output !== bounded.content;
		const truncationChanged = record.snapshot.outputTruncated !== outputTruncated;
		if (changed || truncationChanged) record.outputRevision++;
		if (changed && bounded.content) record.snapshot.lastOutputAt = Date.now();
		record.snapshot.output = bounded.content;
		record.snapshot.outputTruncated = outputTruncated;
		if (changed || truncationChanged) this.emitChange();
	}

	private async run(record: JobRecord, work: BackgroundJobStart): Promise<void> {
		let acceptingUpdates = true;
		let invalidUpdate: Error | undefined;
		try {
			if (
				record.controller.signal.aborted ||
				!this.admissionGate.isCurrent(record.admissionRevision) ||
				!this.hasAccess(record)
			) {
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
			this.diagnose({
				kind: "job_end",
				jobId: record.snapshot.id,
				status: record.snapshot.status,
				outputBytes: Buffer.byteLength(record.snapshot.output),
				outputRevision: record.outputRevision,
			});
			this.emitChange();
		}
	}
}

/** Host UI access; does not admit work or widen the manager's tool/branch grants. */
export type BackgroundJobSource = Pick<
	BackgroundJobManager,
	"list" | "listUncollected" | "listWaits" | "get" | "cancel" | "subscribe"
>;

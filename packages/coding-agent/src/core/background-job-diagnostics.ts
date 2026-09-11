import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { writeToolProgressCapture } from "./tool-progress-capture.ts";

export interface BackgroundJobDiagnosticEvent {
	kind:
		| "run_start"
		| "run_end"
		| "request_start"
		| "request_end"
		| "tool_start"
		| "tool_end"
		| "job_start"
		| "job_end"
		| "job_cancel"
		| "wait_start"
		| "wait_end"
		| "job_read"
		| "job_collected";
	runId?: string;
	requestId?: string;
	toolCallId?: string;
	jobId?: string;
	waitId?: string;
	jobIds?: string[];
	toolName?: string;
	provider?: string;
	model?: string;
	status?: "running" | "cancelling" | "completed" | "failed" | "cancelled";
	mode?: "any" | "all";
	reason?: "terminal" | "steered" | "timeout" | "aborted" | "revoked";
	action?: "read" | "wait";
	outputBytes?: number;
	outputRevision?: number;
	isError?: boolean;
	usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
}

interface Options {
	agentDir: string;
	sessionId: () => string;
	parentSessionId?: () => string | undefined;
	warn?: () => void;
	writer?: (path: string, content: string) => Promise<void>;
}

const KINDS = new Set([
	"run_start",
	"run_end",
	"request_start",
	"request_end",
	"tool_start",
	"tool_end",
	"job_start",
	"job_end",
	"job_cancel",
	"wait_start",
	"wait_end",
	"job_read",
	"job_collected",
]);
const ENUMS = {
	status: ["running", "cancelling", "completed", "failed", "cancelled"],
	mode: ["any", "all"],
	reason: ["terminal", "steered", "timeout", "aborted", "revoked"],
	action: ["read", "wait"],
};
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_BATCH_RECORDS = 64;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
// Only completed files from this schema are eligible for retention. Temp files are not.
const OWNED_FILE = new RegExp(
	`^background-jobs-v1_\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_${UUID}_\\d{8,16}\\.jsonl$`,
);

function metadataString(value: unknown, model = false): value is string {
	return (
		typeof value === "string" &&
		value.length <= (model ? 256 : 128) &&
		(model ? /^[a-zA-Z0-9][a-zA-Z0-9._:+/-]*$/ : /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/).test(value) &&
		!value.includes("..")
	);
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Copy only typed metadata. Do not serialize caller objects, including nested usage objects. */
function allowlistedEvent(event: BackgroundJobDiagnosticEvent): Record<string, unknown> | undefined {
	const kind = event.kind;
	if (!KINDS.has(kind)) return undefined;
	const result: Record<string, unknown> = { kind };
	for (const key of [
		"runId",
		"requestId",
		"toolCallId",
		"jobId",
		"waitId",
		"toolName",
		"provider",
		"model",
	] as const) {
		const value = event[key];
		if (value === undefined) continue;
		// Responses tool IDs contain call_id|item_id; item IDs can be long opaque blobs.
		// A stable digest preserves joins without retaining that provider payload.
		if (
			key === "toolCallId" &&
			typeof value === "string" &&
			value.length <= 8192 &&
			/^[a-zA-Z0-9._:-]+\|[a-zA-Z0-9_+./=:-]+$/.test(value)
		) {
			result[key] = `sha256:${createHash("sha256").update(value).digest("hex")}`;
			continue;
		}
		if (!metadataString(value, key === "model")) return undefined;
		result[key] = value;
	}
	const jobIds = event.jobIds;
	if (jobIds !== undefined) {
		if (!Array.isArray(jobIds) || jobIds.length > 64) return undefined;
		const ids: string[] = [];
		for (let index = 0; index < jobIds.length; index++) {
			const id: unknown = jobIds[index];
			if (!metadataString(id)) return undefined;
			ids.push(id);
		}
		result.jobIds = ids;
	}
	for (const key of ["status", "mode", "reason", "action"] as const) {
		const value = event[key];
		if (value === undefined) continue;
		if (!(ENUMS[key] as readonly unknown[]).includes(value)) return undefined;
		result[key] = value;
	}
	for (const key of ["outputBytes", "outputRevision"] as const) {
		const value = event[key];
		if (value === undefined) continue;
		if (!count(value)) return undefined;
		result[key] = value;
	}
	const isError = event.isError;
	if (isError !== undefined) {
		if (typeof isError !== "boolean") return undefined;
		result.isError = isError;
	}
	const suppliedUsage = event.usage;
	if (suppliedUsage !== undefined) {
		if (!suppliedUsage || typeof suppliedUsage !== "object") return undefined;
		const usage: Record<string, number> = {};
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
			const value = suppliedUsage[key];
			if (!count(value)) return undefined;
			usage[key] = value;
		}
		result.usage = usage;
	}
	return result;
}

async function removedConcurrently(path: string, error: unknown): Promise<boolean> {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT") return true;
	// Windows can report EPERM when another runtime's unlink is completing.
	// Do not suppress a real access failure on a file that still exists.
	if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
		try {
			await lstat(path);
		} catch (currentError) {
			if ((currentError as NodeJS.ErrnoException).code === "ENOENT") return true;
		}
	}
	return false;
}

async function prune(directory: string): Promise<void> {
	try {
		const directoryStat = await lstat(directory);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
			throw new Error("Unsafe diagnostics directory");
		const entries = await readdir(directory, { withFileTypes: true });
		const files = [];
		for (const entry of entries) {
			if (!entry.isFile() || !OWNED_FILE.test(entry.name)) continue;
			const path = join(directory, entry.name);
			try {
				const stat = await lstat(path);
				if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) files.push({ path, stat });
			} catch (error) {
				if (!(await removedConcurrently(path, error))) throw error;
			}
		}
		files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.path.localeCompare(a.path));
		let retainedBytes = 0;
		let retainedFiles = 0;
		for (const file of files) {
			if (retainedFiles < 200 && retainedBytes + file.stat.size <= 50 * 1024 * 1024) {
				retainedFiles++;
				retainedBytes += file.stat.size;
				continue;
			}
			try {
				const current = await lstat(file.path);
				if (
					current.isFile() &&
					!current.isSymbolicLink() &&
					current.nlink === 1 &&
					current.dev === file.stat.dev &&
					current.ino === file.stat.ino
				)
					await unlink(file.path);
			} catch (error) {
				// Another runtime may have pruned the same completed batch.
				if (!(await removedConcurrently(file.path, error))) throw error;
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/** Metadata-only, opt-in diagnostics. The hot path performs no filesystem or subprocess work. */
export class BackgroundJobDiagnostics {
	readonly runtimeId = randomUUID();
	private readonly options: Options;
	private readonly directory: string;
	private readonly startedAt = performance.now();
	private readonly writer: (path: string, content: string) => Promise<void>;
	private accepting: boolean;
	private stopped = false;
	private closing = false;
	private warned = false;
	private sequence = 0;
	private droppedEvents = 0;
	private batch = 0;
	private pending: string[] = [];
	private pendingBytes = 0;
	private flushRequested = false;
	private active: Promise<void> | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private closePromise: Promise<void> | undefined;

	constructor(options: Options) {
		this.options = options;
		this.directory = join(options.agentDir, "background-job-diagnostics");
		this.writer = options.writer ?? writeToolProgressCapture;
		const setting = process.env.VOLT_BACKGROUND_JOB_DIAGNOSTICS?.toLowerCase();
		this.accepting = setting === "1" || setting === "true";
		if (this.accepting) {
			this.timer = setInterval(() => this.flush(), 30_000);
			this.timer.unref();
		}
	}

	get enabled(): boolean {
		return this.accepting;
	}

	record(event: BackgroundJobDiagnosticEvent): void {
		if (!this.accepting) return;
		const sequence = ++this.sequence;
		try {
			const metadata = allowlistedEvent(event);
			const sessionId = this.options.sessionId();
			const parentSessionId = this.options.parentSessionId?.();
			if (
				!metadata ||
				!metadataString(sessionId) ||
				(parentSessionId !== undefined && !metadataString(parentSessionId))
			) {
				this.droppedEvents++;
				return;
			}
			const line = JSON.stringify({
				...metadata,
				schemaVersion: 1,
				timestamp: new Date().toISOString(),
				monotonicMs: performance.now() - this.startedAt,
				sequence,
				runtimeId: this.runtimeId,
				sessionId,
				...(parentSessionId === undefined ? {} : { parentSessionId }),
				droppedEvents: this.droppedEvents,
			});
			// Reserve room for the final record's cumulative drop count at dispatch.
			const bytes = Buffer.byteLength(line, "utf8") + 1 + 16;
			if (bytes > MAX_RECORD_BYTES) {
				this.droppedEvents++;
				return;
			}
			if (this.pending.length >= MAX_BATCH_RECORDS || this.pendingBytes + bytes >= MAX_BATCH_BYTES) this.flush();
			if (this.pending.length >= MAX_BATCH_RECORDS || this.pendingBytes + bytes >= MAX_BATCH_BYTES) {
				this.droppedEvents++;
				return;
			}
			this.pending.push(line);
			this.pendingBytes += bytes;
			if (this.pending.length >= MAX_BATCH_RECORDS || event.kind === "run_end") this.flush();
		} catch {
			// Malformed metadata or a failing identity callback must not affect the session.
			this.droppedEvents++;
		}
	}

	/** Schedule a batch; never call the writer on the caller's stack. */
	flush(): void {
		if (this.stopped) return;
		this.flushRequested = true;
		this.startWrite();
	}

	private startWrite(): void {
		if (this.active || this.stopped || this.pending.length === 0) return;
		const last = this.pending.length - 1;
		const finalRecord = JSON.parse(this.pending[last]!) as Record<string, unknown>;
		finalRecord.droppedEvents = this.droppedEvents;
		this.pending[last] = JSON.stringify(finalRecord);
		const content = `${this.pending.join("\n")}\n`;
		this.pending = [];
		this.pendingBytes = 0;
		this.flushRequested = false;
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = join(
			this.directory,
			`background-jobs-v1_${timestamp}_${this.runtimeId}_${String(++this.batch).padStart(8, "0")}.jsonl`,
		);
		this.active = Promise.resolve()
			.then(async () => {
				if (this.stopped) return;
				await this.writer(path, content);
				if (!this.stopped) await prune(this.directory);
			})
			.catch(() => this.fail())
			.finally(() => {
				this.active = undefined;
				if (this.flushRequested || this.closing) this.startWrite();
			});
	}

	private fail(): void {
		this.stop();
		if (this.warned) return;
		this.warned = true;
		try {
			if (this.options.warn) this.options.warn();
			else process.stderr.write("Background job diagnostics disabled: private capture could not be completed.\n");
		} catch {
			// Diagnostics must not fail a session, including when its warning sink fails.
		}
	}

	private stop(): void {
		this.accepting = false;
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.pending = [];
		this.pendingBytes = 0;
		this.flushRequested = false;
	}

	/** Best effort only: an already active OS write cannot be cancelled through the sink API. */
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.accepting = false;
		this.closing = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.flush();
		this.closePromise = (async () => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					(async () => {
						while (this.active) await this.active;
					})(),
					new Promise<void>((resolve) => {
						timeout = setTimeout(() => {
							this.fail();
							resolve();
						}, 10_000);
					}),
				]);
			} finally {
				if (timeout) clearTimeout(timeout);
				this.stop();
			}
		})();
		return this.closePromise;
	}
}

import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export const DEFAULT_IROH_REMOTE_AUDIT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_IROH_REMOTE_AUDIT_MAX_BACKUP_FILES = 2;
export const DEFAULT_IROH_REMOTE_AUDIT_MAX_ENTRY_BYTES = 64 * 1024;
export const DEFAULT_IROH_REMOTE_SECURITY_AUDIT_WINDOW_MS = 60_000;
export const DEFAULT_IROH_REMOTE_SECURITY_AUDIT_BURST = 4;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MINIMUM_AUDIT_FILE_BYTES = 1024;
const RATE_LIMITED_SECURITY_EVENT_TYPES = new Set([
	"client_rejected",
	"handshake_rejected",
	"iroh_security_connection_limit",
	"iroh_security_unauthenticated_connection_limit",
	"iroh_security_stream_limit",
	"iroh_security_handshake_limit",
	"iroh_security_handshake_timeout",
	"iroh_security_transport_rejected",
]);

export interface IrohRemoteAuditEvent {
	type: string;
	timestamp: number;
	clientNodeId?: string;
	workspace?: string;
	success?: boolean;
	error?: string;
	details?: Record<string, unknown>;
}

export type IrohRemoteAuditEventInput = Omit<IrohRemoteAuditEvent, "timestamp"> & { timestamp?: number };

export interface IrohRemoteAuditSink {
	write(event: IrohRemoteAuditEvent): void | Promise<void>;
}

export interface IrohRemoteSecurityAuditRateLimitOptions {
	maxEventsPerWindow?: number;
	windowMs?: number;
}

export interface IrohRemoteAuditLoggerOptions {
	path?: string;
	sink?: IrohRemoteAuditSink;
	now?: () => number;
	maxFileBytes?: number;
	maxBackupFiles?: number;
	maxEntryBytes?: number;
	/** Path-backed daemon logs enable the default limiter unless explicitly disabled. */
	securityEventRateLimit?: false | IrohRemoteSecurityAuditRateLimitOptions;
}

interface SecurityAuditBucket {
	windowStartedAt: number;
	emitted: number;
	suppressed: number;
	firstSuppressedAt?: number;
	lastSuppressedAt?: number;
	timer?: NodeJS.Timeout;
}

interface ResolvedSecurityAuditRateLimit {
	maxEventsPerWindow: number;
	windowMs: number;
}

function getErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function assertIntegerAtLeast(value: number, minimum: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${name} must be an integer of at least ${minimum}`);
	}
}

/**
 * Serialized, owner-only JSONL audit persistence with bounded files. Rejected
 * unauthenticated traffic is burst-sampled and then represented by aggregate
 * records so hostile handshakes cannot turn the audit trail into a disk DoS.
 */
export class IrohRemoteAuditLogger {
	private readonly path: string | undefined;
	private readonly sink: IrohRemoteAuditSink | undefined;
	private readonly now: () => number;
	private readonly maxFileBytes: number;
	private readonly maxBackupFiles: number;
	private readonly maxEntryBytes: number;
	private readonly securityRateLimit: ResolvedSecurityAuditRateLimit | undefined;
	private readonly securityBuckets = new Map<string, SecurityAuditBucket>();
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(options: IrohRemoteAuditLoggerOptions = {}) {
		this.path = options.path;
		this.sink = options.sink;
		this.now = options.now ?? Date.now;
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_IROH_REMOTE_AUDIT_MAX_FILE_BYTES;
		this.maxBackupFiles = options.maxBackupFiles ?? DEFAULT_IROH_REMOTE_AUDIT_MAX_BACKUP_FILES;
		this.maxEntryBytes = options.maxEntryBytes ?? DEFAULT_IROH_REMOTE_AUDIT_MAX_ENTRY_BYTES;
		assertIntegerAtLeast(this.maxFileBytes, MINIMUM_AUDIT_FILE_BYTES, "maxFileBytes");
		assertIntegerAtLeast(this.maxBackupFiles, 0, "maxBackupFiles");
		assertIntegerAtLeast(this.maxEntryBytes, MINIMUM_AUDIT_FILE_BYTES, "maxEntryBytes");
		if (this.maxEntryBytes > this.maxFileBytes) {
			throw new Error("maxEntryBytes must not exceed maxFileBytes");
		}

		const rateLimit = options.securityEventRateLimit;
		if (rateLimit !== false && (rateLimit !== undefined || this.path !== undefined)) {
			const maxEventsPerWindow = rateLimit?.maxEventsPerWindow ?? DEFAULT_IROH_REMOTE_SECURITY_AUDIT_BURST;
			const windowMs = rateLimit?.windowMs ?? DEFAULT_IROH_REMOTE_SECURITY_AUDIT_WINDOW_MS;
			assertIntegerAtLeast(maxEventsPerWindow, 1, "securityEventRateLimit.maxEventsPerWindow");
			assertIntegerAtLeast(windowMs, 1, "securityEventRateLimit.windowMs");
			this.securityRateLimit = { maxEventsPerWindow, windowMs };
		}
	}

	async log(event: IrohRemoteAuditEventInput): Promise<void> {
		const auditEvent: IrohRemoteAuditEvent = {
			...event,
			timestamp: event.timestamp ?? this.now(),
		};
		const events = this.applySecurityRateLimit(auditEvent);
		for (const eventToWrite of events) {
			await this.enqueue(eventToWrite);
		}
	}

	/** Flush rate-limit summaries and all queued file writes. */
	async flush(): Promise<void> {
		const observedAt = this.now();
		const summaries: IrohRemoteAuditEvent[] = [];
		for (const [eventType, bucket] of this.securityBuckets) {
			if (bucket.timer !== undefined) clearTimeout(bucket.timer);
			const summary = this.createSuppressionSummary(eventType, bucket, observedAt);
			if (summary !== undefined) summaries.push(summary);
		}
		this.securityBuckets.clear();
		const summaryWrites = summaries.map((summary) => this.enqueue(summary));
		await Promise.all(summaryWrites);
		await this.writeQueue;
	}

	private applySecurityRateLimit(event: IrohRemoteAuditEvent): IrohRemoteAuditEvent[] {
		const rateLimit = this.securityRateLimit;
		if (rateLimit === undefined || !RATE_LIMITED_SECURITY_EVENT_TYPES.has(event.type)) return [event];

		const observedAt = this.now();
		let bucket = this.securityBuckets.get(event.type);
		const events: IrohRemoteAuditEvent[] = [];
		if (bucket === undefined || observedAt - bucket.windowStartedAt >= rateLimit.windowMs) {
			if (bucket !== undefined) {
				if (bucket.timer !== undefined) clearTimeout(bucket.timer);
				const summary = this.createSuppressionSummary(event.type, bucket, observedAt);
				if (summary !== undefined) events.push(summary);
			}
			bucket = { windowStartedAt: observedAt, emitted: 0, suppressed: 0 };
			this.securityBuckets.set(event.type, bucket);
		}

		if (bucket.emitted < rateLimit.maxEventsPerWindow) {
			bucket.emitted++;
			events.push(event);
			return events;
		}

		bucket.suppressed++;
		bucket.firstSuppressedAt ??= observedAt;
		bucket.lastSuppressedAt = observedAt;
		this.scheduleSecurityBucketFlush(event.type, bucket);
		return events;
	}

	private scheduleSecurityBucketFlush(eventType: string, bucket: SecurityAuditBucket): void {
		const rateLimit = this.securityRateLimit;
		if (rateLimit === undefined || bucket.timer !== undefined) return;
		const delayMs = Math.max(1, bucket.windowStartedAt + rateLimit.windowMs - this.now());
		bucket.timer = setTimeout(() => {
			void this.flushExpiredSecurityBucket(eventType).catch(() => {});
		}, delayMs);
		bucket.timer.unref?.();
	}

	private async flushExpiredSecurityBucket(eventType: string): Promise<void> {
		const rateLimit = this.securityRateLimit;
		const bucket = this.securityBuckets.get(eventType);
		if (rateLimit === undefined || bucket === undefined) return;
		bucket.timer = undefined;
		const observedAt = this.now();
		if (observedAt - bucket.windowStartedAt < rateLimit.windowMs) {
			this.scheduleSecurityBucketFlush(eventType, bucket);
			return;
		}
		const summary = this.createSuppressionSummary(eventType, bucket, observedAt);
		this.securityBuckets.set(eventType, { windowStartedAt: observedAt, emitted: 0, suppressed: 0 });
		if (summary !== undefined) await this.enqueue(summary);
	}

	private createSuppressionSummary(
		eventType: string,
		bucket: SecurityAuditBucket,
		observedAt: number,
	): IrohRemoteAuditEvent | undefined {
		if (bucket.suppressed === 0) return undefined;
		return {
			type: "security_events_rate_limited",
			timestamp: observedAt,
			success: false,
			details: {
				eventType,
				sampledCount: bucket.emitted,
				suppressedCount: bucket.suppressed,
				windowStartedAt: bucket.windowStartedAt,
				firstSuppressedAt: bucket.firstSuppressedAt,
				lastSuppressedAt: bucket.lastSuppressedAt,
			},
		};
	}

	private enqueue(event: IrohRemoteAuditEvent): Promise<void> {
		const operation = this.writeQueue.then(() => this.write(event));
		this.writeQueue = operation.catch(() => {});
		return operation;
	}

	private async write(auditEvent: IrohRemoteAuditEvent): Promise<void> {
		if (this.sink) await this.sink.write(auditEvent);
		if (!this.path) return;

		const line = this.serialize(auditEvent);
		await this.ensurePrivateParent();
		const existingSize = await this.inspectCurrentFile();
		if (existingSize > 0 && existingSize + Buffer.byteLength(line, "utf8") > this.maxFileBytes) {
			await this.rotate();
		}
		await this.appendPrivate(line);
	}

	private serialize(auditEvent: IrohRemoteAuditEvent): string {
		const serialized = `${JSON.stringify(auditEvent)}\n`;
		const originalBytes = Buffer.byteLength(serialized, "utf8");
		if (originalBytes <= this.maxEntryBytes) return serialized;
		return `${JSON.stringify({
			type: "audit_event_truncated",
			timestamp: auditEvent.timestamp,
			success: false,
			error: "audit event exceeded maximum serialized size",
			details: { originalBytes, originalType: auditEvent.type.slice(0, 128) },
		} satisfies IrohRemoteAuditEvent)}\n`;
	}

	private async ensurePrivateParent(): Promise<void> {
		if (this.path === undefined) return;
		const parentPath = dirname(this.path);
		await mkdir(parentPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
		const parentStat = await lstat(parentPath);
		if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
			throw new Error(`Refusing to use non-directory audit path: ${parentPath}`);
		}
		await chmod(parentPath, PRIVATE_DIRECTORY_MODE);
	}

	private async inspectCurrentFile(): Promise<number> {
		if (this.path === undefined) return 0;
		try {
			const fileStat = await lstat(this.path);
			if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink !== 1) {
				throw new Error(`Refusing to use non-regular audit file: ${this.path}`);
			}
			await chmod(this.path, PRIVATE_FILE_MODE);
			return fileStat.size;
		} catch (error) {
			if (getErrorCode(error) === "ENOENT") return 0;
			throw error;
		}
	}

	private async rotate(): Promise<void> {
		if (this.path === undefined) return;
		if (this.maxBackupFiles === 0) {
			await rm(this.path, { force: true });
			return;
		}
		await rm(`${this.path}.${this.maxBackupFiles}`, { force: true });
		for (let index = this.maxBackupFiles - 1; index >= 1; index--) {
			await this.renameIfRegular(`${this.path}.${index}`, `${this.path}.${index + 1}`);
		}
		await rename(this.path, `${this.path}.1`);
	}

	private async renameIfRegular(source: string, destination: string): Promise<void> {
		try {
			const sourceStat = await lstat(source);
			if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.nlink !== 1) {
				await rm(source, { force: true });
				return;
			}
			await chmod(source, PRIVATE_FILE_MODE);
			await rm(destination, { force: true });
			await rename(source, destination);
		} catch (error) {
			if (getErrorCode(error) !== "ENOENT") throw error;
		}
	}

	private async appendPrivate(line: string): Promise<void> {
		if (this.path === undefined) return;
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const handle = await open(
			this.path,
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
			PRIVATE_FILE_MODE,
		);
		try {
			const fileStat = await handle.stat();
			if (!fileStat.isFile() || fileStat.nlink !== 1) {
				throw new Error(`Refusing to use non-regular audit file: ${this.path}`);
			}
			await handle.chmod(PRIVATE_FILE_MODE);
			await handle.writeFile(line, "utf8");
		} finally {
			await handle.close();
		}
	}
}

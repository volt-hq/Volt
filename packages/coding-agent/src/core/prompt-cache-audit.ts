import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Usage } from "@hansjm10/volt-ai";
import { writeDurableAtomicFile } from "../utils/durable-atomic-write.ts";
import { ensurePrivateDirectorySync } from "../utils/private-files.ts";
import { pruneDiagnosticFiles } from "./background-job-diagnostics.ts";
import type { PromptCacheKeepAliveStop, PromptCacheRefreshReason } from "./prompt-cache-keepalive.ts";

export const PROMPT_CACHE_AUDIT_DIRECTORY = "prompt-cache-audit";

/** Token counts and model-priced cost of one provider request. */
export interface PromptCacheAuditUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	costTotal: number;
}

interface PromptCacheAuditCommon {
	provider: string;
	model: string;
	/** Documented TTL of the active retention tier, when published. */
	ttlSeconds?: number;
	/** Keepalive settings, and the refreshes allowed per real request at the model's prices. */
	keepAlive: { enabled: boolean; idleWindowMinutes: number; refreshBudget: number };
}

export type PromptCacheAuditEvent =
	| (PromptCacheAuditCommon & {
			kind: "request";
			stopReason: string;
			/** Previous request or refresh of this prefix on the branch; "none" for the first request. */
			precededBy: "none" | "request" | "refresh";
			/** Milliseconds since that previous request or refresh started. */
			gapMs?: number;
			/** Prompt tokens of the previous request, which a full cache hit would read. */
			prefixTokens?: number;
			usage: PromptCacheAuditUsage;
	  })
	| (PromptCacheAuditCommon & {
			kind: "refresh";
			reason: PromptCacheRefreshReason;
			outcome: "refreshed" | "unsupported" | "unavailable" | "error";
			/** Unavailable reason code, or the provider's unsupported reason. Never error text. */
			detail?: string;
			durationMs: number;
			/** Milliseconds since the request (or refresh) this renews started. */
			sinceLastRequestMs?: number;
			usage?: PromptCacheAuditUsage;
	  })
	| (PromptCacheAuditCommon & {
			kind: "keepalive_stop";
			reason: PromptCacheKeepAliveStop;
			/** Milliseconds until the documented expiry when keepalive stopped. */
			expiresInMs?: number;
	  });

export function promptCacheAuditUsage(usage: Usage): PromptCacheAuditUsage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cacheWrite1h: usage.cacheWrite1h ?? 0,
		costTotal: usage.cost.total,
	};
}

export interface PromptCacheAuditOptions {
	agentDir: string;
	sessionId: () => string;
	parentSessionId?: () => string | undefined;
	/** Default: on unless VOLT_PROMPT_CACHE_AUDIT is "0" or "false". */
	enabled?: boolean;
	writer?: (path: string, content: string) => Promise<void>;
}

const MAX_BATCH_RECORDS = 64;
const FLUSH_INTERVAL_MS = 30_000;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const OWNED_FILE = new RegExp(
	`^prompt-cache-v1_\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_${UUID}_\\d{8,16}\\.jsonl$`,
);

/**
 * Batches hold metadata only, so they are written like settings and auth files. The private
 * diagnostic capture writer starts PowerShell per file on Windows, which would delay every
 * session disposal and CLI exit by seconds.
 */
async function writeAuditBatch(path: string, content: string): Promise<void> {
	ensurePrivateDirectorySync(dirname(path));
	await writeDurableAtomicFile(path, content);
}

function auditEnabledByEnvironment(): boolean {
	const setting = process.env.VOLT_PROMPT_CACHE_AUDIT?.toLowerCase();
	return setting !== "0" && setting !== "false";
}

/**
 * Metadata-only JSONL audit of prompt-cache requests, refreshes, and keepalive stops, for
 * comparing cache policies over time. Records never contain prompt or response content. Batches
 * are written off the caller's stack; a write failure disables the audit without affecting the
 * session.
 */
export class PromptCacheAudit {
	readonly runtimeId = randomUUID();
	private readonly options: PromptCacheAuditOptions;
	private readonly directory: string;
	private readonly writer: (path: string, content: string) => Promise<void>;
	private accepting: boolean;
	private sequence = 0;
	private batch = 0;
	private pending: string[] = [];
	private active: Promise<void> | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: PromptCacheAuditOptions) {
		this.options = options;
		this.directory = join(options.agentDir, PROMPT_CACHE_AUDIT_DIRECTORY);
		this.writer = options.writer ?? writeAuditBatch;
		this.accepting = options.enabled ?? auditEnabledByEnvironment();
	}

	get enabled(): boolean {
		return this.accepting;
	}

	record(event: PromptCacheAuditEvent): void {
		if (!this.accepting) return;
		try {
			const parentSessionId = this.options.parentSessionId?.();
			this.pending.push(
				JSON.stringify({
					schemaVersion: 1,
					timestamp: new Date().toISOString(),
					sequence: ++this.sequence,
					runtimeId: this.runtimeId,
					sessionId: this.options.sessionId(),
					...(parentSessionId === undefined ? {} : { parentSessionId }),
					...event,
				}),
			);
		} catch {
			// Identity callbacks or serialization failures must not affect the session.
			return;
		}
		if (this.pending.length >= MAX_BATCH_RECORDS) this.flush();
		else if (!this.timer) {
			this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
			this.timer.unref();
		}
	}

	/** Schedule a batch write; never runs the writer on the caller's stack. */
	flush(): void {
		if (this.active || this.pending.length === 0) return;
		const content = `${this.pending.join("\n")}\n`;
		this.pending = [];
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const path = join(
			this.directory,
			`prompt-cache-v1_${timestamp}_${this.runtimeId}_${String(++this.batch).padStart(8, "0")}.jsonl`,
		);
		this.active = Promise.resolve()
			.then(async () => {
				// Never create the agent directory as a side effect; a removed directory ends the audit.
				if (!existsSync(this.options.agentDir)) throw new Error("Agent directory is unavailable");
				await this.writer(path, content);
				await pruneDiagnosticFiles(this.directory, OWNED_FILE);
			})
			.catch(() => this.stop())
			.finally(() => {
				this.active = undefined;
				if (this.pending.length >= MAX_BATCH_RECORDS) this.flush();
			});
	}

	/** Flush remaining records; resolves when the final batch settles. */
	async close(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		while (this.active) await this.active;
		this.flush();
		while (this.active) await this.active;
		this.accepting = false;
	}

	private stop(): void {
		this.accepting = false;
		this.pending = [];
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}

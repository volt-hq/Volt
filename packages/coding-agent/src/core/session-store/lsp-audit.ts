import { opendir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { ENV_SESSION_DIR, expandTildePath, getSessionsDir } from "../../config.ts";
import type { LspOperationMetadata } from "../lsp/outcome.ts";
import {
	type AuditEntry,
	type AuditSession,
	type AuditSnapshot,
	type AuditSnapshotOptions,
	runLspAuditSnapshot,
} from "./lsp-audit-snapshot.ts";
import { SESSION_STORE_SCHEMA_SQL } from "./schema.ts";

export const LSP_AUDIT_LIMITS = {
	maxStores: 128,
	maxSessions: 10_000,
	maxEntries: 100_000,
	maxBytes: 64 * 1024 * 1024,
	maxEntryBytes: 256 * 1024,
	maxStoreMs: 5_000,
	maxDurationMs: 30_000,
	maxGroups: 128,
} as const;

export interface LspAuditOptions {
	cwd?: string;
	sessionDir?: string;
	allWorkspaces?: boolean;
	since?: string;
	until?: string;
	now?: Date;
	signal?: AbortSignal;
	/** Test/embedding limits may only lower the production bounds. */
	limits?: Partial<Record<keyof typeof LSP_AUDIT_LIMITS, number>>;
}

type Counts = Record<string, number>;
export interface LspAuditTotals {
	operations: number;
	explicit: number;
	automatic: number;
	triggers: Counts;
	outcomes: Counts;
	reasons: Counts;
	freshness: Counts;
	sources: Counts;
	startupFailures: number;
	diagnosticCount: number;
	resultCount: number;
}

interface Percentiles {
	samples: number;
	p50: number | null;
	p95: number | null;
}

export interface LspAuditReport {
	version: 1;
	window: { since: string; until: string; boundary: "since-inclusive, until-exclusive" };
	scope: "workspace" | "all-workspaces";
	coverage: {
		partial: boolean;
		cancelled: boolean;
		storesDiscovered: number;
		storesRead: number;
		skippedStores: Counts;
		sessionsScanned: number;
		entriesScanned: number;
		bytesScanned: number;
		oversizedEntries: number;
		limitsReached: string[];
		limits: Record<keyof typeof LSP_AUDIT_LIMITS, number>;
	};
	utilization: {
		definition: string;
		toolActiveConversations: number;
		withExplicitLsp: number;
		withAutomaticLsp: number;
		withAnyLsp: number;
		explicitRate: number | null;
		anyRate: number | null;
		cohorts: Record<"root" | "subagent", { toolActive: number; withLsp: number }>;
	};
	totals: LspAuditTotals;
	byAction: Record<string, LspAuditTotals>;
	byLanguage: Record<string, LspAuditTotals>;
	byDay: Record<string, LspAuditTotals>;
	byCohort: Record<"root" | "subagent", LspAuditTotals>;
	latencyMs: {
		all: Percentiles;
		cold: Percentiles;
		warm: Percentiles;
		startup: Percentiles;
		notStartedOrUnknown: Percentiles;
	};
	latencyDefinition: string;
	uninstrumented: { explicit: number; automaticChecksUnknown: number; outcome: "unknown" };
	contextOnly: { grepResults: number; bashResults: number; note: string };
	deduplication: { copiesRemoved: number; originalContextUnavailable: number; definition: string };
}

const actions = new Set([
	"status",
	"definition",
	"references",
	"implementations",
	"type-definition",
	"callers",
	"callees",
	"hover",
	"symbols",
	"diagnostics",
	"rename",
	"fix",
]);
const outcomes = new Set([
	"success",
	"empty",
	"needs-selection",
	"skipped",
	"unavailable",
	"unsupported",
	"invalid-input",
	"timeout",
	"cancelled",
	"request-failed",
	"edit-failed",
]);
const freshnessValues = new Set(["fresh", "unverified", "stale", "unknown"]);
const sources = new Set(["pull", "push", "cache", "none"]);

function totals(): LspAuditTotals {
	return {
		operations: 0,
		explicit: 0,
		automatic: 0,
		triggers: {},
		outcomes: {},
		reasons: {},
		freshness: {},
		sources: {},
		startupFailures: 0,
		diagnosticCount: 0,
		resultCount: 0,
	};
}

function increment(counts: Counts, key: string): void {
	Object.defineProperty(counts, key, {
		value: (Object.hasOwn(counts, key) ? counts[key] : 0) + 1,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function token(value: unknown): string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9_.+-]{0,79}$/i.test(value) ? value : "unknown";
}

function metadata(value: string | null): LspOperationMetadata | undefined {
	if (!value) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const data = parsed as Record<string, unknown>;
	if (
		typeof data.operationId !== "string" ||
		data.operationId.length === 0 ||
		data.operationId.length > 128 ||
		typeof data.completedAt !== "string" ||
		!Number.isFinite(Date.parse(data.completedAt)) ||
		!["explicit", "edit", "write"].includes(String(data.trigger)) ||
		!outcomes.has(String(data.outcome)) ||
		!freshnessValues.has(String(data.freshness)) ||
		!sources.has(String(data.source))
	)
		return undefined;
	if (
		["durationMs", "coldStartMs", "diagnosticCount", "resultCount"].some(
			(key) => typeof data[key] !== "number" || !Number.isFinite(data[key]) || (data[key] as number) < 0,
		)
	)
		return undefined;
	return {
		...data,
		action: actions.has(String(data.action)) ? String(data.action) : "unknown",
		reason: token(data.reason),
		language: token(data.language),
		server: token(data.server),
	} as unknown as LspOperationMetadata;
}

function accumulate(target: LspAuditTotals, operation: LspOperationMetadata, maxGroups: number): void {
	target.operations++;
	if (operation.trigger === "explicit") target.explicit++;
	else target.automatic++;
	for (const [counts, key] of [
		[target.triggers, operation.trigger],
		[target.outcomes, operation.outcome],
		[target.reasons, operation.reason],
		[target.freshness, operation.freshness],
		[target.sources, operation.source],
	] as const) {
		increment(counts, Object.hasOwn(counts, key) || Object.keys(counts).length < maxGroups ? key : "other");
	}
	if (
		[
			"startup-failed",
			"start-failed",
			"missing-command",
			"missing-executable",
			"unusable-executable",
			"spawn-failed",
			"invalid-initialize",
			"initialize-failed",
			"initialization-failed",
			"startup-timeout",
			"server-start-failed",
			"incompatible-version",
			"version-probe-failed",
			"circuit-open",
			"breaker-open",
		].includes(operation.reason)
	)
		target.startupFailures++;
	target.diagnosticCount += operation.diagnosticCount;
	target.resultCount += operation.resultCount;
}

function percentiles(values: number[]): Percentiles {
	values.sort((a, b) => a - b);
	return {
		samples: values.length,
		p50: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
		p95: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null,
	};
}

async function canonical(path: string): Promise<string> {
	const absolute = resolve(expandTildePath(path));
	let value: string;
	try {
		value = await realpath(absolute);
	} catch {
		value = absolute;
	}
	return process.platform === "win32" ? value.toLowerCase() : value;
}

async function snapshot(
	options: AuditSnapshotOptions,
	timeout: number,
	signal?: AbortSignal,
): Promise<AuditSnapshot | "timeout" | "cancelled"> {
	if (signal?.aborted) return "cancelled";
	const worker = new Worker(`(${runLspAuditSnapshot.toString()})(require)`, {
		eval: true,
		workerData: options,
		execArgv: ["--disable-warning=ExperimentalWarning"],
		resourceLimits: { maxOldGenerationSizeMb: 128 },
	});
	return new Promise((resolveResult) => {
		let settled = false;
		const finish = (value: AuditSnapshot | "timeout" | "cancelled") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			void worker.terminate().then(() => resolveResult(value));
		};
		const abort = () => finish("cancelled");
		const timer = setTimeout(() => finish("timeout"), timeout);
		signal?.addEventListener("abort", abort, { once: true });
		worker.once("message", (value: AuditSnapshot) => finish(value));
		worker.once("error", () =>
			finish({
				status: "unreadable",
				sessions: [],
				entries: [],
				scannedEntries: 0,
				scannedBytes: 0,
				oversizedEntries: 0,
				limited: false,
			}),
		);
		worker.once("exit", () => {
			if (!settled) finish("timeout");
		});
		if (signal?.aborted) abort();
	});
}

interface Candidate {
	operation: LspOperationMetadata;
	sessionKey: string;
	session: AuditSession;
	entry: AuditEntry;
	eligible: boolean;
	inScope: boolean;
}

/** Content-free, offline audit. Does not acquire or initialize a normal session store. */
export async function auditLsp(options: LspAuditOptions = {}): Promise<LspAuditReport> {
	const started = Date.now();
	const until = new Date(options.until ?? options.now ?? new Date());
	const since = new Date(options.since ?? new Date(until.getTime() - 14 * 86400_000));
	if (!Number.isFinite(since.getTime()) || !Number.isFinite(until.getTime()) || since >= until)
		throw new Error("Audit requires valid dates with --since before --until.");
	const limits = { ...LSP_AUDIT_LIMITS } as Record<keyof typeof LSP_AUDIT_LIMITS, number>;
	for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
		const value = options.limits?.[key];
		if (value !== undefined) {
			if (!Number.isInteger(value) || value < 1) throw new Error("Audit limits must be positive integers.");
			limits[key] = Math.min(value, limits[key]);
		}
	}
	const report: LspAuditReport = {
		version: 1,
		window: { since: since.toISOString(), until: until.toISOString(), boundary: "since-inclusive, until-exclusive" },
		scope: options.allWorkspaces ? "all-workspaces" : "workspace",
		coverage: {
			partial: false,
			cancelled: false,
			storesDiscovered: 0,
			storesRead: 0,
			skippedStores: {},
			sessionsScanned: 0,
			entriesScanned: 0,
			bytesScanned: 0,
			oversizedEntries: 0,
			limitsReached: [],
			limits,
		},
		utilization: {
			definition:
				"Distinct sessions with a tool call/result in the window, excluding empty sessions and copied history predating session creation; LSP operations are attributed after operation-ID deduplication. Copies without an eligible original context contribute operation totals but not utilization.",
			toolActiveConversations: 0,
			withExplicitLsp: 0,
			withAutomaticLsp: 0,
			withAnyLsp: 0,
			explicitRate: null,
			anyRate: null,
			cohorts: { root: { toolActive: 0, withLsp: 0 }, subagent: { toolActive: 0, withLsp: 0 } },
		},
		totals: totals(),
		byAction: {},
		byLanguage: {},
		byDay: {},
		byCohort: { root: totals(), subagent: totals() },
		latencyMs: {
			all: percentiles([]),
			cold: percentiles([]),
			warm: percentiles([]),
			startup: percentiles([]),
			notStartedOrUnknown: percentiles([]),
		},
		latencyDefinition:
			"Nearest-rank percentiles of recorded durations. Cold means coldStartMs > 0; warm requires successful/completed server work or a diagnostic source, with no recorded startup. Skips and other uncertain zero-startup attempts are notStartedOrUnknown, not warm. Startup failures count affected operations, not distinct process launches.",
		uninstrumented: { explicit: 0, automaticChecksUnknown: 0, outcome: "unknown" },
		contextOnly: {
			grepResults: 0,
			bashResults: 0,
			note: "Grep/bash counts are context only; they do not establish LSP applicability, intent, or missed opportunities.",
		},
		deduplication: {
			copiesRemoved: 0,
			originalContextUnavailable: 0,
			definition:
				"All branches, once per operationId; completedAt selects the window. Prefer a session created before completion, then earliest result timestamp/session creation. If original execution is unavailable, attribute the earliest observed copy and report uncertainty.",
		},
	};
	const coverage = report.coverage;
	const hitLimit = (name: string) => {
		coverage.partial = true;
		if (!coverage.limitsReached.includes(name)) coverage.limitsReached.push(name);
	};
	const cwd = await canonical(options.cwd ?? process.cwd());
	const explicitDir = options.sessionDir ?? process.env[ENV_SESSION_DIR];
	const directories: string[] = [];
	if (explicitDir) directories.push(await canonical(explicitDir));
	else if (!options.allWorkspaces)
		directories.push(join(getSessionsDir(), `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`));
	else {
		try {
			const root = await opendir(getSessionsDir());
			let inspected = 0;
			for await (const entry of root) {
				if (++inspected > limits.maxStores) {
					hitLimit("stores");
					break;
				}
				if (entry.isDirectory() || entry.isSymbolicLink()) directories.push(join(getSessionsDir(), entry.name));
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				increment(coverage.skippedStores, "unreadable");
				coverage.partial = true;
			}
		}
	}
	const uniqueDirectories = new Set<string>();
	for (const directory of directories) uniqueDirectories.add(await canonical(directory));
	coverage.storesDiscovered = uniqueDirectories.size;
	const active = new Map<string, "root" | "subagent">();
	const explicit = new Set<string>();
	const automatic = new Set<string>();
	const candidates = new Map<string, Candidate>();
	const historical = new Set<string>();
	const inWindow = (timestamp: string) =>
		Date.parse(timestamp) >= since.getTime() && Date.parse(timestamp) < until.getTime();
	const scopeCache = new Map<string, boolean>();
	for (const directory of [...uniqueDirectories].sort()) {
		if (options.signal?.aborted) {
			coverage.cancelled = true;
			coverage.partial = true;
			break;
		}
		const remainingMs = limits.maxDurationMs - (Date.now() - started);
		if (remainingMs <= 0) {
			hitLimit("duration");
			break;
		}
		if (
			coverage.entriesScanned >= limits.maxEntries ||
			coverage.bytesScanned >= limits.maxBytes ||
			coverage.sessionsScanned >= limits.maxSessions
		) {
			hitLimit("scan");
			break;
		}
		const path = join(directory, "sessions.sqlite");
		try {
			if (!(await stat(path)).isFile()) {
				increment(coverage.skippedStores, "unreadable");
				coverage.partial = true;
				continue;
			}
		} catch (error) {
			increment(
				coverage.skippedStores,
				(error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable",
			);
			coverage.partial = true;
			continue;
		}
		const data = await snapshot(
			{
				path,
				schemaSql: SESSION_STORE_SCHEMA_SQL,
				maxSessions: limits.maxSessions - coverage.sessionsScanned,
				maxEntries: limits.maxEntries - coverage.entriesScanned,
				maxBytes: limits.maxBytes - coverage.bytesScanned,
				maxEntryBytes: limits.maxEntryBytes,
			},
			Math.min(limits.maxStoreMs, remainingMs),
			options.signal,
		);
		if (typeof data === "string") {
			increment(coverage.skippedStores, data);
			coverage.partial = true;
			if (data === "cancelled") {
				coverage.cancelled = true;
				break;
			}
			continue;
		}
		if (data.status !== "ok") {
			increment(coverage.skippedStores, data.status);
			coverage.partial = true;
			continue;
		}
		coverage.storesRead++;
		coverage.sessionsScanned += data.sessions.length;
		coverage.entriesScanned += data.scannedEntries;
		coverage.bytesScanned += data.scannedBytes;
		coverage.oversizedEntries += data.oversizedEntries;
		if (data.limited) hitLimit("scan");
		if (data.oversizedEntries) hitLimit("entry-bytes");
		const sessions = new Map(data.sessions.map((session) => [session.id, session]));
		for (const session of data.sessions)
			if (!scopeCache.has(session.cwd))
				scopeCache.set(session.cwd, !!options.allWorkspaces || (await canonical(session.cwd)) === cwd);
		for (const entry of data.entries) {
			const session = sessions.get(entry.sessionId);
			if (!session) continue;
			const sessionKey = `${directory}\0${session.id}`;
			const inScope = scopeCache.get(session.cwd) === true;
			const cohort = session.origin === "subagent" ? "subagent" : "root";
			const operation = entry.role === "toolResult" ? metadata(entry.lsp) : undefined;
			if (operation) {
				if (!inWindow(operation.completedAt)) continue;
				const candidate: Candidate = {
					operation,
					sessionKey,
					session,
					entry,
					inScope,
					eligible: Date.parse(session.createdAt) <= Date.parse(operation.completedAt),
				};
				const old = candidates.get(operation.operationId);
				if (old) report.deduplication.copiesRemoved++;
				if (
					!old ||
					(candidate.eligible && !old.eligible) ||
					(candidate.eligible === old.eligible &&
						(Date.parse(entry.timestamp) < Date.parse(old.entry.timestamp) ||
							(entry.timestamp === old.entry.timestamp &&
								Date.parse(session.createdAt) < Date.parse(old.session.createdAt))))
				)
					candidates.set(operation.operationId, candidate);
			} else if (
				inScope &&
				inWindow(entry.timestamp) &&
				Date.parse(session.createdAt) <= Date.parse(entry.timestamp)
			) {
				if (entry.role === "toolResult" || entry.calls.length > 0) active.set(sessionKey, cohort);
				if (entry.role !== "toolResult") continue;
				const key = `${entry.toolName}\0${entry.toolCallId ?? sessionKey}\0${entry.timestamp}`;
				if (historical.has(key)) continue;
				historical.add(key);
				if (entry.toolName === "lsp") report.uninstrumented.explicit++;
				if (entry.toolName === "edit" || entry.toolName === "write") report.uninstrumented.automaticChecksUnknown++;
				if (entry.toolName === "grep") report.contextOnly.grepResults++;
				if (entry.toolName === "bash") report.contextOnly.bashResults++;
			}
		}
	}
	const durations: number[] = [],
		cold: number[] = [],
		warm: number[] = [],
		startup: number[] = [],
		notStartedOrUnknown: number[] = [];
	for (const candidate of candidates.values()) {
		if (!candidate.inScope) continue;
		const { operation, sessionKey, session } = candidate;
		const cohort = session.origin === "subagent" ? "subagent" : "root";
		if (!candidate.eligible) report.deduplication.originalContextUnavailable++;
		if (candidate.eligible) {
			active.set(sessionKey, cohort);
			(operation.trigger === "explicit" ? explicit : automatic).add(sessionKey);
		}
		accumulate(report.totals, operation, limits.maxGroups);
		accumulate(report.byCohort[cohort], operation, limits.maxGroups);
		for (const [groups, rawKey] of [
			[report.byAction, operation.action],
			[report.byLanguage, operation.language],
			[report.byDay, new Date(operation.completedAt).toISOString().slice(0, 10)],
		] as const) {
			const key = Object.hasOwn(groups, rawKey) || Object.keys(groups).length < limits.maxGroups ? rawKey : "other";
			if (!Object.hasOwn(groups, key))
				Object.defineProperty(groups, key, { value: totals(), enumerable: true, configurable: true });
			accumulate(groups[key], operation, limits.maxGroups);
			if (key === "other") hitLimit("groups");
		}
		durations.push(operation.durationMs);
		if (operation.coldStartMs > 0) {
			cold.push(operation.durationMs);
			startup.push(operation.coldStartMs);
		} else if (
			operation.action !== "status" &&
			(["success", "empty", "needs-selection"].includes(operation.outcome) || operation.source !== "none")
		)
			warm.push(operation.durationMs);
		else notStartedOrUnknown.push(operation.durationMs);
	}
	const withAny = new Set([...explicit, ...automatic]);
	Object.assign(report.utilization, {
		toolActiveConversations: active.size,
		withExplicitLsp: explicit.size,
		withAutomaticLsp: automatic.size,
		withAnyLsp: withAny.size,
		explicitRate: active.size ? explicit.size / active.size : null,
		anyRate: active.size ? withAny.size / active.size : null,
	});
	for (const [key, cohort] of active) {
		report.utilization.cohorts[cohort].toolActive++;
		if (withAny.has(key)) report.utilization.cohorts[cohort].withLsp++;
	}
	report.latencyMs = {
		all: percentiles(durations),
		cold: percentiles(cold),
		warm: percentiles(warm),
		startup: percentiles(startup),
		notStartedOrUnknown: percentiles(notStartedOrUnknown),
	};
	return report;
}

import { randomUUID } from "node:crypto";

export type LspOutcome =
	| "success"
	| "empty"
	| "needs-selection"
	| "skipped"
	| "unavailable"
	| "unsupported"
	| "invalid-input"
	| "timeout"
	| "cancelled"
	| "request-failed"
	| "edit-failed";

export type LspFreshness = "fresh" | "unverified" | "stale" | "unknown";
export type LspDiagnosticSource = "pull" | "push" | "cache" | "none";

/** Human-readable output and machine-readable evidence are independent. */
export interface LspResult {
	text: string;
	outcome: LspOutcome;
	reason: string;
	freshness: LspFreshness;
	source: LspDiagnosticSource;
	diagnosticCount: number;
	resultCount: number;
	coldStartMs: number;
	language?: string;
	server?: string;
	root?: string;
}

/** Bounded, content-free operation evidence stored in tool-result details.lsp. */
export interface LspOperationMetadata {
	operationId: string;
	trigger: "explicit" | "edit" | "write";
	action: string;
	completedAt: string;
	outcome: LspOutcome;
	reason: string;
	language: string;
	server: string;
	durationMs: number;
	coldStartMs: number;
	diagnosticCount: number;
	resultCount: number;
	freshness: LspFreshness;
	source: LspDiagnosticSource;
}

export function lspResult(
	outcome: LspOutcome,
	text: string,
	evidence: Partial<Omit<LspResult, "outcome" | "text">> = {},
): LspResult {
	return {
		text,
		outcome,
		reason: outcome,
		freshness: "unknown",
		source: "none",
		diagnosticCount: 0,
		resultCount: 0,
		coldStartMs: 0,
		...evidence,
	};
}

export class LspOperationError extends Error {
	readonly outcome: LspOutcome;
	readonly reason: string;
	constructor(outcome: LspOutcome, reason: string, message: string) {
		super(message);
		this.outcome = outcome;
		this.reason = reason;
	}
}

export function lspErrorResult(error: unknown): LspResult {
	return lspResult(
		error instanceof LspOperationError ? error.outcome : "request-failed",
		error instanceof Error ? error.message : String(error),
		{ reason: error instanceof LspOperationError ? error.reason : "request-failed" },
	);
}

/** Cancels only this wait, never a shared startup or repair. */
export function waitForLsp<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new LspOperationError("cancelled", "aborted", "LSP operation aborted"));
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener("abort", onAbort);
			reject(new LspOperationError("cancelled", "aborted", "LSP operation aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function lspSucceeded(result: LspResult): boolean {
	return result.outcome === "success" || result.outcome === "empty" || result.outcome === "needs-selection";
}

export function lspOperationMetadata(
	result: LspResult,
	trigger: LspOperationMetadata["trigger"],
	action: string,
	startedAt: number,
): LspOperationMetadata {
	return {
		operationId: randomUUID(),
		trigger,
		action,
		completedAt: new Date().toISOString(),
		outcome: result.outcome,
		reason: result.reason.slice(0, 80),
		language: (result.language ?? "unknown").slice(0, 80),
		server: (result.server ?? "none").slice(0, 80),
		durationMs: Math.max(0, performance.now() - startedAt),
		coldStartMs: result.coldStartMs,
		diagnosticCount: result.diagnosticCount,
		resultCount: result.resultCount,
		freshness: result.freshness,
		source: result.source,
	};
}

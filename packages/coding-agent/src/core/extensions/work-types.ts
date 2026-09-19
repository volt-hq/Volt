import type { FindToolInput } from "../tools/find.ts";
import type { GrepToolInput } from "../tools/grep.ts";
import type { ReadToolInput } from "../tools/read.ts";

export type ExtensionWorkService =
	| "readText"
	| "findPaths"
	| "searchText"
	| "symbols"
	| "definition"
	| "references"
	| "readSkill";
export type ExtensionWorkCause = "input" | "tools" | "continuation" | "retry";
export type ExtensionWorkTaskState = "running" | "draining" | "cancelling" | "completed" | "failed" | "cancelled";
export type ExtensionWorkFailureStatus =
	| "denied"
	| "unavailable"
	| "unsupported"
	| "invalidated"
	| "cancelled"
	| "deadline_exceeded"
	| "limit_exceeded"
	| "failed";

export interface ExtensionWorkFailure {
	status: ExtensionWorkFailureStatus;
	/** Fixed host reason code, not an arbitrary exception message. */
	reason: string;
}

export interface ExtensionWorkInput {
	text: string;
	kind: "prompt" | "steer" | "followUp";
}

export interface ExtensionWorkSkill {
	resourceId: string;
	name: string;
	description: string;
	scope: "user" | "project" | "temporary";
	origin: "top-level" | "package";
}

export interface ExtensionWorkLocation {
	path: string;
	/** All line and column coordinates are 1-based. */
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface ExtensionWorkSymbol extends ExtensionWorkLocation {
	name: string;
	/** Language Server Protocol SymbolKind value. */
	kind: number;
}

export interface ExtensionWorkSnapshot {
	scopeId: string;
	branchId: string;
	runtimeId: string;
	revision: number;
	cwd: string;
	mode: "build" | "plan";
	model?: { provider: string; id: string };
	inputs: readonly ExtensionWorkInput[];
	services: readonly ExtensionWorkService[];
	skills: readonly ExtensionWorkSkill[];
	skillsTruncated: boolean;
}

export interface ExtensionWorkEvidence {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	observedAt: number;
	resourceId?: string;
}

export type ExtensionWorkReadResult =
	| ExtensionWorkFailure
	| { status: "ok"; text: string; truncated: boolean; evidence: ExtensionWorkEvidence };
export type ExtensionWorkFindResult = ExtensionWorkFailure | { status: "ok"; paths: string[]; truncated: boolean };
export type ExtensionWorkSearchResult =
	| ExtensionWorkFailure
	| { status: "ok"; matches: Array<{ path: string; line: number; text: string }>; truncated: boolean };

export type ExtensionWorkSymbolsResult =
	| ExtensionWorkFailure
	| { status: "ok"; symbols: ExtensionWorkSymbol[]; truncated: boolean; coverage: "unknown"; observedAt: number };
export type ExtensionWorkLocationsResult =
	| ExtensionWorkFailure
	| { status: "ok"; locations: ExtensionWorkLocation[]; truncated: boolean; coverage: "unknown"; observedAt: number };

export interface ExtensionWorkRepository {
	readText(input: ReadToolInput): Promise<ExtensionWorkReadResult>;
	findPaths(input: FindToolInput): Promise<ExtensionWorkFindResult>;
	searchText(input: GrepToolInput): Promise<ExtensionWorkSearchResult>;
	symbols(input: { path: string; symbol?: string }): Promise<ExtensionWorkSymbolsResult>;
	definition(input: { path: string; symbol: string; line?: number }): Promise<ExtensionWorkLocationsResult>;
	references(input: { path: string; symbol: string; line?: number }): Promise<ExtensionWorkLocationsResult>;
	readSkill(input: { resourceId: string; offset?: number; limit?: number }): Promise<ExtensionWorkReadResult>;
}

export interface ExtensionWorkContribution {
	key: string;
	text: string;
	/** Source-only text can survive ordinary conversation appends, never a new request. */
	dependency?: "snapshot" | "sources";
	evidenceIds?: string[];
}

export interface ExtensionWorkTaskContext {
	readonly snapshot: ExtensionWorkSnapshot;
	readonly signal: AbortSignal;
	readonly deadline: number;
	readonly repository: ExtensionWorkRepository;
	readonly context: {
		put(contribution: ExtensionWorkContribution): { status: "accepted" } | ExtensionWorkFailure;
		remove(key: string): void;
	};
}

export interface ExtensionWorkTaskSpec {
	key: string;
	label: string;
	timeoutMs?: number;
}

export interface ExtensionWorkTaskSummary {
	id: string;
	key: string;
	state: ExtensionWorkTaskState;
	startedAt: number;
	endedAt?: number;
	reason?: string;
}

export interface ExtensionWorkTaskHandle {
	readonly id: string;
	status(): ExtensionWorkTaskSummary;
	cancel(): void;
	/** Cancellation only stops this wait; it does not cancel the task. */
	wait(options?: { signal?: AbortSignal }): Promise<ExtensionWorkTaskSummary>;
}

export type ExtensionWorkTaskAdmission =
	| { status: "started" | "already_running"; task: ExtensionWorkTaskHandle }
	| ExtensionWorkFailure;

export interface ExtensionWorkContext {
	readonly snapshot: ExtensionWorkSnapshot;
	readonly context: {
		/** Synchronous first-boundary only; returns the shared effective wait allowance. */
		requestWait(milliseconds: number): number;
	};
	readonly tasks: {
		start(
			spec: ExtensionWorkTaskSpec,
			callback: (task: ExtensionWorkTaskContext) => Promise<void>,
		): ExtensionWorkTaskAdmission;
	};
}

export interface ExtensionWorkStatus {
	tasks: ExtensionWorkTaskSummary[];
	contributions: Array<{ key: string; status: "ready" | "admitted" | "omitted"; reason?: string }>;
}

export interface RequestBoundaryEvent {
	type: "request_boundary";
	attemptId: string;
	cause: ExtensionWorkCause;
	first: boolean;
	/** Host allowance at this notification; zero outside the first eligible boundary. */
	waitAvailableMs: number;
}

export interface ExtensionOperationEvent {
	type: "extension_operation";
	extensionId: string;
	scopeId: string;
	operationId: string;
	ownerId: string;
	ownerKind: "task" | "validation";
	service: ExtensionWorkService;
	status: "ok" | ExtensionWorkFailureStatus;
	durationMs: number;
	bytes: number;
}

export type ExtensionOperationOrigin =
	| { kind: "agent" }
	| { kind: "extension"; extensionId: string; scopeId: string; ownerId: string; ownerKind: "task" | "validation" };

/** Host ceilings. All values are finite nonnegative integers; only firstRequestWaitMs can exceed its default (up to 1000 ms). */
export interface ExtensionWorkLimits {
	perExtensionTasks: number;
	perRuntimeTasks: number;
	taskTimeoutMs: number;
	maxTaskTimeoutMs: number;
	taskOperations: number;
	scopeOperations: number;
	taskBytes: number;
	scopeBytes: number;
	contributionBytes: number;
	extensionContributionBytes: number;
	suffixBytes: number;
	collectionMs: number;
	/** Opt-in shared preparation wait on the first request, default 0, maximum 1000 ms. */
	firstRequestWaitMs: number;
}

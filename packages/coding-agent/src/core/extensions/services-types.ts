import type { FindToolInput } from "../tools/find.ts";
import type { GrepToolInput } from "../tools/grep.ts";
import type { ReadToolInput } from "../tools/read.ts";

export type ExtensionServicesService =
	| "readText"
	| "findPaths"
	| "searchText"
	| "symbols"
	| "definition"
	| "references"
	| "readSkill";
export type ExtensionServicesCause = "input" | "tools" | "continuation" | "retry";
export type ExtensionServicesTaskState = "running" | "draining" | "cancelling" | "completed" | "failed" | "cancelled";
export type ExtensionServicesFailureStatus =
	| "denied"
	| "unavailable"
	| "unsupported"
	| "invalidated"
	| "cancelled"
	| "deadline_exceeded"
	| "limit_exceeded"
	| "failed";

export interface ExtensionServicesFailure {
	status: ExtensionServicesFailureStatus;
	/** Fixed host reason code, not an arbitrary exception message. */
	reason: string;
}

export interface ExtensionServicesInput {
	text: string;
	kind: "prompt" | "steer" | "followUp";
}

export interface ExtensionServicesSkill {
	resourceId: string;
	name: string;
	description: string;
	scope: "user" | "project" | "temporary";
	origin: "top-level" | "package";
}

export interface ExtensionServicesLocation {
	path: string;
	/** All line and column coordinates are 1-based. */
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface ExtensionServicesSymbol extends ExtensionServicesLocation {
	name: string;
	/** Language Server Protocol SymbolKind value. */
	kind: number;
}

export interface ExtensionServicesSnapshot {
	scopeId: string;
	branchId: string;
	runtimeId: string;
	revision: number;
	cwd: string;
	mode: "build" | "plan";
	model?: { provider: string; id: string };
	inputs: readonly ExtensionServicesInput[];
	services: readonly ExtensionServicesService[];
	skills: readonly ExtensionServicesSkill[];
	skillsTruncated: boolean;
}

export interface ExtensionServicesEvidence {
	id: string;
	path: string;
	startLine: number;
	endLine: number;
	observedAt: number;
	resourceId?: string;
}

export type ExtensionServicesReadResult =
	| ExtensionServicesFailure
	| { status: "ok"; text: string; truncated: boolean; evidence: ExtensionServicesEvidence };
export type ExtensionServicesFindResult =
	| ExtensionServicesFailure
	| { status: "ok"; paths: string[]; truncated: boolean };
export type ExtensionServicesSearchResult =
	| ExtensionServicesFailure
	| { status: "ok"; matches: Array<{ path: string; line: number; text: string }>; truncated: boolean };

export type ExtensionServicesSymbolsResult =
	| ExtensionServicesFailure
	| { status: "ok"; symbols: ExtensionServicesSymbol[]; truncated: boolean; coverage: "unknown"; observedAt: number };
export type ExtensionServicesLocationsResult =
	| ExtensionServicesFailure
	| {
			status: "ok";
			locations: ExtensionServicesLocation[];
			truncated: boolean;
			coverage: "unknown";
			observedAt: number;
	  };

export interface ExtensionServicesRepository {
	readText(input: ReadToolInput): Promise<ExtensionServicesReadResult>;
	findPaths(input: FindToolInput): Promise<ExtensionServicesFindResult>;
	searchText(input: GrepToolInput): Promise<ExtensionServicesSearchResult>;
	symbols(input: { path: string; symbol?: string }): Promise<ExtensionServicesSymbolsResult>;
	definition(input: { path: string; symbol: string; line?: number }): Promise<ExtensionServicesLocationsResult>;
	references(input: { path: string; symbol: string; line?: number }): Promise<ExtensionServicesLocationsResult>;
	readSkill(input: { resourceId: string; offset?: number; limit?: number }): Promise<ExtensionServicesReadResult>;
}

export interface ExtensionServicesContribution {
	key: string;
	text: string;
	/** Source-only text can survive ordinary conversation appends, never a new request. */
	dependency?: "snapshot" | "sources";
	evidenceIds?: string[];
}

export interface ExtensionServicesTaskContext {
	readonly snapshot: ExtensionServicesSnapshot;
	readonly signal: AbortSignal;
	readonly deadline: number;
	readonly repository: ExtensionServicesRepository;
	readonly context: {
		put(contribution: ExtensionServicesContribution): { status: "accepted" } | ExtensionServicesFailure;
		remove(key: string): void;
	};
}

export interface ExtensionServicesTaskSpec {
	key: string;
	label: string;
	timeoutMs?: number;
}

export interface ExtensionServicesTaskSummary {
	id: string;
	key: string;
	state: ExtensionServicesTaskState;
	startedAt: number;
	endedAt?: number;
	reason?: string;
}

export interface ExtensionServicesTaskHandle {
	readonly id: string;
	status(): ExtensionServicesTaskSummary;
	cancel(): void;
	/** Cancellation only stops this wait; it does not cancel the task. */
	wait(options?: { signal?: AbortSignal }): Promise<ExtensionServicesTaskSummary>;
}

export type ExtensionServicesTaskAdmission =
	| { status: "started" | "already_running"; task: ExtensionServicesTaskHandle }
	| ExtensionServicesFailure;

export interface ExtensionServicesContext {
	readonly snapshot: ExtensionServicesSnapshot;
	readonly context: {
		/** Synchronous first-boundary only; returns the shared effective wait allowance. */
		requestWait(milliseconds: number): number;
	};
	readonly tasks: {
		start(
			spec: ExtensionServicesTaskSpec,
			callback: (task: ExtensionServicesTaskContext) => Promise<void>,
		): ExtensionServicesTaskAdmission;
	};
}

export interface ExtensionServicesStatus {
	tasks: ExtensionServicesTaskSummary[];
	contributions: Array<{ key: string; status: "ready" | "admitted" | "omitted"; reason?: string }>;
}

export interface RequestBoundaryEvent {
	type: "request_boundary";
	attemptId: string;
	cause: ExtensionServicesCause;
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
	service: ExtensionServicesService;
	status: "ok" | ExtensionServicesFailureStatus;
	durationMs: number;
	bytes: number;
}

export type ExtensionOperationOrigin =
	| { kind: "agent" }
	| { kind: "extension"; extensionId: string; scopeId: string; ownerId: string; ownerKind: "task" | "validation" };

/** Host ceilings. All values are finite nonnegative integers; only firstRequestWaitMs can exceed its default (up to 100). */
export interface ExtensionServicesLimits {
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
	/** Opt-in shared preparation wait on the first request, default 0, maximum 100 ms. */
	firstRequestWaitMs: number;
}

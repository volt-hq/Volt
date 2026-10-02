import type { JsonObject } from "@hansjm10/volt-ai";
import type { ManagedLspObservation } from "../lsp/managed-observation.ts";
import type { RepositoryObservation } from "../tools/repository-observation.ts";
import type {
	ExtensionOperationEvent,
	ExtensionOperationOrigin,
	ExtensionWorkCause,
	ExtensionWorkFailure,
	ExtensionWorkLimits,
	ExtensionWorkService,
	ExtensionWorkSnapshot,
	RequestBoundaryEvent,
} from "./work-types.ts";

export interface ExtensionWorkCollection {
	readonly text: string;
	readonly authorization: {
		isCurrent(): boolean;
		settle(admitted: boolean): void;
	};
}

export interface ExtensionWorkExecution {
	service: ExtensionWorkService;
	input: JsonObject;
	signal: AbortSignal;
	origin: Extract<ExtensionOperationOrigin, { kind: "extension" }>;
}

export type ExtensionWorkExecutionResult =
	| ExtensionWorkFailure
	| { status: "ok"; observation: RepositoryObservation | ManagedLspObservation; implementation: object };

export interface ExtensionWorkBoundary {
	/** Stable identity of the most recent committed user-delivery batch, retained over retries. */
	key: string;
	attemptId: string;
	cause: ExtensionWorkCause;
	allowNewWork: boolean;
	snapshot: Omit<ExtensionWorkSnapshot, "scopeId" | "runtimeId">;
}

export interface ExtensionWorkManagerOptions {
	limits?: Partial<ExtensionWorkLimits>;
	isCurrent(): boolean;
	execute(request: ExtensionWorkExecution): Promise<ExtensionWorkExecutionResult>;
	onBoundary(event: RequestBoundaryEvent): void;
	onOperation(event: ExtensionOperationEvent): void;
}

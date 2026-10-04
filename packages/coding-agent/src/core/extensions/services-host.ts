import type { JsonObject } from "@hansjm10/volt-ai";
import type { ManagedLspObservation } from "../lsp/managed-observation.ts";
import type { RepositoryObservation } from "../tools/repository-observation.ts";
import type {
	ExtensionOperationEvent,
	ExtensionOperationOrigin,
	ExtensionServicesCause,
	ExtensionServicesFailure,
	ExtensionServicesLimits,
	ExtensionServicesService,
	ExtensionServicesSnapshot,
	RequestBoundaryEvent,
} from "./services-types.ts";

export interface ExtensionServicesCollection {
	readonly text: string;
	readonly authorization: {
		isCurrent(): boolean;
		settle(admitted: boolean): void;
	};
}

export interface ExtensionServicesExecution {
	service: ExtensionServicesService;
	input: JsonObject;
	signal: AbortSignal;
	origin: Extract<ExtensionOperationOrigin, { kind: "extension" }>;
}

export type ExtensionServicesExecutionResult =
	| ExtensionServicesFailure
	| { status: "ok"; observation: RepositoryObservation | ManagedLspObservation; implementation: object };

export interface ExtensionServicesBoundary {
	/** Stable identity of the most recent committed user-delivery batch, retained over retries. */
	key: string;
	attemptId: string;
	cause: ExtensionServicesCause;
	allowNewWork: boolean;
	snapshot: Omit<ExtensionServicesSnapshot, "scopeId" | "runtimeId">;
}

export interface ExtensionServicesManagerOptions {
	limits?: Partial<ExtensionServicesLimits>;
	isCurrent(): boolean;
	execute(request: ExtensionServicesExecution): Promise<ExtensionServicesExecutionResult>;
	onBoundary(event: RequestBoundaryEvent): void;
	onOperation(event: ExtensionOperationEvent): void;
}

import { OperationCoordinator, type OperationLease } from "../conversation/coordinator.ts";
import { AgentHarnessAdmissionGate } from "./admission-gate.ts";
import { AgentHarnessError } from "./types.ts";

export type HarnessOperationKind = "turn" | "compaction" | "branch_summary";

export type HarnessOperationLease = OperationLease<HarnessOperationKind>;

/** The shared operation coordinator with the Harness operation kinds and error type. */
export class HarnessOperationCoordinator extends OperationCoordinator<HarnessOperationKind> {
	constructor(admissionGate = new AgentHarnessAdmissionGate()) {
		super({
			admissionGate,
			busyError: (message) => new AgentHarnessError("busy", message),
			leaseIdPrefix: "harness-operation",
		});
	}
}

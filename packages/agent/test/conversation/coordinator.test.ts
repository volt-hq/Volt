import { describe, expect, it } from "vitest";
import { type CoordinatorPhase, OperationCoordinator } from "../../src/conversation/coordinator.ts";
import { AgentHarnessAdmissionGate } from "../../src/harness/admission-gate.ts";

type Kind = "turn" | "compaction" | "navigation" | "host";

function recordingCoordinator(admissionGate = new AgentHarnessAdmissionGate()) {
	const phases: CoordinatorPhase<Kind>[] = [];
	const coordinator = new OperationCoordinator<Kind>({
		admissionGate,
		busyError: (message) => Object.assign(new Error(message), { code: "busy" }),
		onPhaseChange: (phase) => phases.push(phase),
	});
	return { coordinator, phases, admissionGate };
}

describe("OperationCoordinator", () => {
	it("derives busy from exclusive operations and counted activities", async () => {
		const { coordinator, phases } = recordingCoordinator();
		const releaseBash = coordinator.beginActivity("bash");
		const releaseCommand = coordinator.beginActivity("extension_command");
		const lease = coordinator.reserve("turn")!;
		coordinator.start(lease);
		releaseBash();
		releaseBash();
		coordinator.finish(lease);
		let notBusy = false;
		const waiting = coordinator.waitForNotBusy().then(() => {
			notBusy = true;
		});
		await coordinator.waitForIdle();
		await Promise.resolve();
		expect(notBusy).toBe(false);
		releaseCommand();
		await waiting;

		expect(
			phases.map((phase) => [
				phase.operation,
				phase.activities.bash,
				phase.activities.extension_command,
				phase.busy,
			]),
		).toEqual([
			[null, 1, 0, true],
			[null, 1, 1, true],
			["turn", 1, 1, true],
			["turn", 0, 1, true],
			[null, 0, 1, true],
			[null, 0, 0, false],
		]);
		expect(Object.isFrozen(coordinator.phase)).toBe(true);
		await expect(coordinator.waitForNotBusy()).resolves.toBeUndefined();
	});

	it("publishes the successor's kind when it is promoted and a reclassified kind", async () => {
		const { coordinator, phases } = recordingCoordinator();
		const reserved = coordinator.reserve("turn")!;
		expect(coordinator.reclassify(reserved, "compaction")).toBe(true);
		coordinator.start(reserved);
		const successor = coordinator.reserveSuccessor("navigation")!;
		coordinator.finish(reserved);
		await successor.ready;
		coordinator.start(successor.lease);
		coordinator.finish(successor.lease);

		expect(phases.map((phase) => phase.operation)).toEqual(["turn", "compaction", "navigation", null]);
	});

	it("gates activities on admission and closure without counting rejected ones", () => {
		const { coordinator, admissionGate } = recordingCoordinator();
		const release = admissionGate.suspend();
		expect(() => coordinator.beginActivity("background")).toThrow("Operation admission is suspended");
		release();
		coordinator.requestClose();
		expect(() => coordinator.beginActivity("background")).toThrow("Operation admission is closed");
		expect(coordinator.phase).toMatchObject({ busy: false, activities: { background: 0 } });
	});
});

import { describe, expect, it } from "vitest";
import { AdmissionGate } from "../../src/conversation/admission-gate.ts";
import { ConversationError } from "../../src/conversation/api.ts";
import { OperationCoordinator } from "../../src/conversation/coordinator.ts";

type Kind = "turn" | "compaction" | "navigation";

const suspendedError = new ConversationError("busy", "Operation admission is suspended");

function gatedCoordinator(admissionGate?: AdmissionGate): OperationCoordinator<Kind> {
	return new OperationCoordinator<Kind>({
		...(admissionGate === undefined ? {} : { admissionGate }),
		busyError: (message) => new ConversationError("busy", message),
	});
}

describe("AdmissionGate", () => {
	it("starts open and only accepts its current revision", () => {
		const gate = new AdmissionGate();
		expect(gate.isOpen).toBe(true);
		expect(gate.assertOpen()).toBeUndefined();
		expect(gate.isCurrent(gate.revision)).toBe(true);
		expect(gate.isCurrent(gate.revision - 1)).toBe(false);
		expect(gate.isCurrent(gate.revision + 1)).toBe(false);
	});

	it("rejects suspended admission with a busy ConversationError", () => {
		const gate = new AdmissionGate();
		const release = gate.suspend();
		let thrown: unknown;
		try {
			gate.assertOpen();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ConversationError);
		expect(thrown).toMatchObject({ code: "busy", message: "Operation admission is suspended" });
		release();
	});

	it.each(["outer-first", "inner-first"] as const)("keeps nested holds closed with %s release", (order) => {
		const gate = new AdmissionGate();
		const originalRevision = gate.revision;
		const outer = gate.suspend();
		expect(gate.isOpen).toBe(false);
		expect(gate.revision).toBe(originalRevision + 1);
		expect(gate.isCurrent(originalRevision)).toBe(false);
		expect(gate.isCurrent(gate.revision)).toBe(false);
		expect(() => gate.assertOpen()).toThrow(suspendedError);
		const inner = gate.suspend();
		expect(gate.revision).toBe(originalRevision + 2);

		const [first, last] = order === "outer-first" ? [outer, inner] : [inner, outer];
		first();
		first();
		expect(gate.isOpen).toBe(false);
		expect(gate.revision).toBe(originalRevision + 2);
		expect(() => gate.assertOpen()).toThrow(suspendedError);
		last();
		last();
		expect(gate.isOpen).toBe(true);
		expect(gate.assertOpen()).toBeUndefined();
		expect(gate.revision).toBe(originalRevision + 2);
		expect(gate.isCurrent(originalRevision)).toBe(false);
		expect(gate.isCurrent(gate.revision)).toBe(true);
	});

	it("does not let an old idempotent release remove a later hold", () => {
		const gate = new AdmissionGate();
		const originalRevision = gate.revision;
		const first = gate.suspend();
		first();
		const reopenedRevision = gate.revision;
		const second = gate.suspend();
		first();
		first();
		expect(gate.isOpen).toBe(false);
		expect(gate.isCurrent(reopenedRevision)).toBe(false);
		second();
		expect(gate.revision).toBe(originalRevision + 2);
		expect(gate.isCurrent(originalRevision)).toBe(false);
		expect(gate.isCurrent(reopenedRevision)).toBe(false);
		expect(gate.isCurrent(gate.revision)).toBe(true);
	});

	it("keeps independent gates independent", () => {
		const first = new AdmissionGate();
		const second = new AdmissionGate();
		const secondRevision = second.revision;
		const releaseFirst = first.suspend();
		expect(second.isOpen).toBe(true);
		expect(second.isCurrent(secondRevision)).toBe(true);
		const releaseSecond = second.suspend();
		releaseFirst();
		expect(first.isOpen).toBe(true);
		expect(second.isOpen).toBe(false);
		releaseSecond();
		expect(second.isCurrent(secondRevision)).toBe(false);
	});
});

describe("OperationCoordinator admission", () => {
	it("supports default coordinators without sharing exclusive operation ownership", async () => {
		const first = gatedCoordinator();
		const second = gatedCoordinator();
		const firstLease = first.reserve("turn")!;
		const secondLease = second.reserve("compaction")!;
		first.start(firstLease);
		second.start(secondLease);
		expect(first.current).toBe(firstLease);
		expect(second.current).toBe(secondLease);
		first.finish(firstLease);
		second.finish(secondLease);
		await Promise.all([first.waitForIdle(), second.waitForIdle()]);
	});

	it.each(["turn", "compaction", "navigation"] as const)(
		"rejects idle %s admission synchronously and recovers after release",
		async (kind) => {
			const gate = new AdmissionGate();
			const coordinator = gatedCoordinator(gate);
			const release = gate.suspend();
			expect(() => coordinator.reserve(kind)).toThrow(suspendedError);
			expect(coordinator.current).toBeUndefined();
			expect(coordinator.isOpen).toBe(true);
			await coordinator.waitForIdle();
			release();
			const lease = coordinator.reserve(kind)!;
			expect(lease.admissionRevision).toBe(gate.revision);
			coordinator.start(lease);
			coordinator.finish(lease);
			await coordinator.waitForIdle();
		},
	);

	it.each([false, true])("invalidates reserved starts even when reopened=%s", async (reopen) => {
		const gate = new AdmissionGate();
		const coordinator = gatedCoordinator(gate);
		const lease = coordinator.reserve("turn")!;
		const idle = coordinator.waitForIdle();
		const release = gate.suspend();
		if (reopen) release();
		expect(() => coordinator.start(lease)).toThrow();
		expect(coordinator.current).toBeUndefined();
		await idle;
		release();
		const fresh = coordinator.reserve("turn")!;
		coordinator.start(fresh);
		expect(fresh.admissionRevision).toBe(gate.revision);
		coordinator.finish(fresh);
		await coordinator.waitForIdle();
	});

	it.each([false, true])("rejects stale reclassification even when reopened=%s", async (reopen) => {
		const gate = new AdmissionGate();
		const coordinator = gatedCoordinator(gate);
		const lease = coordinator.reserve("turn")!;
		const release = gate.suspend();
		if (reopen) release();
		expect(coordinator.reclassify(lease, "compaction")).toBe(false);
		expect(lease.kind).toBe("turn");
		expect(coordinator.current).toBeUndefined();
		await coordinator.waitForIdle();
		release();
	});

	it("rejects successor admission without aborting or replacing the active operation", async () => {
		const gate = new AdmissionGate();
		const coordinator = gatedCoordinator(gate);
		const lease = coordinator.reserve("turn")!;
		coordinator.start(lease);
		const release = gate.suspend();
		expect(() => coordinator.reserveSuccessor("compaction")).toThrow(suspendedError);
		expect(coordinator.current).toBe(lease);
		expect(lease.abortGate.signal.aborted).toBe(false);
		coordinator.finish(lease);
		await coordinator.waitForIdle();
		release();
	});

	it.each([
		["turn", false],
		["turn", true],
		["compaction", false],
		["compaction", true],
		["navigation", false],
		["navigation", true],
	] as const)("settles stale %s successors without promotion, reopened=%s", async (kind, reopen) => {
		const gate = new AdmissionGate();
		const coordinator = gatedCoordinator(gate);
		const active = coordinator.reserve("compaction")!;
		coordinator.start(active);
		const successor = coordinator.reserveSuccessor(kind)!;
		let ready = false;
		void successor.ready.then(() => {
			ready = true;
		});
		const idle = coordinator.waitForIdle();
		const release = gate.suspend();
		if (reopen) release();
		await Promise.resolve();
		expect(ready).toBe(false);
		expect(active.abortGate.signal.aborted).toBe(false);
		coordinator.finish(active);
		await Promise.all([successor.ready, idle]);
		expect(coordinator.current).toBeUndefined();
		expect(() => coordinator.start(successor.lease)).toThrow();
		expect(successor.cancel()).toBe(false);
		release();
		const fresh = coordinator.reserve(kind)!;
		coordinator.start(fresh);
		coordinator.finish(fresh);
		await coordinator.waitForIdle();
	});

	it.each([false, true])("settles every inherited waiter when a replacement is stale, reopened=%s", async (reopen) => {
		const gate = new AdmissionGate();
		const coordinator = gatedCoordinator(gate);
		const active = coordinator.reserve("compaction")!;
		coordinator.start(active);
		const original = coordinator.reserveSuccessor("turn")!;
		const replaced = coordinator.reserveSuccessorReplacing("turn", "navigation")!;
		const final = coordinator.reserveSuccessorReplacing("navigation", "compaction")!;
		const settled: string[] = [];
		void original.ready.then(() => settled.push("original"));
		void replaced.ready.then(() => settled.push("replaced"));
		void final.ready.then(() => settled.push("final"));
		const release = gate.suspend();
		if (reopen) release();
		await Promise.resolve();
		expect(settled).toEqual([]);
		coordinator.finish(active);
		await Promise.all([original.ready, replaced.ready, final.ready, coordinator.waitForIdle()]);
		expect(settled.sort()).toEqual(["final", "original", "replaced"]);
		expect(coordinator.current).toBeUndefined();
		release();
	});

	it.each([false, true])(
		"keeps original and inherited waiters reachable after rejected replacement, inherited=%s",
		async (inherited) => {
			const gate = new AdmissionGate();
			const coordinator = gatedCoordinator(gate);
			const active = coordinator.reserve("compaction")!;
			coordinator.start(active);
			const original = coordinator.reserveSuccessor("turn")!;
			const pending = inherited ? coordinator.reserveSuccessorReplacing("turn", "navigation")! : original;
			const release = gate.suspend();
			expect(() => coordinator.reserveSuccessorReplacing(pending.lease.kind, "compaction")).toThrow(suspendedError);
			expect(coordinator.current).toBe(active);
			coordinator.finish(active);
			await Promise.all([original.ready, pending.ready, coordinator.waitForIdle()]);
			expect(coordinator.current).toBeUndefined();
			release();
		},
	);

	it("still promotes a fresh successor after reopening and preserves settlement ordering", async () => {
		const gate = new AdmissionGate();
		const coordinator = gatedCoordinator(gate);
		const active = coordinator.reserve("compaction")!;
		coordinator.start(active);
		gate.suspend()();
		const original = coordinator.reserveSuccessor("turn")!;
		const replacement = coordinator.reserveSuccessorReplacing("turn", "navigation")!;
		let originalSettled = false;
		let idle = false;
		void original.ready.then(() => {
			originalSettled = true;
		});
		void coordinator.waitForIdle().then(() => {
			idle = true;
		});
		coordinator.finish(active);
		await replacement.ready;
		expect(coordinator.current).toBe(replacement.lease);
		expect(originalSettled).toBe(false);
		expect(idle).toBe(false);
		coordinator.start(replacement.lease);
		coordinator.finish(replacement.lease);
		await Promise.all([original.ready, coordinator.waitForIdle()]);
		expect(originalSettled).toBe(true);
		expect(idle).toBe(true);
	});

	it("allows abort, successor cancellation, and terminal close while suspended", async () => {
		const gate = new AdmissionGate();
		const coordinator = gatedCoordinator(gate);
		const active = coordinator.reserve("turn")!;
		coordinator.start(active);
		const successor = coordinator.reserveSuccessor("compaction")!;
		const release = gate.suspend();
		expect(coordinator.requestAbort("host_action")).toMatchObject({ accepted: true, source: "host_action" });
		expect(active.abortGate.signal.aborted).toBe(true);
		expect(successor.cancel()).toBe(true);
		expect(successor.cancel()).toBe(false);
		await successor.ready;
		expect(coordinator.requestClose()).toBe(true);
		expect(coordinator.requestClose()).toBe(false);
		coordinator.finish(active);
		await Promise.all([coordinator.waitForIdle(), coordinator.waitForClosed()]);
		expect(gate.isOpen).toBe(false);
		release();
		expect(coordinator.isOpen).toBe(false);
		expect(coordinator.reserve("turn")).toBeUndefined();
	});
});

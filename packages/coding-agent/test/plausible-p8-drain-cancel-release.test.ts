import { describe, expect, it, vi } from "vitest";
import { LeaseBroker, type LeaseBrokerEffects, type LeaseRecord } from "../src/daemon/lease-broker.ts";

/**
 * P8: A drain in progress cannot be cancelled by the requesting TUI via
 * lease_release. releaseFromTui requires state === "tui-owned"; when the lease
 * is "daemon-draining" (owned/targeted by the same connection) it returns
 * not_held and leaves the drain running. If the bug did NOT exist, a TUI that
 * changes its mind and calls lease_release on its own pending drain would
 * cancel that drain (as connection death does via cancelDrain), rather than
 * being force-granted the warm lease when the drain completes.
 *
 * This test asserts the CORRECT behavior. If it fails against the current code,
 * the gap is real (RED).
 */
function key(workspaceName: string, sessionId: string): string {
	return `${workspaceName}/${sessionId}`;
}

function publishDaemonRuntime(broker: LeaseBroker, workspaceName: string, sessionId: string) {
	const begun = broker.beginDaemonAttach(workspaceName, sessionId);
	if (begun.kind !== "proceed") throw new Error(`daemon attach did not proceed: ${begun.kind}`);
	const committed = broker.commitDaemonRuntime(begun.claim, workspaceName, sessionId);
	if (!committed.ok) throw new Error(`daemon runtime commit failed: ${committed.reason}`);
	const finalized = broker.finalizeDaemonRuntimeCommit(committed.token);
	if (finalized.kind === "fenced") throw new Error("daemon runtime publication was fenced");
	return finalized.owner;
}

function createHarness() {
	const streaming = new Set<string>();
	const idleWaiters = new Map<string, Array<() => void>>();
	const disposed: Array<{ key: string; reason: string }> = [];
	const drainEnded: Array<{ key: string; reason: string }> = [];

	const effects: LeaseBrokerEffects = {
		isRuntimeStreaming: (ws, sid) => streaming.has(key(ws, sid)),
		waitForRuntimeIdle: (ws, sid) => {
			if (!streaming.has(key(ws, sid))) {
				return Promise.resolve();
			}
			return new Promise((resolve) => {
				const waiters = idleWaiters.get(key(ws, sid)) ?? [];
				waiters.push(resolve);
				idleWaiters.set(key(ws, sid), waiters);
			});
		},
		disposeRuntime: async (ws, sid, reason) => {
			disposed.push({ key: key(ws, sid), reason });
		},
		closePhoneStreams: () => {},
		closeRelays: (_record: LeaseRecord) => {},
		beginTuiLeaseHandoff: () => {},
		commitTuiLeaseHandoff: () => {},
		cancelTuiLeaseHandoff: () => {},
		releaseTuiLease: () => {},
		prepareTuiLeaseRekey: () => {},
		commitTuiLeaseRekey: () => {},
		rollbackTuiLeaseRekey: () => {},
		onDrainEnded: (record, _viewerFeedId, reason) => {
			drainEnded.push({ key: key(record.workspaceName, record.sessionId), reason });
		},
		audit: () => {},
		generateViewerFeedId: () => "vf-1",
	};

	return {
		broker: new LeaseBroker(effects),
		streaming,
		idleWaiters,
		disposed,
		drainEnded,
		async finishTurn(ws: string, sid: string) {
			streaming.delete(key(ws, sid));
			for (const resolve of idleWaiters.get(key(ws, sid)) ?? []) {
				resolve();
			}
			idleWaiters.delete(key(ws, sid));
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

describe("P8: TUI cancels its own pending drain via lease_release", () => {
	it("cancels the drain and does not force-grant the warm lease", async () => {
		const h = createHarness();
		const { broker } = h;
		const runtimeOwner = publishDaemonRuntime(broker, "ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged(runtimeOwner, "ws", "s1", 1);
		h.streaming.add(key("ws", "s1"));

		// TUI c-1 acquires a streaming lease -> drain begins (pending).
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		const granted = outcome.kind === "pending" ? outcome.granted : Promise.reject(new Error("unreachable"));
		const grantedRejected = vi.fn();
		granted.catch(grantedRejected);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-draining");

		// The user changes their mind and the TUI sends lease_release for the
		// pending drain it owns. Correct behavior: this cancels the drain, just
		// like connection death does.
		const released = broker.releaseFromTui("c-1", "ws", "s1", "quit");
		expect(released).toEqual({ ok: true });

		// The drain must be cancelled, not still pending.
		expect(broker.isDraining("ws", "s1")).toBe(false);
		expect(h.drainEnded).toEqual([{ key: "ws/s1", reason: "cancelled" }]);

		// When the turn later ends, no unwanted warm grant / teardown happens.
		await h.finishTurn("ws", "s1");
		expect(broker.lookup("ws", "s1")?.state).not.toBe("tui-owned");
		expect(h.disposed).toHaveLength(0);
		expect(grantedRejected).toHaveBeenCalled();
	});
});

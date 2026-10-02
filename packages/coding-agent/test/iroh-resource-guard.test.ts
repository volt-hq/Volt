import { describe, expect, it } from "vitest";
import {
	DEFAULT_IROH_REMOTE_RESOURCE_LIMITS,
	IrohRemoteResourceGuard,
	type IrohRemoteResourceLimits,
} from "../src/daemon/iroh-resource-guard.ts";

const TEST_LIMITS: IrohRemoteResourceLimits = {
	maxConnectionTasks: 2,
	maxConnectionsPerNode: 2,
	maxUnauthenticatedConnections: 2,
	maxUnauthenticatedConnectionsPerNode: 1,
	maxActiveStreams: 3,
	maxActiveStreamsPerNode: 2,
	maxConcurrentHandshakes: 2,
	maxConcurrentHandshakesPerNode: 1,
};

function requireLease(result: ReturnType<IrohRemoteResourceGuard["tryAcquireConnectionTask"]>) {
	if (!result.ok) throw new Error("expected resource admission");
	return result.lease;
}

describe("IrohRemoteResourceGuard", () => {
	it("keeps authenticated stream defaults within the beta memory budget", () => {
		expect(DEFAULT_IROH_REMOTE_RESOURCE_LIMITS).toMatchObject({
			maxActiveStreams: 128,
			maxActiveStreamsPerNode: 16,
		});
	});

	it("bounds connection tasks and releases leases idempotently", () => {
		const guard = new IrohRemoteResourceGuard(TEST_LIMITS);
		const first = requireLease(guard.tryAcquireConnectionTask());
		const second = requireLease(guard.tryAcquireConnectionTask());
		expect(guard.tryAcquireConnectionTask()).toEqual({ ok: false, scope: "global", limit: 2 });
		expect(guard.snapshot("node-a").connectionTasks).toBe(2);

		first.release();
		first.release();
		expect(guard.snapshot("node-a").connectionTasks).toBe(1);
		requireLease(guard.tryAcquireConnectionTask()).release();
		second.release();
		expect(guard.snapshot("node-a").connectionTasks).toBe(0);
	});

	it("bounds total authenticated and unauthenticated connections per node for their full lifetime", () => {
		const guard = new IrohRemoteResourceGuard(TEST_LIMITS);
		const first = requireLease(guard.tryAcquireNodeConnection("node-a"));
		const second = requireLease(guard.tryAcquireNodeConnection("node-a"));
		expect(guard.tryAcquireNodeConnection("node-a")).toEqual({ ok: false, scope: "node", limit: 2 });
		expect(guard.snapshot("node-a").nodeConnections).toBe(2);

		const otherNode = requireLease(guard.tryAcquireNodeConnection("node-b"));
		expect(guard.snapshot("node-b").nodeConnections).toBe(1);
		first.release();
		first.release();
		expect(guard.snapshot("node-a").nodeConnections).toBe(1);
		second.release();
		otherNode.release();
		expect(guard.snapshot("node-a").nodeConnections).toBe(0);
		expect(guard.snapshot("node-b").nodeConnections).toBe(0);
	});

	it("enforces global and per-node unauthenticated connection caps", () => {
		const guard = new IrohRemoteResourceGuard(TEST_LIMITS);
		const nodeA = requireLease(guard.tryAcquireUnauthenticatedConnection("node-a"));
		expect(guard.tryAcquireUnauthenticatedConnection("node-a")).toEqual({
			ok: false,
			scope: "node",
			limit: 1,
		});
		const nodeB = requireLease(guard.tryAcquireUnauthenticatedConnection("node-b"));
		expect(guard.tryAcquireUnauthenticatedConnection("node-c")).toEqual({
			ok: false,
			scope: "global",
			limit: 2,
		});

		nodeA.release();
		expect(guard.snapshot("node-a")).toMatchObject({
			unauthenticatedConnections: 1,
			nodeUnauthenticatedConnections: 0,
		});
		nodeB.release();
		expect(guard.snapshot("node-b").unauthenticatedConnections).toBe(0);
	});

	it("bounds active streams and in-flight handshakes independently", () => {
		const guard = new IrohRemoteResourceGuard(TEST_LIMITS);
		const streamA1 = requireLease(guard.tryAcquireActiveStream("node-a"));
		const streamA2 = requireLease(guard.tryAcquireActiveStream("node-a"));
		expect(guard.tryAcquireActiveStream("node-a")).toEqual({ ok: false, scope: "node", limit: 2 });
		const streamB = requireLease(guard.tryAcquireActiveStream("node-b"));
		expect(guard.tryAcquireActiveStream("node-c")).toEqual({ ok: false, scope: "global", limit: 3 });

		const handshakeA = requireLease(guard.tryAcquireHandshake("node-a"));
		expect(guard.tryAcquireHandshake("node-a")).toEqual({ ok: false, scope: "node", limit: 1 });
		const handshakeB = requireLease(guard.tryAcquireHandshake("node-b"));
		expect(guard.tryAcquireHandshake("node-c")).toEqual({ ok: false, scope: "global", limit: 2 });

		handshakeA.release();
		expect(guard.snapshot("node-a")).toMatchObject({
			activeStreams: 3,
			nodeActiveStreams: 2,
			concurrentHandshakes: 1,
			nodeConcurrentHandshakes: 0,
		});
		handshakeB.release();
		streamA1.release();
		streamA2.release();
		streamB.release();
		expect(guard.snapshot("node-a")).toMatchObject({ activeStreams: 0, concurrentHandshakes: 0 });
	});

	it("rejects invalid limit configurations", () => {
		expect(() => new IrohRemoteResourceGuard({ ...TEST_LIMITS, maxConcurrentHandshakes: 0 })).toThrow(
			"maxConcurrentHandshakes must be a positive integer",
		);
	});
});

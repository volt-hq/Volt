import { describe, expect, it, vi } from "vitest";
import { LeaseBroker, type LeaseBrokerEffects, type LeaseRecord } from "../src/daemon/lease-broker.ts";

interface Harness {
	broker: LeaseBroker;
	effects: {
		streaming: Set<string>;
		idleWaiters: Map<string, Array<() => void>>;
		disposed: Array<{ key: string; reason: string }>;
		closedStreams: Array<{ key: string; reason: string }>;
		closedRelays: Array<{ key: string; reason: string }>;
		audits: Array<{ type: string; details: Record<string, unknown> }>;
		drainStarted: string[];
		drainEnded: Array<{ key: string; reason: string }>;
	};
	/** Resolve all pending waitForRuntimeIdle calls for a key. */
	finishTurn(workspaceName: string, sessionId: string): Promise<void>;
	/** Make the next disposeRuntime call reject with the given error. */
	failNextDispose(error: Error): void;
}

function key(workspaceName: string, sessionId: string): string {
	return `${workspaceName}/${sessionId}`;
}

function createHarness(): Harness {
	const streaming = new Set<string>();
	const idleWaiters = new Map<string, Array<() => void>>();
	const disposed: Array<{ key: string; reason: string }> = [];
	const closedStreams: Array<{ key: string; reason: string }> = [];
	const closedRelays: Array<{ key: string; reason: string }> = [];
	const audits: Array<{ type: string; details: Record<string, unknown> }> = [];
	const drainStarted: string[] = [];
	const drainEnded: Array<{ key: string; reason: string }> = [];
	let viewerFeedSequence = 0;
	let pendingDisposeError: Error | undefined;

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
			if (pendingDisposeError) {
				const error = pendingDisposeError;
				pendingDisposeError = undefined;
				throw error;
			}
			disposed.push({ key: key(ws, sid), reason });
		},
		closePhoneStreams: (ws, sid, reason) => {
			closedStreams.push({ key: key(ws, sid), reason });
		},
		closeRelays: (record: LeaseRecord, reason) => {
			closedRelays.push({ key: key(record.workspaceName, record.sessionId), reason });
		},
		onDrainStarted: (_record, viewerFeedId) => {
			drainStarted.push(viewerFeedId);
		},
		onDrainEnded: (record, _viewerFeedId, reason) => {
			drainEnded.push({ key: key(record.workspaceName, record.sessionId), reason });
		},
		audit: (event) => {
			audits.push({ type: event.type, details: event.details });
		},
		generateViewerFeedId: () => `vf-${++viewerFeedSequence}`,
	};

	return {
		broker: new LeaseBroker(effects),
		effects: { streaming, idleWaiters, disposed, closedStreams, closedRelays, audits, drainStarted, drainEnded },
		async finishTurn(ws, sid) {
			streaming.delete(key(ws, sid));
			for (const resolve of idleWaiters.get(key(ws, sid)) ?? []) {
				resolve();
			}
			idleWaiters.delete(key(ws, sid));
			// Let the drain continuation run.
			await new Promise((resolve) => setImmediate(resolve));
			await new Promise((resolve) => setImmediate(resolve));
		},
		failNextDispose(error: Error) {
			pendingDisposeError = error;
		},
	};
}

describe("LeaseBroker", () => {
	it("grants unowned acquires immediately with handoff none", async () => {
		const { broker } = createHarness();
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome).toEqual({ kind: "granted", handoff: "none" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
	});

	it("denies force acquires with force_unsupported", async () => {
		const { broker, effects } = createHarness();
		const outcome = await broker.acquireForTui({
			connectionId: "c-1",
			workspaceName: "ws",
			sessionId: "s1",
			force: true,
		});
		expect(outcome).toEqual({ kind: "denied", reason: "force_unsupported" });
		expect(effects.audits.at(-1)?.type).toBe("lease_denied");
	});

	it("is idempotent for the owning connection and denies other TUIs", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		const again = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(again.kind).toBe("granted");
		const other = await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "s1" });
		expect(other).toEqual({ kind: "denied", reason: "held_by_tui" });
	});

	it("lets a TUI preempt a provisional daemon attach before commit", async () => {
		const { broker } = createHarness();
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome).toEqual({ kind: "granted", handoff: "none" });
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1");
		expect(committed).toEqual({ ok: false, reason: "tui_owned", tuiConnectionId: "c-1" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
	});

	it("pins an unowned lease while a provisional daemon attach is in flight", async () => {
		const { broker } = createHarness();
		const begun = broker.beginDaemonAttach("ws", "s1");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") {
			return;
		}
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		broker.releaseFromTui("c-1", "ws", "s1");
		expect(broker.lookup("ws", "s1")?.state).toBe("unowned");
		const committed = broker.commitDaemonRuntime(begun.claim, "ws", "s1");
		expect(committed.ok).toBe(true);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
	});

	it("tracks daemon runtime attach/stream-count/dispose transitions", () => {
		const { broker, effects } = createHarness();
		broker.onDaemonRuntimeAttached("ws", "s1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 2);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 0);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-detached");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		// Retention TTL fired in the registry: disposal reason maps to retention_expired.
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 0);
		broker.onDaemonRuntimeDisposed("ws", "s1", "detached_runtime_ttl_expired");
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		const release = effects.audits.find((event) => event.type === "lease_released");
		expect(release?.details.reason).toBe("retention_expired");
	});

	it("grants warm immediately for an idle daemon runtime and disposes it", async () => {
		const { broker, effects } = createHarness();
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1);
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome).toEqual({ kind: "granted", handoff: "warm" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
		expect(effects.disposed).toHaveLength(1);
		expect(effects.closedStreams).toEqual([{ key: "ws/s1", reason: "lease_transferred" }]);
	});

	it("grants warm for a detached daemon runtime", async () => {
		const { broker, effects } = createHarness();
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 0);
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome).toEqual({ kind: "granted", handoff: "warm" });
		expect(effects.disposed).toHaveLength(1);
	});

	it("drains a detached mid-turn daemon runtime instead of abandoning the turn", async () => {
		// Regression: a TUI acquire while every phone was detached used to
		// dispose the runtime mid-turn, discarding in-flight (e.g. subagent)
		// results and leaving a dangling tool call in the transcript.
		const harness = createHarness();
		const { broker, effects } = harness;
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 0);
		effects.streaming.add("ws/s1");

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		if (outcome.kind !== "pending") {
			return;
		}
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-draining");
		expect(effects.disposed).toHaveLength(0);

		await harness.finishTurn("ws", "s1");
		await expect(outcome.granted).resolves.toEqual({ handoff: "warm" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
		expect(effects.disposed).toHaveLength(1);
	});

	it("returns a cancelled detached drain to daemon-detached with the turn still running", async () => {
		const harness = createHarness();
		const { broker, effects } = harness;
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 0);
		effects.streaming.add("ws/s1");

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		const released = broker.releaseFromTui("c-1", "ws", "s1");
		expect(released).toEqual({ ok: true });
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-detached");
		// The runtime was never disposed: the turn keeps running on the daemon.
		expect(effects.disposed).toHaveLength(0);
	});

	it("drains a mid-turn daemon runtime before granting", async () => {
		const harness = createHarness();
		const { broker, effects } = harness;
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1);
		effects.streaming.add("ws/s1");

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		if (outcome.kind !== "pending") {
			return;
		}
		expect(outcome.viewerFeedId).toBe("vf-1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-draining");
		expect(broker.isDraining("ws", "s1")).toBe(true);
		expect(effects.drainStarted).toEqual(["vf-1"]);
		expect(effects.disposed).toHaveLength(0);

		// Same connection re-acquire is idempotent (same pending drain).
		const again = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(again.kind).toBe("pending");
		if (again.kind === "pending") {
			expect(again.viewerFeedId).toBe("vf-1");
		}
		// A different TUI is denied while the drain is pending.
		const other = await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "s1" });
		expect(other).toEqual({ kind: "denied", reason: "draining_elsewhere" });

		await harness.finishTurn("ws", "s1");
		await expect(outcome.granted).resolves.toEqual({ handoff: "warm" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
		expect(effects.disposed).toHaveLength(1);
		expect(effects.closedStreams).toEqual([{ key: "ws/s1", reason: "lease_transferred" }]);
		expect(effects.drainEnded).toEqual([{ key: "ws/s1", reason: "granted" }]);
	});

	it("stays draining when the last phone stream detaches mid-drain", async () => {
		const harness = createHarness();
		const { broker } = harness;
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1);
		harness.effects.streaming.add("ws/s1");
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 0);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-draining");
		await harness.finishTurn("ws", "s1");
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
	});

	it("cancels the drain when the requesting connection dies", async () => {
		const harness = createHarness();
		const { broker, effects } = harness;
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1);
		effects.streaming.add("ws/s1");
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		const granted = outcome.kind === "pending" ? outcome.granted : Promise.reject(new Error("unreachable"));
		const grantedRejected = vi.fn();
		granted.catch(grantedRejected);

		broker.releaseAllForConnection("c-1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		expect(effects.drainEnded).toEqual([{ key: "ws/s1", reason: "cancelled" }]);

		// The turn ending later must NOT grant anything.
		await harness.finishTurn("ws", "s1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
		expect(effects.disposed).toHaveLength(0);
		expect(grantedRejected).toHaveBeenCalled();
	});

	it("reverts to daemon-detached when a cancelled drain had zero streams", async () => {
		const harness = createHarness();
		const { broker } = harness;
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1);
		harness.effects.streaming.add("ws/s1");
		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 0);
		broker.releaseAllForConnection("c-1");
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-detached");
	});

	it("releases tui leases back to unowned and closes relays", async () => {
		const { broker, effects } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		broker.registerRelay("ws", "s1", "rl-1");
		const released = broker.releaseFromTui("c-1", "ws", "s1");
		expect(released).toEqual({ ok: true });
		expect(effects.closedRelays).toEqual([{ key: "ws/s1", reason: "lease_transferred" }]);
		expect(broker.lookup("ws", "s1")).toBeUndefined();
	});

	it("rejects lease_release for keys the connection does not hold", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(broker.releaseFromTui("c-2", "ws", "s1")).toEqual({ ok: false, code: "not_held" });
		expect(broker.releaseFromTui("c-1", "ws", "other")).toEqual({ ok: false, code: "not_held" });
		expect(broker.lookup("ws", "s1")?.state).toBe("tui-owned");
	});

	it("implicitly releases all leases when a connection dies", async () => {
		const { broker, effects } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s2" });
		broker.releaseAllForConnection("c-1");
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		expect(broker.lookup("ws", "s2")).toBeUndefined();
		const reasons = effects.audits
			.filter((event) => event.type === "lease_released")
			.map((event) => event.details.reason);
		expect(reasons).toEqual(["connection_lost", "connection_lost"]);
	});

	it("rekeys tui-owned leases and closes open relays with session_rekeyed_reconnect", async () => {
		const { broker, effects } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "old" });
		broker.registerRelay("ws", "old", "rl-1");
		broker.rekey("ws", "old", "new");
		expect(broker.lookup("ws", "old")).toBeUndefined();
		expect(broker.lookup("ws", "new")?.state).toBe("tui-owned");
		expect(effects.closedRelays).toEqual([{ key: "ws/new", reason: "session_rekeyed_reconnect" }]);
	});

	it("rekeys daemon leases keeping state", () => {
		const { broker } = createHarness();
		broker.onDaemonRuntimeAttached("ws", "old");
		broker.onDaemonRuntimeStreamCountChanged("ws", "old", 1);
		broker.rekey("ws", "old", "new");
		expect(broker.lookup("ws", "new")?.state).toBe("daemon-active");
		expect(broker.lookup("ws", "new")?.streamCount).toBe(1);
	});

	it("routes a phone attach after TUI release through unowned (lazy resume)", async () => {
		const { broker } = createHarness();
		await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		broker.releaseFromTui("c-1", "ws", "s1");
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		// Next conversation-stream arrival finds unowned and lazily resumes.
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1);
		expect(broker.lookup("ws", "s1")?.state).toBe("daemon-active");
	});

	it("returns the lease to unowned when the connection dies during drain disposal", async () => {
		// Regression: cancellation used to no-op once runDrain cleared record.drain
		// before its disposal awaits, leaving the lease permanently tui-owned by a
		// dead connection.
		const streaming = new Set<string>(["s1"]);
		let releaseIdle: () => void = () => {};
		let releaseDispose: () => void = () => {};
		let disposeEntered: () => void = () => {};
		const disposeEnteredPromise = new Promise<void>((resolve) => {
			disposeEntered = resolve;
		});
		const drainEnded: string[] = [];
		const audits: string[] = [];
		const broker = new LeaseBroker({
			isRuntimeStreaming: () => streaming.has("s1"),
			waitForRuntimeIdle: () =>
				new Promise((resolve) => {
					releaseIdle = resolve;
				}),
			disposeRuntime: async () => {
				disposeEntered();
				await new Promise<void>((resolve) => {
					releaseDispose = resolve;
				});
			},
			closePhoneStreams: () => {},
			closeRelays: () => {},
			onDrainEnded: (_record, _viewerFeedId, reason) => {
				drainEnded.push(reason);
			},
			audit: (event) => {
				audits.push(event.type);
			},
		});
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1);

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		const granted = outcome.kind === "pending" ? outcome.granted : Promise.reject(new Error("unreachable"));
		const grantedRejected = vi.fn();
		granted.catch(grantedRejected);

		// The turn ends; runDrain passes its cancelled-check and enters disposal.
		streaming.delete("s1");
		releaseIdle();
		await disposeEnteredPromise;

		// The requesting TUI's control connection dies mid-disposal.
		broker.releaseAllForConnection("c-1");
		expect(drainEnded).toEqual(["cancelled"]);

		// Disposal completes: the lease must NOT be granted to the dead owner.
		releaseDispose();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(grantedRejected).toHaveBeenCalled();
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		expect(audits.at(-1)).toBe("lease_released");

		// The conversation is acquirable again.
		const again = await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "s1" });
		expect(again).toEqual({ kind: "granted", handoff: "none" });
	});

	it("drops the lease when a cancelled drain then fails disposal", async () => {
		// Regression: the cancelled + disposal-error branch of runDrain set the state
		// to "unowned" but did not zero record.streamCount, so dropIfUnowned (which
		// requires streamCount === 0) left an undroppable ghost record that handed a
		// phantom stream count to the next acquire.
		const streaming = new Set<string>(["s1"]);
		let releaseIdle: () => void = () => {};
		let rejectDispose: (error: Error) => void = () => {};
		let disposeEntered: () => void = () => {};
		const disposeEnteredPromise = new Promise<void>((resolve) => {
			disposeEntered = resolve;
		});
		const drainEnded: string[] = [];
		const broker = new LeaseBroker({
			isRuntimeStreaming: () => streaming.has("s1"),
			waitForRuntimeIdle: () =>
				new Promise((resolve) => {
					releaseIdle = resolve;
				}),
			disposeRuntime: () =>
				new Promise<void>((_resolve, reject) => {
					disposeEntered();
					rejectDispose = reject;
				}),
			closePhoneStreams: () => {},
			closeRelays: () => {},
			onDrainEnded: (_record, _viewerFeedId, reason) => {
				drainEnded.push(reason);
			},
			audit: () => {},
		});
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1);

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		const granted = outcome.kind === "pending" ? outcome.granted : Promise.reject(new Error("unreachable"));
		const grantedRejected = vi.fn();
		granted.catch(grantedRejected);

		// The turn ends; runDrain passes its cancelled-check and enters disposal.
		streaming.delete("s1");
		releaseIdle();
		await disposeEnteredPromise;

		// The requesting TUI dies mid-disposal, then disposal itself fails.
		broker.releaseAllForConnection("c-1");
		rejectDispose(new Error("state-manager write failed"));
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(grantedRejected).toHaveBeenCalled();
		expect(drainEnded).toEqual(["cancelled"]);
		// The record must be dropped, not stranded as an unowned ghost with a stale
		// stream count.
		expect(broker.lookup("ws", "s1")).toBeUndefined();

		// A fresh acquire starts from a clean record (no phantom stream count).
		const again = await broker.acquireForTui({ connectionId: "c-2", workspaceName: "ws", sessionId: "s1" });
		expect(again).toEqual({ kind: "granted", handoff: "none" });
		expect(broker.lookup("ws", "s1")?.streamCount).toBe(0);
	});

	it("drops the lease when the connection dies while an idle runtime is disposed during acquire", async () => {
		let releaseDispose: () => void = () => {};
		let disposeEntered: () => void = () => {};
		const disposeEnteredPromise = new Promise<void>((resolve) => {
			disposeEntered = resolve;
		});
		const audits: string[] = [];
		const broker = new LeaseBroker({
			isRuntimeStreaming: () => false,
			waitForRuntimeIdle: async () => {},
			disposeRuntime: async () => {
				disposeEntered();
				await new Promise<void>((resolve) => {
					releaseDispose = resolve;
				});
			},
			closePhoneStreams: () => {},
			closeRelays: () => {},
			audit: (event) => {
				audits.push(event.type);
			},
		});
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 0); // daemon-detached

		const acquire = broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		await disposeEnteredPromise;
		broker.releaseAllForConnection("c-1");
		releaseDispose();

		const outcome = await acquire;
		expect(outcome).toEqual({ kind: "granted", handoff: "warm" });
		expect(broker.lookup("ws", "s1")).toBeUndefined();
		// No lease_acquired must be recorded for the dead connection after the
		// implicit release.
		expect(audits.at(-1)).toBe("lease_released");
	});

	it("does not wedge the lease when drain disposal fails", async () => {
		const harness = createHarness();
		const { broker, effects } = harness;
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 1); // daemon-active
		effects.streaming.add(key("ws", "s1"));

		const outcome = await broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" });
		expect(outcome.kind).toBe("pending");
		if (outcome.kind !== "pending") {
			return;
		}
		let grantSettled: "resolved" | "rejected" | undefined;
		void outcome.granted.then(
			() => {
				grantSettled = "resolved";
			},
			() => {
				grantSettled = "rejected";
			},
		);

		harness.failNextDispose(new Error("state-manager write failed"));
		await harness.finishTurn("ws", "s1");

		// The grant promise must settle (rejected) rather than hang forever, and the
		// lease must not be stuck in daemon-draining.
		expect(grantSettled).toBe("rejected");
		const record = broker.lookup("ws", "s1");
		expect(record?.state).not.toBe("daemon-draining");
		expect(record?.drain).toBeUndefined();
		expect(effects.drainEnded.at(-1)?.reason).toBe("error");
	});

	it("reverts to daemon-owned when an idle-grant disposal fails", async () => {
		const harness = createHarness();
		const { broker } = harness;
		broker.onDaemonRuntimeAttached("ws", "s1");
		broker.onDaemonRuntimeStreamCountChanged("ws", "s1", 0); // daemon-detached, idle

		harness.failNextDispose(new Error("state-manager write failed"));
		await expect(broker.acquireForTui({ connectionId: "c-1", workspaceName: "ws", sessionId: "s1" })).rejects.toThrow(
			"state-manager write failed",
		);

		// The premature tui-owned flip must not survive the disposal failure.
		const record = broker.lookup("ws", "s1");
		expect(record?.state).not.toBe("tui-owned");
		expect(record?.tuiConnectionId).toBeUndefined();
	});
});

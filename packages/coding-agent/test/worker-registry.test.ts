import { describe, expect, it, vi } from "vitest";
import { type ControlEvent, type ControlResponse, createHelloProof } from "../src/daemon/control-protocol.ts";
import type { LaunchedWorker, WorkerExit, WorkerLaunchRequest } from "../src/daemon/worker-launcher.ts";
import {
	type LiveWorker,
	WORKER_FORCED_STOP_TIMEOUT_MS,
	WorkerOpenError,
	WorkerRegistry,
	type WorkerRegistryAuditEvent,
	type WorkerSpawnInput,
} from "../src/daemon/worker-registry.ts";

const SESSION_DIR = "/sessions";

function ref(sessionId: string) {
	return { sessionDirectory: SESSION_DIR, storeId: "store", sessionId, sessionGeneration: "gen" };
}

/** A worker the test drives: its hello, requests, and exit. */
interface FakeWorker {
	readonly request: WorkerLaunchRequest;
	readonly connectionId: string;
	exit(exit?: WorkerExit): void;
}

function setup(options: { ttlMs?: number } = {}) {
	const generations = new Map<string, number>([["ws", 1]]);
	const events = new Map<string, ControlEvent[]>();
	const audits: WorkerRegistryAuditEvent[] = [];
	const launched: FakeWorker[] = [];
	/** The workers the registry killed, by id. */
	const killed: string[] = [];
	let connections = 0;
	const registry = new WorkerRegistry({
		launcher: {
			launch(request): LaunchedWorker {
				const exited = Promise.withResolvers<WorkerExit>();
				launched.push({
					request,
					connectionId: `c-${++connections}`,
					exit: (exit = { reason: "stopped" }) => exited.resolve(exit),
				});
				return { pid: 4242, exited: exited.promise, kill: () => killed.push(request.workerId) };
			},
		},
		agentDir: "/agent",
		socketPath: () => "/agent/daemon/voltd.sock",
		sendTo: (connectionId, event) => {
			events.set(connectionId, [...(events.get(connectionId) ?? []), event]);
			return true;
		},
		currentGeneration: (workspaceName) => generations.get(workspaceName),
		detachedRuntimeTtlMs: () => options.ttlMs ?? 60_000,
		// Sessions s1-s9 are the workspace's; "ws2" is registered at the same path, sharing its store.
		sessionInWorkspace: async (workspaceName, sessionId) =>
			(workspaceName === "ws" || workspaceName === "ws2") && /^s\d$/.test(sessionId),
		audit: (event) => audits.push(event),
	});

	const spawnInput = (
		sessionId: string,
		generation = generations.get("ws") ?? 0,
		workspaceName = "ws",
	): WorkerSpawnInput => ({
		origin: "phone",
		workspace: { name: workspaceName, path: "/ws", generation },
		session: ref(sessionId),
		cwd: "/ws",
		root: "/ws",
		projectCwd: "/ws",
		toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
		projectTrusted: false,
	});

	const open = (sessionId: string, attach?: "remote" | "local", workspaceName = "ws") => {
		const generation = generations.get(workspaceName) ?? 0;
		return registry.open(
			{ workspaceName, workspaceGeneration: generation, sessionId },
			{
				origin: "phone",
				prepare: async () => spawnInput(sessionId, generation, workspaceName),
				attach: (worker: LiveWorker) => ({
					worker,
					release: attach === undefined ? () => {} : worker.attach(attach),
				}),
			},
		);
	};

	/** The worker launched `index`-th says hello. */
	const hello = (worker: FakeWorker, token = worker.request.workerToken): boolean =>
		registry.admitWorker(
			{
				type: "hello",
				role: "worker",
				protocolVersion: 4,
				workerId: worker.request.workerId,
				workerProof: createHelloProof("worker", token),
				pid: 4242,
				version: "test",
			},
			worker.connectionId,
		) !== undefined;

	let requestId = 0;
	const send = (worker: FakeWorker, request: Record<string, unknown>): Promise<ControlResponse> =>
		registry.handleWorkerRequest(worker.connectionId, { ...request, id: `${++requestId}` } as Parameters<
			WorkerRegistry["handleWorkerRequest"]
		>[1]);

	/** Launch, hello, and ready: the spawn a pending open waits for. */
	const start = async (index = launched.length - 1): Promise<FakeWorker> => {
		await waitUntil(() => launched.length > index);
		const worker = launched[index]!;
		expect(hello(worker)).toBe(true);
		const sessionId = (await spawnOf(worker)).session.sessionId;
		expect(await send(worker, { type: "worker_ready", sessionIds: [sessionId] })).toMatchObject({ type: "ok" });
		return worker;
	};

	const spawnOf = async (worker: FakeWorker) => {
		await Promise.resolve();
		const spawn = (events.get(worker.connectionId) ?? []).find((event) => event.type === "worker_spawn");
		if (spawn?.type !== "worker_spawn") throw new Error("no worker_spawn sent");
		return spawn.spec;
	};

	const stops = (worker: FakeWorker) =>
		(events.get(worker.connectionId) ?? []).filter(
			(event): event is Extract<ControlEvent, { type: "worker_stop" }> => event.type === "worker_stop",
		);

	return { registry, generations, events, audits, launched, killed, open, hello, send, start, spawnOf, stops };
}

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

describe("worker registry", () => {
	it("coalesces concurrent opens into one spawn and attaches both to the live worker", async () => {
		const { registry, open, launched, start, audits } = setup();
		const first = open("s1", "remote");
		const second = open("s1", "local");
		await waitUntil(() => launched.length === 1);
		expect(registry.list()).toMatchObject([{ state: "starting", sessionIds: ["s1"] }]);
		await start(0);
		const [a, b] = await Promise.all([first, second]);
		expect(a.worker.workerId).toBe(b.worker.workerId);
		expect(launched).toHaveLength(1);
		expect(registry.list()).toEqual([
			{
				workerId: a.worker.workerId,
				pid: 4242,
				state: "live",
				origin: "phone",
				workspaceName: "ws",
				sessionIds: ["s1"],
				clients: { local: 1, remote: 1 },
			},
		]);
		expect(audits.map((event) => event.type)).toEqual(["worker_spawned", "worker_ready"]);
	});

	it("admits a worker once, with the token of its spawn, and sends its conversation after the ack", async () => {
		const { open, launched, hello, spawnOf, events } = setup();
		void open("s1").catch(() => undefined);
		await waitUntil(() => launched.length === 1);
		const worker = launched[0]!;
		expect(hello(worker, Buffer.from("wrong").toString("base64url"))).toBe(false);
		expect(hello(worker)).toBe(true);
		// The spawn follows in a later turn, after the ack.
		expect(events.get(worker.connectionId)).toBeUndefined();
		expect((await spawnOf(worker)).workerId).toBe(worker.request.workerId);
		expect(hello(worker)).toBe(false);
	});

	it("refuses a readiness report for conversations the worker was not spawned for", async () => {
		const { open, launched, hello, send } = setup();
		void open("s1").catch(() => undefined);
		await waitUntil(() => launched.length === 1);
		const worker = launched[0]!;
		expect(await send(worker, { type: "worker_ready", sessionIds: ["s1"] })).toMatchObject({
			code: "not_registered",
		});
		hello(worker);
		expect(await send(worker, { type: "worker_ready", sessionIds: ["s2"] })).toMatchObject({
			code: "invalid_sessions",
		});
		expect(await send(worker, { type: "worker_ready", sessionIds: ["s1", "s2"] })).toMatchObject({
			code: "invalid_sessions",
		});
	});

	it("grants claims only for unhosted sessions, under a hosted parent, in the current generation", async () => {
		const { registry, open, start, send, generations, launched } = setup();
		const opened = open("s1", "remote");
		const a = await start(0);
		await opened;
		const other = open("s9");
		const b = await start(1);
		await other;
		expect(
			await send(a, { type: "worker_hosts", sessionId: "s2", kind: "child", parentSessionId: "s1" }),
		).toMatchObject({
			type: "ok",
		});
		expect(
			await send(b, { type: "worker_hosts", sessionId: "s2", kind: "moved", parentSessionId: "s9" }),
		).toMatchObject({ code: "claimed" });
		expect(
			await send(b, { type: "worker_hosts", sessionId: "s1", kind: "sibling", parentSessionId: "s9" }),
		).toMatchObject({ code: "claimed" });
		expect(
			await send(b, { type: "worker_hosts", sessionId: "s3", kind: "child", parentSessionId: "s1" }),
		).toMatchObject({
			code: "not_hosted",
		});
		// Only the worker's own workspace's stored sessions.
		expect(
			await send(a, { type: "worker_hosts", sessionId: "other-workspace", kind: "moved", parentSessionId: "s1" }),
		).toMatchObject({ code: "not_found" });
		expect(await send(a, { type: "worker_released", sessionId: "s1" })).toMatchObject({ code: "primary" });
		expect(await send(a, { type: "worker_released", sessionId: "s2" })).toMatchObject({ type: "ok" });
		expect(
			await send(b, { type: "worker_hosts", sessionId: "s2", kind: "moved", parentSessionId: "s9" }),
		).toMatchObject({ type: "ok" });
		expect(registry.hosts("ws", "s2")).toBe(true);
		generations.set("ws", 2);
		expect(
			await send(b, { type: "worker_hosts", sessionId: "s4", kind: "moved", parentSessionId: "s9" }),
		).toMatchObject({ code: "fenced" });
		expect(launched).toHaveLength(2);
	});

	it("retires a detached idle worker for a sibling claim of a conversation it hosts; the claim waits for its exit", async () => {
		const { registry, open, start, send, stops } = setup();
		const opened = open("s1", "remote");
		const source = await start(0);
		const { release } = await opened;
		const handoff = open("s9");
		const claimant = await start(1);
		await handoff;
		const claimSource = () =>
			send(claimant, { type: "worker_hosts", sessionId: "s1", kind: "sibling", parentSessionId: "s9" });

		// A client is attached: the source stays where it is.
		expect(await claimSource()).toMatchObject({ code: "claimed" });
		expect(stops(source)).toEqual([]);
		// Active: the worker would refuse the stop, so it is not asked.
		release();
		await send(source, { type: "worker_activity", active: true });
		expect(await claimSource()).toMatchObject({ code: "claimed" });
		expect(stops(source)).toEqual([]);

		// Detached and idle: retired as its TTL would, and the claim is retried until it exited.
		await send(source, { type: "worker_activity", active: false });
		expect(await claimSource()).toMatchObject({ code: "retiring" });
		expect(stops(source)).toMatchObject([{ reason: "retention", force: false }]);
		expect(await claimSource()).toMatchObject({ code: "retiring" });
		expect(stops(source)).toHaveLength(1);
		// Only sibling claims retire the host.
		expect(
			await send(claimant, { type: "worker_hosts", sessionId: "s1", kind: "moved", parentSessionId: "s9" }),
		).toMatchObject({ code: "claimed" });
		await send(source, { type: "worker_stop_result", stopId: stops(source)[0]!.stopId, outcome: "stopped" });
		source.exit({ reason: "stopped" });
		await waitUntil(() => registry.size === 1);
		expect(await claimSource()).toMatchObject({ type: "ok" });
		expect(registry.hosts("ws", "s1")).toBe(true);
	});

	it("leaves a detached idle worker of another workspace alone for a sibling claim", async () => {
		const { open, start, send, stops, generations } = setup();
		generations.set("ws2", 1);
		const opened = open("s1", undefined, "ws2");
		const owner = await start(0);
		await opened;
		const handoff = open("s9");
		const claimant = await start(1);
		await handoff;
		expect(
			await send(claimant, { type: "worker_hosts", sessionId: "s1", kind: "sibling", parentSessionId: "s9" }),
		).toMatchObject({ code: "claimed" });
		expect(stops(owner)).toEqual([]);
	});

	it("retires a detached idle worker after its TTL, unless it refuses the stop because it turned active", async () => {
		const { registry, open, start, send, stops, audits } = setup({ ttlMs: 5 });
		const opened = open("s1", "remote");
		const worker = await start(0);
		const { release } = await opened;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stops(worker)).toEqual([]);
		await send(worker, { type: "worker_activity", active: true });
		release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(stops(worker)).toEqual([]);
		await send(worker, { type: "worker_activity", active: false });
		await waitUntil(() => stops(worker).length === 1);
		expect(stops(worker)[0]).toMatchObject({ reason: "retention", force: false });
		expect(registry.list()[0]?.state).toBe("retiring");
		// A job's wake made it active before it answered.
		await send(worker, { type: "worker_stop_result", stopId: stops(worker)[0]!.stopId, outcome: "refused_active" });
		expect(registry.list()[0]?.state).toBe("live");
		await send(worker, { type: "worker_activity", active: false });
		await waitUntil(() => stops(worker).length === 2);
		await send(worker, { type: "worker_stop_result", stopId: stops(worker)[1]!.stopId, outcome: "stopped" });
		worker.exit({ reason: "stopped" });
		await waitUntil(() => registry.size === 0);
		expect(audits.map((event) => event.type)).toEqual([
			"worker_spawned",
			"worker_ready",
			"worker_stop",
			"worker_stop",
			"worker_stop",
			"worker_exited",
		]);
	});

	it("waits for a retiring worker's exit before spawning its replacement", async () => {
		const { registry, open, start, send, stops, launched } = setup({ ttlMs: 1 });
		const opened = open("s1");
		const first = await start(0);
		await opened;
		await waitUntil(() => stops(first).length === 1);
		await send(first, { type: "worker_stop_result", stopId: stops(first)[0]!.stopId, outcome: "stopped" });
		const reopened = open("s1", "remote");
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The previous worker still holds the log: nothing spawns yet.
		expect(launched).toHaveLength(1);
		first.exit();
		const second = await start(1);
		const { worker } = await reopened;
		expect(worker.workerId).toBe(second.request.workerId);
		expect(registry.list()).toHaveLength(1);
	});

	it("fails the opens waiting for a spawn whose worker could not open its conversation", async () => {
		const { registry, open, launched, hello, send } = setup();
		const first = open("s1");
		const second = open("s1");
		await waitUntil(() => launched.length === 1);
		const worker = launched[0]!;
		hello(worker);
		await send(worker, { type: "worker_open_failed", outcome: "conversation_locked", message: "locked elsewhere" });
		worker.exit({ reason: "failed", error: "locked elsewhere" });
		for (const pending of [first, second]) {
			const error = await pending.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(WorkerOpenError);
			expect((error as WorkerOpenError).outcome).toBe("conversation_locked");
		}
		expect(registry.size).toBe(0);
	});

	it("fences a workspace: its stale workers retire without refusal, and admission waits for their exit", async () => {
		const { registry, open, start, send, stops, generations, launched } = setup();
		const retired: string[] = [];
		registry.onWorkerRetiring((workerId) => retired.push(workerId));
		const opened = open("s1", "remote");
		const worker = await start(0);
		await opened;
		generations.set("ws", 2);
		const fence = registry.fenceWorkspace("ws");
		expect(retired).toEqual([worker.request.workerId]);
		expect(stops(worker)).toMatchObject([{ reason: "authority", force: true }]);
		// A forced stop cannot be refused.
		await send(worker, { type: "worker_stop_result", stopId: stops(worker)[0]!.stopId, outcome: "refused_active" });
		expect(registry.list()[0]?.state).toBe("retiring");
		const reopened = open("s1");
		let fenceSettled = false;
		void fence.then(() => {
			fenceSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fenceSettled).toBe(false);
		expect(launched).toHaveLength(1);
		worker.exit();
		await fence;
		await start(1);
		const { worker: replacement } = await reopened;
		expect(replacement.workspaceGeneration).toBe(2);
		// An open of the fenced generation is refused.
		await expect(
			registry.open(
				{ workspaceName: "ws", workspaceGeneration: 1, sessionId: "s5" },
				{
					origin: "phone",
					prepare: () => Promise.reject(new Error("not reached")),
					attach: () => undefined,
				},
			),
		).rejects.toMatchObject({ outcome: "workspace_authorization_removed" });
	});

	it("kills a fenced worker that has not exited by the forced-stop timeout, and the fence then settles", async () => {
		const { registry, open, start, generations, killed } = setup();
		const opened = open("s1", "remote");
		const worker = await start(0);
		await opened;
		generations.set("ws", 2);
		vi.useFakeTimers();
		try {
			const fence = registry.fenceWorkspace("ws");
			vi.advanceTimersByTime(WORKER_FORCED_STOP_TIMEOUT_MS - 1);
			expect(killed).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(killed).toEqual([worker.request.workerId]);
			// The killed process' exit is what settles the fence.
			worker.exit({ reason: "crashed", error: "signal SIGKILL" });
			vi.useRealTimers();
			await fence;
			expect(registry.size).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits for the exit of a worker that lost its control connection", async () => {
		const { registry, open, start, launched } = setup();
		const opened = open("s1");
		const worker = await start(0);
		await opened;
		registry.onConnectionClosed(worker.connectionId);
		expect(registry.list()[0]?.state).toBe("retiring");
		const reopened = open("s1");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(launched).toHaveLength(1);
		worker.exit({ reason: "daemon_lost" });
		await start(1);
		await reopened;
	});

	it("stops every worker on shutdown and refuses later opens", async () => {
		const { registry, open, start, stops } = setup();
		const opened = open("s1");
		const worker = await start(0);
		await opened;
		const stopped = registry.stopAll();
		expect(stops(worker)).toMatchObject([{ reason: "shutdown", force: true }]);
		await expect(open("s2")).rejects.toThrow("shutting down");
		worker.exit();
		await stopped;
		expect(registry.size).toBe(0);
	});

	it("serves an open that waited on a retiring worker once the worker refuses the stop", async () => {
		const { registry, open, start, send, stops, launched } = setup({ ttlMs: 1 });
		const opened = open("s1");
		const worker = await start(0);
		await opened;
		await waitUntil(() => stops(worker).length === 1);
		const reopened = open("s1", "remote");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await send(worker, { type: "worker_stop_result", stopId: stops(worker)[0]!.stopId, outcome: "refused_active" });
		const { worker: live } = await reopened;
		expect(live.workerId).toBe(worker.request.workerId);
		expect(launched).toHaveLength(1);
		expect(registry.list()[0]?.state).toBe("live");
	});

	it("attaches no client to a worker that retires after its lookup", async () => {
		const { registry, open, start, generations } = setup();
		const opened = open("s1");
		await start(0);
		const { worker } = await opened;
		generations.set("ws", 2);
		void registry.fenceWorkspace("ws");
		expect(() => worker.attach("remote")).toThrow(WorkerOpenError);
	});
});

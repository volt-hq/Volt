import type { HostPromptRequest, HostResponse } from "@hansjm10/volt-protocol";
import { describe, expect, it, vi } from "vitest";
import { type ControlEvent, type ControlResponse, createHelloProof } from "../src/daemon/control-protocol.ts";
import type { LaunchedWorker, WorkerExit, WorkerLaunchRequest } from "../src/daemon/worker-launcher.ts";
import {
	type LiveWorker,
	MAX_WORKER_CONVERSATIONS,
	WORKER_FORCED_CLOSE_TIMEOUT_MS,
	WORKER_FORCED_STOP_TIMEOUT_MS,
	WORKER_READY_TIMEOUT_MS,
	WorkerOpenError,
	type WorkerOpenOutcome,
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
		profile = `profile-${sessionId}`,
	): Extract<WorkerSpawnInput, { origin: "phone" }> => ({
		origin: "phone",
		workspace: { name: workspaceName, path: "/ws", generation },
		session: ref(sessionId),
		cwd: "/ws",
		root: "/ws",
		projectCwd: "/ws",
		toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
		projectTrusted: false,
		profile,
	});

	/**
	 * A phone's open of `sessionId`. Its compatibility key comes from
	 * `profile`: a profile of the session's own by default, so opens share a
	 * worker only when they name one profile.
	 */
	const open = (sessionId: string, attach?: "remote" | "local", workspaceName = "ws", profile?: string) => {
		const generation = generations.get(workspaceName) ?? 0;
		const input = spawnInput(sessionId, generation, workspaceName, profile);
		return registry.open(
			{ workspaceName, workspaceGeneration: generation, sessionId },
			{
				compatibility: input,
				prepare: async () => input,
				attach: (worker: LiveWorker, outcome: WorkerOpenOutcome) => ({
					worker,
					outcome,
					release: attach === undefined ? () => {} : worker.attach(attach),
				}),
			},
		);
	};

	/** The worker launched `index`-th says hello. */
	const binding = { challenge: "C".repeat(43), socketPath: "/tmp/voltd-test.sock" };
	const hello = (worker: FakeWorker, token = worker.request.workerToken): boolean =>
		registry.admitWorker(
			{
				type: "hello",
				role: "worker",
				protocolVersion: 4,
				workerId: worker.request.workerId,
				workerProof: createHelloProof("worker", token, binding),
				pid: 4242,
				version: "test",
			},
			binding,
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
		expect(await send(worker, { type: "worker_ready", sessionId })).toMatchObject({ type: "ok" });
		return worker;
	};

	/** The conversations the daemon sent `worker` to open (`worker_open`), its first one first. */
	const opensOf = (worker: FakeWorker) =>
		(events.get(worker.connectionId) ?? []).flatMap((event) => (event.type === "worker_open" ? [event.spec] : []));

	const spawnOf = async (worker: FakeWorker) => {
		await Promise.resolve();
		const spec = opensOf(worker)[0];
		if (!spec) throw new Error("no worker_open sent");
		return spec;
	};

	/** The worker opens the routed conversation `sessionId` once it was sent, and reports it ready. */
	const ready = async (worker: FakeWorker, sessionId: string): Promise<void> => {
		await waitUntil(() => opensOf(worker).some((spec) => spec.session.sessionId === sessionId));
		expect(await send(worker, { type: "worker_ready", sessionId })).toMatchObject({ type: "ok" });
	};

	const stops = (worker: FakeWorker) =>
		(events.get(worker.connectionId) ?? []).filter(
			(event): event is Extract<ControlEvent, { type: "worker_stop" }> => event.type === "worker_stop",
		);

	const closes = (worker: FakeWorker) =>
		(events.get(worker.connectionId) ?? []).filter(
			(event): event is Extract<ControlEvent, { type: "worker_close" }> => event.type === "worker_close",
		);

	return {
		registry,
		spawnInput,
		generations,
		events,
		audits,
		launched,
		killed,
		open,
		hello,
		send,
		start,
		spawnOf,
		opensOf,
		ready,
		stops,
		closes,
	};
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

	it("refuses a readiness report for conversations the worker was not sent", async () => {
		const { open, launched, hello, send } = setup();
		void open("s1").catch(() => undefined);
		await waitUntil(() => launched.length === 1);
		const worker = launched[0]!;
		expect(await send(worker, { type: "worker_ready", sessionId: "s1" })).toMatchObject({
			code: "not_registered",
		});
		hello(worker);
		expect(await send(worker, { type: "worker_ready", sessionId: "s2" })).toMatchObject({
			code: "invalid_sessions",
		});
		expect(await send(worker, { type: "worker_ready", sessionId: "s1" })).toMatchObject({ type: "ok" });
		// Reported once; a live worker reports only the conversations routed to it.
		expect(await send(worker, { type: "worker_ready", sessionId: "s1" })).toMatchObject({
			code: "invalid_sessions",
		});
		expect(await send(worker, { type: "worker_ready", sessionId: "s2" })).toMatchObject({
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
		// What the worker hosts already is never claimed again, into its group or another's.
		for (const sessionId of ["s1", "s2"]) {
			expect(
				await send(a, { type: "worker_hosts", sessionId, kind: "sibling", parentSessionId: "s1" }),
			).toMatchObject({ code: "claimed" });
		}
		// A group's head is released last.
		expect(await send(a, { type: "worker_released", sessionId: "s1" })).toMatchObject({ code: "group_open" });
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

	it("closes a detached idle conversation for a sibling claim of it; the claim waits for its release", async () => {
		const { registry, open, start, send, stops, closes } = setup();
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
		expect(closes(source)).toEqual([]);
		// Active: the worker would refuse the close, so it is not asked.
		release();
		await send(source, { type: "worker_activity", activeSessionIds: ["s1"] });
		expect(await claimSource()).toMatchObject({ code: "claimed" });
		expect(closes(source)).toEqual([]);

		// Detached and idle: closed as its TTL would, and the claim is retried until it was released.
		await send(source, { type: "worker_activity", activeSessionIds: [] });
		expect(await claimSource()).toMatchObject({ code: "retiring" });
		expect(closes(source)).toMatchObject([{ sessionId: "s1", reason: "retention", force: false }]);
		expect(await claimSource()).toMatchObject({ code: "retiring" });
		expect(closes(source)).toHaveLength(1);
		// Only sibling claims close the conversation.
		expect(
			await send(claimant, { type: "worker_hosts", sessionId: "s1", kind: "moved", parentSessionId: "s9" }),
		).toMatchObject({ code: "claimed" });
		await send(source, { type: "worker_close_result", closeId: closes(source)[0]!.closeId, outcome: "closed" });
		expect(await send(source, { type: "worker_released", sessionId: "s1" })).toMatchObject({ type: "ok" });
		// Released: the claim is granted, and the worker that hosts nothing now retires.
		expect(await claimSource()).toMatchObject({ type: "ok" });
		expect(registry.host("ws", "s1")).toMatchObject({ workerId: claimant.request.workerId, kind: "sibling" });
		expect(stops(source)).toMatchObject([{ reason: "retention", force: false }]);
	});

	it("leaves a detached idle conversation of another workspace alone for a sibling claim", async () => {
		const { open, start, send, closes, generations } = setup();
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
		expect(closes(owner)).toEqual([]);
	});

	it("closes a detached idle conversation after its TTL, unless it refuses because it turned active, then retires the empty worker", async () => {
		const { registry, open, start, send, stops, closes, audits } = setup({ ttlMs: 5 });
		const opened = open("s1", "remote");
		const worker = await start(0);
		const { release } = await opened;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(closes(worker)).toEqual([]);
		await send(worker, { type: "worker_activity", activeSessionIds: ["s1"] });
		release();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(closes(worker)).toEqual([]);
		await send(worker, { type: "worker_activity", activeSessionIds: [] });
		await waitUntil(() => closes(worker).length === 1);
		expect(closes(worker)[0]).toMatchObject({ sessionId: "s1", reason: "retention", force: false });
		expect(registry.list()[0]?.state).toBe("live");
		// A job's wake made it active before it answered: it stays, until reported idle again.
		await send(worker, {
			type: "worker_close_result",
			closeId: closes(worker)[0]!.closeId,
			outcome: "refused_active",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(closes(worker)).toHaveLength(1);
		await send(worker, { type: "worker_activity", activeSessionIds: [] });
		await waitUntil(() => closes(worker).length === 2);
		await send(worker, { type: "worker_close_result", closeId: closes(worker)[1]!.closeId, outcome: "closed" });
		expect(stops(worker)).toEqual([]);
		await send(worker, { type: "worker_released", sessionId: "s1" });
		// It hosts nothing: it retires.
		expect(stops(worker)).toMatchObject([{ reason: "retention", force: false }]);
		expect(registry.list()[0]?.state).toBe("retiring");
		await send(worker, { type: "worker_stop_result", stopId: stops(worker)[0]!.stopId, outcome: "stopped" });
		worker.exit({ reason: "stopped" });
		await waitUntil(() => registry.size === 0);
		expect(audits.map((event) => [event.type, event.success])).toEqual([
			["worker_spawned", true],
			["worker_ready", true],
			["worker_close", true],
			["worker_close", false],
			["worker_close", true],
			["worker_close", true],
			["worker_stop", true],
			["worker_exited", true],
		]);
	});

	it("waits for a closing conversation's release, and a retiring worker's exit, before opening it again", async () => {
		const { registry, open, start, send, stops, closes, launched } = setup({ ttlMs: 1 });
		const opened = open("s1");
		const first = await start(0);
		await opened;
		await waitUntil(() => closes(first).length === 1);
		await send(first, { type: "worker_close_result", closeId: closes(first)[0]!.closeId, outcome: "closed" });
		const reopened = open("s1", "remote");
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The worker still holds the log: nothing spawns yet.
		expect(launched).toHaveLength(1);
		await send(first, { type: "worker_released", sessionId: "s1" });
		// Released: the empty worker retires, so the conversation opens in a replacement.
		expect(stops(first)).toHaveLength(1);
		const second = await start(1);
		const { worker, outcome } = await reopened;
		expect([worker.workerId, outcome]).toEqual([second.request.workerId, "spawned"]);
		first.exit();
		await waitUntil(() => registry.list().length === 1);
	});

	it("fails the opens waiting for a spawn whose worker could not open its conversation", async () => {
		const { registry, open, launched, hello, send } = setup();
		const first = open("s1");
		const second = open("s1");
		await waitUntil(() => launched.length === 1);
		const worker = launched[0]!;
		hello(worker);
		await send(worker, {
			type: "worker_open_failed",
			sessionId: "s1",
			outcome: "conversation_locked",
			message: "locked elsewhere",
		});
		worker.exit({ reason: "failed", error: "locked elsewhere" });
		for (const pending of [first, second]) {
			const error = await pending.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(WorkerOpenError);
			expect((error as WorkerOpenError).outcome).toBe("conversation_locked");
		}
		expect(registry.size).toBe(0);
	});

	it("fences a workspace: its stale workers retire without refusal, and admission waits for their exit", async () => {
		const { registry, open, start, send, stops, generations, launched, spawnInput } = setup();
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
					compatibility: spawnInput("s5"),
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

	it("serves an open that waited on a closing conversation once the worker refuses the close", async () => {
		const { registry, open, start, send, closes, launched } = setup({ ttlMs: 1 });
		const opened = open("s1");
		const worker = await start(0);
		await opened;
		await waitUntil(() => closes(worker).length === 1);
		const reopened = open("s1", "remote");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await send(worker, {
			type: "worker_close_result",
			closeId: closes(worker)[0]!.closeId,
			outcome: "refused_active",
		});
		const { worker: live, outcome } = await reopened;
		expect([live.workerId, outcome]).toEqual([worker.request.workerId, "attached"]);
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

	it("keeps a --no-session worker for its opener: other clients are refused, and it alone claims conversations in its memory", async () => {
		const { registry, open, launched, start, send, spawnInput } = setup();
		const env = { PATH: "/bin" };
		const tuiOpen = (client: string | undefined, exclusive: boolean) =>
			registry.open(
				{ workspaceName: "ws", workspaceGeneration: 1, sessionId: "m1" },
				{
					compatibility: { origin: "tui", config: {} },
					...(client === undefined ? {} : { client }),
					exclusive,
					env,
					prepare: async () => ({
						origin: "tui",
						workspace: { name: "ws", path: "/ws", generation: 1 },
						session: { sessionId: "m1", inMemory: true },
						cwd: "/ws",
						root: "/ws",
						projectCwd: "/ws",
						config: {},
						sessionOptions: {},
						clientKey: client ?? "tui-0",
					}),
					attach: (worker: LiveWorker, outcome: WorkerOpenOutcome) => ({ worker, spawned: outcome === "spawned" }),
				},
			);
		const opening = tuiOpen("tui-1", true);
		const exclusive = await start(0);
		const opened = await opening;
		expect(opened.spawned).toBe(true);
		expect(opened.worker.compatibilityKey).toMatch(/^[0-9a-f]{64}$/);
		// The TUI's environment reaches the launch, and nothing else.
		expect(launched[0]?.request.env).toEqual(env);
		expect(await tuiOpen("tui-1", false)).toMatchObject({ spawned: false });
		await expect(tuiOpen("tui-2", false)).rejects.toMatchObject({ outcome: "conversation_in_use" });
		await expect(tuiOpen(undefined, false)).rejects.toMatchObject({ outcome: "conversation_in_use" });

		const phone = open("s9");
		const other = await start(1);
		await phone;
		const claim = (worker: typeof exclusive, sessionId: string, inMemory: boolean, parentSessionId: string) =>
			send(worker, {
				type: "worker_hosts",
				sessionId,
				kind: "moved",
				parentSessionId,
				...(inMemory ? { inMemory: true } : {}),
			});
		expect(await claim(exclusive, "m2", true, "m1")).toMatchObject({ type: "ok" });
		// Only a --no-session worker holds conversations in memory; its stored claims are its workspace's.
		expect(await claim(other, "m3", true, "s9")).toMatchObject({ code: "not_found" });
		expect(await claim(exclusive, "other-workspace", false, "m1")).toMatchObject({ code: "not_found" });
		await expect(
			registry.open(
				{ workspaceName: "ws", workspaceGeneration: 1, sessionId: "m2" },
				{
					compatibility: spawnInput("m2"),
					prepare: async () => Promise.reject(new Error("unused")),
					attach: () => undefined,
				},
			),
		).rejects.toMatchObject({ outcome: "conversation_in_use" });
	});
	it("routes an open nobody hosts into a live worker of its compatibility key, up to the cap, then spawns beside it", async () => {
		const { registry, open, start, ready, opensOf, launched, audits } = setup();
		const first = open("s1", "remote", "ws", "shared");
		const worker = await start(0);
		const outcomes = [(await first).outcome];
		for (let index = 2; index <= MAX_WORKER_CONVERSATIONS; index++) {
			const sessionId = `s${index}`;
			const opening = open(sessionId, "remote", "ws", "shared");
			await ready(worker, sessionId);
			const opened = await opening;
			expect(opened.worker.workerId).toBe(worker.request.workerId);
			outcomes.push(opened.outcome);
		}
		expect(outcomes).toEqual(["spawned", ...Array.from({ length: MAX_WORKER_CONVERSATIONS - 1 }, () => "routed")]);
		// Each routed conversation is opened from its own spec, in the worker the first one spawned.
		expect(opensOf(worker).map((spec) => [spec.workerId, spec.session.sessionId])).toEqual(
			Array.from({ length: MAX_WORKER_CONVERSATIONS }, (_, index) => [worker.request.workerId, `s${index + 1}`]),
		);
		expect(launched).toHaveLength(1);
		expect(audits.filter((event) => event.type === "worker_open")).toHaveLength(MAX_WORKER_CONVERSATIONS - 1);

		// Full: the next open spawns a worker of its own.
		const overflow = open("s7", "remote", "ws", "shared");
		const second = await start(1);
		expect(await overflow).toMatchObject({ outcome: "spawned", worker: { workerId: second.request.workerId } });
		expect(registry.list().map((entry) => [entry.workerId, entry.sessionIds.length])).toEqual([
			[worker.request.workerId, MAX_WORKER_CONVERSATIONS],
			[second.request.workerId, 1],
		]);
	});

	it("never routes across compatibility keys, workspaces, or generations", async () => {
		const { registry, open, start, launched, generations } = setup();
		generations.set("ws2", 1);
		const first = open("s1", "remote", "ws", "a");
		await start(0);
		await first;
		const otherKey = open("s2", "remote", "ws", "b");
		await start(1);
		expect(await otherKey).toMatchObject({ outcome: "spawned" });
		const otherWorkspace = open("s3", "remote", "ws2", "a");
		await start(2);
		expect(await otherWorkspace).toMatchObject({ outcome: "spawned" });
		// The fenced workers retire; a new generation's open spawns once they exited.
		generations.set("ws", 2);
		const fence = registry.fenceWorkspace("ws");
		for (const worker of launched.slice(0, 2)) worker.exit();
		await fence;
		const otherGeneration = open("s4", "remote", "ws", "a");
		await start(3);
		expect(await otherGeneration).toMatchObject({ outcome: "spawned" });
		expect(launched).toHaveLength(4);
	});

	it("closes one group per conversation: its claims go first, its neighbour stays, and the worker retires once it hosts nothing", async () => {
		const { registry, open, start, ready, send, stops, closes } = setup({ ttlMs: 5 });
		const first = open("s1", "remote", "ws", "shared");
		const worker = await start(0);
		const { release: leaveFirst } = await first;
		const second = open("s2", undefined, "ws", "shared");
		await ready(worker, "s2");
		await second;
		// s3 is a subagent child of s2: in s2's group, and attached keeps the group.
		expect(
			await send(worker, { type: "worker_hosts", sessionId: "s3", kind: "child", parentSessionId: "s2" }),
		).toMatchObject({ type: "ok" });
		const child = open("s3", "remote", "ws", "shared");
		const { release: leaveChild } = await child;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(closes(worker)).toEqual([]);
		leaveChild();
		await waitUntil(() => closes(worker).length === 1);
		expect(closes(worker)[0]).toMatchObject({ sessionId: "s2", reason: "retention", force: false });
		// No open reaches a closing group, nor does a claim join it; the open waits for the release.
		const reopen = open("s3", "remote", "ws", "shared");
		expect(
			await send(worker, { type: "worker_hosts", sessionId: "s4", kind: "moved", parentSessionId: "s3" }),
		).toMatchObject({ code: "closing" });
		await send(worker, { type: "worker_close_result", closeId: closes(worker)[0]!.closeId, outcome: "closed" });
		expect(await send(worker, { type: "worker_released", sessionId: "s2" })).toMatchObject({ code: "group_open" });
		expect(await send(worker, { type: "worker_released", sessionId: "s3" })).toMatchObject({ type: "ok" });
		expect(await send(worker, { type: "worker_released", sessionId: "s2" })).toMatchObject({ type: "ok" });
		// s1 serves on, attached; the reopened s3 is routed back into the worker as a conversation of its own.
		await ready(worker, "s3");
		const reopened = await reopen;
		expect(reopened).toMatchObject({ outcome: "routed", worker: { workerId: worker.request.workerId } });
		expect(registry.list()).toMatchObject([{ state: "live", sessionIds: ["s1", "s3"], clients: { remote: 2 } }]);
		expect(stops(worker)).toEqual([]);
		// Every client left: each group closes, and the empty worker retires.
		leaveFirst();
		await waitUntil(() => closes(worker).length === 2);
		await send(worker, { type: "worker_released", sessionId: "s1" });
		expect(stops(worker)).toEqual([]);
		reopened.release();
		await waitUntil(() => closes(worker).length === 3);
		expect(closes(worker).map((close) => close.sessionId)).toEqual(["s2", "s1", "s3"]);
		await send(worker, { type: "worker_released", sessionId: "s3" });
		expect(stops(worker)).toMatchObject([{ reason: "retention", force: false }]);
		expect(registry.list()).toMatchObject([{ state: "retiring", sessionIds: [] }]);
	});

	it("closes one conversation without the option to refuse, leaving the worker's others serving", async () => {
		const { registry, open, start, ready, send, stops, closes } = setup();
		const retiring: Array<readonly string[]> = [];
		registry.onWorkerRetiring((_workerId, _reason, sessionIds) => retiring.push(sessionIds));
		const first = open("s1", "remote", "ws", "shared");
		const worker = await start(0);
		await first;
		const second = open("s2", "remote", "ws", "shared");
		await ready(worker, "s2");
		const { release: relaySettled } = await second;
		await send(worker, { type: "worker_hosts", sessionId: "s3", kind: "child", parentSessionId: "s2" });
		await send(worker, { type: "worker_activity", activeSessionIds: ["s3"] });
		let closed = false;
		const closing = registry.closeConversation("ws", "s3", "authority").then(() => {
			closed = true;
		});
		// Its group's relays close first; the worker is told to close it, refusal or not.
		expect(retiring).toEqual([["s2", "s3"]]);
		expect(closes(worker)).toMatchObject([{ sessionId: "s2", reason: "authority", force: true }]);
		await send(worker, {
			type: "worker_close_result",
			closeId: closes(worker)[0]!.closeId,
			outcome: "refused_active",
		});
		await send(worker, { type: "worker_released", sessionId: "s3" });
		expect(closed).toBe(false);
		await send(worker, { type: "worker_released", sessionId: "s2" });
		await closing;
		// The closed conversation's relay ends with its stream.
		relaySettled();
		expect(registry.list()).toMatchObject([{ state: "live", sessionIds: ["s1"], clients: { remote: 1 } }]);
		expect(stops(worker)).toEqual([]);
	});

	it("fails a routed open the worker could not open, or did not report in time, and keeps the worker's others", async () => {
		const { registry, open, start, send, opensOf, closes } = setup();
		const first = open("s1", "remote", "ws", "shared");
		const worker = await start(0);
		await first;
		const locked = open("s2", "remote", "ws", "shared");
		await waitUntil(() => opensOf(worker).length === 2);
		await send(worker, {
			type: "worker_open_failed",
			sessionId: "s2",
			outcome: "conversation_locked",
			message: "locked elsewhere",
		});
		await expect(locked).rejects.toMatchObject({ outcome: "conversation_locked" });
		expect(registry.list()).toMatchObject([{ state: "live", sessionIds: ["s1"] }]);

		vi.useFakeTimers();
		try {
			const silent = open("s3", "remote", "ws", "shared");
			const failed = silent.catch((error: unknown) => error);
			await vi.waitFor(() => expect(opensOf(worker)).toHaveLength(3));
			await vi.advanceTimersByTimeAsync(WORKER_READY_TIMEOUT_MS);
			expect(await failed).toBeInstanceOf(WorkerOpenError);
			// It may still open it: it is told to close it, and the registry keeps it until it is released.
			expect(closes(worker)).toMatchObject([{ sessionId: "s3", force: true }]);
			expect(registry.list()[0]?.sessionIds).toEqual(["s1", "s3"]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("never claims a conversation another group of the worker hosts, and retires a worker stuck in a forced close with the turn cap", async () => {
		const { registry, open, start, ready, send, stops, closes } = setup();
		const first = open("s1", "remote", "ws", "shared");
		const worker = await start(0);
		await first;
		const second = open("s2", "remote", "ws", "shared");
		await ready(worker, "s2");
		await second;
		// s1's code switching to s2 (another group's conversation here) is refused: s2 stays where it is.
		expect(
			await send(worker, { type: "worker_hosts", sessionId: "s2", kind: "moved", parentSessionId: "s1" }),
		).toMatchObject({ code: "claimed" });
		expect(registry.host("ws", "s2")).toMatchObject({ kind: "conversation" });

		vi.useFakeTimers();
		try {
			void registry.closeConversation("ws", "s2", "authority");
			expect(closes(worker)).toMatchObject([{ sessionId: "s2", reason: "authority", force: true }]);
			await vi.advanceTimersByTimeAsync(WORKER_FORCED_CLOSE_TIMEOUT_MS - 1);
			expect(stops(worker)).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);
			// Its neighbours get the 60 s turn cap, not the close's immediate abort.
			expect(stops(worker)).toMatchObject([{ reason: "retention", force: true }]);
		} finally {
			vi.useRealTimers();
		}
	});
	it("asks only the open that opens a conversation, pausing its ready wait until the answer", async () => {
		const { registry, open, start, send, opensOf, closes, spawnInput } = setup();
		const first = open("s1", "remote", "ws", "shared");
		const worker = await start(0);
		await first;
		// Nobody waits for an open conversation to open: nobody is asked.
		expect(
			await send(worker, {
				type: "worker_host_request",
				sessionId: "s1",
				request: { kind: "confirm", title: "t", message: "m" },
			}),
		).toMatchObject({ type: "error", code: "unavailable" });

		vi.useFakeTimers();
		try {
			const questions: Array<{
				readonly request: HostPromptRequest;
				readonly signal: AbortSignal;
				readonly answer: PromiseWithResolvers<{ readonly response?: HostResponse } | undefined>;
			}> = [];
			const input = spawnInput("s2", 1, "ws", "shared");
			const key = { workspaceName: "ws", workspaceGeneration: 1, sessionId: "s2" };
			const opening = registry.open(key, {
				compatibility: input,
				prepare: async () => input,
				attach: (live: LiveWorker) => live,
				ask: (request, signal) => {
					const answer = Promise.withResolvers<{ readonly response?: HostResponse } | undefined>();
					questions.push({ request, signal, answer });
					return answer.promise;
				},
			});
			// A concurrent open of the same conversation waits for it, and is never asked.
			const waiting = registry.open(key, {
				compatibility: input,
				prepare: async () => input,
				attach: (live: LiveWorker) => live,
				ask: () => Promise.reject(new Error("Only the open that opens the conversation is asked")),
			});
			await vi.waitFor(() => expect(opensOf(worker)).toHaveLength(2));
			const asked = send(worker, {
				type: "worker_host_request",
				sessionId: "s2",
				request: { kind: "select", title: "Trust?", options: ["No", "Yes"] },
			});
			await vi.waitFor(() => expect(questions).toHaveLength(1));
			expect(questions[0]?.request).toEqual({ kind: "select", title: "Trust?", options: ["No", "Yes"] });
			await vi.advanceTimersByTimeAsync(WORKER_READY_TIMEOUT_MS * 2);
			expect(closes(worker)).toEqual([]);
			questions[0]?.answer.resolve({ response: { value: "Yes" } });
			expect(await asked).toMatchObject({ type: "worker_host_response", response: { value: "Yes" } });

			// The wait starts over at the answer.
			const failed = opening.catch((error: unknown) => error);
			void waiting.catch(() => undefined);
			await vi.advanceTimersByTimeAsync(WORKER_READY_TIMEOUT_MS - 1);
			expect(closes(worker)).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);
			expect(await failed).toBeInstanceOf(WorkerOpenError);
			expect(closes(worker)).toMatchObject([{ sessionId: "s2", force: true }]);
			expect(questions[0]?.signal.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps a starting worker while it asks its opener, and ends the question when the worker exits", async () => {
		const { registry, launched, hello, send, spawnInput } = setup();
		vi.useFakeTimers();
		try {
			const signals: AbortSignal[] = [];
			const input = spawnInput("s1");
			const opening = registry.open(
				{ workspaceName: "ws", workspaceGeneration: 1, sessionId: "s1" },
				{
					compatibility: input,
					prepare: async () => input,
					attach: (live: LiveWorker) => live,
					ask: (_request, signal) => {
						signals.push(signal);
						return new Promise(() => {});
					},
				},
			);
			const failed = opening.catch((error: unknown) => error);
			await vi.waitFor(() => expect(launched).toHaveLength(1));
			const worker = launched[0];
			if (worker === undefined) throw new Error("No worker launched");
			expect(hello(worker)).toBe(true);
			void send(worker, {
				type: "worker_host_request",
				sessionId: "s1",
				request: { kind: "input", title: "Name?" },
			});
			await vi.waitFor(() => expect(signals).toHaveLength(1));
			await vi.advanceTimersByTimeAsync(WORKER_READY_TIMEOUT_MS * 2);
			expect(registry.list()).toMatchObject([{ state: "starting" }]);

			worker.exit({ reason: "crashed", error: "gone" });
			expect(await failed).toBeInstanceOf(WorkerOpenError);
			expect(signals[0]?.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

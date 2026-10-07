import { afterEach, describe, expect, it, vi } from "vitest";
import { type ControlEvent, type ControlResponse, createHelloProof } from "../src/daemon/control-protocol.ts";
import type { LaunchedWorker, WorkerExit, WorkerLaunchRequest } from "../src/daemon/worker-launcher.ts";
import { type LiveWorker, WorkerRegistry } from "../src/daemon/worker-registry.ts";

const TTL_MS = 1000;
const SESSION_ID = "retained-background-session";

afterEach(() => {
	vi.useRealTimers();
});

/** A registry whose one worker the test drives: its hello, readiness, activity reports, and exit. */
async function liveWorker() {
	const events: ControlEvent[] = [];
	let launched: { request: WorkerLaunchRequest; exit: (exit: WorkerExit) => void } | undefined;
	const registry = new WorkerRegistry({
		launcher: {
			launch(request): LaunchedWorker {
				const exited = Promise.withResolvers<WorkerExit>();
				launched = { request, exit: exited.resolve };
				return { pid: 4242, exited: exited.promise, kill: () => {} };
			},
		},
		agentDir: "/agent",
		socketPath: () => "/agent/daemon/voltd.sock",
		sendTo: (_connectionId, event) => {
			events.push(event);
			return true;
		},
		currentGeneration: () => 1,
		detachedRuntimeTtlMs: () => TTL_MS,
		sessionInWorkspace: async () => true,
		audit: () => {},
	});
	let requestId = 0;
	const send = (request: Record<string, unknown>): Promise<ControlResponse> =>
		registry.handleWorkerRequest("c-1", { ...request, id: `${++requestId}` } as Parameters<
			WorkerRegistry["handleWorkerRequest"]
		>[1]);
	const opened = registry.open(
		{ workspaceName: "ws", workspaceGeneration: 1, sessionId: SESSION_ID },
		{
			compatibility: {
				origin: "phone",
				toolPolicy: { tools: ["bash"], allowUnlistedExtensionTools: false },
				projectTrusted: false,
			},
			prepare: async () => ({
				origin: "phone",
				workspace: { name: "ws", path: "/ws", generation: 1 },
				session: {
					sessionDirectory: "/sessions",
					storeId: "store",
					sessionId: SESSION_ID,
					sessionGeneration: "gen",
				},
				cwd: "/ws",
				root: "/ws",
				projectCwd: "/ws",
				toolPolicy: { tools: ["bash"], allowUnlistedExtensionTools: false },
				projectTrusted: false,
			}),
			attach: (worker: LiveWorker) => worker.attach("remote"),
		},
	);
	await vi.waitFor(() => expect(launched).toBeDefined());
	const worker = launched!;
	const binding = { challenge: "C".repeat(43), socketPath: "/tmp/voltd-test.sock" };
	expect(
		registry.admitWorker(
			{
				type: "hello",
				role: "worker",
				protocolVersion: 4,
				workerId: worker.request.workerId,
				workerProof: createHelloProof("worker", worker.request.workerToken, binding),
				pid: 4242,
				version: "test",
			},
			binding,
			"c-1",
		),
	).toBeDefined();
	await vi.waitFor(() => expect(events.some((event) => event.type === "worker_open")).toBe(true));
	expect(await send({ type: "worker_ready", sessionId: SESSION_ID })).toMatchObject({ type: "ok" });
	const detach = await opened;
	const stops = () =>
		events.filter((event): event is Extract<ControlEvent, { type: "worker_stop" }> => event.type === "worker_stop");
	const closes = () =>
		events.filter((event): event is Extract<ControlEvent, { type: "worker_close" }> => event.type === "worker_close");
	return { registry, send, detach, stops, closes, exit: worker.exit };
}

describe("daemon running work retention", () => {
	it.each([true, false])(
		"retains a detached conversation while it is active, then for the full TTL (active at detach: %s)",
		async (activeAtDetach) => {
			const { registry, send, detach, stops, closes, exit } = await liveWorker();
			if (activeAtDetach) await send({ type: "worker_activity", activeSessionIds: [SESSION_ID] });
			vi.useFakeTimers();
			detach();
			if (!activeAtDetach) {
				// The TTL started at detach; the conversation turning active cancels it.
				await vi.advanceTimersByTimeAsync(TTL_MS / 2);
				await send({ type: "worker_activity", activeSessionIds: [SESSION_ID] });
			}
			await vi.advanceTimersByTimeAsync(5 * TTL_MS);
			expect(closes()).toEqual([]);
			expect(registry.list()).toMatchObject([{ state: "live", sessionIds: [SESSION_ID] }]);

			// Idle again: the full TTL runs from now, not what was left of it.
			await send({ type: "worker_activity", activeSessionIds: [] });
			await vi.advanceTimersByTimeAsync(TTL_MS - 1);
			expect(closes()).toEqual([]);
			await vi.advanceTimersByTimeAsync(1);
			expect(closes()).toMatchObject([{ sessionId: SESSION_ID, reason: "retention", force: false }]);

			// The conversation closed and was released: the worker hosts nothing, and retires.
			await send({ type: "worker_close_result", closeId: closes()[0]!.closeId, outcome: "closed" });
			expect(stops()).toEqual([]);
			expect(await send({ type: "worker_released", sessionId: SESSION_ID })).toMatchObject({ type: "ok" });
			expect(stops()).toMatchObject([{ reason: "retention", force: false }]);
			expect(registry.list()[0]?.state).toBe("retiring");

			await send({ type: "worker_stop_result", stopId: stops()[0]!.stopId, outcome: "stopped" });
			exit({ reason: "stopped" });
			await vi.waitFor(() => expect(registry.size).toBe(0));
		},
	);
});

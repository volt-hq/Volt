import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDaemonConversation } from "../src/client/daemon-conversation.ts";
import { ProtocolClient } from "../src/client/protocol-client.ts";
import { createDaemonClient, type DaemonClient } from "../src/daemon/control-client.ts";
import type { WorkerSpawnSpec } from "../src/daemon/control-protocol.ts";
import { createIrohDaemonService } from "../src/daemon/iroh-service.ts";
import type { LaunchedWorker, WorkerExit, WorkerLauncher, WorkerLaunchRequest } from "../src/daemon/worker-launcher.ts";
import { handoffRecord } from "./fixtures/handoff-command-extension.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";
import { InProcessWorkerLauncher } from "./suite/in-process-worker-launcher.ts";
import { nativeIrohAvailable, type PairedPhone, type PhoneConversation, pairPhone } from "./utilities/daemon-phone.ts";
import type { RemotePhone } from "./utilities/remote-phone.ts";

const HANDOFF_EXTENSION_PATH = realpathSync.native(
	fileURLToPath(new URL("./fixtures/handoff-command-extension.ts", import.meta.url)),
);

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function startHarness(options: Parameters<typeof createDaemonHarness>[0] = {}): Promise<DaemonHarness> {
	const harness = await createDaemonHarness({
		...options,
		extensions: [createIrohDaemonService({ relayMode: "disabled" }), ...(options.extensions ?? [])],
	});
	cleanups.push(() => harness.dispose());
	return harness;
}

async function pair(harness: DaemonHarness, options: Parameters<typeof pairPhone>[1] = {}): Promise<PairedPhone> {
	const phone = await pairPhone(harness, options);
	cleanups.push(() => phone.close());
	return phone;
}

/** Open `sessionId` on `paired`, say hello, and subscribe to it. */
async function attach(
	paired: PairedPhone,
	sessionId: string,
): Promise<{ stream: PhoneConversation; phone: RemotePhone }> {
	const stream = await paired.openConversation({ target: "session", sessionId });
	expect(stream.handshake).toMatchObject({ success: true, sessionId });
	const phone = stream.phone!;
	await phone.hello();
	await phone.subscribe(sessionId);
	return { stream, phone };
}

function assistantText(frames: readonly HostFrame[]): string[] {
	return frames.flatMap((frame) =>
		frame.type === "entry" &&
		frame.entry.type === "message" &&
		frame.entry.view !== undefined &&
		"role" in frame.entry.view &&
		frame.entry.view.role === "assistant"
			? [String((frame.entry.view as { text?: unknown }).text ?? "")]
			: [],
	);
}

/**
 * In-process workers, two of which a test can steer: one it crashes (its
 * exit reaches the registry while the worker still runs, as a process that
 * died would), and one it plays itself over the control socket.
 */
class TestWorkerLauncher implements WorkerLauncher {
	private readonly inner = new InProcessWorkerLauncher();
	private readonly scripts: Array<(request: WorkerLaunchRequest) => LaunchedWorker> = [];
	private readonly crashes = new Map<string, { crash: (exit: WorkerExit) => void; exited: Promise<WorkerExit> }>();

	/** The next launch runs `launch` instead of a worker. */
	script(launch: (request: WorkerLaunchRequest) => LaunchedWorker): void {
		this.scripts.push(launch);
	}

	/** Report `workerId` crashed; resolves with its real exit, once the worker itself stopped. */
	crash(workerId: string): Promise<WorkerExit> {
		const launched = this.crashes.get(workerId);
		if (!launched) throw new Error(`No worker ${workerId}`);
		launched.crash({ reason: "crashed", error: "test crash" });
		return launched.exited;
	}

	launch(request: WorkerLaunchRequest): LaunchedWorker {
		const scripted = this.scripts.shift();
		if (scripted) return scripted(request);
		const worker = this.inner.launch(request);
		const crash = Promise.withResolvers<WorkerExit>();
		this.crashes.set(request.workerId, { crash: crash.resolve, exited: worker.exited });
		return { pid: worker.pid, exited: Promise.race([worker.exited, crash.promise]), kill: () => worker.kill() };
	}
}

/** A worker the test plays: it connects with its launch's token, reports its conversation open, and stops when asked. */
function scriptedWorker(request: WorkerLaunchRequest): { worker: LaunchedWorker; client: Promise<DaemonClient> } {
	const exited = Promise.withResolvers<WorkerExit>();
	const spec = Promise.withResolvers<WorkerSpawnSpec>();
	const client = createDaemonClient({
		socketPath: request.socketPath,
		version: "test",
		worker: { workerId: request.workerId, workerToken: request.workerToken },
		reconnect: false,
		onEvent: (event) => {
			if (event.type === "worker_spawn") spec.resolve(event.spec);
			if (event.type === "worker_stop") {
				void client
					.request({ type: "worker_stop_result", stopId: event.stopId, outcome: "stopped" })
					.catch(() => undefined)
					.then(() => client.close())
					.then(() => exited.resolve({ reason: "stopped" }));
			}
		},
	});
	const ready = (async () => {
		await client.connect();
		const opened = await spec.promise;
		await client.request({ type: "worker_ready", sessionIds: [opened.session.sessionId] });
		return client;
	})();
	return {
		worker: { pid: process.pid, exited: exited.promise, kill: () => exited.resolve({ reason: "crashed" }) },
		client: ready,
	};
}

describe.runIf(nativeIrohAvailable)("phones in conversation workers", () => {
	it("serves a phone's conversation from the worker its open spawned", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		harness.faux.setResponses([fauxAssistantMessage("hello from the worker")]);
		const paired = await pair(harness);
		const opened = await paired.openConversation({ target: "session", sessionId: ref.sessionId });
		expect(opened.handshake).toMatchObject({ success: true, sessionId: ref.sessionId });
		const phone = opened.phone!;
		await phone.hello();
		await phone.subscribe(ref.sessionId);
		expect(await phone.intent("prompt", { message: "hi" })).toMatchObject({ type: "accepted" });
		await expect.poll(() => assistantText(phone.frames), { timeout: 3000 }).toContain("hello from the worker");
		const status = await harness.status();
		expect(status.workers).toEqual([
			expect.objectContaining({
				origin: "phone",
				state: "live",
				sessionIds: [ref.sessionId],
				clients: { local: 0, remote: 1 },
			}),
		]);
		expect(status.leases).toEqual([
			expect.objectContaining({ sessionId: ref.sessionId, state: "daemon-active", streamCount: 1 }),
		]);
		await opened.close();
		await expect.poll(async () => (await harness.status()).workers[0]?.clients.remote).toBe(0);
	}, 60_000);

	it("relays a phone into the worker a TUI opened, beside the TUI, with that worker's tools", async () => {
		const harness = await startHarness();
		harness.faux.setResponses([fauxAssistantMessage("hello to both")]);
		const tui = await harness.connect("tui");
		const { opened, transport } = await openDaemonConversation(tui, {
			target: { kind: "new" },
			spawn: {
				env: {},
				config: { tools: ["read"] },
				cwd: harness.workspacePath,
				persist: true,
				session: {},
			},
			clientKey: "tui-1",
		});
		const client = new ProtocolClient({ followMoves: "reconnect" });
		cleanups.push(() => client.stop());
		await client.connect(transport);

		const paired = await pair(harness, { access: "chat" });
		const { phone } = await attach(paired, opened.sessionId);
		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({
				origin: "tui",
				sessionIds: [opened.sessionId],
				clients: { local: 1, remote: 1 },
			}),
		]);
		expect(await phone.intent("prompt", { message: "hi" })).toMatchObject({ type: "accepted" });
		await expect.poll(() => assistantText(phone.frames), { timeout: 5000 }).toContain("hello to both");
		await vi.waitFor(() => expect(JSON.stringify(client.state.entries)).toContain("hello to both"));
	}, 60_000);

	it("stops the running turn at once when the client that opened the worker is revoked", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const started = Promise.withResolvers<void>();
		let aborted = false;
		// A turn that answers only once aborted.
		harness.faux.setResponses([
			async (_context, options) => {
				started.resolve();
				await new Promise<void>((resolve) => {
					if (options?.signal?.aborted) resolve();
					options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				aborted = true;
				return fauxAssistantMessage("aborted");
			},
		]);
		const paired = await pair(harness);
		const opened = await paired.openConversation({ target: "session", sessionId: ref.sessionId });
		const phone = opened.phone!;
		await phone.hello();
		await phone.subscribe(ref.sessionId);
		expect(await phone.intent("prompt", { message: "run" })).toMatchObject({ type: "accepted" });
		await started.promise;

		const revokedAt = Date.now();
		expect(await harness.control.request({ type: "client_revoke", clientNodeId: paired.nodeId })).toMatchObject({
			type: "ok",
		});
		// The worker retires for the lost authority without waiting out the 60 s turn cap.
		await expect.poll(async () => (await harness.status()).workers, { timeout: 10_000 }).toEqual([]);
		expect(aborted).toBe(true);
		expect(Date.now() - revokedAt).toBeLessThan(10_000);
		expect(harness.audit()).toContainEqual(
			expect.objectContaining({
				type: "worker_stop",
				details: expect.objectContaining({ reason: "authority", force: true }),
			}),
		);
	}, 60_000);

	it("forwards the phone's daemon-backed queries, and its completion pushes, with the relay's authority", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		harness.faux.setResponses([fauxAssistantMessage("done")]);
		const paired = await pair(harness);
		const { phone } = await attach(paired, ref.sessionId);

		// The completed prompt's push goes through the daemon for this phone (worker_notification_delivery).
		expect(await phone.intent("prompt", { message: "hi" })).toMatchObject({ type: "accepted" });
		await vi.waitFor(() =>
			expect(harness.audit()).toContainEqual(
				expect.objectContaining({
					type: "push_notification_skipped",
					clientNodeId: paired.nodeId,
					workspace: harness.workspaceName,
					details: expect.objectContaining({ kind: "conversation_completed", reason: "no_push_target" }),
				}),
			),
		);

		// The sessions query is the daemon's (worker_forward), with the relay's conversation as the current one.
		expect(await phone.query("sessions")).toMatchObject({
			type: "result",
			data: {
				sessions: [expect.objectContaining({ sessionId: ref.sessionId, current: true, firstMessage: "hi" })],
			},
		});
	}, 60_000);

	it("closes a crashed worker's relays with worker_exited; the phone reconnects with resume in a new worker", async () => {
		const launcher = new TestWorkerLauncher();
		const harness = await startHarness({ workerLauncher: launcher });
		const ref = await harness.createSession();
		harness.faux.setResponses([fauxAssistantMessage("after the crash")]);
		const paired = await pair(harness);
		const first = await attach(paired, ref.sessionId);
		const [crashed] = (await harness.status()).workers;
		if (!crashed) throw new Error("No worker");

		const stray = launcher.crash(crashed.workerId);
		await first.phone.ended;
		await vi.waitFor(() =>
			expect(harness.audit()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "worker_exited",
						success: false,
						details: expect.objectContaining({ workerId: crashed.workerId, reason: "crashed" }),
					}),
					expect.objectContaining({
						type: "relay_closed",
						details: expect.objectContaining({ workerId: crashed.workerId, reason: "worker_exited" }),
					}),
				]),
			),
		);
		expect((await harness.status()).workers).toEqual([]);
		// The crashed process is gone; here, its stray in-process worker loses its daemon and lets go of the log.
		harness.services.controlServer
			.connections()
			.find((connection) => connection.workerId === crashed.workerId)
			?.close();
		expect(await stray).toMatchObject({ reason: "daemon_lost" });

		const second = await attach(paired, ref.sessionId);
		expect(second.stream.handshake).toMatchObject({ success: true, sessionId: ref.sessionId });
		expect(await second.phone.intent("prompt", { message: "again" })).toMatchObject({ type: "accepted" });
		await vi.waitFor(() => expect(assistantText(second.phone.frames)).toContain("after the crash"));
		const [replacement] = (await harness.status()).workers;
		expect(replacement).toMatchObject({ state: "live", sessionIds: [ref.sessionId] });
		expect(replacement?.workerId).not.toBe(crashed.workerId);
	}, 60_000);

	it("answers a phone's unregister_workspace through the daemon, then ends its stream and retires the worker", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const { phone } = await attach(await pair(harness), ref.sessionId);

		expect(await phone.intent("unregister_workspace", { workspaceName: harness.workspaceName })).toMatchObject({
			type: "accepted",
			result: { workspaceName: harness.workspaceName, unregistered: true },
		});
		await phone.ended;
		expect(phone.frames.at(-1)).toMatchObject({ type: "fatal", code: "workspace_unregistered" });
		await vi.waitFor(async () => expect((await harness.status()).workers).toEqual([]));
		expect(harness.services.state.getHostState().workspaces).toEqual([]);
	}, 60_000);

	it("ends a phone's stream with fatal workspace_unregistered when the workspace is unregistered under it", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const { phone } = await attach(await pair(harness), ref.sessionId);

		expect(
			await harness.control.request({ type: "workspace_unregister", name: harness.workspaceName }),
		).toMatchObject({ type: "ok" });
		await phone.ended;
		expect(phone.frames.at(-1)).toMatchObject({ type: "fatal", code: "workspace_unregistered" });
		await vi.waitFor(async () => expect((await harness.status()).workers).toEqual([]));
	}, 60_000);

	it("retires the worker when a TUI acquires the conversation's lease, ending the phone's stream", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const { phone } = await attach(await pair(harness), ref.sessionId);
		const tui = await harness.connect("tui");

		expect(
			await tui.request({ type: "lease_acquire", workspaceName: harness.workspaceName, sessionId: ref.sessionId }),
		).toMatchObject({ type: "lease_granted", handoff: "warm" });
		await phone.ended;
		const status = await harness.status();
		expect(status.workers).toEqual([]);
		expect(status.leases).toEqual([expect.objectContaining({ sessionId: ref.sessionId, state: "tui-owned" })]);
	}, 60_000);

	it("refuses a worker's requests for a relay another worker serves", async () => {
		const launcher = new TestWorkerLauncher();
		const harness = await startHarness({ workerLauncher: launcher });
		const ref = await harness.createSession();
		await attach(await pair(harness), ref.sessionId);
		const relayId = harness.audit().find((event) => event.type === "relay_opened")?.details?.relayId;
		if (typeof relayId !== "string") throw new Error("No relay");

		// A second worker, which the test plays, for another conversation.
		let other: Promise<DaemonClient> | undefined;
		launcher.script((request) => {
			const scripted = scriptedWorker(request);
			other = scripted.client;
			return scripted.worker;
		});
		const otherRef = await harness.createSession();
		await harness.openWorker(otherRef);
		if (!other) throw new Error("The scripted worker did not launch");
		const client = await other;

		const refused = { type: "error", code: "not_found" };
		expect(
			await client.request({
				type: "worker_forward",
				relayId,
				frame: { type: "query", queryId: "q-1", query: "sessions" },
			}),
		).toMatchObject(refused);
		expect(await client.request({ type: "worker_authority", relayId })).toMatchObject(refused);
		expect(await client.request({ type: "worker_last_session", relayId, sessionId: ref.sessionId })).toMatchObject(
			refused,
		);
		expect(
			await client.request({
				type: "worker_notification_delivery",
				relayId,
				notification: {
					eventId: "e-1",
					hostNodeId: "a".repeat(64),
					kind: "conversation_completed",
					title: "Done",
					body: "The run finished.",
				},
			}),
		).toMatchObject(refused);
		// A conversation it does not host is not its to move from.
		expect(await client.request({ type: "worker_moved", from: ref.sessionId, to: ref.sessionId })).toMatchObject({
			type: "error",
			code: "not_hosted",
		});
		// A move from its own conversation leads only to a stored session of its workspace.
		expect(
			await client.request({
				type: "worker_moved",
				from: otherRef.sessionId,
				to: "01a00000-0000-7000-8000-000000000000",
			}),
		).toMatchObject({ type: "error", code: "invalid_session" });
		expect(await client.request({ type: "worker_moved", from: otherRef.sessionId, to: ref.sessionId })).toMatchObject(
			{
				type: "ok",
			},
		);
		// It restores and pins only a managed checkout of a session it hosts, and releases only its own pins.
		expect(
			await client.request({ type: "worker_worktree_restore", path: harness.workspacePath, sessionRef: ref }),
		).toMatchObject({ type: "error", code: "not_hosted" });
		expect(
			await client.request({ type: "worker_worktree_restore", path: harness.workspacePath, sessionRef: otherRef }),
		).toMatchObject({ type: "error", code: "worktree_restore_failed" });
		expect(await client.request({ type: "worker_worktree_release", pinId: "pin-1" })).toMatchObject(refused);
		// A control client restores through `worktree_restore`, never the worker request.
		expect(
			await harness.control.request({
				type: "worker_worktree_restore",
				path: harness.workspacePath,
				sessionRef: otherRef,
			}),
		).toMatchObject({ type: "error", code: "forbidden" });
	}, 60_000);

	it("opens an extension command's new session in the phone's worker and seeds it once the phone reconnects (D1)", async () => {
		const record = handoffRecord();
		record.seeds.length = 0;
		record.handoffs.length = 0;
		record.events.length = 0;
		const harness = await startHarness({ workerExtensions: [HANDOFF_EXTENSION_PATH] });
		const ref = await harness.createSession();
		const paired = await pair(harness);
		const { phone } = await attach(paired, ref.sessionId);
		const [source] = (await harness.status()).workers;

		phone.send({
			type: "extension.command.handoff-command.handoff",
			intentId: "i-handoff",
			expectedOrdinal: phone.position(),
			input: {},
		});
		await phone.ended;
		const moved = phone.frames.at(-1);
		if (moved?.type !== "ended" || moved.reason !== "moved" || moved.target === undefined) {
			throw new Error(`The phone was not redirected: ${JSON.stringify(moved)}`);
		}
		const targetId = moved.target;
		// The target opened in the source's worker; its seed waits for a client.
		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({ workerId: source?.workerId, sessionIds: [ref.sessionId, targetId] }),
		]);
		expect(record.seeds).toEqual([]);

		const back = await attach(paired, targetId);
		expect(back.stream.handshake).toMatchObject({ success: true, sessionId: targetId });
		await vi.waitFor(() =>
			expect(record.handoffs).toEqual([{ cancelled: false, sessionId: targetId, seeded: true }]),
		);
		expect(record.seeds).toEqual([targetId]);
		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({ workerId: source?.workerId, clients: { local: 0, remote: 1 } }),
		]);
	}, 60_000);
});

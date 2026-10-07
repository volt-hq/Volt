import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationLockedError } from "../src/core/conversation-log/conversation-lock.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import { createHelloProof, PROTOCOL_VERSION } from "../src/daemon/control-protocol.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import type { LaunchedWorker, WorkerLaunchRequest } from "../src/daemon/worker-launcher.ts";
import { WorkerOpenError } from "../src/daemon/worker-registry.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";
import { InProcessWorkerLauncher } from "./suite/in-process-worker-launcher.ts";

const harnesses: DaemonHarness[] = [];

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

async function startHarness(options: Parameters<typeof createDaemonHarness>[0] = {}): Promise<DaemonHarness> {
	const harness = await createDaemonHarness(options);
	harnesses.push(harness);
	return harness;
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Whether another process (here: this one, outside the worker) can take the session's lock. */
async function lockIsFree(ref: Parameters<typeof SessionManager.open>[0]): Promise<boolean> {
	try {
		const manager = await SessionManager.open(ref);
		await manager.closePersistence();
		return true;
	} catch (error) {
		if (error instanceof ConversationLockedError) return false;
		throw error;
	}
}

/** The in-process launcher, recording each launch request. */
class RecordingLauncher extends InProcessWorkerLauncher {
	readonly requests: WorkerLaunchRequest[] = [];
	override launch(request: WorkerLaunchRequest): LaunchedWorker {
		this.requests.push(request);
		return super.launch(request);
	}
}

describe("daemon conversation workers", () => {
	it("opens a stored conversation in a worker that holds its lock, and lists it", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const { worker, release } = await harness.openWorker(ref, { attach: "remote" });
		expect(worker.spec.session).toEqual(ref);
		expect(await lockIsFree(ref)).toBe(false);
		const status = await harness.status();
		expect(status.workers).toEqual([
			{
				workerId: worker.workerId,
				pid: process.pid,
				state: "live",
				origin: "phone",
				workspaceName: harness.workspaceName,
				sessionIds: [ref.sessionId],
				clients: { local: 0, remote: 1 },
			},
		]);
		release();
	}, 30_000);

	it("shares one spawn between concurrent opens of a conversation", async () => {
		const launcher = new RecordingLauncher();
		const harness = await startHarness({ workerLauncher: launcher });
		const ref = await harness.createSession();
		const [first, second] = await Promise.all([harness.openWorker(ref), harness.openWorker(ref)]);
		expect(first.worker.workerId).toBe(second.worker.workerId);
		expect(launcher.requests).toHaveLength(1);
	}, 30_000);

	it("retires a detached idle worker after the retention TTL, releasing its lock", async () => {
		const harness = await startHarness({ detachedRuntimeTtlMs: 200 });
		const ref = await harness.createSession();
		const { release } = await harness.openWorker(ref, { attach: "remote" });
		// Attached: the TTL does not run.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect((await harness.status()).workers).toHaveLength(1);
		release();
		await waitFor(async () => (await harness.status()).workers.length === 0);
		expect(await lockIsFree(ref)).toBe(true);
	}, 30_000);

	it("spawns a replacement once the previous worker exited", async () => {
		const launcher = new RecordingLauncher();
		const harness = await startHarness({ detachedRuntimeTtlMs: 100, workerLauncher: launcher });
		const ref = await harness.createSession();
		const { worker: first } = await harness.openWorker(ref);
		await waitFor(async () => (await harness.status()).workers.length === 0);
		const { worker: second, release } = await harness.openWorker(ref, { attach: "remote" });
		expect(second.workerId).not.toBe(first.workerId);
		expect(launcher.requests).toHaveLength(2);
		expect(await lockIsFree(ref)).toBe(false);
		release();
	}, 30_000);

	it("admits each worker once, with the token its spawn issued, and keeps roles apart", async () => {
		const launcher = new RecordingLauncher();
		const harness = await startHarness({ workerLauncher: launcher });
		const ref = await harness.createSession();
		const { release } = await harness.openWorker(ref, { attach: "remote" });
		const request = launcher.requests[0]!;
		const probe = await probeDaemon(harness.agentDir);
		for (const worker of [
			// The token was spent by the worker's own hello.
			{ workerId: request.workerId, workerToken: request.workerToken },
			{ workerId: "w-unknown", workerToken: request.workerToken },
		]) {
			const impostor = createDaemonClient({
				socketPath: probe.socketPath,
				version: "test",
				worker,
				reconnect: false,
			});
			await expect(impostor.connect()).rejects.toThrow(/auth_failed/);
			await impostor.close();
		}
		// A control client sends no worker request.
		expect(await harness.control.request({ type: "worker_activity", activeSessionIds: [] })).toMatchObject({
			type: "error",
			code: "forbidden",
		});
		release();
	}, 30_000);

	it("reads nothing after a refused hello on the same connection", async () => {
		const harness = await startHarness();
		const probe = await probeDaemon(harness.agentDir);
		const socket = createConnection(probe.socketPath);
		const received: string[] = [];
		const greeted = Promise.withResolvers<string>();
		socket.on("data", (chunk: Buffer) => {
			received.push(chunk.toString("utf8"));
			greeted.resolve(received.join(""));
		});
		const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
		// The daemon greets first; a control hello that proves the token on this connection would be admitted.
		const greeting = JSON.parse((await greeted.promise).split("\n")[0] ?? "") as { type: string; nonce: string };
		expect(greeting.type).toBe("hello_challenge");
		const binding = { challenge: greeting.nonce, socketPath: probe.socketPath };
		const line = (message: object) => `${JSON.stringify(message)}\n`;
		socket.write(
			line({
				type: "hello",
				role: "worker",
				protocolVersion: PROTOCOL_VERSION,
				workerId: "w-x",
				workerProof: createHelloProof("worker", "x", binding),
				pid: 1,
				version: "test",
			}) +
				line({
					type: "hello",
					role: "control",
					protocolVersion: PROTOCOL_VERSION,
					pid: 1,
					version: "test",
					client: "cli",
					...(probe.authToken === undefined
						? {}
						: { controlProof: createHelloProof("control", probe.authToken, binding) }),
				}) +
				line({ type: "status", id: "after-refusal" }),
		);
		await closed;
		const messages = received
			.join("")
			.trim()
			.split("\n")
			.map((text) => JSON.parse(text) as { type: string; error?: string });
		expect(messages).toEqual([
			expect.objectContaining({ type: "hello_challenge" }),
			expect.objectContaining({ type: "hello_ack", ok: false, error: "auth_failed" }),
		]);
	}, 30_000);

	it("fails the open when the worker cannot take the conversation's lock within its retry window", async () => {
		const harness = await startHarness({ workerLauncher: new InProcessWorkerLauncher({ lockRetryMs: 300 }) });
		const ref = await harness.createSession();
		const holder = await SessionManager.open(ref);
		try {
			await expect(harness.openWorker(ref)).rejects.toBeInstanceOf(WorkerOpenError);
			expect((await harness.status()).workers).toEqual([]);
		} finally {
			await holder.closePersistence();
		}
	}, 30_000);

	it("opens once the previous holder of the conversation's lock released it", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const holder = await SessionManager.open(ref);
		const opened = harness.openWorker(ref, { attach: "remote" });
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect((await harness.status()).workers).toEqual([expect.objectContaining({ state: "starting" })]);
		await holder.closePersistence();
		const { worker, release } = await opened;
		expect(worker.spec.session).toEqual(ref);
		expect(await lockIsFree(ref)).toBe(false);
		release();
	}, 30_000);

	it("retires a fenced workspace's workers before the fence settles", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const { release } = await harness.openWorker(ref, { attach: "remote" });
		expect(
			await harness.control.request({ type: "workspace_unregister", name: harness.workspaceName }),
		).toMatchObject({ type: "ok" });
		await harness.workers.fenceWorkspace(harness.workspaceName);
		expect((await harness.status()).workers).toEqual([]);
		expect(await lockIsFree(ref)).toBe(true);
		release();
	}, 30_000);

	it("stops its workers when the daemon shuts down", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		await harness.openWorker(ref, { attach: "remote" });
		expect(await harness.shutdown()).toBe(0);
		expect(await lockIsFree(ref)).toBe(true);
	}, 30_000);
});

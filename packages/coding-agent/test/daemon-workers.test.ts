import { afterEach, describe, expect, it } from "vitest";
import { ConversationLockedError } from "../src/core/conversation-log/conversation-lock.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import {
	InProcessWorkerLauncher,
	type LaunchedWorker,
	type WorkerLaunchRequest,
} from "../src/daemon/worker-launcher.ts";
import { WorkerOpenError } from "../src/daemon/worker-registry.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";

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
		expect(await harness.control.request({ type: "worker_activity", active: true })).toMatchObject({
			type: "error",
			code: "forbidden",
		});
		release();
	}, 30_000);

	it("fails the open when the worker cannot take the conversation's lock", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const holder = await SessionManager.open(ref);
		try {
			await expect(harness.openWorker(ref)).rejects.toBeInstanceOf(WorkerOpenError);
			expect((await harness.status()).workers).toEqual([]);
		} finally {
			await holder.closePersistence();
		}
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

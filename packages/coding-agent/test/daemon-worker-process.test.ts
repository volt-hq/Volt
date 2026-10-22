/**
 * Conversation workers as processes of their own (`ProcessWorkerLauncher`,
 * `volt daemon worker`), started from this checkout's source by a harness
 * daemon in this process: the worker holds its conversation's lock and its
 * share of the worker gate from another process, keeps its token out of its
 * argv, environment, and log, writes a private log, is replaced after it is
 * killed, finishes its turn and exits when it loses its daemon, and stops
 * with the daemon. A phone's conversation streams from the test's faux
 * provider across the processes, and so does a TUI's, in a worker that runs
 * with the TUI's environment less the daemon's credentials. What its
 * conversations' extensions started ends with it, however it ends; a process
 * that left its tree keeps running through the exits the daemon carries out or
 * confirms.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDaemonConversation } from "../src/client/daemon-conversation.ts";
import { ProtocolClient } from "../src/client/protocol-client.ts";
import { ConversationLockedError } from "../src/core/conversation-log/conversation-lock.ts";
import { SessionManager, type SessionReference } from "../src/core/session-manager.ts";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import { createIrohDaemonService } from "../src/daemon/iroh-service.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { holdWorkerGate, waitForWorkerGate } from "../src/daemon/worker-gate.ts";
import { type LaunchedWorker, ProcessWorkerLauncher, type WorkerLaunchRequest } from "../src/daemon/worker-launcher.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";
import { nativeIrohAvailable, pairPhone } from "./utilities/daemon-phone.ts";
import {
	expectEnded,
	killStarted,
	processIsAlive,
	type SleeperStart,
	spawnerExtension,
	waitForPid,
	writeSleeper,
} from "./utilities/process-tree.ts";

/** A worker process starts from source here: compiling it can take a while on a cold cache. */
const PROCESS_TEST_TIMEOUT_MS = 180_000;

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

/** The process launcher, recording each launch and the worker it launched. */
class RecordingProcessLauncher extends ProcessWorkerLauncher {
	readonly requests: WorkerLaunchRequest[] = [];
	readonly launched: LaunchedWorker[] = [];
	override launch(request: WorkerLaunchRequest): LaunchedWorker {
		this.requests.push(request);
		const launched = super.launch(request);
		this.launched.push(launched);
		return launched;
	}
}

async function startHarness(
	launcher: ProcessWorkerLauncher,
	options: Parameters<typeof createDaemonHarness>[0] = {},
): Promise<DaemonHarness> {
	const harness = await createDaemonHarness({ ...options, workerLauncher: launcher });
	cleanups.push(() => harness.dispose());
	return harness;
}

/**
 * A harness whose workers' conversations load extension `spawner`, which starts sleepers: `plain` with its child
 * `grandchild`, `detached` (spawned detached), and `orphan`, whose parent exits at once so that it has left the
 * worker's tree (on macOS and Linux it stays in the worker's process group). Resolves once a worker hosts a
 * conversation and every sleeper runs. Once they do, the factory runs `then(directory)` (statements), given the
 * directory the sleepers' pid files are in.
 */
async function startSpawningWorker(
	launcher: ProcessWorkerLauncher,
	then?: (directory: string) => string,
): Promise<{
	harness: DaemonHarness;
	release: () => void;
	directory: string;
	pids: { plain: number; grandchild: number; detached: number; orphan: number };
}> {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), "volt-worker-process-tree-")));
	const started: number[] = [];
	cleanups.push(async () => {
		killStarted(started);
		rmSync(directory, { recursive: true, force: true });
	});
	const sleeper = writeSleeper(directory);
	const pidFile = (name: string) => join(directory, `${name}.pid`);
	const starts: SleeperStart[] = [
		{ args: [pidFile("plain"), "child", pidFile("grandchild")] },
		{ args: [pidFile("detached")], detached: true },
		{ args: [pidFile("launcher"), "orphan", pidFile("orphan")] },
	];
	const names = ["plain", "grandchild", "detached", "orphan"] as const;
	const extension = join(directory, "spawner.ts");
	writeFileSync(extension, spawnerExtension(sleeper, starts, names.map(pidFile), then?.(directory)));
	const harness = await startHarness(launcher, { workerExtensions: [extension] });
	// A conversation's extensions load as its first client attaches.
	const { release } = await harness.openWorker(await harness.createSession(), { attach: "remote" });
	const [plain, grandchild, detached, orphan] = await Promise.all(
		names.map((name) => waitForPid(pidFile(name), started, PROCESS_TEST_TIMEOUT_MS - 30_000)),
	);
	const pids = { plain, grandchild, detached, orphan };
	for (const pid of Object.values(pids)) expect(processIsAlive(pid)).toBe(true);
	return { harness, release, directory, pids };
}

/** Whether this process can take the session's lock: nobody else has the log open. */
async function lockIsFree(ref: SessionReference): Promise<boolean> {
	try {
		const manager = await SessionManager.open(ref);
		await manager.closePersistence();
		return true;
	} catch (error) {
		if (error instanceof ConversationLockedError) {
			expect(error.holder).toBe("another_process");
			return false;
		}
		throw error;
	}
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

describe("conversation workers as processes", () => {
	it(
		"runs a worker in a process of its own with a private log, and keeps its token out of its argv, environment, and log",
		async () => {
			const launcher = new RecordingProcessLauncher();
			const harness = await startHarness(launcher);
			const ref = await harness.createSession();
			const { release } = await harness.openWorker(ref, { attach: "remote" });
			const [worker] = (await harness.status()).workers;
			const request = launcher.requests[0];
			if (!worker || !request) throw new Error("No worker");
			expect(worker).toMatchObject({ state: "live", origin: "phone", sessionIds: [ref.sessionId] });
			expect(worker.pid).not.toBe(process.pid);
			expect(processIsAlive(worker.pid)).toBe(true);

			// Another process holds the log, and a share of the worker gate.
			expect(await lockIsFree(ref)).toBe(false);
			expect(await waitForWorkerGate(harness.agentDir, { timeoutMs: 0 })).toMatchObject({ status: "timed_out" });

			const logPath = worker.logPath;
			if (logPath === undefined) throw new Error("No worker log");
			expect(existsSync(logPath)).toBe(true);
			if (process.platform !== "win32") {
				expect(statSync(logPath).mode & 0o777).toBe(0o600);
				expect(statSync(dirname(logPath)).mode & 0o777).toBe(0o700);
			}
			const log = readFileSync(logPath, "utf8");
			expect(log).toContain(`worker ${worker.workerId} pid ${worker.pid} started`);
			expect(log).not.toContain(request.workerToken);
			if (process.platform === "linux") {
				for (const file of ["cmdline", "environ"]) {
					expect(readFileSync(`/proc/${worker.pid}/${file}`, "utf8")).not.toContain(request.workerToken);
				}
			}
			release();

			// The daemon stops its workers when it shuts down.
			expect(await harness.shutdown()).toBe(0);
			expect(processIsAlive(worker.pid)).toBe(false);
			expect(await lockIsFree(ref)).toBe(true);
			expect(await waitForWorkerGate(harness.agentDir, { timeoutMs: 0 })).toMatchObject({ status: "open" });
			expect(readFileSync(logPath, "utf8")).toContain(`worker ${worker.workerId} exited: stopped`);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"replaces a killed worker with a new process",
		async () => {
			const harness = await startHarness(new ProcessWorkerLauncher());
			const ref = await harness.createSession();
			await harness.openWorker(ref);
			const [killed] = (await harness.status()).workers;
			if (!killed) throw new Error("No worker");
			process.kill(killed.pid, "SIGKILL");
			await vi.waitFor(async () => expect((await harness.status()).workers).toEqual([]), { timeout: 30_000 });
			// The exit's audit entry is appended asynchronously after the registry drops the worker.
			await vi.waitFor(
				() =>
					expect(harness.audit()).toContainEqual(
						expect.objectContaining({
							type: "worker_exited",
							success: false,
							details: expect.objectContaining({ workerId: killed.workerId, reason: "crashed" }),
						}),
					),
				{ timeout: 10_000 },
			);
			expect(await lockIsFree(ref)).toBe(true);

			const { release } = await harness.openWorker(ref, { attach: "remote" });
			const [replacement] = (await harness.status()).workers;
			expect(replacement?.workerId).not.toBe(killed.workerId);
			expect(replacement?.pid).not.toBe(killed.pid);
			expect(await lockIsFree(ref)).toBe(false);
			release();
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"exits when it loses its daemon, releasing its log and its share of the gate",
		async () => {
			const harness = await startHarness(new ProcessWorkerLauncher());
			const ref = await harness.createSession();
			await harness.openWorker(ref);
			const [worker] = (await harness.status()).workers;
			if (!worker) throw new Error("No worker");
			// The worker's control connection drops, as it does when its daemon dies.
			harness.services.controlServer
				.connections()
				.find((connection) => connection.workerId === worker.workerId)
				?.close();
			await vi.waitFor(() => expect(processIsAlive(worker.pid)).toBe(false), { timeout: 30_000 });
			await vi.waitFor(() =>
				expect(harness.audit()).toContainEqual(
					expect.objectContaining({
						type: "worker_exited",
						details: expect.objectContaining({ workerId: worker.workerId, reason: "daemon_lost" }),
					}),
				),
			);
			expect(await lockIsFree(ref)).toBe(true);
			expect(await waitForWorkerGate(harness.agentDir, { timeoutMs: 0 })).toMatchObject({ status: "open" });
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

describe("a worker's process tree", () => {
	it(
		"ends what its conversation's extensions started when it stops, and leaves running a process that left its tree",
		async () => {
			// Regression for #971: a plain spawn outlived its worker, reparented to init.
			const { harness, release, pids } = await startSpawningWorker(new ProcessWorkerLauncher());
			const [worker] = (await harness.status()).workers;
			if (!worker) throw new Error("No worker");
			release();

			expect(await harness.shutdown()).toBe(0);
			await expectEnded([pids.plain, pids.grandchild, pids.detached]);
			expect(processIsAlive(pids.orphan)).toBe(true);
			// The daemon ended the tree as the worker asked (`worker_exit`), during its own shutdown.
			expect(harness.audit()).toContainEqual(
				expect.objectContaining({
					type: "worker_exited",
					success: true,
					details: expect.objectContaining({ workerId: worker.workerId, reason: "stopped" }),
				}),
			);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"ends what its conversation's extensions started, then the worker, when the daemon kills it",
		async () => {
			const launcher = new RecordingProcessLauncher();
			const { harness, pids } = await startSpawningWorker(launcher);
			const [worker] = (await harness.status()).workers;
			const [launched] = launcher.launched;
			if (!worker || !launched) throw new Error("No worker");

			// What a forced stop that times out does.
			launched.kill();
			await launched.exited;
			expect(processIsAlive(worker.pid)).toBe(false);
			await expectEnded([pids.plain, pids.grandchild, pids.detached]);
			expect(processIsAlive(pids.orphan)).toBe(true);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"ends what its conversation's extensions started when it is killed from outside",
		async () => {
			const { harness, pids } = await startSpawningWorker(new ProcessWorkerLauncher());
			const [worker] = (await harness.status()).workers;
			if (!worker) throw new Error("No worker");

			process.kill(worker.pid, "SIGKILL");
			// What can still be found: on macOS and Linux the worker's process group, on Windows its tree. A plain
			// child and its own are in both.
			await expectEnded([pids.plain, pids.grandchild]);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"ends what its conversation's extensions started when an extension exits the worker, and reports a crash",
		async () => {
			const launcher = new RecordingProcessLauncher();
			// The extension exits the worker once the test writes `exit`, skipping the worker's own cleanup.
			const { directory, pids } = await startSpawningWorker(
				launcher,
				(dir) => `void (async () => {
		while (!existsSync(${JSON.stringify(join(dir, "exit"))})) await new Promise((resolve) => setTimeout(resolve, 20));
		process.exit(0);
	})();`,
			);
			const [launched] = launcher.launched;
			if (!launched) throw new Error("No worker");

			writeFileSync(join(directory, "exit"), "");
			// A bare exit 0 says nothing: the worker did not tell the daemon it exits (`worker_exit`).
			expect(await launched.exited).toEqual({ reason: "crashed", error: "exit code 0" });
			// What the daemon still finds: on macOS and Linux the worker's process group, on Windows its tree.
			await expectEnded([pids.plain, pids.grandchild]);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

describe("a TUI's conversation in a worker process", () => {
	it(
		"runs with the TUI's environment, less the daemon's credentials, and streams the TUI's turn across the processes",
		async () => {
			const harness = await startHarness(new ProcessWorkerLauncher());
			harness.faux.setResponses([fauxAssistantMessage("hello from the TUI's worker process")]);
			const tui = await harness.connect("tui");
			const env: Record<string, string> = {};
			for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
			const { opened, transport } = await openDaemonConversation(tui, {
				target: { kind: "new" },
				spawn: {
					env: {
						...env,
						VOLT_TEST_TUI_MARKER: "tui-marker-value",
						VOLT_IROH_RELAY_AUTH_TOKEN: "daemon-only-secret",
					},
					config: {},
					cwd: harness.workspacePath,
					persist: true,
					session: {},
				},
				clientKey: "tui-1",
			});
			const client = new ProtocolClient({ followMoves: "reconnect" });
			cleanups.push(() => client.stop());
			await client.connect(transport);
			await client.promptAndWait("hi", { timeoutMs: 30_000 });
			expect(JSON.stringify(client.state.entries)).toContain("hello from the TUI's worker process");

			const [worker] = (await harness.status()).workers;
			if (!worker?.logPath) throw new Error("No worker");
			expect(worker).toMatchObject({ origin: "tui", sessionIds: [opened.sessionId] });
			expect(worker.pid).not.toBe(process.pid);
			// The worker logs its environment's names, never a value.
			const log = readFileSync(worker.logPath, "utf8");
			expect(log).toContain("VOLT_TEST_TUI_MARKER");
			expect(log).not.toContain("tui-marker-value");
			expect(log).not.toContain("VOLT_IROH_RELAY_AUTH_TOKEN");
			expect(log).not.toContain("daemon-only-secret");
			if (process.platform === "linux") {
				const environ = readFileSync(`/proc/${worker.pid}/environ`, "utf8").split("\0");
				expect(environ).toContain("VOLT_TEST_TUI_MARKER=tui-marker-value");
				expect(environ.some((entry) => entry.startsWith("VOLT_IROH_RELAY_AUTH_TOKEN="))).toBe(false);
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

describe("the worker gate", () => {
	it("keeps a restarted daemon from serving until the workers of the previous daemon exited", async () => {
		const harness = await createDaemonHarness();
		const agentDir = harness.agentDir;
		await harness.shutdown();
		cleanups.push(() => harness.dispose());
		// A worker of the daemon that just stopped still runs.
		const orphan = holdWorkerGate(agentDir);
		if (!orphan) throw new Error("The gate is held");
		const daemon = runVoltDaemon({ agentDir, foreground: false });
		cleanups.push(async () => {
			orphan.close();
			const probe = await probeDaemon(agentDir);
			if (probe.healthy) {
				const client = createDaemonClient({
					socketPath: probe.socketPath,
					client: "cli",
					version: "test",
					...(probe.authToken === undefined ? {} : { authToken: probe.authToken }),
					reconnect: false,
				});
				await client.request({ type: "shutdown" }).catch(() => undefined);
				await client.close();
			}
			await daemon;
		});
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect((await probeDaemon(agentDir)).healthy).toBe(false);
		orphan.close();
		await vi.waitFor(async () => expect((await probeDaemon(agentDir)).healthy).toBe(true), { timeout: 10_000 });
	}, 30_000);
});

describe.runIf(nativeIrohAvailable)("a phone's conversation in a worker process", () => {
	it(
		"streams from the test's faux provider across the processes, and resumes in a new worker after the worker is killed",
		async () => {
			const harness = await startHarness(new ProcessWorkerLauncher(), {
				extensions: [createIrohDaemonService({ relayMode: "disabled" })],
			});
			const ref = await harness.createSession();
			harness.faux.setResponses([
				fauxAssistantMessage("hello from the worker process"),
				fauxAssistantMessage("hello from its replacement"),
			]);
			const paired = await pairPhone(harness);
			cleanups.push(() => paired.close());
			const first = await paired.openConversation({ target: "session", sessionId: ref.sessionId });
			expect(first.handshake).toMatchObject({ success: true, sessionId: ref.sessionId });
			const phone = first.phone!;
			await phone.hello();
			await phone.subscribe(ref.sessionId);
			expect(await phone.intent("prompt", { message: "hi" })).toMatchObject({ type: "accepted" });
			await expect
				.poll(() => assistantText(phone.frames), { timeout: 30_000 })
				.toContain("hello from the worker process");
			const [worker] = (await harness.status()).workers;
			if (!worker) throw new Error("No worker");
			expect(worker.pid).not.toBe(process.pid);

			process.kill(worker.pid, "SIGKILL");
			await phone.ended;
			await vi.waitFor(async () => expect((await harness.status()).workers).toEqual([]), { timeout: 30_000 });

			const second = await paired.openConversation({ target: "session", sessionId: ref.sessionId });
			expect(second.handshake).toMatchObject({ success: true, sessionId: ref.sessionId });
			const resumed = second.phone!;
			await resumed.hello();
			await resumed.subscribe(ref.sessionId);
			// The replacement serves the log the killed worker wrote: its snapshot has the first reply.
			expect(JSON.stringify(resumed.frames.filter((frame) => frame.type === "snapshot"))).toContain(
				"hello from the worker process",
			);
			expect(await resumed.intent("prompt", { message: "again" })).toMatchObject({ type: "accepted" });
			await expect
				.poll(() => assistantText(resumed.frames), { timeout: 30_000 })
				.toContain("hello from its replacement");
			const [replacement] = (await harness.status()).workers;
			expect(replacement?.pid).not.toBe(worker.pid);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"finishes a running turn and exits when it loses its daemon",
		async () => {
			const harness = await startHarness(new ProcessWorkerLauncher(), {
				extensions: [createIrohDaemonService({ relayMode: "disabled" })],
			});
			const ref = await harness.createSession();
			const started = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			harness.faux.setResponses([
				async () => {
					started.resolve();
					await finish.promise;
					return fauxAssistantMessage("finished after the daemon left");
				},
			]);
			const paired = await pairPhone(harness);
			cleanups.push(() => paired.close());
			const opened = await paired.openConversation({ target: "session", sessionId: ref.sessionId });
			const phone = opened.phone!;
			await phone.hello();
			await phone.subscribe(ref.sessionId);
			expect(await phone.intent("prompt", { message: "run" })).toMatchObject({ type: "accepted" });
			await started.promise;
			const [worker] = (await harness.status()).workers;
			if (!worker) throw new Error("No worker");

			harness.services.controlServer
				.connections()
				.find((connection) => connection.workerId === worker.workerId)
				?.close();
			// It takes no new input, but the turn it is running finishes.
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(processIsAlive(worker.pid)).toBe(true);
			finish.resolve();
			await vi.waitFor(() => expect(processIsAlive(worker.pid)).toBe(false), { timeout: 30_000 });

			const manager = await SessionManager.open(ref);
			try {
				expect(JSON.stringify(manager.getEntries())).toContain("finished after the daemon left");
			} finally {
				await manager.closePersistence();
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

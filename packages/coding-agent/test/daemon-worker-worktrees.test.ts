/**
 * A worker's extensions reach the managed worktrees of the workspace the
 * worker serves (`worker_worktree_create`, `worker_worktree_list`): the
 * daemon creates and lists them for that workspace only, and only for a
 * worker; a control client uses `worktree_create`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonClient, type DaemonClient } from "../src/daemon/control-client.ts";
import type { WorkerSpawnSpec } from "../src/daemon/control-protocol.ts";
import { createIrohDaemonService } from "../src/daemon/iroh-service.ts";
import type { LaunchedWorker, WorkerExit, WorkerLauncher, WorkerLaunchRequest } from "../src/daemon/worker-launcher.ts";
import { getWorktreesRoot } from "../src/daemon/worktree-manager.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Workers the test plays over the control socket: each connects with its launch's token and reports its conversation open. */
class ScriptedWorkerLauncher implements WorkerLauncher {
	readonly clients: Array<Promise<DaemonClient>> = [];

	launch(request: WorkerLaunchRequest): LaunchedWorker {
		const exited = Promise.withResolvers<WorkerExit>();
		const spec = Promise.withResolvers<WorkerSpawnSpec>();
		const client = createDaemonClient({
			socketPath: request.socketPath,
			version: "test",
			worker: { workerId: request.workerId, workerToken: request.workerToken },
			reconnect: false,
			onEvent: (event) => {
				if (event.type === "worker_open") spec.resolve(event.spec);
				if (event.type === "worker_stop") {
					void client
						.request({ type: "worker_stop_result", stopId: event.stopId, outcome: "stopped" })
						.catch(() => undefined)
						.then(() => client.close())
						.then(() => exited.resolve({ reason: "stopped" }));
				}
			},
		});
		this.clients.push(
			(async () => {
				await client.connect();
				const opened = await spec.promise;
				await client.request({ type: "worker_ready", sessionId: opened.session.sessionId });
				return client;
			})(),
		);
		return { pid: process.pid, exited: exited.promise, kill: () => exited.resolve({ reason: "crashed" }) };
	}
}

/** A daemon whose workspace is a Git checkout on `main`, and a worker the test plays serving a conversation of it. */
async function fixture(): Promise<{ harness: DaemonHarness; worker: DaemonClient }> {
	const launcher = new ScriptedWorkerLauncher();
	const harness = await createDaemonHarness({
		workerLauncher: launcher,
		extensions: [createIrohDaemonService({ relayMode: "disabled" })],
	});
	cleanups.push(() => harness.dispose());
	writeFileSync(join(harness.workspacePath, "README.md"), "workspace\n");
	git(harness.workspacePath, "init", "--initial-branch=main");
	git(harness.workspacePath, "add", ".");
	git(
		harness.workspacePath,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.test",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"base",
	);
	const ref = await harness.createSession();
	await harness.openWorker(ref);
	const [worker] = launcher.clients;
	if (!worker) throw new Error("The scripted worker did not launch");
	return { harness, worker: await worker };
}

describe("a worker's managed worktrees", () => {
	it("creates and lists the worktrees of the workspace the worker serves", async () => {
		const { harness, worker } = await fixture();

		const created = await worker.request({
			type: "worker_worktree_create",
			worktreeName: "issue-12",
			baseRef: "main",
		});
		expect(created).toMatchObject({
			type: "worktree_result",
			worktree: {
				id: "issue-12",
				workspaceName: harness.workspaceName,
				branch: "volt/issue-12",
				baseRef: "main",
				available: true,
			},
		});
		if (created.type !== "worktree_result") throw new Error("unreachable");
		expect(created.worktree.path.startsWith(getWorktreesRoot(harness.agentDir))).toBe(true);
		expect(git(created.worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("volt/issue-12");

		expect(await worker.request({ type: "worker_worktree_list" })).toMatchObject({
			type: "worktrees_result",
			worktrees: [{ id: "issue-12", path: created.worktree.path, branch: "volt/issue-12", available: true }],
		});
		// The daemon's own refusals reach the worker: an id in use is not created twice.
		expect(
			await worker.request({ type: "worker_worktree_create", worktreeName: "issue-12", baseRef: "main" }),
		).toMatchObject({ type: "error" });
	}, 60_000);

	it("removes a worktree, keeping its branch, and creates it again on that branch", async () => {
		const { harness, worker } = await fixture();
		const created = await worker.request({
			type: "worker_worktree_create",
			worktreeName: "issue-12",
			baseRef: "main",
		});
		if (created.type !== "worktree_result") throw new Error(`not created: ${JSON.stringify(created)}`);
		const path = created.worktree.path;
		writeFileSync(join(path, "fix.txt"), "fixed\n");
		git(path, "add", "fix.txt");
		git(
			path,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"fix",
		);
		const head = git(path, "rev-parse", "HEAD");

		// A dirty checkout stays.
		writeFileSync(join(path, "scratch.txt"), "wip\n");
		expect(await worker.request({ type: "worker_worktree_remove", worktreeId: "issue-12" })).toMatchObject({
			type: "error",
			code: "worktree_dirty",
		});
		rmSync(join(path, "scratch.txt"));
		expect(await worker.request({ type: "worker_worktree_remove", worktreeId: "issue-12" })).toMatchObject({
			type: "ok",
		});
		expect(existsSync(path)).toBe(false);
		expect(await worker.request({ type: "worker_worktree_list" })).toMatchObject({ worktrees: [] });
		expect(git(harness.workspacePath, "rev-parse", "volt/issue-12")).toBe(head);

		// Created again: without reuseBranch the branch is in the way; with it, its commits come back.
		expect(
			await worker.request({ type: "worker_worktree_create", worktreeName: "issue-12", baseRef: "main" }),
		).toMatchObject({ type: "error", code: "worktree_branch_conflict" });
		const again = await worker.request({
			type: "worker_worktree_create",
			worktreeName: "issue-12",
			baseRef: "main",
			reuseBranch: true,
		});
		expect(again).toMatchObject({ type: "worktree_result", worktree: { id: "issue-12", branch: "volt/issue-12" } });
		if (again.type !== "worktree_result") throw new Error("unreachable");
		expect(git(again.worktree.path, "rev-parse", "HEAD")).toBe(head);
		// reuseBranch for a branch that does not exist creates it from the base.
		const fresh = await worker.request({
			type: "worker_worktree_create",
			worktreeName: "issue-13",
			baseRef: "main",
			reuseBranch: true,
		});
		if (fresh.type !== "worktree_result") throw new Error(`not created: ${JSON.stringify(fresh)}`);
		expect(git(fresh.worktree.path, "rev-parse", "HEAD")).toBe(git(harness.workspacePath, "rev-parse", "main"));
	}, 60_000);

	it("serves the requests only to a worker", async () => {
		const { harness } = await fixture();
		const tui = await harness.connect("tui");

		expect(await tui.request({ type: "worker_worktree_create", worktreeName: "issue-12" })).toMatchObject({
			type: "error",
			code: "forbidden",
		});
		expect(await harness.control.request({ type: "worker_worktree_list" })).toMatchObject({
			type: "error",
			code: "forbidden",
		});
		expect(await tui.request({ type: "worker_worktree_remove", worktreeId: "issue-12" })).toMatchObject({
			type: "error",
			code: "forbidden",
		});
	}, 60_000);
});

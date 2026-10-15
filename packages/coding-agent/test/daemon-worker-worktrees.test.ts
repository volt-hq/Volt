/**
 * A worker's extensions reach the managed worktrees of the workspace the
 * worker serves (`worker_worktree_create`, `worker_worktree_list`,
 * `worker_worktree_remove`): the daemon creates, lists, and removes them for
 * that workspace only, and of the repository the worker's conversation in
 * `cwd` works in only, and only for a worker; a control client uses
 * `worktree_create`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** Make `directory` a Git repository on `main` with one commit. */
function commitRepository(directory: string): void {
	writeFileSync(join(directory, "README.md"), "repository\n");
	git(directory, "init", "--initial-branch=main");
	git(directory, "add", ".");
	git(
		directory,
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
}

/** The canonical Git common directory of the checkout `path`: which repository it is a checkout of. */
function commonGitDir(path: string): string {
	return realpathSync.native(git(path, "rev-parse", "--path-format=absolute", "--git-common-dir"));
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
	commitRepository(harness.workspacePath);
	const ref = await harness.createSession();
	await harness.openWorker(ref);
	const [worker] = launcher.clients;
	if (!worker) throw new Error("The scripted worker did not launch");
	return { harness, worker: await worker };
}

describe("a worker's managed worktrees", () => {
	it("creates and lists the worktrees of the workspace the worker serves", async () => {
		const { harness, worker } = await fixture();
		const cwd = harness.workspacePath;

		const created = await worker.request({
			type: "worker_worktree_create",
			cwd,
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

		expect(await worker.request({ type: "worker_worktree_list", cwd })).toMatchObject({
			type: "worktrees_result",
			worktrees: [{ id: "issue-12", path: created.worktree.path, branch: "volt/issue-12", available: true }],
		});
		// The daemon's own refusals reach the worker: an id in use is not created twice.
		expect(
			await worker.request({ type: "worker_worktree_create", cwd, worktreeName: "issue-12", baseRef: "main" }),
		).toMatchObject({ type: "error" });
	}, 60_000);

	it("removes a worktree, keeping its branch, and creates it again on that branch", async () => {
		const { harness, worker } = await fixture();
		const cwd = harness.workspacePath;
		const created = await worker.request({
			type: "worker_worktree_create",
			cwd,
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
		expect(await worker.request({ type: "worker_worktree_remove", cwd, worktreeId: "issue-12" })).toMatchObject({
			type: "error",
			code: "worktree_dirty",
		});
		rmSync(join(path, "scratch.txt"));
		expect(await worker.request({ type: "worker_worktree_remove", cwd, worktreeId: "issue-12" })).toMatchObject({
			type: "ok",
		});
		expect(existsSync(path)).toBe(false);
		expect(await worker.request({ type: "worker_worktree_list", cwd })).toMatchObject({ worktrees: [] });
		expect(git(harness.workspacePath, "rev-parse", "volt/issue-12")).toBe(head);

		// Created again: without reuseBranch the branch is in the way; with it, its commits come back.
		expect(
			await worker.request({ type: "worker_worktree_create", cwd, worktreeName: "issue-12", baseRef: "main" }),
		).toMatchObject({ type: "error", code: "worktree_branch_conflict" });
		const again = await worker.request({
			type: "worker_worktree_create",
			cwd,
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
			cwd,
			worktreeName: "issue-13",
			baseRef: "main",
			reuseBranch: true,
		});
		if (fresh.type !== "worktree_result") throw new Error(`not created: ${JSON.stringify(fresh)}`);
		expect(git(fresh.worktree.path, "rev-parse", "HEAD")).toBe(git(harness.workspacePath, "rev-parse", "main"));
	}, 60_000);

	it("creates, lists, and removes only the worktrees of the repository the conversation works in", async () => {
		const { harness, worker } = await fixture();
		const workspace = harness.workspacePath;
		// A repository of its own inside the workspace's.
		const nested = join(workspace, "vendor", "project");
		mkdirSync(nested, { recursive: true });
		commitRepository(nested);

		const outer = await worker.request({ type: "worker_worktree_create", cwd: workspace, worktreeName: "outer-1" });
		const inner = await worker.request({ type: "worker_worktree_create", cwd: nested, worktreeName: "nested-1" });
		if (outer.type !== "worktree_result" || inner.type !== "worktree_result") {
			throw new Error(`not created: ${JSON.stringify([outer, inner])}`);
		}
		expect(commonGitDir(outer.worktree.path)).toBe(commonGitDir(workspace));
		expect(commonGitDir(inner.worktree.path)).toBe(commonGitDir(nested));

		const listed = async (cwd: string) => {
			const response = await worker.request({ type: "worker_worktree_list", cwd });
			if (response.type !== "worktrees_result") throw new Error(`not listed: ${JSON.stringify(response)}`);
			return response.worktrees.map((worktree) => worktree.id);
		};
		expect(await listed(workspace)).toEqual(["outer-1"]);
		expect(await listed(nested)).toEqual(["nested-1"]);
		// A conversation in a subdirectory works in the repository holding it.
		mkdirSync(join(workspace, "packages", "app"), { recursive: true });
		expect(await listed(join(workspace, "packages", "app"))).toEqual(["outer-1"]);
		// A conversation in a managed worktree works in the repository the worktree was created from.
		expect(await listed(inner.worktree.path)).toEqual(["nested-1"]);
		const sibling = await worker.request({
			type: "worker_worktree_create",
			cwd: inner.worktree.path,
			worktreeName: "nested-2",
		});
		if (sibling.type !== "worktree_result") throw new Error(`not created: ${JSON.stringify(sibling)}`);
		expect(commonGitDir(sibling.worktree.path)).toBe(commonGitDir(nested));

		// Another repository's worktree is not found, and stays.
		expect(
			await worker.request({ type: "worker_worktree_remove", cwd: nested, worktreeId: "outer-1" }),
		).toMatchObject({ type: "error", code: "worktree_not_found" });
		expect(existsSync(outer.worktree.path)).toBe(true);
		expect(
			await worker.request({ type: "worker_worktree_remove", cwd: nested, worktreeId: "nested-1" }),
		).toMatchObject({ type: "ok" });
		expect(await listed(nested)).toEqual(["nested-2"]);

		// A directory outside the workspace has no repository of it.
		expect(await worker.request({ type: "worker_worktree_list", cwd: realpathSync.native(tmpdir()) })).toMatchObject({
			type: "error",
			code: "invalid_working_directory",
		});
	}, 60_000);

	it.each(["workspace", "outside"] as const)(
		"shares repository scope across linked checkouts (primary location: %s)",
		async (primaryLocation) => {
			const { harness, worker } = await fixture();
			const workspace = harness.workspacePath;
			const primary = primaryLocation === "workspace" ? workspace : join(dirname(workspace), "external");
			if (primaryLocation === "outside") {
				mkdirSync(primary);
				commitRepository(primary);
			}
			const first = join(workspace, ".worktrees", "first");
			const second = join(workspace, ".worktrees", "second");
			git(primary, "worktree", "add", first, "-b", "first");
			git(primary, "worktree", "add", second, "-b", "second");
			const primaryHead = git(primary, "rev-parse", "HEAD");
			git(
				first,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.test",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"-m",
				"linked checkout commit",
			);
			const firstHead = git(first, "rev-parse", "HEAD");
			expect(firstHead).not.toBe(primaryHead);
			const subdirectory = join(first, "src");
			mkdirSync(subdirectory);

			const fromFirst = await worker.request({
				type: "worker_worktree_create",
				cwd: subdirectory,
				worktreeName: "from-first",
			});
			const otherCwd = primaryLocation === "workspace" ? primary : second;
			const fromSecond = await worker.request({
				type: "worker_worktree_create",
				cwd: otherCwd,
				worktreeName: "from-second",
			});
			if (fromFirst.type !== "worktree_result" || fromSecond.type !== "worktree_result") {
				throw new Error(`not created: ${JSON.stringify([fromFirst, fromSecond])}`);
			}
			// Repository identity must not change which checkout supplies the default HEAD.
			expect(fromFirst.worktree.baseRef).toBe("first");
			expect(git(fromFirst.worktree.path, "rev-parse", "HEAD")).toBe(firstHead);
			expect(git(fromSecond.worktree.path, "rev-parse", "HEAD")).toBe(primaryHead);
			expect(git(primary, "rev-parse", "HEAD")).toBe(primaryHead);

			const fromManaged = await worker.request({
				type: "worker_worktree_create",
				cwd: fromFirst.worktree.path,
				worktreeName: "from-managed",
			});
			if (fromManaged.type !== "worktree_result") throw new Error(`not created: ${JSON.stringify(fromManaged)}`);
			expect(commonGitDir(fromManaged.worktree.path)).toBe(commonGitDir(primary));
			expect(git(fromManaged.worktree.path, "rev-parse", "HEAD")).toBe(firstHead);

			for (const cwd of [
				first,
				subdirectory,
				second,
				otherCwd,
				fromFirst.worktree.path,
				fromManaged.worktree.path,
			]) {
				const listed = await worker.request({ type: "worker_worktree_list", cwd });
				if (listed.type !== "worktrees_result") throw new Error(`not listed: ${JSON.stringify(listed)}`);
				expect(listed.worktrees.map((worktree) => worktree.id)).toEqual([
					"from-first",
					"from-second",
					"from-managed",
				]);
			}
			if (primaryLocation === "outside") {
				// Sharing Git metadata does not authorize a conversation outside the workspace.
				expect(await worker.request({ type: "worker_worktree_list", cwd: primary })).toMatchObject({
					type: "error",
					code: "invalid_working_directory",
				});
				expect(await worker.request({ type: "worker_worktree_list", cwd: workspace })).toMatchObject({
					type: "worktrees_result",
					worktrees: [],
				});
			}

			expect(
				await worker.request({ type: "worker_worktree_remove", cwd: otherCwd, worktreeId: "from-first" }),
			).toMatchObject({ type: "ok" });
			expect(
				await worker.request({
					type: "worker_worktree_remove",
					cwd: fromManaged.worktree.path,
					worktreeId: "from-second",
				}),
			).toMatchObject({ type: "ok" });
			expect(await worker.request({ type: "worker_worktree_list", cwd: first })).toMatchObject({
				type: "worktrees_result",
				worktrees: [{ id: "from-managed" }],
			});
			expect(existsSync(fromFirst.worktree.path)).toBe(false);
			expect(existsSync(fromSecond.worktree.path)).toBe(false);
		},
		60_000,
	);

	it("does not attribute a worktree to an enclosing repository when its source is no longer a checkout", async () => {
		const { harness, worker } = await fixture();
		const workspace = harness.workspacePath;
		const nested = join(workspace, "nested");
		mkdirSync(nested);
		commitRepository(nested);
		const created = await worker.request({ type: "worker_worktree_create", cwd: nested, worktreeName: "nested-1" });
		if (created.type !== "worktree_result") throw new Error(`not created: ${JSON.stringify(created)}`);
		renameSync(join(nested, ".git"), join(nested, "saved-git"));

		expect(await worker.request({ type: "worker_worktree_list", cwd: workspace })).toMatchObject({
			type: "worktrees_result",
			worktrees: [],
		});
		expect(
			await worker.request({ type: "worker_worktree_remove", cwd: workspace, worktreeId: "nested-1" }),
		).toMatchObject({ type: "error", code: "worktree_not_found" });
		expect(existsSync(created.worktree.path)).toBe(true);
	}, 60_000);

	it.each(["repository", "submodule"] as const)(
		"rejects a nested %s inside a managed checkout instead of managing its enclosing repository",
		async (kind) => {
			const { harness, worker } = await fixture();
			const cwd = harness.workspacePath;
			const outer = await worker.request({ type: "worker_worktree_create", cwd, worktreeName: "outer-1" });
			if (outer.type !== "worktree_result") throw new Error(`not created: ${JSON.stringify(outer)}`);

			const subdirectory = join(outer.worktree.path, "packages", "app");
			mkdirSync(subdirectory, { recursive: true });
			expect(await worker.request({ type: "worker_worktree_list", cwd: subdirectory })).toMatchObject({
				type: "worktrees_result",
				worktrees: [{ id: "outer-1" }],
			});

			const nested = join(outer.worktree.path, "vendor", "project");
			if (kind === "submodule") {
				const source = join(cwd, "project-source");
				mkdirSync(source);
				commitRepository(source);
				git(outer.worktree.path, "-c", "protocol.file.allow=always", "submodule", "add", source, "vendor/project");
			} else {
				mkdirSync(nested, { recursive: true });
				commitRepository(nested);
			}
			const nestedSubdirectory = join(nested, "src");
			mkdirSync(nestedSubdirectory);
			const head = git(cwd, "rev-parse", "HEAD");
			const nestedHead = git(nested, "rev-parse", "HEAD");

			for (const conversationCwd of [nested, nestedSubdirectory]) {
				expect(await worker.request({ type: "worker_worktree_list", cwd: conversationCwd })).toMatchObject({
					type: "error",
					code: "nested_git_repository_unsupported",
				});
				expect(
					await worker.request({
						type: "worker_worktree_create",
						cwd: conversationCwd,
						worktreeName: "nested-request",
					}),
				).toMatchObject({ type: "error", code: "nested_git_repository_unsupported" });
				expect(
					await worker.request({
						type: "worker_worktree_remove",
						cwd: conversationCwd,
						worktreeId: "outer-1",
					}),
				).toMatchObject({ type: "error", code: "nested_git_repository_unsupported" });
			}

			expect(await worker.request({ type: "worker_worktree_list", cwd })).toMatchObject({
				type: "worktrees_result",
				worktrees: [{ id: "outer-1" }],
			});
			expect(existsSync(outer.worktree.path)).toBe(true);
			expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
			expect(git(nested, "rev-parse", "HEAD")).toBe(nestedHead);
			expect(git(cwd, "branch", "--list", "volt/nested-request")).toBe("");
		},
		60_000,
	);

	it("serves the requests only to a worker", async () => {
		const { harness } = await fixture();
		const tui = await harness.connect("tui");
		const cwd = harness.workspacePath;

		expect(await tui.request({ type: "worker_worktree_create", cwd, worktreeName: "issue-12" })).toMatchObject({
			type: "error",
			code: "forbidden",
		});
		expect(await harness.control.request({ type: "worker_worktree_list", cwd })).toMatchObject({
			type: "error",
			code: "forbidden",
		});
		expect(await tui.request({ type: "worker_worktree_remove", cwd, worktreeId: "issue-12" })).toMatchObject({
			type: "error",
			code: "forbidden",
		});
	}, 60_000);
});

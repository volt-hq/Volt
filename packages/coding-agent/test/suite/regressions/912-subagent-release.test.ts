/** PR #912: a detached subagent's `ended` joins daemon hosting release, not just local closure. */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import { SubagentManager } from "../../../src/core/subagents/index.ts";
import { createIrohDaemonService } from "../../../src/daemon/iroh-service.ts";
import { WorkerDaemonClient } from "../../../src/daemon/worker/daemon-client.ts";
import { WorkerConversations } from "../../../src/daemon/worker/hosted.ts";
import { createDaemonHarness } from "../daemon-harness.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	vi.useRealTimers();
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});

/** Actual in-process worker, child registration, control socket, and registry-aware worktree manager. */
async function fixture() {
	const parent = Promise.withResolvers<HostedConversation>();
	const workerClient = Promise.withResolvers<WorkerDaemonClient>();
	const adopt = WorkerConversations.prototype.adoptTop;
	vi.spyOn(WorkerConversations.prototype, "adoptTop").mockImplementation(function (
		this: WorkerConversations,
		spec,
		opened,
	) {
		adopt.call(this, spec, opened);
		parent.resolve(opened.conversation);
	});
	const ready = WorkerDaemonClient.prototype.ready;
	vi.spyOn(WorkerDaemonClient.prototype, "ready").mockImplementation(function (this: WorkerDaemonClient, id) {
		workerClient.resolve(this);
		return ready.call(this, id);
	});
	const harness = await createDaemonHarness({
		extensions: [createIrohDaemonService({ relayMode: "disabled" }, { loadIrohModule: () => ({}) })],
	});
	cleanups.push(() => harness.dispose());
	writeFileSync(join(harness.workspacePath, "README.md"), "workspace\n");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: harness.workspacePath, stdio: ["ignore", "pipe", "pipe"] });
	git("init", "--initial-branch=main");
	git("add", "README.md");
	git(
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
	mkdirSync(join(harness.agentDir, "agents"));
	writeFileSync(
		join(harness.agentDir, "agents", "worker.md"),
		"---\nname: worker\ndescription: Works an issue\n---\nWork the issue.\n",
	);
	const ref = await harness.createSession();
	const opened = await harness.openWorker(ref, { attach: "remote" });
	cleanups.push(async () => opened.release());
	const conversation = await parent.promise;
	const manager = conversation.session.getSubagentToolManager();
	if (!(manager instanceof SubagentManager)) throw new Error("Worker has no subagent manager");
	const client = await workerClient.promise;
	const worktree = await client.createWorktree({ name: "issue-12", baseRef: "main" });
	return { harness, client, manager, worktree };
}

describe("PR #912 subagent hosting release", () => {
	it.each(["acknowledged", "timed out"] as const)(
		"waits for release until it is %s, within one cleanup budget",
		async (mode) => {
			const { harness, client, manager, worktree } = await fixture();
			const finishReply = Promise.withResolvers<void>();
			const closeEntered = Promise.withResolvers<void>();
			const allowClose = Promise.withResolvers<void>();
			const observationEntered = Promise.withResolvers<void>();
			const allowObservation = Promise.withResolvers<void>();
			const releaseEntered = Promise.withResolvers<void>();
			const allowRelease = Promise.withResolvers<void>();
			const releaseAcknowledged = Promise.withResolvers<void>();
			harness.faux.setResponses([
				async () => {
					await finishReply.promise;
					return fauxAssistantMessage("issue worked");
				},
			]);
			const run = await manager.startRun("worker", "Work issue 12", { cwd: worktree.path });
			const child = manager.childConversation(run.conversation);
			if (!child) throw new Error("Child conversation was not created");
			expect(
				await harness.control.request({
					type: "worktree_bind",
					workspaceName: harness.workspaceName,
					worktreeId: worktree.id,
					sessionId: run.conversation,
				}),
			).toMatchObject({ type: "ok" });
			const observe = WorkerDaemonClient.prototype.changeObserve;
			vi.spyOn(WorkerDaemonClient.prototype, "changeObserve").mockImplementation(async function (
				this: WorkerDaemonClient,
				...args
			) {
				if (args[1] === run.conversation && args[2] === null && child.closed) {
					observationEntered.resolve();
					await allowObservation.promise;
				}
				return observe.apply(this, args);
			});
			const release = WorkerDaemonClient.prototype.released;
			vi.spyOn(WorkerDaemonClient.prototype, "released").mockImplementation(async function (
				this: WorkerDaemonClient,
				id,
			) {
				if (id === run.conversation) {
					releaseEntered.resolve();
					await allowRelease.promise;
				}
				const response = await release.call(this, id);
				if (id === run.conversation) releaseAcknowledged.resolve();
				return response;
			});
			let ended = false;
			void run.ended.then(() => {
				ended = true;
			});
			try {
				if (mode === "timed out") {
					const close = child.close.bind(child);
					vi.spyOn(child, "close").mockImplementation(async (...args) => {
						closeEntered.resolve();
						await allowClose.promise;
						return close(...args);
					});
					// Keep real socket/I/O scheduling; fake only the cleanup deadline after admission.
					vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
				}
				finishReply.resolve();
				if (mode === "timed out") {
					await closeEntered.promise;
					await nextTurn();
					await vi.advanceTimersByTimeAsync(6000);
					expect(ended).toBe(false);
					expect(child.closed).toBe(false);
					allowClose.resolve();
				}
				await observationEntered.promise;
				await nextTurn();
				expect(child.closed).toBe(true);
				expect(ended).toBe(false);
				expect(harness.workers.hosts(harness.workspaceName, run.conversation)).toBe(true);
				allowObservation.resolve();
				await releaseEntered.promise;
				await nextTurn();
				expect(ended).toBe(false);
				expect(harness.workers.hosts(harness.workspaceName, run.conversation)).toBe(true);
				await expect(client.removeWorktree(worktree.id)).rejects.toMatchObject({ code: "worktree_busy" });
				if (mode === "timed out") {
					await vi.advanceTimersByTimeAsync(3999);
					expect(ended).toBe(false);
					await vi.advanceTimersByTimeAsync(1);
					expect((await run.ended).status).toBe("completed");
					// Timeout does not pretend the claim was released; its cleanup continues.
					expect(harness.workers.hosts(harness.workspaceName, run.conversation)).toBe(true);
					vi.useRealTimers();
				}
				allowRelease.resolve();
				expect((await run.ended).status).toBe("completed");
				await releaseAcknowledged.promise;
				expect(harness.workers.hosts(harness.workspaceName, run.conversation)).toBe(false);
				// No retry or polling between ended and cleanup.
				await client.removeWorktree(worktree.id);
				expect(existsSync(worktree.path)).toBe(false);
			} finally {
				finishReply.resolve();
				allowClose.resolve();
				allowObservation.resolve();
				allowRelease.resolve();
				vi.useRealTimers();
				await run.ended;
			}
		},
		60_000,
	);
});

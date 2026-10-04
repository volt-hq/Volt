import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import type { BackgroundJobSnapshot } from "../../src/core/background-jobs.ts";
import type { ConversationFactory } from "../../src/core/host/hosted-conversation.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { parsePersistedSessionEntry } from "../../src/core/session-entry-codec.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "../../src/core/session-store/index.ts";
import { createBuiltInSubagentDefinitions, SubagentManager } from "../../src/core/subagents/index.ts";
import { createAgentSessionTestControl } from "../agent-session-test-control.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createFauxModelRegistry, createHarness, getMessageText, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup(withConfiguredAuth = true) {
	const directory = mkdtempSync(join(tmpdir(), "volt-background-persistence-"));
	const fixture = await createHarness({ settings: { lsp: { enabled: false }, retry: { enabled: false } } });
	const parent = await SessionManager.create(directory, join(directory, "sessions"));
	const children: Harness[] = [];
	const promptReady = deferred();
	const allowPrompt = deferred();
	const published = deferred();
	const finishChild = deferred();
	const resourceLoader = {
		...createTestResourceLoader(),
		getSubagents: () => ({ definitions: createBuiltInSubagentDefinitions(), diagnostics: [] }),
	};
	const createRuntime: ConversationFactory = async ({ cwd, sessionManager }) => {
		const child = await createHarness({ withConfiguredAuth });
		children.push(child);
		child.setResponses([
			async (_context, options) => {
				const signal = options?.signal;
				const aborted = deferred();
				signal?.addEventListener("abort", aborted.resolve, { once: true });
				if (signal?.aborted) aborted.resolve();
				try {
					await Promise.race([finishChild.promise, aborted.promise]);
					return fauxAssistantMessage("durable child report");
				} finally {
					signal?.removeEventListener("abort", aborted.resolve);
				}
			},
		]);
		const services = await createAgentSessionServices({
			cwd,
			agentDir: child.tempDir,
			authStorage: child.authStorage,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		services.modelRegistry.client.registerProvider(child.faux);
		services.settingsManager.applyOverrides({ lsp: { enabled: false }, retry: { enabled: false } });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: child.getModel(),
			noTools: "all",
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const manager = new SubagentManager({
		createRuntime,
		cwd: directory,
		agentDir: fixture.tempDir,
		resourceLoader,
		parentSessionManager: parent,
	});
	manager.subscribeActivities(() => published.resolve());
	const startByName = manager.startByName.bind(manager);
	const startSpy = vi.spyOn(manager, "startByName").mockImplementation(async (...args) => {
		const handle = await startByName(...args);
		const prompt = handle.prompt.bind(handle);
		vi.spyOn(handle, "prompt").mockImplementation(async (message) => {
			promptReady.resolve();
			await allowPrompt.promise;
			await prompt(message);
		});
		return handle;
	});
	const { session } = await createAgentSession({
		cwd: directory,
		agentDir: fixture.tempDir,
		resourceLoader,
		sessionManager: parent,
		model: fixture.getModel(),
		authStorage: fixture.authStorage,
		modelRegistry: createFauxModelRegistry(fixture),
		settingsManager: fixture.settingsManager,
		subagentToolManager: manager,
		disableMcp: true,
		tools: ["subagent", "jobs"],
	});
	fixture.setResponses([fauxAssistantMessage("parent baseline")]);
	await session.prompt("prepare independent work");
	// Settle one-time startup metadata before intercepting the parent transaction.
	await session.gitContextProvider.refresh();
	await vi.waitFor(() => expect(parent.getStartingGitContext()).not.toBeUndefined());
	const storeLease = await acquireSharedSQLiteSessionStore(parent.getSessionDir());
	const jobs = session.state.tools.find((tool) => tool.name === "jobs")!;
	return {
		parent,
		session,
		control: createAgentSessionTestControl(session),
		manager,
		store: storeLease.client,
		allowPrompt,
		published,
		finishChild,
		async start() {
			const tool = session.state.tools.find((tool) => tool.name === "subagent")!;
			const params = { agent: "general", task: "independent work", background: true };
			const preflight = await tool.execute("preflight", params);
			const confirm = /"confirm": "([^"]+)"/.exec(getMessageText(preflight))?.[1];
			if (!confirm) throw new Error("Expected spawn confirmation");
			const result = await tool.execute("background-spawn", { ...params, confirm });
			const job = (result.details as { backgroundJob: BackgroundJobSnapshot }).backgroundJob;
			await promptReady.promise;
			return job.id;
		},
		async wait(id: string) {
			const result = await jobs.execute("collect", { action: "wait", ids: [id], timeoutMs: 30_000 });
			// These tests write the parent outside session run admission.
			// Suppress terminal-job inference without changing the settled worker outcome.
			session.backgroundJobs.cancel(id);
			return result;
		},
		/** Close the parent session: its conversation drains every write already called, then closes the log. */
		async close() {
			session.dispose();
			await session.waitForClosed();
		},
		async cleanup(expectedCloseFailure = false) {
			allowPrompt.resolve();
			finishChild.resolve();
			startSpy.mockRestore();
			session.dispose();
			let closeError: unknown;
			try {
				await session.waitForClosed();
			} catch (error) {
				closeError = error;
			}
			await manager.dispose();
			for (const child of children) await child.cleanupAsync();
			await fixture.cleanupAsync();
			await storeLease.release();
			rmSync(directory, { recursive: true, force: true });
			if (closeError !== undefined && !expectedCloseFailure) throw closeError;
			return closeError;
		},
	};
}

type Context = Awaited<ReturnType<typeof setup>>;

function pauseParent(context: Context, outcome: "commit" | "rollback" | "conflict" = "commit", failSpawn = false) {
	const started = deferred();
	const release = deferred();
	const spawnStarted = deferred();
	const releaseSpawn = deferred();
	const apply = context.store.applyTransaction.bind(context.store);
	const writes: string[][] = [];
	let paused = false;
	const spy = vi.spyOn(context.store, "applyTransaction").mockImplementation(async (input) => {
		if (input.sessionId !== context.parent.getSessionId()) return apply(input);
		const types = input.payload.entries.map((entry) => parsePersistedSessionEntry(entry.entry).type);
		writes.push(types);
		if (!paused) {
			paused = true;
			started.resolve();
			await release.promise;
			if (outcome === "rollback") throw new Error("injected parent rollback");
			// The parent's lock was lost: another writer appended, so the fence fails.
			if (outcome === "conflict") return { status: "conflict", actualOrdinal: input.expectedOrdinal + 1 };
		} else if (types.includes("subagent_spawn")) {
			spawnStarted.resolve();
			await releaseSpawn.promise;
			if (failSpawn) throw new Error("injected spawn write failure");
		}
		return apply(input);
	});
	return { started, release, spawnStarted, releaseSpawn, writes, restore: () => spy.mockRestore() };
}

/**
 * A parent write through its live session's conversation: a host message
 * append, or a leaf move. The session refuses tree navigation while a
 * background job runs; the conversation's own leaf move does not.
 */
function commitParent(context: Context, kind: "append" | "navigation"): Promise<unknown> {
	if (kind === "append")
		return context.session.sessionWriter.appendMessage(fauxAssistantMessage("parent continuation"));
	return context.control.conversation.navigate(null);
}

describe("background subagent spawn persistence", () => {
	it.each(["append", "navigation"] as const)(
		"persists one hidden edge after a concurrent parent %s commit and reopens it",
		async (kind) => {
			const context = await setup();
			const barrier = pauseParent(context);
			try {
				const jobId = await context.start();
				const leaf = context.parent.getLeafId();
				const observed: string[] = [];
				const branches: unknown[] = [];
				context.parent.subscribeEntries((entry) => observed.push(entry.type));
				context.parent.subscribeBranchChanges((change) => branches.push(change));
				const commit = commitParent(context, kind);
				await barrier.started.promise;
				context.allowPrompt.resolve();
				await context.published.promise;
				context.finishChild.resolve();
				expect(await context.wait(jobId)).toMatchObject({
					details: {
						backgroundJobWait: { reason: "terminal", results: [{ id: jobId, status: "completed" }], pending: [] },
					},
				});
				expect(context.manager.listDelegations()).toMatchObject([{ status: "completed" }]);
				expect(context.parent.getSubagentSpawnEntries()).toEqual([]);
				expect(context.parent.getLeafId()).toBe(leaf);
				expect(observed).toEqual([]);
				barrier.release.resolve();
				await commit;
				await barrier.spawnStarted.promise;
				await setImmediate();
				// The edge commits after the parent commit; it is not visible while its own commit is in flight.
				expect(context.parent.getSubagentSpawnEntries()).toEqual([]);
				const finalLeaf = context.parent.getLeafId();
				const entries = context.parent.getEntries();
				const branch = context.parent.getBranch();
				barrier.releaseSpawn.resolve();
				await vi.waitFor(() => expect(context.parent.getSubagentSpawnEntries()).toHaveLength(1));
				const edges = context.parent.getSubagentSpawnEntries();
				expect(edges).toHaveLength(1);
				expect(edges[0]).toMatchObject({ toolCallId: "background-spawn", parentId: finalLeaf });
				expect(context.parent.getEntry(edges[0].id)).toBeUndefined();
				expect(context.parent.getLeafId()).toBe(finalLeaf);
				expect(context.parent.getEntries()).toEqual(entries);
				expect(context.parent.getBranch()).toEqual(branch);
				// Only a leaf entry moves the branch; appends advance the leaf without a branch change.
				expect(observed).toEqual(kind === "append" ? ["message"] : []);
				expect(branches).toEqual(kind === "navigation" ? [{ previousLeafId: leaf, nextLeafId: null }] : []);
				expect(barrier.writes).toEqual([kind === "append" ? ["message"] : ["leaf"], ["subagent_spawn"]]);
				const reopened = await SessionManager.openReadOnly(context.parent.getSessionRef()!);
				try {
					expect(reopened.getSubagentSpawnEntries()).toEqual(edges);
					expect(reopened.getEntries()).toEqual(entries);
					expect(reopened.getLeafId()).toBe(finalLeaf);
				} finally {
					await reopened.closePersistence();
				}
			} finally {
				barrier.release.resolve();
				barrier.releaseSpawn.resolve();
				barrier.restore();
				await context.cleanup();
			}
		},
	);

	it.each(["commit", "rollback"] as const)(
		"drains accepted edges on close after a parent append %s, preserving owned attribution",
		async (outcome) => {
			const context = await setup();
			const barrier = pauseParent(context, outcome);
			try {
				const leaf = context.parent.getLeafId();
				const ref = context.parent.getSessionRef()!;
				const child = await SessionManager.create(context.parent.getCwd(), context.parent.getSessionDir(), {
					origin: "subagent",
					parentSession: ref,
				});
				const childRef = child.getSessionRef()!;
				await child.closePersistence();
				const commit = commitParent(context, "append").then(
					() => undefined,
					(error: unknown) => error,
				);
				await barrier.started.promise;
				const spawn = {
					toolCallId: "owned-call",
					subagentId: "sa_owned",
					agent: "general",
					childSessionId: childRef.sessionId,
					childSessionRef: { ...childRef },
					requestKey: "owned-request",
				};
				const first = context.session.sessionWriter.appendSubagentSpawn(spawn);
				spawn.childSessionRef.sessionId = "mutated-child";
				spawn.requestKey = "mutated-request";
				const second = context.session.sessionWriter.appendSubagentSpawn({
					...spawn,
					childSessionRef: childRef,
					subagentId: "sa_second",
				});
				let closed = false;
				const close = context.close().then(
					() => {
						closed = true;
						return undefined;
					},
					(error: unknown) => {
						closed = true;
						return error;
					},
				);
				barrier.release.resolve();
				const result = await commit;
				if (outcome === "rollback") expect(result).toMatchObject({ code: "commit_rolled_back" });
				else expect(result).toBeUndefined();
				// The edges commit after the parent append, under the leaf it left.
				const edgeParent = context.parent.getLeafId();
				if (outcome === "rollback") expect(edgeParent).toBe(leaf);
				await barrier.spawnStarted.promise;
				await setImmediate();
				expect(closed).toBe(false);
				barrier.releaseSpawn.resolve();
				// An earlier write's failure is reported by that write, not by close.
				expect(await close).toBeUndefined();
				// The closed session's log refuses later writes.
				await expect(
					context.parent.logWriter.appendSubagentSpawn({
						...spawn,
						childSessionRef: childRef,
						subagentId: "sa_after_close",
					}),
				).rejects.toThrow(/closed/);
				const firstId = await first;
				const secondId = await second;
				const reopened = await SessionManager.open(ref);
				try {
					expect(reopened.getSubagentSpawnEntries()).toMatchObject([
						{ id: firstId, parentId: edgeParent, requestKey: "owned-request", childSessionRef: childRef },
						{ id: secondId, parentId: edgeParent, subagentId: "sa_second" },
					]);
					if (outcome === "rollback") expect(reopened.getLeafId()).toBe(leaf);
				} finally {
					await reopened.closePersistence();
				}
			} finally {
				barrier.release.resolve();
				barrier.releaseSpawn.resolve();
				barrier.restore();
				expect(await context.cleanup()).toBeUndefined();
			}
		},
	);

	it.each(["rejected", "aborted-before", "aborted-after"] as const)(
		"records only accepted prompts when the child is %s during the parent commit",
		async (phase) => {
			const context = await setup(phase !== "rejected");
			const barrier = pauseParent(context);
			try {
				const jobId = await context.start();
				const commit = commitParent(context, "append");
				await barrier.started.promise;
				if (phase === "aborted-before") {
					const abort = context.session.abort();
					context.allowPrompt.resolve();
					await abort;
				} else {
					context.allowPrompt.resolve();
					if (phase === "aborted-after") {
						await context.published.promise;
						await context.session.abort();
					}
				}
				await context.wait(jobId);
				barrier.release.resolve();
				barrier.releaseSpawn.resolve();
				await commit;
				// Close waits for every write already called, including an edge written after the commit.
				await context.close();
				expect(context.parent.getSubagentSpawnEntries()).toHaveLength(phase === "aborted-after" ? 1 : 0);
				expect(context.manager.listDelegations()).toHaveLength(phase === "aborted-after" ? 1 : 0);
			} finally {
				barrier.release.resolve();
				barrier.releaseSpawn.resolve();
				barrier.restore();
				await context.cleanup();
			}
		},
	);

	it("rejects queued edges when the parent loses its log", async () => {
		const context = await setup();
		const barrier = pauseParent(context, "conflict");
		try {
			const jobId = await context.start();
			const ref = context.parent.getSessionRef()!;
			const commit = commitParent(context, "append");
			const rejectedCommit = expect(commit).rejects.toThrow(/but the log head is/);
			await barrier.started.promise;
			context.allowPrompt.resolve();
			await context.published.promise;
			context.finishChild.resolve();
			await context.wait(jobId);
			barrier.release.resolve();
			await rejectedCommit;
			await expect(context.parent.lost).resolves.toMatchObject({ reason: "fence_conflict" });
			// Closing reports nothing new: `lost` already did. It waits for the queued edge, which the loss rejects.
			await expect(context.close()).resolves.toBeUndefined();
			expect(context.parent.getSubagentSpawnEntries()).toEqual([]);
			await expect(context.parent.logWriter.appendSessionInfo("must reject")).rejects.toThrow(/but the log head is/);
			const reopened = await SessionManager.openReadOnly(ref);
			try {
				expect(reopened.getSubagentSpawnEntries()).toEqual([]);
			} finally {
				await reopened.closePersistence();
			}
		} finally {
			barrier.release.resolve();
			barrier.releaseSpawn.resolve();
			barrier.restore();
			expect(await context.cleanup(true)).toBeUndefined();
		}
	});

	it("drains edges admitted while close waits for an earlier write", async () => {
		const context = await setup();
		const barrier = pauseParent(context);
		try {
			const jobId = await context.start();
			const earlier = context.session.sessionWriter.appendSessionInfo("earlier write");
			await barrier.started.promise;
			context.allowPrompt.resolve();
			await context.published.promise;
			context.finishChild.resolve();
			await context.wait(jobId);
			const drain = context.close();
			barrier.release.resolve();
			await earlier;
			const leaf = context.parent.getLeafId();
			barrier.releaseSpawn.resolve();
			await drain;
			// Close waits for the writes called before it, the edge queued behind the earlier write included.
			expect(context.parent.getSubagentSpawnEntries()).toMatchObject([{ parentId: leaf }]);
			expect(context.parent.getSubagentSpawnEntries()).toHaveLength(1);
			expect(context.parent.getLeafId()).toBe(leaf);
			expect(context.parent.getSessionName()).toBe("earlier write");
		} finally {
			barrier.release.resolve();
			barrier.releaseSpawn.resolve();
			barrier.restore();
			await context.cleanup();
		}
	});

	it("rolls back a failed edge write without claiming durable recovery", async () => {
		const context = await setup();
		const barrier = pauseParent(context, "commit", true);
		try {
			const jobId = await context.start();
			const ref = context.parent.getSessionRef()!;
			const commit = commitParent(context, "append");
			await barrier.started.promise;
			context.allowPrompt.resolve();
			await context.published.promise;
			context.finishChild.resolve();
			await context.wait(jobId);
			barrier.release.resolve();
			await commit;
			await barrier.spawnStarted.promise;
			barrier.releaseSpawn.resolve();
			// Close waits for the failed edge write; that failure is the write's own, not close's.
			await expect(context.close()).resolves.toBeUndefined();
			// The edge was rolled back, so the parent still matches its log and was not lost.
			expect(context.parent.getSubagentSpawnEntries()).toEqual([]);
			await expect(Promise.race([context.parent.lost, setImmediate("live")])).resolves.toBe("live");
			const reopened = await SessionManager.open(ref);
			try {
				expect(reopened.getSubagentSpawnEntries()).toEqual([]);
				expect(getMessageText(reopened.getConversationState().context.messages.at(-1))).toBe("parent continuation");
			} finally {
				await reopened.closePersistence();
			}
		} finally {
			barrier.release.resolve();
			barrier.releaseSpawn.resolve();
			barrier.restore();
			expect(await context.cleanup(true)).toBeUndefined();
		}
	});
});

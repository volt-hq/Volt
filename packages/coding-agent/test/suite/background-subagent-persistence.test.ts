import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import type { ConversationFactory } from "../../src/core/host/hosted-conversation.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { parsePersistedSessionEntry } from "../../src/core/session-entry-codec.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "../../src/core/session-store/index.ts";
import { createBuiltInSubagentDefinitions, SubagentManager } from "../../src/core/subagents/index.ts";
import type { JobSummary } from "../../src/core/tools/jobs.ts";
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
			const job = (result.details as { job: JobSummary }).job;
			await promptReady.promise;
			return job.id;
		},
		/**
		 * Wait for the job's result. A job that finishes into this wait queues no
		 * notice, so no inference wakes the parent. Its result is recorded through
		 * the parent's log, after the writes queued before it.
		 */
		async wait(id: string) {
			return await jobs.execute("collect", { action: "wait", ids: [id], timeoutMs: 30_000 });
		},
		/** The parent's `subagent` work, in start order. */
		subagentWork() {
			return session.work.list().filter((record) => record.kind === "subagent");
		},
		/** Wait until the delegated child run settled; the job records its result after the parent writes queued before it. */
		async childSettled() {
			await vi.waitFor(() =>
				expect(manager.listDelegations().every((delegation) => delegation.status !== "running")).toBe(true),
			);
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

/** The work payload types of a store transaction's entries. */
function workTypes(types: readonly string[]): boolean {
	return types.every((type) => type.startsWith("work_"));
}

/**
 * Pause the parent's first write that is not work: a concurrent parent
 * commit. Writes queued behind it, the subagent's `work_started` included,
 * wait for it. `failSubagentStart` fails the write that records the subagent.
 */
function pauseParent(context: Context, outcome: "commit" | "conflict" = "commit", failSubagentStart = false) {
	const started = deferred();
	const release = deferred();
	const apply = context.store.applyTransaction.bind(context.store);
	const writes: string[][] = [];
	let paused = false;
	const spy = vi.spyOn(context.store, "applyTransaction").mockImplementation(async (input) => {
		if (input.sessionId !== context.parent.getSessionId()) return apply(input);
		const entries = input.payload.entries.map((entry) => parsePersistedSessionEntry(entry.entry));
		const types = entries.map((entry) => entry.type);
		writes.push(types);
		if (!paused && !workTypes(types)) {
			paused = true;
			started.resolve();
			await release.promise;
			// The parent's lock was lost: another writer appended, so the fence fails.
			if (outcome === "conflict") return { status: "conflict", actualOrdinal: input.expectedOrdinal + 1 };
		} else if (
			failSubagentStart &&
			entries.some((entry) => entry.type === "work_started" && entry.kind === "subagent")
		) {
			throw new Error("injected subagent start write failure");
		}
		return apply(input);
	});
	return { started, release, writes, restore: () => spy.mockRestore() };
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

describe("background subagent work persistence", () => {
	it.each(["append", "navigation"] as const)(
		"records the subagent's work before its first prompt, behind a concurrent parent %s, and reopens it",
		async (kind) => {
			const context = await setup();
			const barrier = pauseParent(context);
			try {
				const jobId = await context.start();
				const waited = context.wait(jobId);
				const leaf = context.parent.getLeafId();
				const commit = commitParent(context, kind);
				await barrier.started.promise;
				context.allowPrompt.resolve();
				// The child's first prompt waits for its work to be recorded, behind the parent commit.
				await setImmediate();
				expect(context.subagentWork()).toEqual([]);
				expect(context.manager.listDelegations()).toEqual([]);
				barrier.release.resolve();
				await commit;
				await context.published.promise;
				const [started] = context.subagentWork();
				expect(started).toMatchObject({
					kind: "subagent",
					state: "running",
					toolCallId: "background-spawn",
					input: { agent: "general", task: "independent work" },
					child: { conversation: expect.any(String), ref: expect.any(Object) },
				});
				expect(started?.outcome).toBeUndefined();
				// Work entries are host records: they never move the leaf.
				const finalLeaf = context.parent.getLeafId();
				if (kind === "navigation") expect(finalLeaf).toBeNull();
				else expect(finalLeaf).not.toBe(leaf);
				context.finishChild.resolve();
				await context.childSettled();
				expect(context.manager.listDelegations()).toMatchObject([{ id: started?.workId, status: "completed" }]);
				expect(await waited).toMatchObject({
					details: {
						wait: {
							reason: "terminal",
							results: [
								{
									id: jobId,
									status: kind === "append" ? "completed" : expect.stringMatching(/^(completed|failed)$/),
								},
							],
						},
					},
				});
				await vi.waitFor(() => expect(context.subagentWork()[0]?.outcome).toBe("completed"));
				expect(context.parent.getLeafId()).toBe(finalLeaf);
				// The parent commit was the only non-work write; the subagent's start queued behind it.
				expect(barrier.writes.filter((types) => !workTypes(types))).toEqual([
					kind === "append" ? ["message"] : ["leaf"],
				]);
				const entries = context.parent.getEntries();
				const reopened = await SessionManager.openReadOnly(context.parent.getSessionRef()!);
				try {
					const work = [...reopened.getConversationState().work.values()].filter(
						(record) => record.kind === "subagent",
					);
					expect(work).toMatchObject([
						{
							workId: started?.workId,
							outcome: "completed",
							result: { output: { text: "durable child report" } },
						},
					]);
					expect(reopened.getEntries()).toEqual(entries);
					expect(reopened.getLeafId()).toBe(finalLeaf);
				} finally {
					await reopened.closePersistence();
				}
			} finally {
				barrier.release.resolve();
				barrier.restore();
				await context.cleanup();
			}
		},
	);

	it.each([
		["rejected", ["failed"]],
		["aborted-before", ["cancelled"]],
		["aborted-after", ["cancelled"]],
	] as const)("ends the subagent's work when its child is %s during the parent commit", async (phase, outcomes) => {
		const context = await setup(phase !== "rejected");
		const barrier = pauseParent(context);
		try {
			const jobId = await context.start();
			const waited = context.wait(jobId);
			const commit = commitParent(context, "append");
			await barrier.started.promise;
			// The abort stops the job at once; the job records the cancel after the parent commit.
			let abort: Promise<void> | undefined;
			if (phase === "aborted-before") {
				abort = context.session.abort();
				context.allowPrompt.resolve();
			} else {
				context.allowPrompt.resolve();
				if (phase === "aborted-after") {
					barrier.release.resolve();
					await context.published.promise;
					abort = context.session.abort();
				}
			}
			barrier.release.resolve();
			await commit;
			await abort;
			await waited;
			await vi.waitFor(() => expect(context.subagentWork().every((record) => record.outcome)).toBe(true));
			// A child stopped before its work was recorded leaves none (the abort races the start);
			// once recorded, the work ends with the child.
			const work = context.subagentWork();
			expect(work.map((record) => record.outcome)).toEqual(
				phase === "aborted-before" && work.length === 0 ? [] : outcomes,
			);
			if (phase === "rejected") expect(work[0]?.error).toMatch(/API key|auth/i);
			await context.close();
			const reopened = await SessionManager.openReadOnly(context.parent.getSessionRef()!);
			try {
				const reopenedWork = [...reopened.getConversationState().work.values()].filter(
					(record) => record.kind === "subagent",
				);
				expect(reopenedWork.map((record) => record.outcome)).toEqual(work.map((record) => record.outcome));
			} finally {
				await reopened.closePersistence();
			}
		} finally {
			barrier.release.resolve();
			barrier.restore();
			await context.cleanup();
		}
	});

	it("never prompts a child whose work cannot be recorded because the parent lost its log", async () => {
		const context = await setup();
		const barrier = pauseParent(context, "conflict");
		try {
			const jobId = await context.start();
			const ref = context.parent.getSessionRef()!;
			const commit = commitParent(context, "append");
			const rejectedCommit = expect(commit).rejects.toThrow(/but the log head is/);
			await barrier.started.promise;
			context.allowPrompt.resolve();
			barrier.release.resolve();
			await rejectedCommit;
			await expect(context.parent.lost).resolves.toMatchObject({ reason: "fence_conflict" });
			expect(jobId).toBeDefined();
			// The subagent's start was queued behind the lost commit: its child never runs a turn.
			await expect(context.close()).resolves.toBeUndefined();
			expect(context.manager.listDelegations()).toEqual([]);
			const reopened = await SessionManager.openReadOnly(ref);
			try {
				expect(
					[...reopened.getConversationState().work.values()].filter((record) => record.kind === "subagent"),
				).toEqual([]);
			} finally {
				await reopened.closePersistence();
			}
		} finally {
			barrier.release.resolve();
			barrier.restore();
			expect(await context.cleanup(true)).toBeUndefined();
		}
	});

	it("ends a subagent start whose work write fails without a child turn, and the parent stays live", async () => {
		const context = await setup();
		const barrier = pauseParent(context, "commit", true);
		try {
			const jobId = await context.start();
			const waited = context.wait(jobId);
			const ref = context.parent.getSessionRef()!;
			const commit = commitParent(context, "append");
			await barrier.started.promise;
			context.allowPrompt.resolve();
			barrier.release.resolve();
			await commit;
			expect(await waited).toMatchObject({ details: { wait: { results: [{ id: jobId, status: "failed" }] } } });
			expect(context.subagentWork()).toEqual([]);
			expect(context.manager.listDelegations()).toEqual([]);
			// The failed write was rolled back, so the parent still matches its log and was not lost.
			await expect(Promise.race([context.parent.lost, setImmediate("live")])).resolves.toBe("live");
			await expect(context.close()).resolves.toBeUndefined();
			const reopened = await SessionManager.open(ref);
			try {
				expect(getMessageText(reopened.getConversationState().context.messages.at(-1))).toBe("parent continuation");
			} finally {
				await reopened.closePersistence();
			}
		} finally {
			barrier.release.resolve();
			barrier.restore();
			expect(await context.cleanup(true)).toBeUndefined();
		}
	});
});

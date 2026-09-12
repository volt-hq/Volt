import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { BackgroundJobSnapshot } from "../../src/core/background-jobs.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { parsePersistedSessionEntry } from "../../src/core/session-entry-codec.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "../../src/core/session-store/index.ts";
import { createBuiltInSubagentDefinitions, SubagentManager } from "../../src/core/subagents/index.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

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
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager }) => {
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
		requestTimeoutMs: 5_000,
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
		settingsManager: fixture.settingsManager,
		subagentToolManager: manager,
		disableMcp: true,
		tools: ["subagent", "jobs"],
	});
	fixture.setResponses([fauxAssistantMessage("parent baseline")]);
	await session.prompt("prepare independent work");
	// Settle one-time startup metadata before intercepting the parent transaction.
	await session.gitContextProvider.refresh();
	await parent.flush();
	const storeLease = await acquireSharedSQLiteSessionStore(parent.getSessionDir());
	const jobs = session.state.tools.find((tool) => tool.name === "jobs")!;
	return {
		parent,
		session,
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
			return jobs.execute("collect", { action: "wait", ids: [id], timeoutMs: 30_000 });
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

function pauseParent(context: Context, outcome: "commit" | "rollback" = "commit", failSpawn = false) {
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
		} else if (types.includes("subagent_spawn")) {
			spawnStarted.resolve();
			await releaseSpawn.promise;
			if (failSpawn) throw new Error("injected spawn write failure");
		}
		return apply(input);
	});
	return { started, release, spawnStarted, releaseSpawn, writes, restore: () => spy.mockRestore() };
}

function commitParent(parent: SessionManager, kind: "delivery" | "command") {
	const message = fauxAssistantMessage("parent continuation");
	return kind === "delivery"
		? parent.commitDelivery({ deliveryId: "delivery", epoch: 1, attemptId: "attempt", messages: [message] })
		: parent.commitCanonicalCommand({
				guard: { kind: "exact", token: parent.issueCanonicalProjection().token },
				mutations: [
					{ kind: "move", leafId: null },
					{ kind: "append", entry: { type: "message", message } },
				],
			});
}

describe("background subagent spawn persistence", () => {
	it.each(["delivery", "command"] as const)(
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
				const commit = commitParent(context.parent, kind);
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
				expect(() => context.parent.appendSessionInfo("illegal nested append")).toThrow(/atomic/);
				await expect(commitParent(context.parent, "delivery")).rejects.toThrow(/Nested atomic/);
				let flushed = false;
				const flush = context.parent.flush().then(() => {
					flushed = true;
				});
				barrier.release.resolve();
				await commit;
				await barrier.spawnStarted.promise;
				await setImmediate();
				expect(flushed).toBe(false);
				const finalLeaf = context.parent.getLeafId();
				const entries = context.parent.getEntries();
				const branch = context.parent.getBranch();
				const projection = context.parent.issueCanonicalProjection();
				barrier.releaseSpawn.resolve();
				await flush;
				const edges = context.parent.getSubagentSpawnEntries();
				expect(edges).toHaveLength(1);
				expect(edges[0]).toMatchObject({ toolCallId: "background-spawn", parentId: leaf });
				expect(context.parent.getEntry(edges[0].id)).toBeUndefined();
				expect(context.parent.getLeafId()).toBe(finalLeaf);
				expect(context.parent.getEntries()).toEqual(entries);
				expect(context.parent.getBranch()).toEqual(branch);
				expect(context.parent.issueCanonicalProjection().revision).toBe(projection.revision);
				expect(observed).toEqual(["message"]);
				expect(branches).toEqual([{ previousLeafId: leaf, nextLeafId: finalLeaf }]);
				expect(barrier.writes).toEqual([
					kind === "command" ? ["leaf", "message"] : ["message"],
					["subagent_spawn"],
				]);
				const reopened = await SessionManager.open(context.parent.getSessionRef()!);
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
		"drains accepted edges on close after parent %s, preserving owned attribution",
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
				const commit = commitParent(context.parent, "command").then(
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
				const first = context.parent.appendSubagentSpawn(spawn);
				spawn.childSessionRef.sessionId = "mutated-child";
				spawn.requestKey = "mutated-request";
				const second = context.parent.appendSubagentSpawn({
					...spawn,
					childSessionRef: childRef,
					subagentId: "sa_second",
				});
				let closed = false;
				const close = context.parent.closePersistence().then(
					() => {
						closed = true;
						return undefined;
					},
					(error: unknown) => {
						closed = true;
						return error;
					},
				);
				expect(() => context.parent.appendSubagentSpawn(spawn)).toThrow(/closed/);
				barrier.release.resolve();
				const result = await commit;
				if (outcome === "rollback") expect(result).toMatchObject({ effect: "rolled_back", authority: "available" });
				else expect(result).toBeUndefined();
				await barrier.spawnStarted.promise;
				await setImmediate();
				expect(closed).toBe(false);
				barrier.releaseSpawn.resolve();
				const closeResult = await close;
				if (outcome === "rollback") expect(closeResult).toMatchObject({ effect: "rolled_back" });
				else expect(closeResult).toBeUndefined();
				expect(context.parent.getConversationAuthorityStatus()).toEqual({ status: "available" });
				const reopened = await SessionManager.open(ref);
				try {
					expect(reopened.getSubagentSpawnEntries()).toMatchObject([
						{ id: first, parentId: leaf, requestKey: "owned-request", childSessionRef: childRef },
						{ id: second, parentId: leaf, subagentId: "sa_second" },
					]);
					if (outcome === "rollback") expect(reopened.getLeafId()).toBe(leaf);
				} finally {
					await reopened.closePersistence();
				}
			} finally {
				barrier.release.resolve();
				barrier.releaseSpawn.resolve();
				barrier.restore();
				const cleanupError = await context.cleanup(outcome === "rollback");
				if (outcome === "rollback") expect(cleanupError).toMatchObject({ effect: "rolled_back" });
				else expect(cleanupError).toBeUndefined();
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
				const commit = commitParent(context.parent, "delivery");
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
				await context.parent.flush();
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

	it("rejects queued edges when the parent loses canonical authority", async () => {
		const context = await setup();
		const barrier = pauseParent(context);
		try {
			const jobId = await context.start();
			const ref = context.parent.getSessionRef()!;
			const commit = commitParent(context.parent, "delivery");
			const rejectedCommit = expect(commit).rejects.toMatchObject({
				effect: "not_started",
				authority: "reconciliation_required",
			});
			await barrier.started.promise;
			context.allowPrompt.resolve();
			await context.published.promise;
			context.finishChild.resolve();
			await context.wait(jobId);
			const other = await SessionManager.open(ref);
			other.appendSessionInfo("another writer");
			await other.closePersistence();
			const flush = expect(context.parent.flush()).rejects.toThrow(/revision changed/);
			barrier.release.resolve();
			await rejectedCommit;
			await flush;
			expect(await context.parent.drainPersistence()).toMatchObject({ status: "reconciliation_required" });
			expect(() => context.parent.appendSessionInfo("must reject")).toThrow(/reconciliation/);
			const reopened = await SessionManager.open(ref);
			try {
				expect(reopened.getSubagentSpawnEntries()).toEqual([]);
				expect(reopened.getSessionName()).toBe("another writer");
			} finally {
				await reopened.closePersistence();
			}
		} finally {
			barrier.release.resolve();
			barrier.releaseSpawn.resolve();
			barrier.restore();
			expect(await context.cleanup(true)).toMatchObject({
				effect: "not_started",
				authority: "reconciliation_required",
			});
		}
	});

	it.each(["close", "guard", "no-effect"] as const)(
		"drains edges admitted while an atomic %s operation waits for an earlier write",
		async (operation) => {
			const context = await setup();
			const barrier = pauseParent(context);
			try {
				const jobId = await context.start();
				const token = context.parent.issueCanonicalProjection().token;
				context.parent.appendSessionInfo("earlier write");
				await barrier.started.promise;
				const leaf = context.parent.getLeafId();
				const atomic =
					operation === "no-effect"
						? context.parent.attestDeliveryNoEffect({ deliveryId: "none", epoch: 1, attemptId: "none" })
						: context.parent.commitCanonicalCommand({
								guard: { kind: "exact", token },
								mutations: [{ kind: "append", entry: { type: "session_info", name: "must not commit" } }],
							});
				const atomicResult = atomic.then(
					() => undefined,
					(error: unknown) => error,
				);
				context.allowPrompt.resolve();
				await context.published.promise;
				context.finishChild.resolve();
				await context.wait(jobId);
				const drain = operation === "close" ? context.parent.closePersistence() : context.parent.flush();
				barrier.release.resolve();
				const result = await atomicResult;
				if (operation === "close") expect(result).toMatchObject({ message: "Session persistence is closed" });
				else if (operation === "guard") expect(result).toMatchObject({ name: "SessionCanonicalConflictError" });
				else expect(result).toBeUndefined();
				barrier.releaseSpawn.resolve();
				await drain;
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
		},
	);

	it("surfaces a deferred edge write failure without claiming durable recovery", async () => {
		const context = await setup();
		const barrier = pauseParent(context, "commit", true);
		try {
			const jobId = await context.start();
			const ref = context.parent.getSessionRef()!;
			const commit = commitParent(context.parent, "delivery");
			await barrier.started.promise;
			context.allowPrompt.resolve();
			await context.published.promise;
			context.finishChild.resolve();
			await context.wait(jobId);
			const flush = expect(context.parent.flush()).rejects.toThrow(/rolled back/);
			barrier.release.resolve();
			await commit;
			barrier.releaseSpawn.resolve();
			await flush;
			expect(context.parent.getConversationAuthorityStatus().status).toBe("reconciliation_required");
			await expect(context.parent.closePersistence()).rejects.toThrow(/rolled back/);
			const reopened = await SessionManager.open(ref);
			try {
				expect(reopened.getSubagentSpawnEntries()).toEqual([]);
				expect(getMessageText(reopened.buildSessionContext().messages.at(-1))).toBe("parent continuation");
			} finally {
				await reopened.closePersistence();
			}
		} finally {
			barrier.release.resolve();
			barrier.releaseSpawn.resolve();
			barrier.restore();
			expect(await context.cleanup(true)).toMatchObject({ effect: "rolled_back" });
		}
	});
});

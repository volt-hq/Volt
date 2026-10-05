// Regression for #129: delegated runs outlive the process that started them.
// Each child is `subagent` work in its parent conversation's log (#585, RFC
// §7): the parent log alone, with the child logs its work locates, recovers
// the delegation tree, each run's outcome and report, and the runs a restart
// suspended, which resume only when asked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { type SubagentDefinition, SubagentManager } from "../../../src/core/subagents/index.ts";
import { seedSession } from "../../utilities/seed-log.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const definition: SubagentDefinition = {
	name: "researcher",
	description: "Research the task",
	systemPrompt: "Research the task.",
	source: "user",
	sourceInfo: createSyntheticSourceInfo(join(tmpdir(), "issue-129-researcher.md"), { source: "local", scope: "user" }),
	filePath: join(tmpdir(), "issue-129-researcher.md"),
};

function resourceLoader(): ResourceLoader {
	return {
		...createTestResourceLoader({ systemPrompt: "You are a test assistant." }),
		getSubagents: () => ({ definitions: [definition], diagnostics: [] }),
	};
}

interface Context {
	readonly parent: Harness;
	readonly manager: SubagentManager;
	/** Child runtimes the manager created. */
	readonly children: Harness[];
}

/** A parent conversation over `parentLog` whose subagent manager belongs to it. */
async function openParent(
	parentLog: SessionManager,
	options: {
		childResponses?: Array<string | FauxResponseStep>;
		withConfiguredAuth?: boolean;
		tools?: string[];
		/** Runs before each child runtime is created. */
		beforeChild?: () => Promise<void>;
	} = {},
): Promise<Context> {
	const children: Harness[] = [];
	const createRuntime: ConversationFactory = async ({ cwd, sessionManager }) => {
		await options.beforeChild?.();
		const child = await createHarness({ withConfiguredAuth: options.withConfiguredAuth ?? true });
		children.push(child);
		child.setResponses(
			(options.childResponses ?? ["researched the task"]).map((step) =>
				typeof step === "string" ? fauxAssistantMessage(step) : step,
			),
		);
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
		services.settingsManager.applyOverrides({ retry: { enabled: false } });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: child.getModel(),
			...(options.tools === undefined ? { noTools: "all" as const } : { tools: options.tools }),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const manager = new SubagentManager({
		createRuntime,
		cwd: tmpdir(),
		agentDir: tmpdir(),
		resourceLoader: resourceLoader(),
		parentSessionManager: parentLog,
	});
	const parent = await createHarness({
		sessionManager: parentLog,
		subagentToolManager: manager,
		resourceLoader: resourceLoader(),
		initialActiveToolNames: ["subagent", "read"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
	});
	cleanups.push(async () => {
		await parent.cleanupAsync().catch(() => undefined);
		for (const child of children) await child.cleanupAsync().catch(() => undefined);
	});
	return { parent, manager, children };
}

async function createSessionDir(): Promise<string> {
	const sessionDir = mkdtempSync(join(tmpdir(), "issue-129-sessions-"));
	cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
	return sessionDir;
}

/** A persisted log with one exchange; its manager still writes it. */
async function createLog(sessionDir: string, task = "Delegate the research"): Promise<SessionManager> {
	const log = await SessionManager.create(tmpdir(), sessionDir);
	await seedSession(log, (seed) => seed.user(task).assistant("delegating"));
	return log;
}

interface SeededRun {
	readonly workId: string;
	readonly task: string;
	readonly child?: SessionReference;
	readonly parentWorkId?: string;
	/** Absent: open, so suspended once its conversation opens. */
	readonly outcome?: "completed" | "failed" | "cancelled" | "interrupted";
	readonly report?: string;
	readonly error?: string;
}

/** Record `runs` as `subagent` work of `log`, as a runtime that started them would have. */
async function seedRuns(log: SessionManager, runs: readonly SeededRun[]): Promise<void> {
	await seedSession(log, (seed) => {
		for (const run of runs) {
			seed.hostRecord("work_started", {
				workId: run.workId,
				kind: "subagent",
				title: `researcher: ${run.task}`,
				...(run.parentWorkId === undefined ? {} : { parentWorkId: run.parentWorkId }),
				input: { agent: "researcher", task: run.task },
				cancellable: true,
				delivery: "none",
				resume: true,
				state: "running",
				...(run.child === undefined ? {} : { child: { conversation: run.child.sessionId, ref: run.child } }),
			});
			if (run.outcome === undefined) continue;
			seed.hostRecord("work_finished", {
				workId: run.workId,
				outcome: run.outcome,
				...(run.report === undefined ? {} : { result: { output: { text: run.report, truncated: false } } }),
				...(run.error === undefined ? {} : { error: run.error }),
			});
		}
	});
}

/** A closed child log of `parent` holding `task` and how far it got; without a parent, a plain log. */
async function createChildLog(
	sessionDir: string,
	task: string,
	report?: string,
	parent?: SessionManager,
): Promise<SessionReference> {
	const parentSession = parent?.getSessionRef();
	const child = await SessionManager.create(
		tmpdir(),
		sessionDir,
		parentSession === undefined ? {} : { origin: "subagent", parentSession },
	);
	await seedSession(child, (seed) => {
		seed.user(task);
		if (report !== undefined) seed.assistant(report);
	});
	const ref = child.getSessionRef()!;
	await child.closePersistence();
	return ref;
}

describe("issue #129", () => {
	it("records each child as subagent work once, before its first prompt, without moving the leaf", async () => {
		const sessionDir = await createSessionDir();
		const context = await openParent(await createLog(sessionDir), {
			childResponses: ["researched the task", "second turn"],
		});
		const leaf = context.parent.sessionManager.getLeafId();
		const handle = await context.manager.startByName("researcher", { toolCallId: "call_129" });
		expect(context.parent.session.work.list()).toEqual([]);
		const completion = handle.waitForEnd();
		await handle.prompt("inspect the incident");
		await completion;
		await handle.prompt("look again").catch(() => undefined);
		await handle.dispose();

		const work = context.parent.session.work.list();
		expect(work).toMatchObject([
			{
				workId: handle.id,
				kind: "subagent",
				toolCallId: "call_129",
				input: { agent: "researcher", task: "inspect the incident" },
				child: { conversation: handle.sessionId, ref: { sessionId: handle.sessionId } },
				outcome: "completed",
				result: { output: { text: "researched the task" } },
			},
		]);
		// Host records: the branch and its navigation never see them.
		expect(context.parent.sessionManager.getLeafId()).toBe(leaf);
		expect(context.parent.sessionManager.getBranch().some((entry) => entry.type.startsWith("work_"))).toBe(false);
	});

	it("records no work for a manager that belongs to no conversation", async () => {
		const parentLog = SessionManager.inMemory(tmpdir());
		const children: Harness[] = [];
		const manager = new SubagentManager({
			createRuntime: async ({ cwd, sessionManager }) => {
				const child = await createHarness();
				children.push(child);
				child.setResponses([fauxAssistantMessage("programmatic report")]);
				const services = await createAgentSessionServices({
					cwd,
					agentDir: child.tempDir,
					authStorage: child.authStorage,
					resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
				});
				services.modelRegistry.client.registerProvider(child.faux);
				const created = await createAgentSessionFromServices({
					services,
					sessionManager,
					model: child.getModel(),
					noTools: "all",
				});
				return { ...created, services, diagnostics: services.diagnostics };
			},
			cwd: tmpdir(),
			agentDir: tmpdir(),
			resourceLoader: resourceLoader(),
			parentSessionManager: parentLog,
		});
		cleanups.push(async () => {
			await manager.dispose();
			for (const child of children) await child.cleanupAsync();
		});
		const handle = await manager.startByName("researcher");
		const completion = handle.waitForEnd();
		await handle.prompt("inspect the incident");
		await expect(completion).resolves.toMatchObject({ status: "completed" });
		await handle.dispose();
		expect(parentLog.getConversationState().work.size).toBe(0);
		await expect(manager.startWork("researcher", "detached")).rejects.toThrow(/only in a conversation/);
	});

	it("hydrates a reopened conversation's finished and suspended runs and their descendants without opening runtimes", async () => {
		const sessionDir = await createSessionDir();
		const parentLog = await createLog(sessionDir);
		const childRef = await createChildLog(sessionDir, "survey the code", "partial survey");
		const grandchildRef = await createChildLog(sessionDir, "leaf task", "leaf report");
		const childLog = await SessionManager.open(childRef);
		await seedRuns(childLog, [
			{
				workId: "sa_leaf",
				task: "leaf task",
				child: grandchildRef,
				parentWorkId: "sa_survey",
				outcome: "completed",
				report: "leaf report",
			},
		]);
		await childLog.closePersistence();
		await seedRuns(parentLog, [
			{ workId: "sa_done", task: "finished work", outcome: "completed", report: "finished report" },
			{ workId: "sa_failed", task: "failing work", outcome: "failed", error: "The provider failed" },
			{ workId: "sa_survey", task: "survey the code", child: childRef },
			{
				workId: "sa_unreadable",
				task: "lost work",
				child: { ...childRef, sessionId: "019a0000-0000-7000-8000-000000000000" },
			},
		]);
		const context = await openParent(parentLog);
		await context.manager.ensureRegistryHydrated();
		const records = new Map(context.manager.listDelegations().map((record) => [record.id, record]));
		expect(records.get("sa_done")).toMatchObject({
			status: "completed",
			task: "finished work",
			path: ["researcher"],
		});
		// Times come from the run's work entries, not from this hydration.
		expect(records.get("sa_done")?.startedAt).toBeLessThan(Date.now() - 60_000);
		expect(records.get("sa_done")?.finishedAt).toBeGreaterThan(records.get("sa_done")?.startedAt ?? 0);
		expect(records.get("sa_failed")).toMatchObject({ status: "failed", error: "The provider failed" });
		expect(records.get("sa_survey")).toMatchObject({ status: "suspended", task: "survey the code" });
		expect(records.get("sa_unreadable")).toMatchObject({ status: "suspended" });
		// The grandchild is recovered through the child's log, under its parent run.
		expect(records.get("sa_leaf")).toMatchObject({
			status: "completed",
			parentId: "sa_survey",
			path: ["researcher", "researcher"],
			task: "leaf task",
		});
		await expect(context.manager.followDelegation("sa_done")).resolves.toMatchObject({
			status: "completed",
			output: "finished report",
		});
		await expect(context.manager.followDelegation("sa_leaf")).resolves.toMatchObject({ output: "leaf report" });
		// A suspended run is not waited on.
		await expect(context.manager.followDelegation("sa_survey")).resolves.toMatchObject({ status: "suspended" });
		expect(context.children).toHaveLength(0);
		expect(context.parent.faux.state.callCount).toBe(0);

		// A cancel of suspended work reaches the hydrated record.
		await context.parent.session.work.cancel("sa_unreadable");
		expect(context.manager.listDelegations().find((record) => record.id === "sa_unreadable")).toMatchObject({
			status: "cancelled",
		});
	});

	it("resumes only suspended runs of this conversation, and a failed preparation leaves the run suspended", async () => {
		const sessionDir = await createSessionDir();
		const parentLog = await createLog(sessionDir);
		const missing = {
			...(await createChildLog(sessionDir, "gone", undefined, parentLog)),
			sessionId: "019a0000-0000-7000-8000-000000000001",
		};
		// A locator that names a log this conversation did not create as its subagent.
		const foreign = await createChildLog(sessionDir, "foreign work");
		await seedRuns(parentLog, [
			{ workId: "sa_done", task: "finished work", outcome: "completed", report: "finished report" },
			{ workId: "sa_gone", task: "gone", child: missing },
			{ workId: "sa_foreign", task: "foreign work", child: foreign },
		]);
		const context = await openParent(parentLog);
		await expect(context.manager.resumeDelegation("sa_done")).rejects.toThrow(/not suspended/);
		await expect(context.manager.resumeDelegation("sa_missing")).rejects.toThrow(/not suspended/);
		await expect(context.manager.resumeDelegation("sa_gone")).rejects.toThrow(/cannot resume: .*no longer exists/);
		await expect(context.manager.resumeDelegation("sa_foreign")).rejects.toThrow(
			/cannot resume: .*not a subagent conversation of this conversation/,
		);
		expect(context.parent.session.work.get("sa_foreign")?.outcome).toBeUndefined();
		// Its work is still suspended, and no checkpoint claimed it ran again.
		expect(context.parent.session.work.get("sa_gone")).toMatchObject({ state: "running" });
		expect(context.parent.session.work.get("sa_gone")?.outcome).toBeUndefined();
		expect(context.parent.session.work.running()).toEqual([]);
		expect(context.manager.listDelegations().find((record) => record.id === "sa_gone")).toMatchObject({
			status: "suspended",
		});
		expect(context.children).toHaveLength(0);
	});

	it("resumes a child clamped to the conversation's tool policy, which reopens its log under its id", async () => {
		const sessionDir = await createSessionDir();
		const parentLog = await createLog(sessionDir);
		const childRef = await createChildLog(sessionDir, "finish the audit", "starting the audit", parentLog);
		await seedRuns(parentLog, [{ workId: "sa_resume", task: "finish the audit", child: childRef }]);
		let resumedTools: string[] | undefined;
		const context = await openParent(parentLog, {
			tools: ["read", "bash"],
			childResponses: [
				(llmContext) => {
					resumedTools = llmContext.tools?.map((tool) => tool.name) ?? [];
					return fauxAssistantMessage("audit complete");
				},
			],
		});
		const followed = await context.manager.resumeDelegation("sa_resume");
		expect(followed).toMatchObject({ id: "sa_resume", status: "completed", output: "audit complete" });
		expect(context.children).toHaveLength(1);
		// The parent has `read` and `subagent` active, not `bash`.
		expect(resumedTools).toContain("read");
		expect(resumedTools).not.toContain("bash");
	});

	it("cancels a resumed run whose caller aborted while its child was being prepared", async () => {
		const sessionDir = await createSessionDir();
		const parentLog = await createLog(sessionDir);
		const childRef = await createChildLog(sessionDir, "finish the audit", "starting the audit", parentLog);
		await seedRuns(parentLog, [{ workId: "sa_abort", task: "finish the audit", child: childRef }]);
		const preparing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const context = await openParent(parentLog, {
			beforeChild: async () => {
				preparing.resolve();
				await release.promise;
			},
		});
		const controller = new AbortController();
		const resuming = context.manager.resumeDelegation("sa_abort", { signal: controller.signal });
		await preparing.promise;
		controller.abort();
		release.resolve();
		await expect(resuming).rejects.toThrow(/abort/i);
		await vi.waitFor(() => expect(context.parent.session.work.get("sa_abort")?.outcome).toBe("cancelled"));
		expect(context.parent.session.work.running()).toEqual([]);
		// The child never ran a turn.
		expect(context.children[0]?.faux.state.callCount ?? 0).toBe(0);
	});

	it("records an in-memory parent's children without a locator, so they cannot resume", async () => {
		const context = await openParent(SessionManager.inMemory(tmpdir()));
		const handle = await context.manager.startByName("researcher");
		const completion = handle.waitForEnd();
		await handle.prompt("inspect the incident");
		await completion;
		await handle.dispose();
		const [record] = context.parent.session.work.list();
		expect(record).toMatchObject({ kind: "subagent", child: { conversation: handle.sessionId } });
		expect(record?.child?.ref).toBeUndefined();
	});
});

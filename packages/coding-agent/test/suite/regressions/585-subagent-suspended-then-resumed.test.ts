// Regression for #585 (Phase 4, RFC §7.1 as amended): a subagent is
// `subagent` work in its parent conversation's log. A subagent running when
// its parent's runtime closes stays open: the reopened conversation shows it
// suspended, spends no tokens on it, and resumes it only when asked. Its
// closed child conversation opens read-only from its log meanwhile. A resume
// reopens the child's log and lets the child finish its task.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { type SubagentDefinition, SubagentManager } from "../../../src/core/subagents/index.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { conversationLines } from "../../../src/modes/interactive/components/work-inspector.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { lastAssistantText } from "../../utilities/session-reads.ts";
import { createSessionWorkView } from "../../utilities/work-view.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

const definition: SubagentDefinition = {
	name: "researcher",
	description: "Research the task",
	systemPrompt: "Research the task.",
	source: "user",
	sourceInfo: createSyntheticSourceInfo(join(tmpdir(), "585-researcher.md"), { source: "local", scope: "user" }),
	filePath: join(tmpdir(), "585-researcher.md"),
};

function resourceLoader(): ResourceLoader {
	return {
		...createTestResourceLoader({ systemPrompt: "You are a test assistant." }),
		getSubagents: () => ({ definitions: [definition], diagnostics: [] }),
	};
}

/** A child response that runs until the child's run is aborted. */
const runsUntilStopped: FauxResponseStep = async (_context, options) => {
	const signal = options?.signal;
	await new Promise<void>((resolve) => {
		if (signal?.aborted) resolve();
		signal?.addEventListener("abort", () => resolve(), { once: true });
	});
	return fauxAssistantMessage("", { stopReason: "aborted" });
};

interface Runtime {
	readonly parent: Harness;
	readonly manager: SubagentManager;
	/** Each child runtime's faux provider requests, in order. */
	readonly childPrompts: string[][];
	/** Child runtimes the manager created. */
	readonly children: Harness[];
}

/** One process: the parent conversation over `parentLog`, its subagent manager, and its children's responses. */
async function openRuntime(parentLog: SessionManager, childResponses: FauxResponseStep[]): Promise<Runtime> {
	const children: Harness[] = [];
	const childPrompts: string[][] = [];
	const createRuntime: ConversationFactory = async ({ cwd, sessionManager }) => {
		const child = await createHarness({ settings: { lsp: { enabled: false }, retry: { enabled: false } } });
		children.push(child);
		const prompts: string[] = [];
		childPrompts.push(prompts);
		child.setResponses(
			childResponses.map((step): FauxResponseStep => {
				return async (context, options, state, model) => {
					const users = context.messages.filter((message) => message.role === "user");
					prompts.push(getMessageText(users.at(-1)));
					return typeof step === "function" ? await step(context, options, state, model) : step;
				};
			}),
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
		cwd: tmpdir(),
		agentDir: tmpdir(),
		resourceLoader: resourceLoader(),
		parentSessionManager: parentLog,
	});
	const parent = await createHarness({
		sessionManager: parentLog,
		subagentToolManager: manager,
		resourceLoader: resourceLoader(),
		initialActiveToolNames: ["subagent"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
	});
	cleanups.push(async () => {
		await parent.cleanupAsync().catch(() => undefined);
		for (const child of children) await child.cleanupAsync().catch(() => undefined);
	});
	return { parent, manager, childPrompts, children };
}

/** Close the runtime the way a host does: its work stops first, then the session. */
async function closeRuntime(runtime: Runtime): Promise<void> {
	runtime.parent.session.dispose();
	await runtime.parent.session.waitForClosed();
}

/** A persisted parent conversation; the children it starts are persisted beside it. */
async function createParentLog(): Promise<SessionManager> {
	const sessionDir = mkdtempSync(join(tmpdir(), "585-subagent-sessions-"));
	cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
	return await SessionManager.create(tmpdir(), sessionDir);
}

/** Start a subagent as the model does: a confirmed `subagent` tool call that waits for the child. */
async function startSubagentThroughModel(runtime: Runtime): Promise<void> {
	const params = { agent: "researcher", task: "Audit the authentication module" };
	runtime.parent.setResponses([
		fauxAssistantMessage(fauxToolCall("subagent", params), { stopReason: "toolUse" }),
		(context) => {
			const preflight = context.messages.findLast((message) => message.role === "toolResult");
			const confirm = /"confirm": "([^"]+)"/.exec(getMessageText(preflight))?.[1];
			if (!confirm) throw new Error("Expected a spawn confirmation token");
			return fauxAssistantMessage(fauxToolCall("subagent", { ...params, confirm }), { stopReason: "toolUse" });
		},
	]);
	void runtime.parent.session.prompt("Delegate the audit").catch(() => undefined);
	await vi.waitFor(() => expect(runtime.childPrompts[0]?.length).toBe(1), { timeout: 10_000 });
}

describe("#585 subagent suspended after a restart, then resumed explicitly", () => {
	it("keeps a subagent its closing runtime stopped open, and resumes it only when the model asks", async () => {
		const parentLog = await createParentLog();
		const parentRef = parentLog.getSessionRef()!;
		const first = await openRuntime(parentLog, [runsUntilStopped]);
		await startSubagentThroughModel(first);
		const [running] = first.parent.session.work.list();
		expect(running).toMatchObject({ kind: "subagent", state: "running", resume: true, delivery: "none" });
		expect(running?.outcome).toBeUndefined();
		const workId = running!.workId;
		const childRef = running!.child?.ref;
		expect(childRef).toBeDefined();
		expect(running?.child?.conversation).toBe(childRef?.sessionId);
		expect(first.parent.session.work.running().map((record) => record.workId)).toEqual([workId]);

		await closeRuntime(first);

		// The restart: a new process opens the same conversation.
		const second = await openRuntime(await SessionManager.open(parentRef), [
			fauxAssistantMessage("The authentication module is sound."),
		]);
		const suspended = second.parent.session.work.get(workId);
		expect(suspended).toMatchObject({ kind: "subagent", state: "running", resume: true });
		expect(suspended?.outcome).toBeUndefined();
		// Suspended: open without an executor. Opening ran nothing and spent no tokens.
		expect(second.parent.session.work.running()).toEqual([]);
		expect(second.parent.session.work.busy()).toBe(false);
		expect(second.children).toHaveLength(0);
		expect(second.parent.faux.state.callCount).toBe(0);
		// The work inspector shows it suspended, and opens its closed conversation read-only from its log.
		const view = await createSessionWorkView(second.parent.session, tmpdir());
		cleanups.push(() => view.dispose());
		expect(view.work.items()).toEqual([
			expect.objectContaining({ suspended: true, actions: { cancel: true, resume: true, open: true } }),
		]);
		const opened = await view.work.open(workId);
		cleanups.push(() => (opened.kind === "view" ? opened.conversation.dispose() : undefined));
		if (opened.kind !== "view") throw new Error("Expected a read-only view of the child");
		initTheme("dark");
		expect(opened.conversation.live).toBe(false);
		expect(conversationLines(opened.conversation.messages(), 100).map(stripAnsi).join("\n")).toContain(
			"Audit the authentication module",
		);
		expect(second.children).toHaveLength(0);
		expect(second.parent.faux.state.callCount).toBe(0);
		await second.manager.ensureRegistryHydrated();
		expect(second.manager.listDelegations()).toEqual([
			expect.objectContaining({ id: workId, status: "suspended", task: "Audit the authentication module" }),
		]);

		// The next turn tells the model, which resumes the run explicitly.
		second.parent.setResponses([
			(context) => {
				const notice = context.messages.find((message) =>
					getMessageText(message).startsWith("Subagent recovery: 1 subagent run was stopped"),
				);
				expect(getMessageText(notice)).toContain(workId);
				return fauxAssistantMessage(fauxToolCall("subagent", { resume: workId }), { stopReason: "toolUse" });
			},
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				expect(getMessageText(result)).toContain(`Resumed subagent run ${workId}`);
				expect(getMessageText(result)).toContain("The authentication module is sound.");
				return fauxAssistantMessage("The audit finished after the restart.");
			},
		]);
		await second.parent.session.prompt("What happened to the audit?");
		expect(lastAssistantText(second.parent.session)).toBe("The audit finished after the restart.");

		// The child's own log was reopened and prompted to finish its task.
		expect(second.childPrompts).toEqual([[expect.stringContaining("You were interrupted before completing")]]);
		await vi.waitFor(() => expect(second.parent.session.work.get(workId)?.outcome).toBeDefined(), {
			timeout: 10_000,
		});
		expect(second.parent.session.work.get(workId)).toMatchObject({
			kind: "subagent",
			outcome: "completed",
			result: { output: { text: "The authentication module is sound.", truncated: false } },
		});
		expect(second.parent.session.work.output(workId)).toMatchObject({
			text: "The authentication module is sound.",
			final: true,
		});
		const child = await SessionManager.openReadOnly(childRef!);
		try {
			const texts = child.getEntries().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
			expect(texts.map(getMessageText)).toEqual(
				expect.arrayContaining(["Audit the authentication module", "The authentication module is sound."]),
			);
		} finally {
			await child.closePersistence();
		}
	});

	it("resumes a suspended subagent through the work registry, as resume_work does", async () => {
		const parentLog = await createParentLog();
		const parentRef = parentLog.getSessionRef()!;
		const first = await openRuntime(parentLog, [runsUntilStopped]);
		await startSubagentThroughModel(first);
		const workId = first.parent.session.work.list()[0]!.workId;
		await closeRuntime(first);

		const second = await openRuntime(await SessionManager.open(parentRef), [fauxAssistantMessage("Resumed report.")]);
		expect(second.parent.session.work.running()).toEqual([]);
		await second.parent.session.work.resume(workId);
		await vi.waitFor(() => expect(second.parent.session.work.get(workId)?.outcome).toBe("completed"), {
			timeout: 10_000,
		});
		expect(second.parent.session.work.get(workId)?.result?.output?.text).toBe("Resumed report.");
		// The result reaches no turn on its own: a subagent delivers nothing.
		expect(second.parent.faux.state.callCount).toBe(0);
		expect(second.parent.session.work.running()).toEqual([]);
	});
});

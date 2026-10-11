/**
 * Extension subagents (`ctx.subagents`): an extension with the `exec`
 * permission starts an agent as `subagent` work of the conversation, in a
 * directory inside the conversation's working directory, under its own
 * limits, and learns how the run ended. It cancels only its own runs, and a
 * run it starts from its own work is that work's child.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, type Usage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import type {
	ExtensionCommandContext,
	ExtensionFactory,
	ExtensionSubagentRun,
	ExtensionSubagentStartOptions,
} from "../../src/core/extensions/index.ts";
import type { ConversationFactory } from "../../src/core/host/hosted-conversation.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import { type SubagentDefinition, SubagentManager } from "../../src/core/subagents/index.ts";
import type { CreateTestExtensionsResultInput } from "../utilities.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const definition: SubagentDefinition = {
	name: "worker",
	description: "Works an issue",
	systemPrompt: "Work the issue.",
	source: "user",
	sourceInfo: createSyntheticSourceInfo(join(tmpdir(), "extension-subagents-worker.md"), {
		source: "local",
		scope: "user",
	}),
	filePath: join(tmpdir(), "extension-subagents-worker.md"),
};

const usage: Usage = {
	input: 100,
	output: 20,
	cacheRead: 5,
	cacheWrite: 0,
	totalTokens: 125,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

/** A child reply that holds until its request is aborted. */
const heldUntilAborted: FauxResponseStep = async (_context, options) => {
	await new Promise<void>((resolve) => {
		const signal = options?.signal;
		if (signal?.aborted) resolve();
		signal?.addEventListener("abort", () => resolve(), { once: true });
	});
	return fauxAssistantMessage("", { stopReason: "aborted" });
};

interface Setup {
	readonly parent: Harness;
	/** The working directory each child runtime was created in. */
	readonly childCwds: string[];
}

/** A parent conversation whose subagent manager runs `worker` children that answer `childResponses`. */
async function setup(
	extensions: Array<ExtensionFactory | CreateTestExtensionsResultInput>,
	childResponses: FauxResponseStep[] = [fauxAssistantMessage("issue worked", { usage })],
): Promise<Setup> {
	const childCwds: string[] = [];
	const children: Harness[] = [];
	const resourceLoader = (): ResourceLoader => ({
		...createTestResourceLoader({ systemPrompt: "You are a test assistant." }),
		getSubagents: () => ({ definitions: [definition], diagnostics: [] }),
	});
	const createRuntime: ConversationFactory = async ({ cwd, sessionManager }) => {
		childCwds.push(cwd);
		const child = await createHarness();
		children.push(child);
		child.setResponses(childResponses);
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
			noTools: "all",
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const manager = new SubagentManager({
		createRuntime,
		cwd: tmpdir(),
		agentDir: tmpdir(),
		resourceLoader: resourceLoader(),
	});
	const parent = await createHarness({
		subagentToolManager: manager,
		extensionFactories: extensions,
		settings: { lsp: { enabled: false }, retry: { enabled: false } },
	});
	cleanups.push(async () => {
		parent.cleanup();
		await manager.dispose().catch(() => undefined);
		for (const child of children) await child.cleanupAsync().catch(() => undefined);
	});
	return { parent, childCwds };
}

/** An extension whose `/delegate` command starts a run with the options `options` gives, keeping the run or the error. */
function delegating(
	options: (ctx: ExtensionCommandContext) => ExtensionSubagentStartOptions,
	permissions: CreateTestExtensionsResultInput["permissions"] = ["exec"],
): {
	extension: CreateTestExtensionsResultInput;
	runs: ExtensionSubagentRun[];
	errors: string[];
	ctx: () => ExtensionCommandContext;
} {
	const runs: ExtensionSubagentRun[] = [];
	const errors: string[] = [];
	let captured: ExtensionCommandContext | undefined;
	return {
		runs,
		errors,
		ctx: () => {
			if (!captured) throw new Error("/delegate has not run");
			return captured;
		},
		extension: {
			id: "delegator",
			permissions,
			factory: (volt) => {
				volt.registerCommand("delegate", {
					handler: async (_args, ctx) => {
						captured = ctx;
						try {
							runs.push(await ctx.subagents.start(options(ctx)));
						} catch (error) {
							errors.push(error instanceof Error ? error.message : String(error));
						}
					},
				});
			},
		},
	};
}

describe("extension subagents", () => {
	it("starts an agent as conversation work in a directory inside the conversation, under its limits", async () => {
		let directory = "";
		const delegator = delegating(() => ({
			agent: "worker",
			task: "Work issue 12",
			cwd: directory,
			limits: { maxTurns: 3, maxTotalCostUsd: 1 },
		}));
		const { parent, childCwds } = await setup([delegator.extension]);
		directory = join(parent.tempDir, "checkout");
		mkdirSync(directory);

		await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([]);
		expect(delegator.ctx().subagents.definitions()).toEqual([{ name: "worker", description: "Works an issue" }]);
		const [run] = delegator.runs;
		expect(await run?.ended).toEqual({
			status: "completed",
			output: "issue worked",
			usage: { tokens: 125, cost: 0.003 },
		});
		expect(childCwds).toEqual([realpathSync.native(directory)]);
		await parent.session.work.waitForIdle();
		expect(parent.session.work.get(run?.id ?? "")).toMatchObject({
			kind: "subagent",
			input: { agent: "worker", task: "Work issue 12" },
			outcome: "completed",
			child: { conversation: run?.sessionId },
		});
		expect(parent.faux.state.callCount).toBe(0);
	});

	it("stops a run at its limits", async () => {
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12", limits: { maxDurationMs: 50 } }));
		const { parent } = await setup([delegator.extension], [heldUntilAborted]);

		await parent.session.prompt("/delegate");
		const [run] = delegator.runs;
		expect((await run?.ended)?.status).toBe("cancelled");
	});

	it("needs the exec permission", async () => {
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12" }), []);
		const { parent, childCwds } = await setup([delegator.extension]);

		await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([
			'Extension "delegator" needs the "exec" permission to use ctx.subagents.start: declare it in the manifest\'s "permissions"',
		]);
		expect(childCwds).toEqual([]);
	});

	it("runs only inside the conversation's working directory or its repository's managed worktrees", async () => {
		const outside = mkdtempSync(join(tmpdir(), "volt-extension-subagents-outside-"));
		cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
		const cwds = [outside, "relative/checkout", join(tmpdir(), "volt-extension-subagents-missing")];
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12", cwd: cwds.shift() ?? "" }));
		const { parent, childCwds } = await setup([delegator.extension]);

		for (let attempt = 0; attempt < 3; attempt += 1) await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([
			`ctx.subagents.start: cwd ${JSON.stringify(outside)} is outside the conversation's working directory and its repository's managed worktrees`,
			"ctx.subagents.start: cwd must be an absolute path",
			`ctx.subagents.start: cwd ${JSON.stringify(join(tmpdir(), "volt-extension-subagents-missing"))} is not a directory`,
		]);
		expect(childCwds).toEqual([]);
	});

	it("checks the agent, task, and limits", async () => {
		const requests: ExtensionSubagentStartOptions[] = [
			{ agent: "", task: "Work issue 12" },
			{ agent: "worker", task: " " },
			{ agent: "worker", task: "Work issue 12", limits: { maxTurns: 1.5 } },
			{ agent: "worker", task: "Work issue 12", limits: { maxTotalTokens: 0 } },
			{ agent: "worker", task: "Work issue 12", parentWorkId: "not-mine" },
			{ agent: "nobody", task: "Work issue 12" },
		];
		const delegator = delegating(() => requests.shift() ?? { agent: "worker", task: "unused" });
		const { parent, childCwds } = await setup([delegator.extension]);

		for (let attempt = 0; attempt < 6; attempt += 1) await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([
			"ctx.subagents.start: agent must name an agent definition",
			"ctx.subagents.start: task must be a non-empty string",
			"ctx.subagents.start: limits.maxTurns must be a positive integer",
			"ctx.subagents.start: limits.maxTotalTokens must be a positive number",
			"ctx.subagents.start: parentWorkId must be work of the extension's own kinds",
			'Subagent definition "nobody" was not found',
		]);
		expect(childCwds).toEqual([]);
	});

	it("cancels its own runs, and no other extension's", async () => {
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12" }));
		const outcomes: string[] = [];
		const intruder: CreateTestExtensionsResultInput = {
			id: "intruder",
			permissions: ["exec"],
			factory: (volt) => {
				volt.registerCommand("steal", {
					handler: async (args, ctx) => {
						await ctx.subagents.cancel(args).then(
							() => outcomes.push("cancelled"),
							(error: unknown) => outcomes.push(error instanceof Error ? error.message : String(error)),
						);
					},
				});
			},
		};
		const { parent } = await setup([delegator.extension, intruder], [heldUntilAborted]);

		await parent.session.prompt("/delegate");
		const [run] = delegator.runs;
		if (!run) throw new Error(`no run: ${delegator.errors.join("; ")}`);
		await parent.session.prompt(`/steal ${run.id}`);
		expect(outcomes).toEqual([
			`Unknown subagent run ${JSON.stringify(run.id)}: an extension cancels only the runs it started`,
		]);
		expect(parent.session.work.get(run.id)?.outcome).toBeUndefined();

		await delegator.ctx().subagents.cancel(run.id);
		expect((await run.ended).status).toBe("cancelled");
		await parent.session.work.waitForIdle();
		expect(parent.session.work.get(run.id)?.outcome).toBe("cancelled");
		// A run that ended cancels as nothing.
		await delegator.ctx().subagents.cancel(run.id);
	});

	it("starts a run as a child of the extension's own work", async () => {
		const runs: ExtensionSubagentRun[] = [];
		let parentWorkId = "";
		const orchestrator: CreateTestExtensionsResultInput = {
			id: "orchestrator",
			permissions: ["exec"],
			factory: (volt) => {
				volt.registerWorkKind("loop", { cancelOnAbort: false });
				volt.registerCommand("orchestrate", {
					handler: async (_args, ctx) => {
						await ctx.startWork("loop", { title: "Orchestrate issues" }, async (work) => {
							parentWorkId = work.workId;
							const run = await ctx.subagents.start({
								agent: "worker",
								task: "Work issue 12",
								parentWorkId: work.workId,
							});
							runs.push(run);
							const result = await run.ended;
							return { outcome: "completed", result: { summary: result.output ?? "" } };
						});
					},
				});
			},
		};
		const { parent } = await setup([orchestrator]);

		await parent.session.prompt("/orchestrate");
		await parent.session.work.waitForIdle();
		const [run] = runs;
		expect(parent.session.work.get(run?.id ?? "")).toMatchObject({ kind: "subagent", parentWorkId });
		expect(parent.session.work.get(parentWorkId)).toMatchObject({
			kind: "ext:orchestrator/loop",
			outcome: "completed",
			result: { summary: "issue worked" },
		});
	});
});

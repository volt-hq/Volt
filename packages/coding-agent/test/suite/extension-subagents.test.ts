/**
 * Extension subagents (`ctx.subagents`): an extension with the `exec`
 * permission starts an agent as `subagent` work of the conversation, in a
 * directory inside the conversation's working directory, under its own
 * limits, and learns how the run ended. It cancels only its own runs, and a
 * run it starts from its own work is that work's child.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, type Usage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import {
	type SubagentDefinition,
	SubagentManager,
	type SubagentManagerOptions,
} from "../../src/core/subagents/index.ts";
import { getWorktreesRoot } from "../../src/daemon/worktree-manager.ts";
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

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Make `directory` a Git repository on `main` with one commit. */
function commitRepository(directory: string): void {
	writeFileSync(join(directory, "README.md"), "repository\n");
	git(directory, "init", "--initial-branch=main");
	git(directory, "add", "README.md");
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
	readonly manager: SubagentManager;
	/** The working directory each child runtime was created in. */
	readonly childCwds: string[];
}

/** A parent conversation whose subagent manager runs `worker` children that answer `childResponses`. */
async function setup(
	extensions: Array<ExtensionFactory | CreateTestExtensionsResultInput>,
	childResponses: FauxResponseStep[] = [fauxAssistantMessage("issue worked", { usage })],
	agentDir?: string,
	retainRuntimeOnDispose = false,
	onRuntimeCreated?: SubagentManagerOptions["onRuntimeCreated"],
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
		retainRuntimeOnDispose,
		...(onRuntimeCreated === undefined ? {} : { onRuntimeCreated }),
	});
	const parent = await createHarness({
		...(agentDir === undefined ? {} : { agentDir }),
		subagentToolManager: manager,
		extensionFactories: extensions,
		settings: { lsp: { enabled: false }, retry: { enabled: false } },
	});
	cleanups.push(async () => {
		parent.cleanup();
		await manager.dispose().catch(() => undefined);
		for (const child of children) await child.cleanupAsync().catch(() => undefined);
	});
	return { parent, manager, childCwds };
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

	it("starts an agent in a managed worktree of the conversation's repository, and of no other", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-extension-subagents-agent-"));
		const elsewhere = mkdtempSync(join(tmpdir(), "volt-extension-subagents-elsewhere-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(elsewhere, { recursive: true, force: true });
		});
		const cwds: string[] = [];
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12", cwd: cwds.shift() ?? "" }));
		const { parent, childCwds } = await setup([delegator.extension], undefined, agentDir);
		const ours = join(getWorktreesRoot(agentDir), "ws", "issue-12");
		const theirs = join(getWorktreesRoot(agentDir), "other", "issue-7");
		commitRepository(parent.tempDir);
		git(parent.tempDir, "worktree", "add", "-b", "volt/issue-12", ours);
		commitRepository(elsewhere);
		git(elsewhere, "worktree", "add", "-b", "volt/issue-7", theirs);
		cwds.push(ours, theirs);

		await parent.session.prompt("/delegate");
		await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([
			`ctx.subagents.start: cwd ${JSON.stringify(theirs)} is outside the conversation's working directory and its repository's managed worktrees`,
		]);
		expect((await delegator.runs[0]?.ended)?.status).toBe("completed");
		expect(childCwds).toEqual([realpathSync.native(ours)]);
	});

	it("starts in a managed worktree from an ordinary linked checkout of the same repository", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-linked-subagents-agent-"));
		const primary = mkdtempSync(join(tmpdir(), "volt-linked-subagents-primary-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(primary, { recursive: true, force: true });
		});
		let cwd = "";
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12", cwd }));
		const { parent, childCwds } = await setup([delegator.extension], undefined, agentDir);
		commitRepository(primary);
		// The conversation's directory is a linked checkout outside the managed root.
		git(primary, "worktree", "add", "-b", "workspace", parent.tempDir);
		const managed = join(getWorktreesRoot(agentDir), "ws", "issue-12");
		git(parent.tempDir, "worktree", "add", "-b", "volt/issue-12", managed);
		cwd = join(managed, "src");
		mkdirSync(cwd);

		await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([]);
		expect((await delegator.runs[0]?.ended)?.status).toBe("completed");
		expect(childCwds).toEqual([realpathSync.native(cwd)]);
	});

	it.each(["preparation", "prompt acceptance"] as const)(
		"cancels a child whose extension was disabled during %s",
		async (stage) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12" }));
			const { parent, manager } = await setup(
				[delegator.extension],
				[heldUntilAborted],
				undefined,
				false,
				async ({ conversation }) => {
					if (stage === "preparation") {
						entered.resolve();
						await release.promise;
					} else {
						const prompt = conversation.session.prompt.bind(conversation.session);
						vi.spyOn(conversation.session, "prompt").mockImplementation(async (...args) => {
							entered.resolve();
							await release.promise;
							return prompt(...args);
						});
					}
				},
			);
			const prompt = parent.session.prompt("/delegate");
			try {
				await entered.promise;
				parent.settingsManager.setExtensionEnabled("delegator", "global", false);
				await parent.session.extensionRegistry.settled();
				expect(parent.session.extensionRegistry.stopped("delegator")).toBe(true);
			} finally {
				release.resolve();
			}
			await prompt;
			// The pending start rejects rather than handing a retired instance a live child.
			expect(delegator.runs).toEqual([]);
			expect(delegator.errors).toEqual(["Extension delegator was disabled"]);
			await parent.session.work.waitForIdle();
			expect(parent.session.work.list()).toContainEqual(
				expect.objectContaining({ kind: "subagent", outcome: "cancelled" }),
			);
			expect(manager.listActivities()).toContainEqual(expect.objectContaining({ status: "cancelled" }));
		},
	);

	it("keeps only its own child actions in work details, as it does in panels", async () => {
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12" }));
		let ownId = "";
		let otherId = "";
		const detailDone = Promise.withResolvers<void>();
		let workId = "";
		const extension: CreateTestExtensionsResultInput = {
			id: "orchestrator",
			permissions: ["exec"],
			factory: (volt) => {
				const actions = () =>
					[ownId, otherId].flatMap((id) => [
						{ id: `open:${id}`, label: "Open", intent: { type: "open_work", input: { workId: id } } },
						{ id: `cancel:${id}`, label: "Cancel", intent: { type: "cancel_work", input: { workId: id } } },
					]);
				volt.registerWorkKind("loop", { detail: () => ({ type: "actions", actions: actions() }) });
				volt.registerCommand("orchestrate", {
					handler: async (_args, ctx) => {
						const child = await ctx.subagents.start({ agent: "worker", task: "Work issue 13" });
						ownId = child.id;
						ctx.ui.setPanel("children", { node: { type: "actions", actions: actions() } });
						({ workId } = await ctx.startWork("loop", { title: "Children" }, async () => {
							await detailDone.promise;
							return { outcome: "completed" };
						}));
					},
				});
			},
		};
		const { parent } = await setup([delegator.extension, extension], [heldUntilAborted]);
		await parent.session.attachExtensionClient({ id: "test", mode: "rpc" }).ready;
		cleanups.push(() => detailDone.resolve());
		await parent.session.prompt("/delegate");
		otherId = delegator.runs[0]?.id ?? "";
		await parent.session.prompt("/orchestrate");
		const expected = {
			type: "actions",
			actions: [
				{ id: `open:${ownId}`, label: "Open", intent: { type: "open_work", input: { workId: ownId } } },
				{ id: `cancel:${ownId}`, label: "Cancel", intent: { type: "cancel_work", input: { workId: ownId } } },
			],
		};
		expect(parent.session.liveState.get("ext_panel/orchestrator/children")).toMatchObject({ node: expected });
		await vi.waitFor(() =>
			expect(parent.session.liveState.get(`work/${workId}`)).toMatchObject({ detail: expected }),
		);
		detailDone.resolve();
	});

	it("closes a run's conversation once it ended, also where the host keeps children open", async () => {
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12" }));
		// Daemon workers keep subagent conversations open for live attachment.
		const { parent, manager } = await setup([delegator.extension], undefined, undefined, true);

		await parent.session.prompt("/delegate");
		const [run] = delegator.runs;
		if (!run) throw new Error(`no run: ${delegator.errors.join("; ")}`);
		expect((await run.ended).status).toBe("completed");
		// Closed by the time `ended` resolves: what it held, such as its checkout, is free.
		expect(manager.childConversation(run.sessionId)).toBeUndefined();
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

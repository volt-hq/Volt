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
import type { ConversationFactory, SubagentRuntimeContext } from "../../src/core/host/hosted-conversation.ts";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import {
	type SubagentDefinition,
	SubagentDelegationScope,
	SubagentManager,
	type SubagentManagerOptions,
	SubagentRegistry,
} from "../../src/core/subagents/index.ts";
import { getWorktreesRoot } from "../../src/daemon/worktree-manager.ts";
import type { CreateTestExtensionsResultInput } from "../utilities.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	vi.useRealTimers();
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
	/** The harness of each child runtime, in creation order. */
	readonly children: Harness[];
}

/** A parent conversation whose subagent manager runs `worker` children that answer `childResponses`. */
async function setup(
	extensions: Array<ExtensionFactory | CreateTestExtensionsResultInput>,
	childResponses: FauxResponseStep[] = [fauxAssistantMessage("issue worked", { usage })],
	agentDir?: string,
	retainRuntimeOnDispose = false,
	/** Runs as each child runtime is being created, before it exists. */
	creatingRuntime?: () => Promise<void>,
	managerOptions: Pick<SubagentManagerOptions, "delegationLimits" | "subagentContext"> = {},
	/** The parent conversation's working directory: the harness temp dir by default. */
	cwd?: string,
): Promise<Setup> {
	const childCwds: string[] = [];
	const children: Harness[] = [];
	const resourceLoader = (): ResourceLoader => ({
		...createTestResourceLoader({ systemPrompt: "You are a test assistant." }),
		getSubagents: () => ({ definitions: [definition], diagnostics: [] }),
	});
	const createRuntime: ConversationFactory = async ({ cwd, sessionManager }) => {
		childCwds.push(cwd);
		await creatingRuntime?.();
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
		...managerOptions,
	});
	const parent = await createHarness({
		...(agentDir === undefined ? {} : { agentDir }),
		...(cwd === undefined ? {} : { cwd }),
		subagentToolManager: manager,
		extensionFactories: extensions,
		settings: { lsp: { enabled: false }, retry: { enabled: false } },
	});
	cleanups.push(async () => {
		// Join the parent's Git scans before another cleanup removes their working directory.
		await parent.cleanupAsync();
		await manager.dispose().catch(() => undefined);
		for (const child of children) await child.cleanupAsync().catch(() => undefined);
	});
	return { parent, manager, childCwds, children };
}

/** The context of a subagent conversation that may start `worker`, in delegation tree `tree`. */
function subagentContext(tree: SubagentDelegationScope): SubagentRuntimeContext {
	return {
		depth: 1,
		agentName: "coordinator",
		subagentId: "sa_coordinator",
		path: ["coordinator"],
		delegationScope: tree,
		registry: new SubagentRegistry(),
		allowedSubagents: ["worker"],
	};
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

	it("does not start an agent in a managed worktree of a repository enclosing the conversation's", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-extension-subagents-agent-"));
		const outer = mkdtempSync(join(tmpdir(), "volt-extension-subagents-outer-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(outer, { recursive: true, force: true });
		});
		// The conversation runs in `vendor/project`, a repository of its own inside `outer`'s.
		const nested = join(outer, "vendor", "project");
		mkdirSync(nested, { recursive: true });
		commitRepository(outer);
		commitRepository(nested);
		const enclosing = join(getWorktreesRoot(agentDir), "ws", "outer-1");
		const ours = join(getWorktreesRoot(agentDir), "ws", "nested-1");
		git(outer, "worktree", "add", "-b", "volt/outer-1", enclosing);
		git(nested, "worktree", "add", "-b", "volt/nested-1", ours);
		const cwds = [enclosing, ours];
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12", cwd: cwds.shift() ?? "" }));
		const { parent, childCwds } = await setup(
			[delegator.extension],
			undefined,
			agentDir,
			false,
			undefined,
			{},
			nested,
		);

		await parent.session.prompt("/delegate");
		await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([
			`ctx.subagents.start: cwd ${JSON.stringify(enclosing)} is outside the conversation's working directory and its repository's managed worktrees`,
		]);
		expect((await delegator.runs[0]?.ended)?.status).toBe("completed");
		expect(childCwds).toEqual([realpathSync.native(ours)]);
	});

	it("starts an agent in a managed worktree of the repository from a subdirectory or another of its worktrees", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-extension-subagents-agent-"));
		const repository = mkdtempSync(join(tmpdir(), "volt-extension-subagents-repository-"));
		cleanups.push(() => {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(repository, { recursive: true, force: true });
		});
		commitRepository(repository);
		const subdirectory = join(repository, "packages", "app");
		mkdirSync(subdirectory, { recursive: true });
		const first = join(getWorktreesRoot(agentDir), "ws", "issue-12");
		const second = join(getWorktreesRoot(agentDir), "ws", "issue-13");
		git(repository, "worktree", "add", "-b", "volt/issue-12", first);
		git(repository, "worktree", "add", "-b", "volt/issue-13", second);

		const cases: Array<[conversationCwd: string, target: string]> = [
			[subdirectory, first],
			[first, second],
		];
		for (const [conversationCwd, target] of cases) {
			const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12", cwd: target }));
			const { parent, childCwds } = await setup(
				[delegator.extension],
				undefined,
				agentDir,
				false,
				undefined,
				{},
				conversationCwd,
			);

			await parent.session.prompt("/delegate");
			expect(delegator.errors).toEqual([]);
			expect((await delegator.runs[0]?.ended)?.status).toBe("completed");
			expect(childCwds).toEqual([realpathSync.native(target)]);
		}
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

	it.each([2_147_483_648, 2_592_000_000])(
		"rejects an overflowing duration of %s before starting a child",
		async (maxDurationMs) => {
			const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12", limits: { maxDurationMs } }));
			const { parent, childCwds } = await setup([delegator.extension]);

			await parent.session.prompt("/delegate");
			expect(delegator.errors).toEqual(["ctx.subagents.start: limits.maxDurationMs must be at most 2147483647ms"]);
			expect(delegator.runs).toEqual([]);
			expect(childCwds).toEqual([]);
			expect(parent.session.work.list()).toEqual([]);
		},
	);

	it("accepts the maximum finite duration", async () => {
		const delegator = delegating(() => ({
			agent: "worker",
			task: "Work issue 12",
			limits: { maxDurationMs: 2_147_483_647 },
		}));
		const { parent } = await setup([delegator.extension]);

		await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([]);
		expect((await delegator.runs[0]?.ended)?.status).toBe("completed");
	});

	it("stops a run at its limits", async () => {
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12", limits: { maxDurationMs: 50 } }));
		const { parent } = await setup([delegator.extension], [heldUntilAborted]);
		// Task admission may take longer than the deadline on a busy host; advance it only after admission.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([]);
		const [run] = delegator.runs;
		if (!run) throw new Error("The delegator did not start its run");
		await vi.advanceTimersByTimeAsync(49);
		expect(parent.session.work.get(run.id)?.outcome).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect((await run.ended).status).toBe("cancelled");
	});

	it("stops a run at its limits inside a subagent's conversation, counting it in the subagent's tree", async () => {
		const tree = new SubagentDelegationScope();
		cleanups.push(() => tree.dispose());
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12", limits: { maxDurationMs: 50 } }));
		const { parent } = await setup([delegator.extension], [heldUntilAborted], undefined, false, undefined, {
			subagentContext: subagentContext(tree),
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([]);
		const [run] = delegator.runs;
		if (!run) throw new Error("The delegator did not start its run");
		await vi.advanceTimersByTimeAsync(49);
		expect(tree.snapshot()).toMatchObject({ startsUsed: 1, activeDescendants: 1, aborted: false });
		await vi.advanceTimersByTimeAsync(1);
		expect((await run.ended).status).toBe("cancelled");
		// The run's limit stopped it alone: the subagent's tree counted it and keeps running.
		expect(tree.snapshot()).toMatchObject({ startsUsed: 1, activeDescendants: 0, aborted: false });
	});

	it("keeps a run within the host's limits when it asks for looser ones", async () => {
		const delegator = delegating(() => ({
			agent: "worker",
			task: "Work issue 12",
			limits: { maxDurationMs: 3_600_000 },
		}));
		const { parent } = await setup([delegator.extension], [heldUntilAborted], undefined, false, undefined, {
			delegationLimits: { maxDurationMs: 50 },
		});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		await parent.session.prompt("/delegate");
		expect(delegator.errors).toEqual([]);
		const [run] = delegator.runs;
		if (!run) throw new Error("The delegator did not start its run");
		await vi.advanceTimersByTimeAsync(49);
		expect(parent.session.work.get(run.id)?.outcome).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect((await run.ended).status).toBe("cancelled");
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

	it("cancels its runs when it is disabled", async () => {
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12" }));
		const { parent } = await setup([delegator.extension], [heldUntilAborted]);

		await parent.session.prompt("/delegate");
		const [run] = delegator.runs;
		if (!run) throw new Error(`no run: ${delegator.errors.join("; ")}`);
		parent.session.settingsManager.setExtensionEnabled("delegator", "global", false);
		expect((await run.ended).status).toBe("cancelled");
		await parent.session.extensionRegistry.settled();
		await parent.session.work.waitForIdle();
		expect(parent.session.work.get(run.id)?.outcome).toBe("cancelled");
	});

	it("stops a run still starting when it is disabled: the child takes no task", async () => {
		const delegator = delegating(() => ({ agent: "worker", task: "Work issue 12" }));
		const creating = Promise.withResolvers<void>();
		const created = Promise.withResolvers<void>();
		const { parent, childCwds, children } = await setup(
			[delegator.extension],
			undefined,
			undefined,
			false,
			async () => {
				creating.resolve();
				await created.promise;
			},
		);
		const instance = parent.session.extensionRegistry.instance("delegator");
		if (!instance) throw new Error("The delegator does not run");

		// The extension is disabled while its child's runtime is still being created.
		const delegated = parent.session.prompt("/delegate");
		await creating.promise;
		parent.session.settingsManager.setExtensionEnabled("delegator", "global", false);
		await vi.waitFor(() => expect(instance.lifetime.stopped).toBe(true));
		created.resolve();
		await delegated;

		expect(delegator.errors).toEqual([
			"ctx.subagents.start: extension delegator was disabled while the run started; it was cancelled",
		]);
		expect(delegator.runs).toEqual([]);
		expect(childCwds).toHaveLength(1);
		// No work was recorded, and the child's model was never asked.
		expect(parent.session.work.list().filter((item) => item.kind === "subagent")).toEqual([]);
		expect(children.map((child) => child.faux.state.callCount)).toEqual([0]);
		await parent.session.extensionRegistry.settled();
	});

	it("keeps work-detail actions for its own subagents, but not other extensions' or unowned runs", async () => {
		const foreign = delegating(() => ({ agent: "worker", task: "Another extension's task" }));
		const runs: ExtensionSubagentRun[] = [];
		let parentWorkId = "";
		let context: ExtensionCommandContext | undefined;
		const orchestrator: CreateTestExtensionsResultInput = {
			id: "orchestrator",
			permissions: ["exec"],
			factory: (volt) => {
				volt.registerWorkKind("loop", {
					cancelOnAbort: false,
					detail: (work) => ({
						type: "card",
						title: work.title,
						actions: [work.workId, work.progress?.text, ...(Array.isArray(work.input) ? work.input : [])]
							.filter((id): id is string => typeof id === "string")
							.flatMap((workId) =>
								["open_work", "cancel_work"].map((type) => ({
									id: `${type}-${workId}`,
									label: type,
									intent: { type, input: { workId } },
								})),
							),
					}),
				});
				volt.registerCommand("orchestrate", {
					handler: async (args, ctx) => {
						context = ctx;
						await ctx.startWork("loop", { title: "Orchestrate issues", input: args.split(" ") }, async (work) => {
							parentWorkId = work.workId;
							const run = await ctx.subagents.start({
								agent: "worker",
								task: "Work issue 12",
								parentWorkId: work.workId,
							});
							runs.push(run);
							work.progress({ text: run.id });
							await run.ended;
							return { outcome: "completed" };
						});
					},
				});
			},
		};
		const { parent, manager } = await setup([foreign.extension, orchestrator], [heldUntilAborted]);
		await parent.session.prompt("/delegate");
		const foreignRun = foreign.runs[0];
		if (!foreignRun) throw new Error(`no foreign run: ${foreign.errors.join("; ")}`);
		const unowned = await manager.startRun("worker", "Host task");

		await parent.session.prompt(`/orchestrate ${foreignRun.id} ${unowned.workId} not-mine`);
		await vi.waitFor(() => expect(runs).toHaveLength(1));
		const run = runs[0];
		if (!run || !context) throw new Error("The orchestrator did not start its run");
		await vi.waitFor(() =>
			expect(parent.session.liveState.get(`work/${parentWorkId}`)).toMatchObject({
				kind: "work",
				detail: {
					type: "card",
					actions: [parentWorkId, run.id].flatMap((workId) =>
						["open_work", "cancel_work"].map((type) => ({
							id: `${type}-${workId}`,
							label: type,
							intent: { type, input: { workId } },
						})),
					),
				},
			}),
		);
		// UI ownership does not make a subagent work of an extension's own kind.
		await expect(
			context.subagents.start({ agent: "worker", task: "Invalid parent", parentWorkId: run.id }),
		).rejects.toThrow("parentWorkId must be work of the extension's own kinds");

		await context.subagents.cancel(run.id);
		expect((await run.ended).status).toBe("cancelled");
		await foreign.ctx().subagents.cancel(foreignRun.id);
		await manager.cancelRun(unowned.workId);
		await parent.session.work.waitForIdle();
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

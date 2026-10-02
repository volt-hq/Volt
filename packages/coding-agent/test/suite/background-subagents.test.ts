import { setImmediate } from "node:timers/promises";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, type JsonObject } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { BackgroundJobSnapshot } from "../../src/core/background-jobs.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	createBuiltInSubagentDefinitions,
	SubagentDelegationScope,
	SubagentManager,
	type SubagentManagerOptions,
	SubagentRegistry,
} from "../../src/core/subagents/index.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import * as nativeTools from "../../src/core/tools/index.ts";
import { getBackgroundJobResultSnapshots } from "../../src/core/tools/jobs.ts";
import { createSubagentTool } from "../../src/core/tools/subagent.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup(
	options: {
		beforeRuntimeCreate?: () => Promise<void>;
		onRuntimeCreated?: SubagentManagerOptions["onRuntimeCreated"];
		retainRuntimeOnDispose?: boolean;
		subagentContext?: SubagentManagerOptions["subagentContext"];
		childResponses?: FauxResponseStep[];
		childTools?: string[];
	} = {},
) {
	const parentFixture = await createHarness({ settings: { lsp: { enabled: false }, retry: { enabled: false } } });
	const children: Harness[] = [];
	const runtimes: AgentSessionRuntime[] = [];
	const scopes: SubagentDelegationScope[] = [];
	const finish = deferred();
	const childInputs: string[] = [];
	const signals: AbortSignal[] = [];
	const definitions = createBuiltInSubagentDefinitions();
	const resourceLoader = {
		...createTestResourceLoader(),
		getSubagents: () => ({ definitions, diagnostics: [] }),
	};
	const parentManager = SessionManager.inMemory(parentFixture.tempDir);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, subagentContext }) => {
		if (subagentContext) scopes.push(subagentContext.delegationScope);
		await options.beforeRuntimeCreate?.();
		const child = await createHarness({ settings: { lsp: { enabled: false }, retry: { enabled: false } } });
		children.push(child);
		child.setResponses(
			options.childResponses ?? [
				async (context, options) => {
					childInputs.push(
						context.messages
							.filter((message) => message.role === "user")
							.map(getMessageText)
							.join("\n"),
					);
					const signal = options?.signal;
					if (signal) signals.push(signal);
					let abort!: () => void;
					try {
						await Promise.race([
							finish.promise,
							new Promise<void>((resolve) => {
								abort = resolve;
								signal?.addEventListener("abort", abort, { once: true });
								if (signal?.aborted) abort();
							}),
						]);
						return fauxAssistantMessage("child report");
					} finally {
						signal?.removeEventListener("abort", abort);
					}
				},
			],
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
		services.settingsManager.applyOverrides({ lsp: { enabled: false }, retry: { enabled: false } });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: child.getModel(),
			...(options.childTools ? { tools: options.childTools } : { noTools: "all" }),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const manager = new SubagentManager({
		createRuntime,
		cwd: parentFixture.tempDir,
		agentDir: parentFixture.tempDir,
		resourceLoader,
		parentSessionManager: parentManager,
		requestTimeoutMs: 5_000,
		retainRuntimeOnDispose: options.retainRuntimeOnDispose,
		subagentContext: options.subagentContext,
		onRuntimeCreated: (event) => {
			runtimes.push(event.runtime);
			return options.onRuntimeCreated?.(event);
		},
	});
	const { session } = await createAgentSession({
		cwd: parentFixture.tempDir,
		agentDir: parentFixture.tempDir,
		resourceLoader,
		sessionManager: parentManager,
		model: parentFixture.getModel(),
		authStorage: parentFixture.authStorage,
		settingsManager: parentFixture.settingsManager,
		subagentToolManager: manager,
		disableMcp: true,
		tools: [...new Set(["read", "subagent", "jobs", ...(options.childTools ?? [])])],
	});
	session.setSessionName("Background subagent test");
	return {
		session,
		parentFixture,
		manager,
		finish,
		childInputs,
		signals,
		runtimes,
		scopes,
		children,
		async cleanup() {
			finish.resolve();
			session.dispose();
			await session.waitForClosed();
			await manager.dispose();
			if (options.retainRuntimeOnDispose) {
				for (const runtime of runtimes) await runtime.dispose();
			}
			for (const child of children) await child.cleanupAsync();
			await parentFixture.cleanupAsync();
		},
	};
}

async function startSubagent(context: Awaited<ReturnType<typeof setup>>, params: JsonObject) {
	const subagent = context.session.state.tools.find((tool) => tool.name === "subagent")!;
	const preflight = await subagent.execute("preflight", params);
	const confirm = /"confirm": "([^"]+)"/.exec(getMessageText(preflight))?.[1];
	if (!confirm) throw new Error("Expected confirmation preflight");
	return subagent.execute("start", { ...params, confirm });
}

function jobSnapshot(result: unknown): BackgroundJobSnapshot {
	const snapshot = getBackgroundJobResultSnapshots((result as { details?: unknown }).details)[0];
	if (!snapshot) throw new Error("Expected background job result");
	return snapshot;
}

describe("native background subagents", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["complete", "abort"] as const)(
		"retains child background ownership after its final text until jobs %s",
		async (operation) => {
			const started = deferred();
			const finish = deferred();
			let signal: AbortSignal | undefined;
			const operations: BashOperations = {
				exec: vi.fn(async (_command, _cwd, options) => {
					signal = options.signal;
					started.resolve();
					await finish.promise;
					if (signal?.aborted) throw new Error("aborted after cleanup");
					options.onData(Buffer.from("child background output"));
					return { exitCode: 0 };
				}),
			};
			const createDefinitions = nativeTools.createAllToolDefinitions;
			vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
				createDefinitions(cwd, { ...options, bash: { ...options?.bash, operations } }),
			);
			const context = await setup({
				retainRuntimeOnDispose: true,
				childTools: ["bash", "jobs"],
				childResponses: [
					fauxAssistantMessage(fauxToolCall("bash", { command: "child background work", background: true }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("Child final report."),
				],
			});
			let abort: Promise<void> | undefined;
			try {
				const params = { agent: "general", task: "own the child background work", background: true };
				const parentJob = jobSnapshot(await startSubagent(context, params));
				await started.promise;
				const child = context.runtimes[0]!.session;
				await child.waitForIdle();
				await setImmediate();
				expect(child.getLastAssistantText()).toBe("Child final report.");
				expect(child.isBusy).toBe(false);
				expect(child.isStreaming).toBe(false);
				expect(child.hasBackgroundJobs).toBe(true);
				expect(signal?.aborted).toBe(false);
				const jobs = context.session.state.tools.find((tool) => tool.name === "jobs")!;
				const childJobs = child.state.tools.find((tool) => tool.name === "jobs")!;
				const childJob = jobSnapshot(child.messages.find((message) => message.role === "toolResult"));
				expect(jobSnapshot(await jobs.execute("parent-running", { action: "read", id: parentJob.id })).status).toBe(
					"running",
				);
				expect(context.manager.listDelegations()[0]?.status).toBe("running");
				expect(context.scopes[0]?.snapshot().activeDescendants).toBe(1);
				const subagent = createSubagentTool(context.parentFixture.tempDir, { manager: context.manager });
				expect(getMessageText(await subagent.execute("duplicate", params))).toContain("already being started");

				const settled = vi.fn();
				if (operation === "abort") {
					abort = context.session.abort().then(settled);
					expect(signal?.aborted).toBe(true);
					await setImmediate();
					expect(settled).not.toHaveBeenCalled();
					expect(context.session.hasBackgroundJobs).toBe(true);
					expect(
						jobSnapshot(await childJobs.execute("child-cancelling", { action: "read", id: childJob.id })).status,
					).toBe("cancelling");
					expect(getMessageText(await subagent.execute("duplicate-cancelling", params))).toContain(
						"already being started",
					);
				}
				if (operation === "complete") {
					context.children[0]!.setResponses([
						fauxAssistantMessage(fauxToolCall("jobs", { action: "read", id: childJob.id }), {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage("Child collected its background output."),
					]);
				}
				finish.resolve();
				await abort;
				const result = jobSnapshot(
					await jobs.execute("parent-done", { action: "wait", ids: [parentJob.id], timeoutMs: 30_000 }),
				);
				expect(result.status).toBe(operation === "abort" ? "cancelled" : "completed");
				if (operation === "complete") expect(result.output).toContain("Child collected its background output.");
				expect(child.hasBackgroundJobs).toBe(false);
				expect(context.session.hasBackgroundJobs).toBe(false);
				expect(context.scopes[0]?.snapshot().activeDescendants).toBe(0);
				expect(context.manager.listDelegations()[0]?.status).toBe(operation === "abort" ? "aborted" : "completed");
				expect(getMessageText(await subagent.execute("released", params))).toMatch(/"confirm": "/);
				expect(context.children[0]?.faux.state.callCount).toBe(operation === "complete" ? 4 : 2);
				// Retention remains intentional after every delegated resource settles.
				context.children[0]!.setResponses([fauxAssistantMessage("Retained runtime is usable.")]);
				await child.prompt("Continue through the retained owner");
				expect(child.getLastAssistantText()).toBe("Retained runtime is usable.");
			} finally {
				finish.resolve();
				await abort;
				await context.cleanup();
			}
		},
	);

	it.each(["task-finally", "late-start"] as const)(
		"holds inherited descendant capacity through %s cancellation cleanup",
		async (phase) => {
			const started = deferred();
			const abortStarted = deferred();
			const releaseCleanup = deferred();
			const releaseStart = deferred();
			const scope = new SubagentDelegationScope({ limits: { maxActiveDescendants: 1 } });
			const operations: BashOperations = {
				exec: vi.fn(async (_command, _cwd, options) => {
					const onAbort = () => abortStarted.resolve();
					options.signal?.addEventListener("abort", onAbort, { once: true });
					started.resolve();
					try {
						await releaseCleanup.promise;
						if (options.signal?.aborted) throw new Error("aborted after cleanup");
						return { exitCode: 0 };
					} finally {
						options.signal?.removeEventListener("abort", onAbort);
					}
				}),
			};
			const createDefinitions = nativeTools.createAllToolDefinitions;
			vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
				createDefinitions(cwd, { ...options, bash: { ...options?.bash, operations } }),
			);
			const context = await setup({
				retainRuntimeOnDispose: true,
				subagentContext: {
					depth: 1,
					agentName: "design-doc",
					subagentId: "sa_parent",
					path: ["design-doc"],
					allowedSubagents: ["general"],
					delegationScope: scope,
					registry: new SubagentRegistry(),
				},
				childTools: ["bash", "jobs"],
				childResponses: [
					fauxAssistantMessage(fauxToolCall("bash", { command: "child background work", background: true }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("Child final report."),
				],
				onRuntimeCreated: async ({ runtime }) => {
					if (phase !== "late-start") return;
					// A host can use the runtime before its factory returns the handle.
					await runtime.session.prompt("Prepare child background work");
					await releaseStart.promise;
				},
			});
			try {
				const subagent = createSubagentTool(context.parentFixture.tempDir, { manager: context.manager });
				const second = { agent: "general", task: "different child request" };
				const before = await subagent.execute("second-before", second);
				const confirm = /"confirm": "([^"]+)"/.exec(getMessageText(before))?.[1];
				if (!confirm) throw new Error("Expected second request confirmation preflight");
				const parentJob = jobSnapshot(
					await startSubagent(context, { agent: "general", task: "own background work", background: true }),
				);
				await started.promise;
				const child = context.runtimes[0]!.session;
				await child.waitForIdle();
				expect(child.hasBackgroundJobs).toBe(true);
				expect(context.manager.isSubagentRuntime()).toBe(true);
				expect(context.scopes[0]).toBe(scope);
				expect(scope.snapshot().activeDescendants).toBe(1);
				const jobs = context.session.state.tools.find((tool) => tool.name === "jobs")!;
				expect(jobSnapshot(await jobs.execute("cancel", { action: "cancel", id: parentJob.id })).status).toBe(
					"cancelling",
				);
				releaseStart.resolve();
				await abortStarted.promise;
				// Let runTask finally and the late-start continuation both reach disposal.
				await setImmediate();
				const nativeSubagent = context.session.state.tools.find((tool) => tool.name === "subagent")!;
				const secondJob = jobSnapshot(
					await nativeSubagent.execute("second-confirm", { ...second, confirm, background: true }),
				);
				await vi.waitFor(async () => {
					const rejected = jobSnapshot(
						await jobs.execute("second-rejected", { action: "read", id: secondJob.id }),
					);
					expect(rejected.status).toBe("failed");
					expect(rejected.output).toContain("Subagent batch admission was rejected. Zero children started.");
				});
				const blocked = await subagent.execute("second-blocked", second);
				expect(blocked.details?.capacity?.fits).toBe(false);
				expect(getMessageText(blocked)).not.toMatch(/"confirm": "/);
				expect(context.runtimes).toHaveLength(1);
				expect(scope.snapshot().activeDescendants).toBe(1);
				expect(scope.signal.aborted).toBe(false);
				const cancelling = jobSnapshot(await jobs.execute("cancelling", { action: "read", id: parentJob.id }));
				expect(cancelling.status).toBe("cancelling");
				expect(cancelling.endedAt).toBeUndefined();
				expect(child.hasBackgroundJobs).toBe(true);

				releaseCleanup.resolve();
				expect(
					jobSnapshot(await jobs.execute("done", { action: "wait", ids: [parentJob.id], timeoutMs: 30_000 }))
						.status,
				).toBe("cancelled");
				expect(child.hasBackgroundJobs).toBe(false);
				expect(scope.snapshot().activeDescendants).toBe(0);
				const available = await subagent.execute("second-available", second);
				expect(available.details?.capacity?.fits).toBe(true);
				expect(getMessageText(available)).toMatch(/"confirm": "/);
				expect(context.children[0]?.faux.state.callCount).toBe(2);
			} finally {
				releaseStart.resolve();
				releaseCleanup.resolve();
				await context.cleanup();
				scope.dispose();
			}
		},
	);

	it.each(["single", "parallel", "chain"] as const)(
		"keeps %s preflight direct, then resumes the idle parent to collect without user input",
		async (mode) => {
			const context = await setup();
			try {
				const params: JsonObject =
					mode === "single"
						? { agent: "general", task: "first task" }
						: mode === "parallel"
							? {
									tasks: [
										{ agent: "general", task: "first task" },
										{ agent: "general", task: "second task" },
									],
								}
							: {
									chain: [
										{ agent: "general", task: "first task" },
										{ agent: "general", task: "Continue from {previous}" },
									],
								};
				context.parentFixture.setResponses([
					fauxAssistantMessage(fauxToolCall("subagent", { ...params, background: true }), {
						stopReason: "toolUse",
					}),
					(providerContext) => {
						expect(context.manager.listDelegations()).toEqual([]);
						const preflight = providerContext.messages.find((message) => message.role === "toolResult");
						const confirm = /"confirm": "([^"]+)"/.exec(getMessageText(preflight))?.[1];
						if (!confirm) throw new Error("Expected confirmation preflight");
						return fauxAssistantMessage(fauxToolCall("subagent", { ...params, background: true, confirm }), {
							stopReason: "toolUse",
						});
					},
					fauxAssistantMessage("Parent work continues."),
				]);
				await context.session.prompt("Delegate independent work");
				expect(context.session.getLastAssistantText()).toBe("Parent work continues.");
				await vi.waitFor(() => expect(context.signals).toHaveLength(mode === "parallel" ? 2 : 1));
				expect(context.signals.every((signal) => !signal.aborted)).toBe(true);
				const result = context.session.messages.filter((message) => message.role === "toolResult").at(-1);
				const job = (result?.details as { backgroundJob: BackgroundJobSnapshot }).backgroundJob;
				expect(job.status).toBe("running");
				context.parentFixture.setResponses([
					fauxAssistantMessage(fauxToolCall("jobs", { action: "read", id: job.id }), { stopReason: "toolUse" }),
					(providerContext) => {
						expect(providerContext.messages.map(getMessageText).join("\n")).toContain("child report");
						return fauxAssistantMessage("Parent collected the child report automatically.");
					},
				]);
				context.finish.resolve();
				await vi.waitFor(() =>
					expect(context.session.getLastAssistantText()).toBe("Parent collected the child report automatically."),
				);
				await context.session.waitForIdle();
				const jobs = context.session.state.tools.find((tool) => tool.name === "jobs")!;
				const collected = await jobs.execute("collect", { action: "wait", ids: [job.id], timeoutMs: 30_000 });
				expect(collected).toMatchObject({
					details: {
						backgroundJobWait: {
							reason: "terminal",
							results: [{ id: job.id, status: "completed", output: expect.stringContaining("child report") }],
							pending: [],
						},
					},
				});
				expect(context.manager.listDelegations()).toHaveLength(mode === "single" ? 1 : 2);
				expect(context.manager.listDelegations().every((record) => record.status === "completed")).toBe(true);
				if (mode === "chain") expect(context.childInputs[1]).toContain("child report");
				expect(context.parentFixture.faux.state.callCount).toBe(5);
			} finally {
				await context.cleanup();
			}
		},
	);

	it.each(["single", "parallel"] as const)(
		"holds cancellation and admission for %s factories and their late cleanup",
		async (mode) => {
			const releaseFactory = deferred();
			const releaseDisposal = deferred();
			const creating = vi.fn(() => releaseFactory.promise);
			const disposing = vi.fn(() => releaseDisposal.promise);
			const context = await setup({
				beforeRuntimeCreate: creating,
				onRuntimeCreated: ({ runtime }) => {
					const dispose = runtime.dispose.bind(runtime);
					vi.spyOn(runtime, "dispose").mockImplementation(async () => {
						await disposing();
						await dispose();
					});
				},
			});
			try {
				const params: JsonObject =
					mode === "single"
						? { agent: "general", task: "blocked factory", background: true }
						: {
								tasks: [
									{ agent: "general", task: "first blocked factory" },
									{ agent: "general", task: "second blocked factory" },
								],
								background: true,
							};
				const job = jobSnapshot(await startSubagent(context, params));
				const count = mode === "single" ? 1 : 2;
				await vi.waitFor(() => expect(creating).toHaveBeenCalledTimes(count));
				const jobs = context.session.state.tools.find((tool) => tool.name === "jobs")!;
				// Inspect shared admission independently of the session's abort barrier.
				const subagent = createSubagentTool(context.parentFixture.tempDir, { manager: context.manager });
				let settled = false;
				const abort = context.session.abort().then(() => {
					settled = true;
				});
				await setImmediate();
				expect(settled).toBe(false);
				const cancelling = jobSnapshot(await jobs.execute("read", { action: "read", id: job.id }));
				expect(cancelling.status).toBe("cancelling");
				expect(cancelling.endedAt).toBeUndefined();
				expect(getMessageText(await subagent.execute("duplicate", params))).toContain("already being started");
				await expect(context.session.setAgentMode("plan")).rejects.toThrow(/abort or wait/);
				await expect(context.session.reload()).rejects.toThrow(/abort or wait/);

				releaseFactory.resolve();
				await vi.waitFor(() => expect(disposing).toHaveBeenCalledTimes(count));
				await setImmediate();
				expect(settled).toBe(false);
				expect(jobSnapshot(await jobs.execute("read-late", { action: "read", id: job.id })).status).toBe(
					"cancelling",
				);
				expect(getMessageText(await subagent.execute("duplicate-late", params))).toContain("already being started");
				await expect(context.session.setAgentMode("plan")).rejects.toThrow(/abort or wait/);
				await expect(context.session.reload()).rejects.toThrow(/abort or wait/);
				expect(context.childInputs).toEqual([]);
				expect(context.manager.listDelegations()).toEqual([]);

				releaseDisposal.resolve();
				await abort;
				expect(jobSnapshot(await jobs.execute("done", { action: "read", id: job.id })).status).toBe("cancelled");
				expect(getMessageText(await subagent.execute("released", params))).toMatch(/"confirm": "/);
				await expect(context.session.setAgentMode("plan")).resolves.toMatchObject({ mode: "plan" });
				await expect(context.session.reload()).resolves.toBeUndefined();
			} finally {
				releaseFactory.resolve();
				releaseDisposal.resolve();
				await context.cleanup();
			}
		},
	);

	it.each(["abort", "close"] as const)(
		"keeps parent %s pending when completed child disposal was already started",
		async (operation) => {
			const disposalStarted = deferred();
			const releaseDisposal = deferred();
			const context = await setup({
				onRuntimeCreated: ({ runtime }) => {
					const dispose = runtime.dispose.bind(runtime);
					vi.spyOn(runtime, "dispose").mockImplementation(async () => {
						disposalStarted.resolve();
						await releaseDisposal.promise;
						await dispose();
					});
				},
			});
			try {
				const job = jobSnapshot(
					await startSubagent(context, {
						agent: "general",
						task: "complete before disposal",
						background: true,
					}),
				);
				context.finish.resolve();
				await disposalStarted.promise;
				const jobs = context.session.state.tools.find((tool) => tool.name === "jobs")!;
				expect(jobSnapshot(await jobs.execute("cancel", { action: "cancel", id: job.id })).status).toBe(
					"cancelling",
				);
				let settled = false;
				if (operation === "close") context.session.dispose();
				const pending = (operation === "close" ? context.session.waitForClosed() : context.session.abort()).then(
					() => {
						settled = true;
					},
				);
				await setImmediate();
				expect(settled).toBe(false);
				if (operation === "abort") {
					const cancelling = jobSnapshot(await jobs.execute("read", { action: "read", id: job.id }));
					expect(cancelling.status).toBe("cancelling");
					expect(cancelling.endedAt).toBeUndefined();
					await expect(context.session.setAgentMode("plan")).rejects.toThrow(/abort or wait/);
					await expect(context.session.reload()).rejects.toThrow(/abort or wait/);
				}
				releaseDisposal.resolve();
				await pending;
				if (operation === "abort") {
					expect(jobSnapshot(await jobs.execute("done", { action: "read", id: job.id })).status).toBe("cancelled");
					await expect(context.session.setAgentMode("plan")).resolves.toMatchObject({ mode: "plan" });
				}
			} finally {
				releaseDisposal.resolve();
				await context.cleanup();
			}
		},
	);

	it.each(["prompt", "abort"] as const)(
		"joins pending child %s work even after the handle is disposed",
		async (phase) => {
			const blocked = deferred();
			const release = deferred();
			const context = await setup();
			const startByName = context.manager.startByName.bind(context.manager);
			vi.spyOn(context.manager, "startByName").mockImplementation(async (name, options) => {
				const handle = await startByName(name, options);
				if (phase === "prompt") {
					const prompt = handle.prompt.bind(handle);
					vi.spyOn(handle, "prompt").mockImplementation(async (message) => {
						blocked.resolve();
						await release.promise;
						await prompt(message);
					});
				} else {
					const abort = handle.abort.bind(handle);
					vi.spyOn(handle, "abort").mockImplementation(async (source) => {
						await abort(source);
						blocked.resolve();
						await release.promise;
					});
				}
				return handle;
			});
			try {
				const job = jobSnapshot(
					await startSubagent(context, {
						agent: "general",
						task: "pending child work",
						background: true,
					}),
				);
				if (phase === "prompt") await blocked.promise;
				else await vi.waitFor(() => expect(context.signals).toHaveLength(1));
				let settled = false;
				const abort = context.session.abort().then(() => {
					settled = true;
				});
				await blocked.promise;
				await setImmediate();
				expect(settled).toBe(false);
				const jobs = context.session.state.tools.find((tool) => tool.name === "jobs")!;
				expect(jobSnapshot(await jobs.execute("read", { action: "read", id: job.id })).status).toBe("cancelling");
				await expect(context.session.setAgentMode("plan")).rejects.toThrow(/abort or wait/);
				await expect(context.session.reload()).rejects.toThrow(/abort or wait/);
				release.resolve();
				await abort;
				expect(jobSnapshot(await jobs.execute("done", { action: "read", id: job.id })).status).toBe("cancelled");
			} finally {
				release.resolve();
				await context.cleanup();
			}
		},
	);

	it.each(["factory", "disposal"] as const)(
		"preserves fast foreground cancellation during blocked %s work",
		async (phase) => {
			const blocked = deferred();
			const release = deferred();
			const context = await setup({
				beforeRuntimeCreate:
					phase === "factory"
						? async () => {
								blocked.resolve();
								await release.promise;
							}
						: undefined,
				onRuntimeCreated: ({ runtime }) => {
					if (phase !== "disposal") return;
					const dispose = runtime.dispose.bind(runtime);
					vi.spyOn(runtime, "dispose").mockImplementation(async () => {
						blocked.resolve();
						await release.promise;
						await dispose();
					});
				},
			});
			try {
				const controller = new AbortController();
				const subagent = createSubagentTool(context.parentFixture.tempDir, { manager: context.manager });
				const params = { agent: "general", task: "foreground work" };
				const preflight = await subagent.execute("preflight", params);
				const confirm = /"confirm": "([^"]+)"/.exec(getMessageText(preflight))?.[1];
				if (!confirm) throw new Error("Expected confirmation preflight");
				const execution = subagent.execute("foreground", { ...params, confirm }, controller.signal);
				const rejected = expect(execution).rejects.toThrow(/aborted/i);
				context.finish.resolve();
				await blocked.promise;
				controller.abort();
				await rejected;
				const jobs = context.session.state.tools.find((tool) => tool.name === "jobs")!;
				expect(await jobs.execute("list", { action: "list" })).toMatchObject({ details: { jobs: [] } });
			} finally {
				release.resolve();
				await context.cleanup();
			}
		},
	);

	it("cancels children when the parent aborts after returning to idle", async () => {
		const context = await setup();
		try {
			const subagent = context.session.state.tools.find((tool) => tool.name === "subagent")!;
			const params = { agent: "general", task: "independent task", background: true };
			const preflight = await subagent.execute("preflight", params);
			const confirm = /"confirm": "([^"]+)"/.exec(getMessageText(preflight))?.[1];
			const result = await subagent.execute("start", { ...params, confirm });
			const job = (result.details as { backgroundJob: BackgroundJobSnapshot }).backgroundJob;
			await vi.waitFor(() => expect(context.signals).toHaveLength(1));
			await context.session.abort();
			expect(context.signals[0].aborted).toBe(true);
			const jobs = context.session.state.tools.find((tool) => tool.name === "jobs")!;
			expect(await jobs.execute("read", { action: "read", id: job.id })).toMatchObject({
				details: { backgroundJob: { status: "cancelled" } },
			});
			await vi.waitFor(() => expect(context.manager.listDelegations()[0]?.status).toBe("aborted"));
		} finally {
			await context.cleanup();
		}
	});
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type {
	ExtensionMode,
	InputEvent,
	PromptRouteEvent,
	PromptRouteResult,
} from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createBuiltInSubagentDefinitions, SubagentManager } from "../../src/core/subagents/index.ts";
import type { SubagentToolManager } from "../../src/core/tools/subagent.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

async function setup(
	options: {
		mode?: ExtensionMode;
		excludeDelegation?: boolean;
		isChild?: boolean;
		toolGate?: boolean;
		sessionManager?: SessionManager;
		input?: (event: InputEvent) => Promise<void>;
		route?: (
			event: PromptRouteEvent,
			fixture: Harness,
		) => PromptRouteResult | undefined | Promise<PromptRouteResult | undefined>;
		beforeCreate?: () => Promise<void>;
		beforeDispose?: () => Promise<void>;
	} = {},
) {
	let manager: SubagentManager;
	let fixture: Harness;
	const children: AgentSession[] = [];
	const definitions = createBuiltInSubagentDefinitions();
	const start = vi.fn<SubagentToolManager["startByName"]>((name, options) => manager.startByName(name, options));
	const proxy: SubagentToolManager = {
		getDefinition: (name) => {
			const definition = definitions.find((entry) => entry.name === name);
			if (!definition) throw new Error("Unknown definition");
			return definition;
		},
		listAvailableDefinitions: () => definitions,
		isSubagentRuntime: () => options.isChild ?? false,
		createDelegationScope: (options) => manager.createDelegationScope(options),
		startByName: start,
		ensureRegistryHydrated: () => manager.ensureRegistryHydrated(),
		listDelegations: () => manager.listDelegations(),
		dispose: () => manager.dispose(),
	};
	const route = vi.fn(async (event: PromptRouteEvent) =>
		options.route
			? options.route(event, fixture)
			: {
					agent: "general",
					model: `${fixture.getModel().provider}/worker`,
					task: "Create the PR for the completed committed changes.",
				},
	);
	fixture = await createHarness({
		models: [{ id: "primary" }, { id: "worker" }],
		settings: { lsp: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } },
		subagentToolManager: proxy,
		initialActiveToolNames: ["read", "subagent"],
		sessionManager: options.sessionManager,
		...(options.excludeDelegation ? { excludedToolNames: ["subagent"] } : {}),
		extensionFactories: [
			(volt) => {
				volt.on("prompt_route", route);
				if (options.input) volt.on("input", options.input);
				if (options.toolGate) volt.on("tool_call", () => ({ block: true, reason: "Host gate" }));
			},
		],
	});
	fixture.session.setSessionName("Routing parent");
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
		await options.beforeCreate?.();
		sessionManager.appendSessionInfo("Routing worker");
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: fixture.authStorage,
			modelRegistry: fixture.session.modelRegistry,
			settingsManager: fixture.settingsManager,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, model: fixture.getModel() });
		children.push(created.session);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	manager = new SubagentManager({
		createRuntime,
		cwd: fixture.tempDir,
		agentDir: fixture.tempDir,
		parentSessionManager: fixture.sessionManager,
		resourceLoader: { ...fixture.session.resourceLoader, getSubagents: () => ({ definitions, diagnostics: [] }) },
		onRuntimeCreated: ({ runtime }) => {
			if (!options.beforeDispose) return;
			const dispose = runtime.dispose.bind(runtime);
			vi.spyOn(runtime, "dispose").mockImplementation(async () => {
				await options.beforeDispose?.();
				await dispose();
			});
		},
	});
	await fixture.session.bindExtensions({ mode: options.mode ?? "tui" });
	return { fixture, manager, start, route, children, definitions, cleanup: () => fixture.cleanupAsync() };
}

describe("host-owned prompt routing", () => {
	it("runs only the selected worker, preserves primary configuration, and persists a bounded attributed report", async () => {
		const context = await setup();
		const { fixture } = context;
		try {
			const primary = fixture.session.model;
			const defaults = fixture.settingsManager.getDefaultModel();
			fixture.sessionManager.appendMessage({ role: "user", content: "PRIVATE_PARENT_HISTORY", timestamp: 1 });
			fixture.setResponses([
				(input) => {
					expect(input.messages.map(getMessageText).join("\n")).not.toContain("PRIVATE_PARENT_HISTORY");
					return fauxAssistantMessage("PR created: https://github.test/repo/pull/1");
				},
			]);
			await fixture.session.prompt("Create a PR for the completed changes");
			expect(context.start).toHaveBeenCalledOnce();
			expect(fixture.faux.state.callCount).toBe(1);
			expect(context.children[0].model?.id).toBe("worker");
			expect(context.children[0].getActiveToolNames()).toEqual(["read"]);
			expect(fixture.session.model).toEqual(primary);
			expect(fixture.settingsManager.getDefaultModel()).toBe(defaults);
			expect(fixture.session.messages.filter((message) => message.role === "assistant")).toEqual([]);
			const result = fixture.session.messages.at(-1);
			expect(getMessageText(result)).toContain("https://github.test/repo/pull/1");
			expect(result).toMatchObject({
				role: "custom",
				customType: "prompt-delegation",
				details: {
					status: "completed",
					model: `${primary?.provider}/worker`,
					usage: { tokens: expect.any(Object) },
				},
			});
			expect(fixture.eventsOfType("agent_start")).toHaveLength(1);
			expect(fixture.eventsOfType("agent_end")).toHaveLength(1);
			expect(fixture.eventsOfType("agent_settled")).toHaveLength(1);
			expect(fixture.session.isBusy).toBe(false);
			fixture.setResponses([fauxAssistantMessage("Primary answers the next request")]);
			context.route.mockResolvedValueOnce(undefined);
			await fixture.session.prompt("Explain the implementation");
			expect(fixture.session.getLastAssistantText()).toBe("Primary answers the next request");
		} finally {
			await context.cleanup();
		}
	});

	it("routes to a named agent with its own model, max thinking, and instructions without changing the parent", async () => {
		const context = await setup();
		const { fixture } = context;
		try {
			const primary = fixture.session.model;
			const defaults = fixture.settingsManager.getDefaultModel();
			const defaultThinking = fixture.settingsManager.getDefaultThinkingLevel();
			fixture.session.modelRegistry.registerProvider(fixture.getModel().provider, {
				api: fixture.faux.api,
				baseUrl: fixture.getModel().baseUrl,
				apiKey: "faux-key",
				models: fixture.faux.models.map((model) => ({
					...model,
					reasoning: true,
					thinkingLevelMap: { max: "max" },
				})),
			});
			const definition = {
				...createBuiltInSubagentDefinitions()[0]!,
				name: "pr",
				description: "Dedicated PR worker",
				model: `${fixture.getModel().provider}/worker`,
				thinking: "max",
				systemPrompt: "Dedicated PR workflow: publish existing committed changes only.",
			};
			context.definitions.push(definition);
			context.route.mockImplementation(async (event) => {
				const agent = event.agents.find((agent) => agent.name === "pr");
				expect(agent).toEqual({
					name: definition.name,
					description: definition.description,
					model: definition.model,
				});
				return { agent: definition.name, model: definition.model, task: "Create the PR" };
			});
			fixture.setResponses([
				(input) => {
					expect(input.systemPrompt).toContain(definition.systemPrompt);
					return fauxAssistantMessage("PR URL");
				},
			]);
			await fixture.session.prompt("Create a PR");
			expect(context.start).toHaveBeenCalledWith("pr", expect.objectContaining({ model: definition.model }));
			expect(fixture.faux.state.callCount).toBe(1);
			expect(context.children[0].model?.id).toBe("worker");
			expect(context.children[0].thinkingLevel).toBe("max");
			expect(fixture.session.model).toEqual(primary);
			expect(fixture.session.thinkingLevel).toBe("off");
			expect(fixture.settingsManager.getDefaultModel()).toBe(defaults);
			expect(fixture.settingsManager.getDefaultThinkingLevel()).toBe(defaultThinking);
			expect(fixture.session.messages.at(-1)).toMatchObject({ details: { agent: "pr", status: "completed" } });
		} finally {
			await context.cleanup();
		}
	});

	it.each(["abstain", "unknown-model", "same-model", "unknown-agent", "error"] as const)(
		"falls back before dispatch on %s",
		async (kind) => {
			const context = await setup({
				route: (_event, fixture) => {
					if (kind === "abstain") return undefined;
					if (kind === "error") throw new Error("Synthetic router outage");
					return {
						agent: kind === "unknown-agent" ? "missing" : "general",
						model:
							kind === "unknown-model"
								? "missing/worker"
								: `${fixture.getModel().provider}/${kind === "same-model" ? "primary" : "worker"}`,
						task: "Create the PR",
					};
				},
			});
			try {
				context.fixture.setResponses([fauxAssistantMessage("Primary handled it")]);
				await context.fixture.session.prompt("Create a PR");
				expect(context.start).not.toHaveBeenCalled();
				expect(context.fixture.faux.state.callCount).toBe(1);
				expect(context.fixture.session.getLastAssistantText()).toBe("Primary handled it");
			} finally {
				await context.cleanup();
			}
		},
	);

	it.each(["rpc", "json", "print"] as const)("never routes in %s mode", async (mode) => {
		const context = await setup({ mode });
		try {
			context.fixture.setResponses([fauxAssistantMessage("Ordinary turn")]);
			await context.fixture.session.prompt("Create a PR");
			expect(context.route).not.toHaveBeenCalled();
			expect(context.start).not.toHaveBeenCalled();
		} finally {
			await context.cleanup();
		}
	});

	it.each(["plan", "excluded", "child", "images", "rpc-source", "extension-source", "queued-context"] as const)(
		"keeps %s input out of routing",
		async (kind) => {
			const context = await setup({ excludeDelegation: kind === "excluded", isChild: kind === "child" });
			try {
				if (kind === "plan") await context.fixture.session.setAgentMode("plan");
				if (kind === "queued-context")
					await context.fixture.session.sendCustomMessage(
						{ customType: "aside", content: "Keep this context", display: false },
						{ deliverAs: "nextTurn" },
					);
				context.fixture.setResponses([fauxAssistantMessage("Ordinary turn")]);
				await context.fixture.session.prompt("Create a PR", {
					...(kind === "rpc-source" ? { source: "rpc" as const } : {}),
					...(kind === "extension-source" ? { source: "extension" as const } : {}),
					...(kind === "images"
						? {
								images: [
									{
										type: "image" as const,
										mimeType: "image/png",
										data: "YQ==",
									},
								],
							}
						: {}),
				});
				expect(context.route).not.toHaveBeenCalled();
				expect(context.start).not.toHaveBeenCalled();
			} finally {
				await context.cleanup();
			}
		},
	);

	it("cancels classification without calling either provider or starting a child", async () => {
		const entered = Promise.withResolvers<AbortSignal>();
		const release = Promise.withResolvers<void>();
		const context = await setup({
			route: async (event, fixture) => {
				entered.resolve(event.signal);
				await release.promise;
				return { agent: "general", model: `${fixture.getModel().provider}/worker`, task: "Create PR" };
			},
		});
		try {
			const prompt = context.fixture.session.prompt("Create a PR");
			const rejection = expect(prompt).rejects.toThrow(/aborted/i);
			const signal = await entered.promise;
			expect(context.fixture.session.isStreaming).toBe(true);
			await expect(
				context.fixture.session.navigateTree(context.fixture.sessionManager.getLeafId()!),
			).rejects.toThrow(/abort or wait/);
			const abort = context.fixture.session.abort();
			expect(signal.aborted).toBe(true);
			release.resolve();
			await rejection;
			await abort;
			expect(context.start).not.toHaveBeenCalled();
			expect(context.fixture.faux.state.callCount).toBe(0);
		} finally {
			release.resolve();
			await context.cleanup();
		}
	});

	it.each(["abort", "dispose"] as const)(
		"joins late startup during %s and does not publish work afterward",
		async (operation) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const context = await setup({
				beforeCreate: async () => {
					entered.resolve();
					await release.promise;
				},
			});
			try {
				const session = context.fixture.session;
				const prompt = session.prompt("Create a PR");
				await entered.promise;
				expect(session.isStreaming).toBe(true);
				await expect(session.setAgentMode("plan")).rejects.toThrow(/abort or wait/);
				await expect(session.reload()).rejects.toThrow(/abort or wait/);
				await expect(session.compact()).rejects.toThrow(/abort or wait/);
				await expect(session.steer("Do not publish")).rejects.toThrow(/stop/);
				await expect(session.followUp("Do another thing")).rejects.toThrow(/wait/);
				await expect(session.prompt("Do not publish", { streamingBehavior: "steer" })).rejects.toThrow(
					/routed worker/,
				);
				let settled = false;
				if (operation === "dispose") session.dispose();
				const closing = (operation === "dispose" ? session.waitForClosed() : session.abort()).then(() => {
					settled = true;
				});
				await setImmediate();
				expect(settled).toBe(false);
				release.resolve();
				await prompt;
				await closing;
				expect(context.fixture.faux.state.callCount).toBe(0);
				expect(context.manager.listDelegations()).toEqual([]);
				if (operation === "abort")
					expect(session.messages.at(-1)).toMatchObject({ details: { status: "aborted" } });
				else
					expect(context.fixture.sessionManager.getEntries().at(-1)).toMatchObject({
						type: "custom_message",
						customType: "prompt-delegation",
						details: { status: "aborted" },
					});
			} finally {
				release.resolve();
				await context.cleanup();
			}
		},
	);

	it("holds abort through worker cleanup and does not wake the primary model", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const context = await setup({
			beforeDispose: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		try {
			context.fixture.setResponses([fauxAssistantMessage("PR URL")]);
			const prompt = context.fixture.session.prompt("Create a PR");
			await entered.promise;
			let settled = false;
			const abort = context.fixture.session.abort().then(() => {
				settled = true;
			});
			await setImmediate();
			expect(settled).toBe(false);
			release.resolve();
			await prompt;
			await abort;
			expect(context.fixture.faux.state.callCount).toBe(1);
			expect(context.fixture.session.messages.at(-1)).toMatchObject({ details: { status: "aborted" } });
		} finally {
			release.resolve();
			await context.cleanup();
		}
	});

	it.each(["stop", "tool-policy", "extension-gate"] as const)("does not bypass %s policies", async (kind) => {
		const context = await setup({ toolGate: kind === "extension-gate" });
		try {
			const unregister =
				kind === "stop"
					? context.fixture.session.registerTurnPolicy({ nextAction: () => ({ type: "stop" }) })
					: kind === "tool-policy"
						? context.fixture.session.registerTurnPolicy({
								beforeToolCall: () => ({ block: true, reason: "Denied" }),
							})
						: undefined;
			context.fixture.setResponses([fauxAssistantMessage("Primary flow")]);
			await context.fixture.session.prompt("Create a PR");
			expect(context.route).not.toHaveBeenCalled();
			expect(context.start).not.toHaveBeenCalled();
			unregister?.();
		} finally {
			await context.cleanup();
		}
	});

	it.each(["abort", "revoke-tools", "install-policy"] as const)(
		"cancels an executing worker on %s",
		async (operation) => {
			const entered = Promise.withResolvers<AbortSignal>();
			const context = await setup();
			let unregister: (() => void) | undefined;
			try {
				context.fixture.setResponses([
					async (_input, options) => {
						const signal = options?.signal;
						if (!signal) throw new Error("Expected worker cancellation signal");
						entered.resolve(signal);
						await new Promise<void>((resolve) => {
							if (signal.aborted) resolve();
							else signal.addEventListener("abort", () => resolve(), { once: true });
						});
						return fauxAssistantMessage("Cancelled worker");
					},
				]);
				const prompt = context.fixture.session.prompt("Create a PR");
				const signal = await entered.promise;
				if (operation === "revoke-tools") context.fixture.session.setActiveToolsByName(["read"]);
				else if (operation === "install-policy")
					unregister = context.fixture.session.registerTurnPolicy({ nextAction: () => ({ type: "stop" }) });
				else await context.fixture.session.abort();
				await prompt;
				expect(signal.aborted).toBe(true);
				expect(context.fixture.faux.state.callCount).toBe(1);
				expect(context.fixture.session.messages.at(-1)).toMatchObject({ details: { status: "aborted" } });
			} finally {
				unregister?.();
				await context.cleanup();
			}
		},
	);

	it("bounds a large worker report while preserving the child transcript", async () => {
		const context = await setup();
		try {
			const output = `${"漢".repeat(12_000)}\nlast line`;
			context.fixture.setResponses([fauxAssistantMessage(output)]);
			await context.fixture.session.prompt("Create a PR");
			const report = getMessageText(context.fixture.session.messages.at(-1));
			expect(Buffer.byteLength(report)).toBeLessThan(25_000);
			expect(report).toContain("Report truncated");
			expect((await context.manager.followDelegation(context.manager.listDelegations()[0]!.id)).output).toBe(output);
		} finally {
			await context.cleanup();
		}
	});

	it("rejects input whose async preflight overlaps route admission", async () => {
		const first = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const creating = Promise.withResolvers<void>();
		const releaseChild = Promise.withResolvers<void>();
		const context = await setup({
			input: async (event) => {
				if (event.text === "Create a PR") {
					first.resolve();
					await releaseFirst.promise;
				} else {
					second.resolve();
					await releaseSecond.promise;
				}
			},
			beforeCreate: async () => {
				creating.resolve();
				await releaseChild.promise;
			},
		});
		try {
			const prompt = context.fixture.session.prompt("Create a PR");
			await first.promise;
			const correction = context.fixture.session.prompt("Do not publish", { streamingBehavior: "steer" });
			const rejected = expect(correction).rejects.toThrow(/routed worker/);
			await second.promise;
			releaseFirst.resolve();
			await creating.promise;
			releaseSecond.resolve();
			await rejected;
			expect(context.fixture.session.pendingMessageCount).toBe(0);
			const abort = context.fixture.session.abort();
			releaseChild.resolve();
			await prompt;
			await abort;
			expect(context.fixture.faux.state.callCount).toBe(0);
		} finally {
			releaseFirst.resolve();
			releaseSecond.resolve();
			releaseChild.resolve();
			await context.cleanup();
		}
	});

	it("does not route or infer after tree navigation revokes a preflight reservation", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const context = await setup({
			input: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		try {
			const prompt = context.fixture.session.prompt("Create a PR");
			const rejected = expect(prompt).rejects.toThrow(/aborted/i);
			await entered.promise;
			await context.fixture.session.navigateTree(context.fixture.sessionManager.getLeafId()!);
			release.resolve();
			await rejected;
			expect(context.route).not.toHaveBeenCalled();
			expect(context.fixture.faux.state.callCount).toBe(0);
		} finally {
			release.resolve();
			await context.cleanup();
		}
	});

	it("recovers a completed child when the parent report could not be committed", async () => {
		const dir = await mkdtemp(join(tmpdir(), "volt-route-recovery-"));
		const parent = await SessionManager.create(dir);
		const context = await setup({ sessionManager: parent });
		let reopened: SessionManager | undefined;
		let recovered: SubagentManager | undefined;
		try {
			const append = parent.appendCustomMessageEntry.bind(parent);
			const failResult = vi
				.spyOn(parent, "appendCustomMessageEntry")
				.mockImplementation((type, content, display, details) => {
					const metadata: unknown = details;
					if (
						type === "prompt-delegation" &&
						metadata &&
						typeof metadata === "object" &&
						"status" in metadata &&
						metadata.status === "completed"
					) {
						throw new Error("Simulated interruption before parent report");
					}
					return append(type, content, display, details);
				});
			context.fixture.setResponses([fauxAssistantMessage("Recovered PR URL")]);
			await expect(context.fixture.session.prompt("Create a PR")).rejects.toThrow(/Simulated interruption/);
			failResult.mockRestore();
			await parent.flush();
			expect(parent.getSubagentSpawnEntries()).toHaveLength(1);
			reopened = await SessionManager.open(parent.getSessionRef()!);
			recovered = new SubagentManager({
				cwd: context.fixture.tempDir,
				agentDir: context.fixture.tempDir,
				parentSessionManager: reopened,
				createRuntime: async () => {
					throw new Error("Recovery must not restart a worker");
				},
			});
			await recovered.ensureRegistryHydrated();
			const records = recovered.listDelegations();
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ status: "completed", hydrated: true });
			expect(records[0].stranded).not.toBe(true);
			expect((await recovered.followDelegation(records[0].id)).output).toBe("Recovered PR URL");
			expect(context.fixture.faux.state.callCount).toBe(1);
		} finally {
			await recovered?.dispose();
			await reopened?.closePersistence();
			await context.cleanup();
			await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});

	it("records worker failure without falling back or repeating external actions", async () => {
		const context = await setup();
		try {
			context.fixture.setResponses([
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic worker failure" }),
			]);
			await context.fixture.session.prompt("Create a PR");
			expect(context.fixture.faux.state.callCount).toBe(1);
			expect(context.fixture.session.messages.at(-1)).toMatchObject({ details: { status: "failed" } });
			expect(context.fixture.session.isBusy).toBe(false);
		} finally {
			await context.cleanup();
		}
	});
});

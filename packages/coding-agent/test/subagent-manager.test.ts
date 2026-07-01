import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxModelDefinition,
	type FauxResponseStep,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type SubagentRuntimeContext,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ResourceDiagnostic, ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	type SubagentDefinition,
	SubagentDefinitionConfigurationError,
	SubagentDefinitionNotFoundError,
	SubagentManager,
	type SubagentRuntimeCreatedEvent,
} from "../src/core/subagents/index.ts";
import { createTestResourceLoader } from "./utilities.ts";

interface TestManagerContext {
	manager: SubagentManager;
	getDisposedSessionCount(): number;
}

interface CreateTestManagerOptions {
	responseText?: string;
	responses?: FauxResponseStep[];
	models?: FauxModelDefinition[];
	initialModelId?: string;
	noTools?: "all" | false;
	resourceLoader?: ResourceLoader;
	allowedTools?: string[];
	subagentContext?: SubagentRuntimeContext;
	parentSessionManager?: SessionManager;
	retainRuntimeOnDispose?: boolean;
	onRuntimeCreated?: (event: SubagentRuntimeCreatedEvent) => void | Promise<void>;
	onCreateRuntime?: (subagentContext: SubagentRuntimeContext | undefined) => void;
}

function createDefinition(
	overrides: Partial<SubagentDefinition> & Pick<SubagentDefinition, "name">,
): SubagentDefinition {
	const filePath = join(tmpdir(), `${overrides.name}.md`);
	return {
		name: overrides.name,
		description: overrides.description ?? `${overrides.name} description`,
		systemPrompt: overrides.systemPrompt ?? `${overrides.name} instructions`,
		source: overrides.source ?? "user",
		sourceInfo: overrides.sourceInfo ?? createSyntheticSourceInfo(filePath, { source: "local", scope: "user" }),
		filePath,
		...(overrides.tools ? { tools: overrides.tools } : {}),
		...(overrides.excludedTools ? { excludedTools: overrides.excludedTools } : {}),
		...(overrides.allowedSubagents ? { allowedSubagents: overrides.allowedSubagents } : {}),
		...(overrides.maxSubagentDepth !== undefined ? { maxSubagentDepth: overrides.maxSubagentDepth } : {}),
		...(overrides.maxChildAgents !== undefined ? { maxChildAgents: overrides.maxChildAgents } : {}),
		...(overrides.model ? { model: overrides.model } : {}),
		...(overrides.thinking ? { thinking: overrides.thinking } : {}),
	};
}

function createSubagentResourceLoader(
	definitions: SubagentDefinition[],
	diagnostics: ResourceDiagnostic[] = [],
): ResourceLoader {
	return {
		...createTestResourceLoader(),
		getSubagents: () => ({ definitions, diagnostics }),
	};
}

describe("SubagentManager", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createTestManager(options: CreateTestManagerOptions = {}): Promise<TestManagerContext> {
		const tempDir = join(tmpdir(), `subagent-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({ models: options.models });
		if (options.models) {
			writeFileSync(
				join(tempDir, "models.json"),
				JSON.stringify({
					providers: {
						[faux.getModel().provider]: {
							api: faux.api,
							baseUrl: "http://localhost:0",
							apiKey: "faux-key",
							models: options.models,
						},
					},
				}),
				"utf-8",
			);
		}
		faux.setResponses(options.responses ?? [fauxAssistantMessage(options.responseText ?? "child complete")]);
		const initialModel = options.initialModelId ? faux.getModel(options.initialModelId) : faux.getModel();
		if (!initialModel) {
			throw new Error(`Missing faux model ${options.initialModelId}`);
		}

		const authStorage = AuthStorage.inMemory();
		for (const model of faux.models) {
			authStorage.setRuntimeApiKey(model.provider, "faux-key");
		}
		let disposedSessionCount = 0;

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
			subagentContext,
		}) => {
			options.onCreateRuntime?.(subagentContext);
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				authStorage,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: initialModel,
				...(options.noTools === false ? {} : { noTools: options.noTools ?? "all" }),
			});
			const originalDispose = result.session.dispose.bind(result.session);
			result.session.dispose = () => {
				disposedSessionCount += 1;
				originalDispose();
			};
			return {
				...result,
				services,
				diagnostics: services.diagnostics,
			};
		};

		const manager = new SubagentManager({
			createRuntime,
			cwd: tempDir,
			agentDir: tempDir,
			resourceLoader: options.resourceLoader,
			allowedTools: options.allowedTools,
			...(options.subagentContext ? { subagentContext: options.subagentContext } : {}),
			parentSessionManager: options.parentSessionManager,
			retainRuntimeOnDispose: options.retainRuntimeOnDispose,
			onRuntimeCreated: options.onRuntimeCreated,
			requestTimeoutMs: 5_000,
		});

		cleanups.push(async () => {
			await manager.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return {
			manager,
			getDisposedSessionCount: () => disposedSessionCount,
		};
	}

	it("creates an isolated child and exposes its session id", async () => {
		const { manager } = await createTestManager();
		const handle = await manager.start();

		expect(handle.id).toMatch(/^sa_/);
		expect(handle.sessionId).toBeTruthy();
		await expect(handle.getState()).resolves.toMatchObject({ sessionId: handle.sessionId });
	});

	it("persists child sessions beside a persisted parent and records the parent session", async () => {
		const parentRoot = join(tmpdir(), `subagent-manager-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(parentRoot, { recursive: true });
		cleanups.push(() => {
			if (existsSync(parentRoot)) {
				rmSync(parentRoot, { recursive: true, force: true });
			}
		});
		const parentSessionManager = SessionManager.create(parentRoot, join(parentRoot, "sessions"));
		parentSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "parent prompt" }],
			timestamp: 1,
		});
		const parentSessionFile = parentSessionManager.getSessionFile();
		const { manager } = await createTestManager({ parentSessionManager, responseText: "persisted child" });
		const handle = await manager.start();

		const completion = handle.waitForEnd();
		await handle.prompt("write child transcript");
		await completion;
		const stats = await handle.getSessionStats();

		expect(stats.sessionFile).toBeTruthy();
		if (!stats.sessionFile) {
			throw new Error("expected persisted child session file");
		}
		expect(stats.sessionFile.startsWith(parentSessionManager.getSessionDir())).toBe(true);
		const headerLine = readFileSync(stats.sessionFile, "utf-8").split("\n")[0];
		if (!headerLine) {
			throw new Error("expected child session header");
		}
		const header = JSON.parse(headerLine) as { id?: string; parentSession?: string; type?: string };
		expect(header).toMatchObject({ type: "session", id: handle.sessionId, parentSession: parentSessionFile });
		const reopened = SessionManager.open(stats.sessionFile);
		expect(reopened.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant")).toBe(
			true,
		);
	});

	it("emits runtime-created metadata and can retain child runtimes after loopback dispose", async () => {
		const events: SubagentRuntimeCreatedEvent[] = [];
		const { manager, getDisposedSessionCount } = await createTestManager({
			retainRuntimeOnDispose: true,
			onRuntimeCreated: (event) => {
				events.push(event);
			},
		});
		const handle = await manager.start();

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ id: handle.id, sessionId: handle.sessionId });

		await handle.dispose();
		expect(getDisposedSessionCount()).toBe(0);

		await events[0]?.runtime.dispose();
		expect(getDisposedSessionCount()).toBe(1);
	});

	it("prompts the child and waits for terminal agent_end", async () => {
		const { manager } = await createTestManager({ responseText: "child result text" });
		const handle = await manager.start();

		const completion = handle.waitForEnd();
		await handle.prompt("run child task");
		const result = await completion;

		expect(result.id).toBe(handle.id);
		expect(result.sessionId).toBe(handle.sessionId);
		expect(result.event.type).toBe("agent_end");
		expect(result.event.willRetry).toBe(false);

		const transcript = await handle.getTranscript();
		expect(transcript.sessionId).toBe(handle.sessionId);
		expect(
			transcript.items.some((item) => item.role === "assistant" && item.text.includes("child result text")),
		).toBe(true);
	});

	it("starts by definition name and applies the definition body as child prompt context", async () => {
		let observedSystemPrompt: string | undefined;
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "scout", systemPrompt: "Always answer as the scout subagent.", tools: ["read"] }),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			noTools: false,
			responses: [
				(context) => {
					observedSystemPrompt = context.systemPrompt;
					return fauxAssistantMessage(
						context.systemPrompt?.includes("scout subagent") ? "scout prompt observed" : "prompt missing",
					);
				},
			],
		});

		const handle = await manager.startByName("scout");
		const completion = handle.waitForEnd();
		await handle.prompt("use definition body");
		await completion;

		expect(observedSystemPrompt).toContain("Always answer as the scout subagent.");
		const transcript = await handle.getTranscript();
		expect(transcript.items.some((item) => item.role === "assistant" && item.text === "scout prompt observed")).toBe(
			true,
		);
	});

	it("intersects definition tools with the inherited allowed tool policy", async () => {
		let observedToolNames: string[] = [];
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "worker", tools: ["read", "bash", "write"] }),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			allowedTools: ["read", "grep"],
			noTools: false,
			responses: [
				(context) => {
					observedToolNames = context.tools?.map((tool) => tool.name).sort() ?? [];
					return fauxAssistantMessage("tools captured");
				},
			],
		});

		const handle = await manager.startByName("worker");
		const completion = handle.waitForEnd();
		await handle.prompt("list tools");
		await completion;

		expect(observedToolNames).toEqual(["read"]);
	});

	it("inherits allowed tools then removes definition excluded tools", async () => {
		let observedToolNames: string[] = [];
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "general", excludedTools: ["subagent"] }),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			allowedTools: ["read", "subagent", "write"],
			noTools: false,
			responses: [
				(context) => {
					observedToolNames = context.tools?.map((tool) => tool.name).sort() ?? [];
					return fauxAssistantMessage("tools captured");
				},
			],
		});

		const handle = await manager.startByName("general");
		const completion = handle.waitForEnd();
		await handle.prompt("list tools");
		await completion;

		expect(observedToolNames).toEqual(["read", "write"]);
	});

	it("passes definition delegation policy to the child runtime context", async () => {
		const observedContexts: Array<SubagentRuntimeContext | undefined> = [];
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({
				name: "researcher",
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 3,
				maxChildAgents: 2,
			}),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			onCreateRuntime: (context) => {
				observedContexts.push(context);
			},
		});

		const handle = await manager.startByName("researcher");

		expect(observedContexts).toEqual([
			{
				depth: 1,
				agentName: "researcher",
				path: ["researcher"],
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 3,
				maxChildAgents: 2,
			},
		]);
		await handle.dispose();
	});

	it("passes nested delegation paths to child runtime context", async () => {
		const observedContexts: Array<SubagentRuntimeContext | undefined> = [];
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({
				name: "researcher",
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 3,
				maxChildAgents: 2,
			}),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			subagentContext: {
				depth: 1,
				agentName: "design-doc",
				path: ["design-doc"],
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 3,
				maxChildAgents: 8,
			},
			onCreateRuntime: (context) => {
				observedContexts.push(context);
			},
		});

		const handle = await manager.startByName("researcher");

		expect(observedContexts).toEqual([
			{
				depth: 2,
				agentName: "researcher",
				path: ["design-doc", "researcher"],
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 3,
				maxChildAgents: 2,
			},
		]);
		await handle.dispose();
	});

	it("clamps child max depth to the inherited ancestor cap", async () => {
		const observedContexts: Array<SubagentRuntimeContext | undefined> = [];
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({
				name: "researcher",
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 5,
				maxChildAgents: 2,
			}),
			createDefinition({
				name: "analyst",
				allowedSubagents: ["researcher"],
				maxChildAgents: 2,
			}),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			subagentContext: {
				depth: 1,
				agentName: "design-doc",
				path: ["design-doc"],
				allowedSubagents: ["researcher", "analyst"],
				maxSubagentDepth: 2,
				maxChildAgents: 8,
			},
			onCreateRuntime: (context) => {
				observedContexts.push(context);
			},
		});

		const researcher = await manager.startByName("researcher");
		const analyst = await manager.startByName("analyst");

		expect(observedContexts).toEqual([
			{
				depth: 2,
				agentName: "researcher",
				path: ["design-doc", "researcher"],
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 2,
				maxChildAgents: 2,
			},
			{
				depth: 2,
				agentName: "analyst",
				path: ["design-doc", "analyst"],
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 2,
				maxChildAgents: 2,
			},
		]);
		await researcher.dispose();
		await analyst.dispose();
	});

	it("blocks delegated subagent names outside the current policy", async () => {
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "researcher" }),
			createDefinition({ name: "approved-child" }),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			subagentContext: {
				depth: 1,
				agentName: "security-reviewer",
				path: ["security-reviewer"],
				allowedSubagents: ["approved-child"],
				maxSubagentDepth: 3,
				maxChildAgents: 2,
			},
		});

		await expect(manager.startByName("researcher")).rejects.toThrow("Allowed subagents: approved-child");
		const handle = await manager.startByName("approved-child");
		await handle.dispose();
	});

	it("blocks unnamed delegated child runtimes from subagent contexts", async () => {
		const { manager } = await createTestManager({
			subagentContext: {
				depth: 1,
				agentName: "researcher",
				path: ["researcher"],
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 3,
				maxChildAgents: 2,
			},
		});

		await expect(manager.start()).rejects.toThrow("cannot start unnamed child subagents");
	});

	it("blocks all named delegation when no child subagents are allowed", async () => {
		const resourceLoader = createSubagentResourceLoader([createDefinition({ name: "researcher" })]);
		const { manager } = await createTestManager({
			resourceLoader,
			subagentContext: {
				depth: 1,
				agentName: "general",
				path: ["general"],
				allowedSubagents: [],
				maxChildAgents: 0,
			},
		});

		await expect(manager.startByName("researcher")).rejects.toThrow("no child subagents are allowed");
	});

	it("blocks delegation after max depth is reached", async () => {
		const resourceLoader = createSubagentResourceLoader([createDefinition({ name: "researcher" })]);
		const { manager } = await createTestManager({
			resourceLoader,
			subagentContext: {
				depth: 2,
				agentName: "researcher",
				path: ["design-doc", "researcher"],
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 2,
				maxChildAgents: 2,
			},
		});

		await expect(manager.startByName("researcher")).rejects.toThrow("maxSubagentDepth 2 reached");
	});

	it("blocks delegation after max child count is reached", async () => {
		const resourceLoader = createSubagentResourceLoader([createDefinition({ name: "researcher" })]);
		const { manager } = await createTestManager({
			resourceLoader,
			subagentContext: {
				depth: 1,
				agentName: "researcher",
				path: ["researcher"],
				allowedSubagents: ["researcher"],
				maxSubagentDepth: 3,
				maxChildAgents: 1,
			},
		});

		const handle = await manager.startByName("researcher");
		await expect(manager.startByName("researcher")).rejects.toThrow("cannot start more than 1 child subagent");
		await handle.dispose();
	});

	it("applies definition model and thinking before the child starts", async () => {
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "planner", model: "specialist-model", thinking: "high" }),
		]);
		const { manager } = await createTestManager({
			resourceLoader,
			models: [
				{ id: "base-model", name: "Base", reasoning: false },
				{ id: "specialist-model", name: "Specialist", reasoning: true },
			],
			initialModelId: "base-model",
		});

		const handle = await manager.startByName("planner");
		const state = await handle.getState();

		expect(state.model).toMatchObject({ id: "specialist-model" });
		expect(state.thinkingLevel).toBe("high");
	});

	it("throws clear definition errors when no definitions are present", async () => {
		const resourceLoader = createSubagentResourceLoader([]);
		const { manager, getDisposedSessionCount } = await createTestManager({ resourceLoader });

		await expect(manager.startByName("scout")).rejects.toBeInstanceOf(SubagentDefinitionNotFoundError);
		await expect(manager.startByName("scout")).rejects.toMatchObject({ availableNames: [] });
		expect(getDisposedSessionCount()).toBe(0);
	});

	it("throws clear definition errors for missing names and invalid thinking", async () => {
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "bad-thinking", thinking: "turbo" }),
		]);
		const { manager, getDisposedSessionCount } = await createTestManager({ resourceLoader });

		await expect(manager.startByName("missing")).rejects.toBeInstanceOf(SubagentDefinitionNotFoundError);
		await expect(manager.startByName("missing")).rejects.toMatchObject({
			availableNames: ["bad-thinking"],
		});
		await expect(manager.startByName("bad-thinking")).rejects.toBeInstanceOf(SubagentDefinitionConfigurationError);
		expect(getDisposedSessionCount()).toBe(1);
	});

	it("disposes the child runtime when a definition model is unavailable", async () => {
		const resourceLoader = createSubagentResourceLoader([
			createDefinition({ name: "bad-model", model: "missing-model" }),
		]);
		const { manager, getDisposedSessionCount } = await createTestManager({ resourceLoader });

		await expect(manager.startByName("bad-model")).rejects.toMatchObject({
			name: "SubagentDefinitionConfigurationError",
			field: "model",
		});
		expect(getDisposedSessionCount()).toBe(1);
	});

	it("emits observable child RPC events", async () => {
		const { manager } = await createTestManager();
		const handle = await manager.start();
		const eventTypes: string[] = [];
		handle.onEvent((event) => {
			eventTypes.push(event.type);
		});

		const completion = handle.waitForEnd();
		await handle.prompt("observe child task");
		await completion;

		expect(eventTypes).toContain("agent_start");
		expect(eventTypes).toContain("agent_end");
	});

	it("allows abort calls through the handle", async () => {
		const { manager } = await createTestManager();
		const handle = await manager.start();

		await expect(handle.abort()).resolves.toBeUndefined();
	});

	it("disposes the child runtime through the RPC client", async () => {
		const { manager, getDisposedSessionCount } = await createTestManager();
		const handle = await manager.start();

		await handle.dispose();

		expect(getDisposedSessionCount()).toBe(1);
		await expect(handle.getState()).rejects.toThrow(`Subagent ${handle.id} is disposed`);
		await expect(handle.waitForEnd()).rejects.toThrow(`Subagent ${handle.id} was disposed before completion`);
	});
});

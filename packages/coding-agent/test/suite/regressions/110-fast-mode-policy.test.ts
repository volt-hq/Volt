import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { type FauxProviderRegistration, type Model, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { THINKING_FAST_MODE_ACTION_ID } from "../../../src/core/host-actions.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { getUiActionDescriptors } from "../../../src/core/rpc/ui-actions.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../utilities.ts";

interface TestRuntime {
	session: AgentSession;
	manager: SessionManager;
	settings: SettingsManager;
	modelRegistry: ModelRegistry;
	faux: FauxProviderRegistration;
	tempDir: string;
}

const runtimes: TestRuntime[] = [];

function registerModels(
	provider: "openai" | "openai-codex",
	models: Array<{ id: string; reasoning: boolean }>,
): { faux: FauxProviderRegistration; modelRegistry: ModelRegistry } {
	const faux = registerFauxProvider({
		provider,
		api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
		models,
	});
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(provider, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	return { faux, modelRegistry };
}

async function createRuntime(options: {
	provider: "openai" | "openai-codex";
	models?: Array<{ id: string; reasoning: boolean }>;
	manager?: SessionManager;
	modelRegistry?: ModelRegistry;
	faux?: FauxProviderRegistration;
	explicitModel?: Model<string>;
	explicitThinking?: ThinkingLevel;
	settings?: SettingsManager;
	tempDir?: string;
}): Promise<TestRuntime> {
	const tempDir = options.tempDir ?? mkdtempSync(join(tmpdir(), "volt-issue-110-"));
	const registered =
		options.modelRegistry && options.faux
			? { modelRegistry: options.modelRegistry, faux: options.faux }
			: registerModels(
					options.provider,
					options.models ?? [{ id: `${options.provider}-reasoning`, reasoning: true }],
				);
	const manager = options.manager ?? SessionManager.create(tempDir, tempDir);
	const settings = options.settings ?? SettingsManager.inMemory({ defaultThinkingLevel: "medium" });
	const created = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: manager,
		settingsManager: settings,
		modelRegistry: registered.modelRegistry,
		authStorage: registered.modelRegistry.authStorage,
		resourceLoader: createTestResourceLoader(),
		disableMcp: true,
		model: options.explicitModel,
		thinkingLevel: options.explicitThinking,
		noTools: "all",
	});
	const runtime = {
		session: created.session,
		manager,
		settings,
		modelRegistry: registered.modelRegistry,
		faux: registered.faux,
		tempDir,
	};
	runtimes.push(runtime);
	return runtime;
}

function fastDescriptorEnabled(session: AgentSession): boolean | undefined {
	return getUiActionDescriptors(session, "primary").find((action) => action.id === THINKING_FAST_MODE_ACTION_ID)?.state
		?.value as boolean | undefined;
}

function settingsSnapshot(settings: SettingsManager): object {
	return {
		activeProfile: settings.getActiveProfile(),
		global: settings.getGlobalSettings(),
		project: settings.getProjectSettings(),
	};
}

afterEach(() => {
	const tempDirs = new Set<string>();
	const fauxProviders = new Set<FauxProviderRegistration>();
	while (runtimes.length > 0) {
		const runtime = runtimes.pop()!;
		runtime.session.dispose();
		tempDirs.add(runtime.tempDir);
		fauxProviders.add(runtime.faux);
	}
	for (const faux of fauxProviders) faux.unregister();
	for (const tempDir of tempDirs) rmSync(tempDir, { recursive: true, force: true });
});

describe("issue #110: durable Fast mode policy", () => {
	it.each(["openai", "openai-codex"] as const)(
		"restores enabled/base state for %s sessions and disables back to the base",
		async (provider: "openai" | "openai-codex") => {
			const first = await createRuntime({ provider, explicitThinking: "high" });
			expect(first.session.model?.api).toBe(provider === "openai" ? "openai-responses" : "openai-codex-responses");

			first.session.setFastModeEnabled(true);
			expect(first.session.fastModeEnabled).toBe(true);
			expect(first.session.baseThinkingLevel).toBe("high");
			expect(first.session.thinkingLevel).toBe("off");
			expect(first.settings.getDefaultThinkingLevel()).toBe("medium");
			const sessionFile = first.manager.getSessionFile()!;
			first.session.dispose();

			const resumedManager = SessionManager.open(sessionFile, first.tempDir);
			const resumed = await createRuntime({
				provider,
				manager: resumedManager,
				modelRegistry: first.modelRegistry,
				faux: first.faux,
				settings: first.settings,
				tempDir: first.tempDir,
			});
			expect(resumed.session.fastModeEnabled).toBe(true);
			expect(resumed.session.baseThinkingLevel).toBe("high");
			expect(resumed.session.thinkingLevel).toBe("off");
			expect(fastDescriptorEnabled(resumed.session)).toBe(true);

			resumed.session.setFastModeEnabled(false);
			expect(resumed.session.fastModeEnabled).toBe(false);
			expect(resumed.session.thinkingLevel).toBe("high");
			expect(resumed.settings.getDefaultThinkingLevel()).toBe("medium");
		},
	);

	it("treats explicit startup thinking and model overrides as durable Fast invalidations", async () => {
		const first = await createRuntime({ provider: "openai", explicitThinking: "high" });
		first.session.setFastModeEnabled(true);
		const sessionFile = first.manager.getSessionFile()!;
		const initialSettings = settingsSnapshot(first.settings);
		first.session.dispose();

		const thinkingOverride = await createRuntime({
			provider: "openai",
			manager: SessionManager.open(sessionFile, first.tempDir),
			modelRegistry: first.modelRegistry,
			faux: first.faux,
			settings: first.settings,
			tempDir: first.tempDir,
			explicitThinking: "medium",
		});
		expect(thinkingOverride.session.fastModeEnabled).toBe(false);
		expect(thinkingOverride.session.baseThinkingLevel).toBe("medium");
		expect(thinkingOverride.session.thinkingLevel).toBe("medium");
		expect(thinkingOverride.manager.buildSessionContext().fastMode.enabled).toBe(false);

		thinkingOverride.session.setThinkingLevel("high", { persistDefault: false });
		thinkingOverride.session.setFastModeEnabled(true);
		thinkingOverride.session.dispose();
		const modelOverride = await createRuntime({
			provider: "openai",
			manager: SessionManager.open(sessionFile, first.tempDir),
			modelRegistry: first.modelRegistry,
			faux: first.faux,
			settings: first.settings,
			tempDir: first.tempDir,
			explicitModel: first.faux.getModel(),
		});
		expect(modelOverride.session.fastModeEnabled).toBe(false);
		expect(modelOverride.session.baseThinkingLevel).toBe("high");
		expect(modelOverride.session.thinkingLevel).toBe("high");
		expect(modelOverride.manager.buildSessionContext().fastMode.enabled).toBe(false);
		expect(settingsSnapshot(first.settings)).toEqual(initialSettings);
	});

	it("keeps two agent sessions independent across reopen", async () => {
		const sharedSettings = SettingsManager.inMemory({ defaultThinkingLevel: "medium" });
		const first = await createRuntime({ provider: "openai", explicitThinking: "high", settings: sharedSettings });
		const second = await createRuntime({
			provider: "openai-codex",
			explicitThinking: "high",
			settings: sharedSettings,
		});
		first.session.setFastModeEnabled(true);
		second.session.setFastModeEnabled(true);
		second.session.setFastModeEnabled(false);
		const firstFile = first.manager.getSessionFile()!;
		const secondFile = second.manager.getSessionFile()!;
		first.session.dispose();
		second.session.dispose();

		const reopenedFirst = await createRuntime({
			provider: "openai",
			manager: SessionManager.open(firstFile, first.tempDir),
			modelRegistry: first.modelRegistry,
			faux: first.faux,
			settings: sharedSettings,
			tempDir: first.tempDir,
		});
		const reopenedSecond = await createRuntime({
			provider: "openai-codex",
			manager: SessionManager.open(secondFile, second.tempDir),
			modelRegistry: second.modelRegistry,
			faux: second.faux,
			settings: sharedSettings,
			tempDir: second.tempDir,
		});

		expect(reopenedFirst.session.fastModeEnabled).toBe(true);
		expect(reopenedFirst.session.baseThinkingLevel).toBe("high");
		expect(reopenedSecond.session.fastModeEnabled).toBe(false);
		expect(reopenedSecond.session.baseThinkingLevel).toBe("high");
	});

	it("manual thinking and model/scoped-model changes disable Fast from the captured base", async () => {
		const runtime = await createRuntime({
			provider: "openai",
			models: [
				{ id: "reasoning", reasoning: true },
				{ id: "non-reasoning", reasoning: false },
			],
			explicitThinking: "high",
		});
		const reasoningModel = runtime.faux.getModel("reasoning")!;
		const nonReasoningModel = runtime.faux.getModel("non-reasoning")!;
		const initialSettings = settingsSnapshot(runtime.settings);
		const actionStates: boolean[] = [];
		runtime.session.subscribe((event) => {
			if (event.type === "ui_action_state_changed") actionStates.push(event.state.value === true);
		});

		runtime.session.setFastModeEnabled(true);
		runtime.session.setThinkingLevel("off", { persistDefault: false });
		expect(runtime.session.fastModeEnabled).toBe(false);
		expect(runtime.session.baseThinkingLevel).toBe("off");
		expect(runtime.session.thinkingLevel).toBe("off");

		runtime.session.setThinkingLevel("high", { persistDefault: false });
		runtime.session.setFastModeEnabled(true);
		await runtime.session.setModel(reasoningModel, { persistDefault: false });
		expect(runtime.session.fastModeEnabled).toBe(false);
		expect(runtime.session.baseThinkingLevel).toBe("high");
		expect(runtime.session.thinkingLevel).toBe("high");

		runtime.session.setFastModeEnabled(true);
		await runtime.session.setModel(nonReasoningModel, { persistDefault: false });
		expect(runtime.session.fastModeEnabled).toBe(false);
		expect(runtime.session.baseThinkingLevel).toBe("high");
		expect(runtime.session.thinkingLevel).toBe("off");
		await runtime.session.setModel(reasoningModel, { persistDefault: false });
		expect(runtime.session.thinkingLevel).toBe("high");

		runtime.session.setFastModeEnabled(true);
		runtime.session.setScopedModels([{ model: reasoningModel }]);
		expect(runtime.session.fastModeEnabled).toBe(false);
		expect(runtime.session.thinkingLevel).toBe("high");
		expect(actionStates).toEqual([true, false, true, false, true, false, true, false]);
		expect(settingsSnapshot(runtime.settings)).toEqual(initialSettings);
	});

	it("makes a same-effective explicit thinking choice the new base after model clamping", async () => {
		const runtime = await createRuntime({
			provider: "openai",
			models: [
				{ id: "reasoning", reasoning: true },
				{ id: "non-reasoning", reasoning: false },
			],
			explicitThinking: "high",
		});
		const reasoningModel = runtime.faux.getModel("reasoning")!;
		const nonReasoningModel = runtime.faux.getModel("non-reasoning")!;

		await runtime.session.setModel(nonReasoningModel, { persistDefault: false });
		expect(runtime.session.thinkingLevel).toBe("off");
		expect(runtime.session.baseThinkingLevel).toBe("high");

		runtime.session.setThinkingLevel("off", { persistDefault: false });
		expect(runtime.session.baseThinkingLevel).toBe("off");
		expect(runtime.manager.buildSessionContext().fastMode).toEqual({
			enabled: false,
			baseThinkingLevel: "off",
		});

		await runtime.session.setModel(reasoningModel, { persistDefault: false });
		expect(runtime.session.thinkingLevel).toBe("off");
		expect(runtime.session.baseThinkingLevel).toBe("off");
	});

	it("uses the fastest supported target and performs no write when already there", async () => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		Object.assign(runtime.session.model!, { thinkingLevelMap: { off: null, minimal: null } });
		runtime.session.setFastModeEnabled(true);
		expect(runtime.session.thinkingLevel).toBe("low");
		runtime.session.setFastModeEnabled(false);
		runtime.session.setThinkingLevel("low", { persistDefault: false });
		const entryCount = runtime.manager.getEntries().length;
		const events: AgentSessionEvent[] = [];
		runtime.session.subscribe((event) => events.push(event));

		expect(() => runtime.session.setFastModeEnabled(true)).toThrow(/fastest supported thinking level/);
		expect(runtime.manager.getEntries()).toHaveLength(entryCount);
		expect(events).toEqual([]);
	});

	it("restores the selected branch policy before publishing a navigation generation", async () => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		const branchPoint = runtime.manager.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
		runtime.session.agent.state.messages = runtime.manager.buildSessionContext().messages;
		const generationSnapshots: Array<{ enabled: boolean; thinkingLevel: ThinkingLevel }> = [];
		runtime.session.subscribeConversationGenerationChanges(() => {
			generationSnapshots.push({
				enabled: runtime.session.fastModeEnabled,
				thinkingLevel: runtime.session.thinkingLevel,
			});
		});
		runtime.session.setFastModeEnabled(true);
		const enabledLeaf = runtime.manager.getLeafId()!;

		runtime.manager.branch(branchPoint);
		runtime.session.setThinkingLevel("medium", { persistDefault: false });
		expect(runtime.session.fastModeEnabled).toBe(false);

		await runtime.session.navigateTree(enabledLeaf, { summarize: false });

		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.baseThinkingLevel).toBe("high");
		expect(runtime.session.thinkingLevel).toBe("off");
		expect(fastDescriptorEnabled(runtime.session)).toBe(true);
		expect(generationSnapshots).toEqual([{ enabled: true, thinkingLevel: "off" }]);
	});

	it("restores the selected branch model before deriving its Fast thinking target", async () => {
		const runtime = await createRuntime({
			provider: "openai",
			models: [
				{ id: "supports-off", reasoning: true },
				{ id: "starts-at-low", reasoning: true },
			],
			explicitThinking: "high",
		});
		const supportsOff = runtime.modelRegistry.find("openai", "supports-off")!;
		const startsAtLow = runtime.modelRegistry.find("openai", "starts-at-low")!;
		Object.assign(startsAtLow, { thinkingLevelMap: { off: null, minimal: null } });
		const branchPoint = runtime.manager.appendMessage({ role: "user", content: "branch point", timestamp: 1 });
		runtime.session.agent.state.messages = runtime.manager.buildSessionContext().messages;

		runtime.session.setFastModeEnabled(true);
		const supportsOffLeaf = runtime.manager.getLeafId()!;
		runtime.manager.branch(branchPoint);
		await runtime.session.setModel(startsAtLow, { persistDefault: false });
		runtime.session.setFastModeEnabled(true);
		const startsAtLowLeaf = runtime.manager.getLeafId()!;
		expect(runtime.session.thinkingLevel).toBe("low");

		await runtime.session.navigateTree(supportsOffLeaf, { summarize: false });
		expect(runtime.session.model?.id).toBe(supportsOff.id);
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.thinkingLevel).toBe("off");

		await runtime.session.navigateTree(startsAtLowLeaf, { summarize: false });
		expect(runtime.session.model?.id).toBe(startsAtLow.id);
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.thinkingLevel).toBe("low");
	});

	it("keeps runtime state unchanged when the durable Fast commit fails", async () => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		const events: AgentSessionEvent[] = [];
		runtime.session.subscribe((event) => events.push(event));
		vi.spyOn(runtime.manager, "appendFastModeChange").mockImplementation(() => {
			throw new Error("injected append failure");
		});

		expect(() => runtime.session.setFastModeEnabled(true)).toThrow("injected append failure");
		expect(runtime.session.fastModeEnabled).toBe(false);
		expect(runtime.session.baseThinkingLevel).toBe("high");
		expect(runtime.session.thinkingLevel).toBe("high");
		expect(events).toEqual([]);
	});

	it("keeps enabled runtime state unchanged when the durable disable commit fails", async () => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		runtime.session.setFastModeEnabled(true);
		const events: AgentSessionEvent[] = [];
		runtime.session.subscribe((event) => events.push(event));
		vi.spyOn(runtime.manager, "appendFastModeChange").mockImplementation(() => {
			throw new Error("injected disable failure");
		});

		expect(() => runtime.session.setFastModeEnabled(false)).toThrow("injected disable failure");
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(runtime.session.baseThinkingLevel).toBe("high");
		expect(runtime.session.thinkingLevel).toBe("off");
		expect(events).toEqual([]);
	});

	it("publishes one settled action event to every listener after the complete commit", async () => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		const firstEvents: boolean[] = [];
		const secondEvents: boolean[] = [];
		const thinkingSnapshots: boolean[] = [];
		const baselineFastEntries = runtime.manager
			.getEntries()
			.filter((entry) => entry.type === "fast_mode_change").length;
		const baselineThinkingEntries = runtime.manager
			.getEntries()
			.filter((entry) => entry.type === "thinking_level_change").length;
		runtime.session.subscribe((event) => {
			if (event.type === "thinking_level_changed")
				thinkingSnapshots.push(fastDescriptorEnabled(runtime.session) === true);
			if (event.type === "ui_action_state_changed") {
				firstEvents.push(event.state.value === true);
				expect(runtime.manager.buildSessionContext().fastMode).toEqual({
					enabled: true,
					baseThinkingLevel: "high",
				});
			}
		});
		runtime.session.subscribe((event) => {
			if (event.type === "ui_action_state_changed") secondEvents.push(event.state.value === true);
		});

		runtime.session.setFastModeEnabled(true);

		expect(thinkingSnapshots).toEqual([true]);
		expect(firstEvents).toEqual([true]);
		expect(secondEvents).toEqual([true]);
		expect(fastDescriptorEnabled(runtime.session)).toBe(true);
		expect(runtime.manager.getEntries().filter((entry) => entry.type === "fast_mode_change")).toHaveLength(
			baselineFastEntries + 1,
		);
		expect(runtime.manager.getEntries().filter((entry) => entry.type === "thinking_level_change")).toHaveLength(
			baselineThinkingEntries,
		);
	});

	it("does not turn a committed Fast transition into a failure when an event listener throws", async () => {
		const runtime = await createRuntime({ provider: "openai", explicitThinking: "high" });
		const observed: AgentSessionEvent[] = [];
		runtime.session.subscribe(() => {
			throw new Error("injected listener failure");
		});
		runtime.session.subscribe((event) => observed.push(event));

		expect(() => runtime.session.setFastModeEnabled(true)).not.toThrow();
		expect(runtime.session.fastModeEnabled).toBe(true);
		expect(observed.filter((event) => event.type === "ui_action_state_changed")).toHaveLength(1);
	});
});

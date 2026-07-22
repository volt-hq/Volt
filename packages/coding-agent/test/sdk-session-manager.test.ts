import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type FauxProviderRegistration, getModel, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

function toDisplayPath(path: string): string {
	return path.replace(/\\/g, "/");
}

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	const sessions: AgentSession[] = [];
	const fauxProviders: FauxProviderRegistration[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		while (sessions.length > 0) {
			sessions.pop()?.dispose();
		}
		while (fauxProviders.length > 0) {
			fauxProviders.pop()?.unregister();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile ? dirname(sessionFile) : undefined).toBe(expectedSessionDir);

		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("persists a model policy when Fast mode is pre-seeded for a new session", async () => {
		const faux = registerFauxProvider({
			models: [
				{ id: "default-model", reasoning: true },
				{ id: "later-default", reasoning: true },
			],
		});
		fauxProviders.push(faux);
		const model = faux.getModel("default-model")!;
		const laterDefault = faux.getModel("later-default")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});
		const sessionManager = SessionManager.create(cwd, agentDir);
		sessionManager.appendFastModeChange(true);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: model.provider,
				defaultModel: model.id,
			}),
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new" },
			disableMcp: true,
			noTools: "all",
		});
		sessions.push(session);

		expect(session.model?.id).toBe(model.id);
		expect(session.fastModeEnabled).toBe(true);
		expect(sessionManager.buildSessionContext().model).toEqual({
			provider: model.provider,
			modelId: model.id,
		});

		const sessionFile = sessionManager.getSessionFile()!;
		const resumed = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: laterDefault.provider,
				defaultModel: laterDefault.id,
			}),
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.open(sessionFile, agentDir),
			disableMcp: true,
			noTools: "all",
		});
		sessions.push(resumed.session);

		expect(resumed.session.model?.id).toBe(model.id);
		expect(resumed.session.fastModeEnabled).toBe(true);
	});

	it("uses scoped-model bootstrap when Fast mode is pre-seeded for a new session", async () => {
		const faux = registerFauxProvider({
			models: [
				{ id: "default-model", reasoning: true },
				{ id: "scoped-model", reasoning: true },
			],
		});
		fauxProviders.push(faux);
		const defaultModel = faux.getModel("default-model")!;
		const scopedModel = faux.getModel("scoped-model")!;
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(defaultModel.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(defaultModel.provider, {
			baseUrl: defaultModel.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendFastModeChange(true);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.inMemory({
				defaultProvider: defaultModel.provider,
				defaultModel: defaultModel.id,
			}),
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			sessionStartEvent: { type: "session_start", reason: "new" },
			scopedModels: [{ model: scopedModel }],
			disableMcp: true,
			noTools: "all",
		});
		sessions.push(session);

		expect(session.model?.id).toBe(scopedModel.id);
		expect(sessionManager.buildSessionContext().model).toEqual({
			provider: scopedModel.provider,
			modelId: scopedModel.id,
		});
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${toDisplayPath(sessionCwd)}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: process.platform === "win32" ? "pwd -W" : "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});
});

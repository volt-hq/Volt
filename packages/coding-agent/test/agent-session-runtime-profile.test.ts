import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

function getRuntimeProfile(options: Parameters<CreateAgentSessionRuntimeFactory>[0]): string | undefined {
	if (!("profile" in options)) {
		return undefined;
	}
	const profile = options.profile;
	return typeof profile === "string" ? profile : undefined;
}

describe("AgentSessionRuntime profile propagation", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("keeps an interactive profile switch across new session runtime creation", async () => {
		const tempDir = join(tmpdir(), `volt-runtime-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const settings = {
			defaultProfile: "base",
			profiles: {
				base: { theme: "base-theme" },
				switched: { theme: "switched-theme" },
			},
		} satisfies Partial<Settings>;

		let runtimeProfileDuringReplacement: string | undefined;
		const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
			const runtimeProfile = getRuntimeProfile(runtimeOptions);
			if (runtimeOptions.sessionStartEvent?.reason === "new") {
				runtimeProfileDuringReplacement = runtimeProfile;
			}
			const settingsManager = SettingsManager.inMemory(settings, { profile: runtimeProfile });
			const services = await createAgentSessionServices({
				cwd: runtimeOptions.cwd,
				agentDir,
				authStorage,
				settingsManager,
				resourceLoaderOptions: {
					extensionFactories: [
						(volt) => {
							volt.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: runtimeOptions.sessionManager,
					sessionStartEvent: runtimeOptions.sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir,
			sessionManager: SessionManager.create(tempDir),
		});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		expect(runtime.services.settingsManager.getActiveProfile()).toBe("base");
		runtime.services.settingsManager.setActiveProfile("switched");

		await runtime.newSession();

		expect(runtimeProfileDuringReplacement).toBe("switched");
		expect(runtime.services.settingsManager.getActiveProfile()).toBe("switched");
		expect(runtime.services.settingsManager.getTheme()).toBe("switched-theme");
	});
});

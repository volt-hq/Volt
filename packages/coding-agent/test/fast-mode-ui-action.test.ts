import type { Api, Model } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import { type IntentContext, LOCAL_INTENT_PROFILE } from "../src/core/protocol/intents/index.ts";
import {
	getUiActionDescriptors,
	prepareUiActionInvocation,
	type UiActionDiscoverySession,
} from "../src/core/rpc/ui-actions.ts";

const THINKING_FAST_MODE_ACTION_ID = "thinking.fast_mode";

function model(): Model<Api> {
	return {
		id: "gpt-5.4",
		name: "Reasoning",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

/** A session with a Fast mode toggle; `fastModeEnabled` reads the live value. */
function fastModeSession(options: { model: Model<Api>; enabled: boolean }) {
	let fastModeEnabled = options.enabled;
	const setFastModeEnabled = vi.fn(async (enabled: boolean) => {
		fastModeEnabled = enabled;
	});
	const session = {
		isStreaming: false,
		isCompacting: false,
		model: options.model,
		thinkingLevel: "high" as const,
		get fastModeEnabled() {
			return fastModeEnabled;
		},
		setFastModeEnabled,
		extensionRunner: { getRegisteredCommands: () => [] },
		promptTemplates: [],
		resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
		sessionManager: { getCwd: () => "/repo", getOrdinal: () => 0 },
	};
	const context: IntentContext = {
		target: { session, conversation: {}, host: {}, client: {} } as unknown as IntentContext["target"],
		services: {},
		profile: LOCAL_INTENT_PROFILE,
	};
	const descriptor = () =>
		getUiActionDescriptors(session as unknown as UiActionDiscoverySession, "all").find(
			(candidate) => candidate.id === THINKING_FAST_MODE_ACTION_ID,
		);
	const invoke = async (enabled: boolean) =>
		prepareUiActionInvocation(context, { action: THINKING_FAST_MODE_ACTION_ID, args: { enabled } }).run();
	return { session, setFastModeEnabled, descriptor, invoke };
}

describe("Fast mode UI action", () => {
	it("delegates each toggle without changing thinking", async () => {
		const { session, setFastModeEnabled, invoke } = fastModeSession({ model: model(), enabled: false });

		await expect(invoke(true)).resolves.toMatchObject({
			action: THINKING_FAST_MODE_ACTION_ID,
			status: "completed",
			state: { type: "boolean", value: true, label: "Fast mode enabled" },
			stateChanged: true,
		});
		await expect(invoke(false)).resolves.toMatchObject({
			state: { type: "boolean", value: false, label: "Fast mode disabled" },
			stateChanged: true,
		});
		expect(setFastModeEnabled.mock.calls).toEqual([[true], [false]]);
		expect(session.thinkingLevel).toBe("high");
	});

	it("keeps an enabled Fast toggle available after switching to an unsupported model", async () => {
		const { setFastModeEnabled, descriptor, invoke } = fastModeSession({
			model: { ...model(), provider: "anthropic", api: "anthropic-messages" } as Model<Api>,
			enabled: true,
		});

		expect(descriptor()).toMatchObject({
			enabled: true,
			disabledReason: null,
			state: { type: "boolean", value: true, label: "Fast mode enabled" },
		});
		await expect(invoke(true)).resolves.toMatchObject({
			state: { type: "boolean", value: true, label: "Fast mode enabled" },
			stateChanged: false,
			message: "Fast mode already enabled. Priority processing may cost more.",
		});
		await expect(invoke(false)).resolves.toMatchObject({
			state: { type: "boolean", value: false, label: "Fast mode disabled" },
			stateChanged: true,
		});
		expect(setFastModeEnabled.mock.calls).toEqual([[true], [false]]);
		await expect(invoke(true)).rejects.toThrow("Fast mode is not supported for the current provider and model");
	});

	it.each([
		{ provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com", id: "claude" },
		{ provider: "openai", api: "openai-responses", baseUrl: "https://gateway.example/v1", id: "gpt-5.4" },
		{ provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1", id: "gpt-5.4-pro" },
	])("disables Fast for unsupported model $provider/$id at $baseUrl", async (override) => {
		const { descriptor, invoke } = fastModeSession({
			model: { ...model(), ...override } as Model<Api>,
			enabled: false,
		});

		expect(descriptor()).toMatchObject({
			enabled: false,
			disabledReason: "Fast mode is not supported for the current provider and model",
		});
		await expect(invoke(true)).rejects.toThrow("Fast mode is not supported for the current provider and model");
	});
});

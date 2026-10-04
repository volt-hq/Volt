import type { Api, Model } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	type IntentContext,
	intentRegistry,
	intentStateOf,
	LOCAL_INTENT_PROFILE,
} from "../src/core/protocol/intents/index.ts";
import { describeFastModeChange } from "../src/core/protocol/intents/state.ts";

const UNSUPPORTED = { code: "unavailable", message: "Fast mode is not supported for the current provider and model" };

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
		sessionManager: { getOrdinal: () => 0 },
	};
	const context: IntentContext = {
		target: { session, conversation: {}, host: {}, client: {} } as unknown as IntentContext["target"],
		services: {},
		profile: LOCAL_INTENT_PROFILE,
	};
	const descriptor = () =>
		intentRegistry.descriptor(intentRegistry.resolve("set_fast_mode")!, {
			state: intentStateOf(session as unknown as AgentSession),
			services: {},
			profile: LOCAL_INTENT_PROFILE,
		});
	const invoke = async (enabled: boolean) =>
		(await intentRegistry.invoke(context, "set_fast_mode", { enabled })).outcome;
	return { session, setFastModeEnabled, descriptor, invoke };
}

describe("Fast mode intent", () => {
	it("delegates each toggle without changing thinking", async () => {
		const { session, setFastModeEnabled, descriptor, invoke } = fastModeSession({ model: model(), enabled: false });

		await expect(invoke(true)).resolves.toEqual({ requested: true, wasEnabled: false, enabled: true });
		expect(descriptor().state).toEqual({ type: "boolean", value: true, label: "Fast mode enabled" });
		await expect(invoke(false)).resolves.toEqual({ requested: false, wasEnabled: true, enabled: false });
		expect(descriptor().state).toEqual({ type: "boolean", value: false, label: "Fast mode disabled" });
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
			state: { type: "boolean", value: true, label: "Fast mode enabled" },
		});
		expect(descriptor()).not.toHaveProperty("reason");
		const unchanged = await invoke(true);
		expect(unchanged).toEqual({ requested: true, wasEnabled: true, enabled: true });
		expect(describeFastModeChange(unchanged)).toBe("Fast mode already enabled. Priority processing may cost more.");
		await expect(invoke(false)).resolves.toEqual({ requested: false, wasEnabled: true, enabled: false });
		expect(descriptor().state).toEqual({ type: "boolean", value: false, label: "Fast mode disabled" });
		expect(setFastModeEnabled.mock.calls).toEqual([[true], [false]]);
		await expect(invoke(true)).rejects.toMatchObject(UNSUPPORTED);
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

		expect(descriptor()).toMatchObject({ enabled: false, reason: UNSUPPORTED.message });
		await expect(invoke(true)).rejects.toMatchObject(UNSUPPORTED);
	});
});

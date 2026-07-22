import type { Api, Model } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import {
	HostActionRegistry,
	registerBuiltinHostActions,
	THINKING_FAST_MODE_ACTION_ID,
} from "../src/core/host-actions.ts";

function model(): Model<Api> {
	return {
		id: "reasoning",
		name: "Reasoning",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

describe("Fast mode host action", () => {
	it("delegates each toggle without changing thinking", async () => {
		const thinkingLevel = "high" as const;
		let fastModeEnabled = false;
		const setFastModeEnabled = vi.fn((enabled: boolean) => {
			fastModeEnabled = enabled;
		});
		const session = {
			isStreaming: false,
			isCompacting: false,
			model: model(),
			get thinkingLevel() {
				return thinkingLevel;
			},
			get fastModeEnabled() {
				return fastModeEnabled;
			},
		};
		const context = {
			session,
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => ({ summary: "", firstKeptEntryId: "entry", tokensBefore: 0 })),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
			setFastModeEnabled,
		};
		const registry = registerBuiltinHostActions(new HostActionRegistry());

		await expect(registry.invoke(THINKING_FAST_MODE_ACTION_ID, context, { enabled: true })).resolves.toMatchObject({
			action: THINKING_FAST_MODE_ACTION_ID,
			status: "completed",
			state: { type: "boolean", value: true, label: "Fast mode enabled" },
			stateChanged: true,
		});
		await expect(registry.invoke(THINKING_FAST_MODE_ACTION_ID, context, { enabled: false })).resolves.toMatchObject({
			state: { type: "boolean", value: false, label: "Fast mode disabled" },
			stateChanged: true,
		});
		expect(setFastModeEnabled.mock.calls).toEqual([[true], [false]]);
		expect(thinkingLevel).toBe("high");
	});
});

/**
 * The host's own notices: when an Anthropic subscription login bills a
 * conversation's usage as extra usage.
 */

import type { Api, Model } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { isAnthropicSubscriptionAuthKey, usesAnthropicSubscription } from "../src/core/host/host-notices.ts";

function sessionWith(options: {
	readonly stored?: "oauth" | "api_key";
	readonly key?: string;
	readonly warn?: boolean;
}): Pick<AgentSession, "settingsManager" | "modelRegistry"> {
	return {
		settingsManager: { getWarnings: () => ({ anthropicExtraUsage: options.warn }) },
		modelRegistry: {
			authStorage: { get: () => (options.stored === undefined ? undefined : { type: options.stored }) },
			getApiKeyForProvider: async () => options.key,
		},
	} as unknown as Pick<AgentSession, "settingsManager" | "modelRegistry">;
}

const anthropic = { provider: "anthropic", id: "claude" } as Model<Api>;
const other = { provider: "openai", id: "gpt" } as Model<Api>;

describe("Anthropic subscription notices", () => {
	it("recognizes a subscription token", () => {
		expect(isAnthropicSubscriptionAuthKey("sk-ant-oat01-abc")).toBe(true);
		expect(isAnthropicSubscriptionAuthKey("sk-ant-api03-abc")).toBe(false);
		expect(isAnthropicSubscriptionAuthKey(undefined)).toBe(false);
	});

	it("warns for an Anthropic model on a subscription login or token, unless turned off", async () => {
		expect(await usesAnthropicSubscription(sessionWith({ stored: "oauth" }), anthropic)).toBe(true);
		expect(await usesAnthropicSubscription(sessionWith({ key: "sk-ant-oat01-abc" }), anthropic)).toBe(true);
		expect(await usesAnthropicSubscription(sessionWith({ key: "sk-ant-api03-abc" }), anthropic)).toBe(false);
		expect(await usesAnthropicSubscription(sessionWith({ stored: "oauth", warn: false }), anthropic)).toBe(false);
		expect(await usesAnthropicSubscription(sessionWith({ stored: "oauth" }), other)).toBe(false);
		expect(await usesAnthropicSubscription(sessionWith({ stored: "oauth" }), undefined)).toBe(false);
	});
});

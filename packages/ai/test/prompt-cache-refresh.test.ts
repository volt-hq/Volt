import { afterEach, describe, expect, it } from "vitest";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "../src/providers/faux.ts";
import { completeSimple, refreshPromptCache, supportsPromptCacheRefresh } from "../src/stream.ts";
import type { Context, PromptCacheMetadata } from "../src/types.ts";

const renewing: PromptCacheMetadata = {
	modes: ["explicit"],
	retention: { short: { ttlSeconds: 300 } },
	refreshesOnHit: true,
};
const context: Context = {
	systemPrompt: "system",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
	tools: [],
};

let registrations: FauxProviderRegistration[] = [];
afterEach(() => {
	for (const registration of registrations) registration.unregister();
	registrations = [];
});

function register(options: Parameters<typeof registerFauxProvider>[0]): FauxProviderRegistration {
	const registration = registerFauxProvider(options);
	registrations.push(registration);
	return registration;
}

describe("refreshPromptCache", () => {
	it("requires both a provider refresh and a cache that renews on hit", async () => {
		const noRefresh = register({ models: [{ id: "a", promptCache: renewing }] });
		const noRenewal = register({ models: [{ id: "b" }], refreshPromptCache: true });
		const supported = register({ models: [{ id: "c", promptCache: renewing }], refreshPromptCache: true });

		expect(supportsPromptCacheRefresh(noRefresh.getModel())).toBe(false);
		expect(supportsPromptCacheRefresh(noRenewal.getModel())).toBe(false);
		expect(supportsPromptCacheRefresh(supported.getModel())).toBe(true);

		expect(await refreshPromptCache(noRefresh.getModel(), context, { sessionId: "s" })).toMatchObject({
			status: "unsupported",
		});
		expect(await refreshPromptCache(noRenewal.getModel(), context, { sessionId: "s" })).toMatchObject({
			status: "unsupported",
		});
		expect(noRenewal.state.refreshCount).toBe(0);
	});

	it("applies the provider's check to the request options", () => {
		const faux = register({
			models: [{ id: "c", promptCache: renewing }],
			refreshPromptCache: true,
			canRefreshPromptCache: (_model, options) => options?.reasoning === undefined,
		});

		expect(supportsPromptCacheRefresh(faux.getModel())).toBe(true);
		expect(supportsPromptCacheRefresh(faux.getModel(), { reasoning: "high" })).toBe(false);
		expect(supportsPromptCacheRefresh(faux.getModel(), { cacheRetention: "none" })).toBe(false);
	});

	it("reads the prefix the previous request cached without producing output", async () => {
		const faux = register({ models: [{ id: "c", promptCache: renewing }], refreshPromptCache: true });
		faux.setResponses([fauxAssistantMessage("hi")]);
		const first = await completeSimple(faux.getModel(), context, { sessionId: "s" });

		const result = await refreshPromptCache(faux.getModel(), context, { sessionId: "s" });

		expect(first.usage.cacheWrite).toBeGreaterThan(0);
		expect(result).toMatchObject({ status: "refreshed", usage: { output: 0, cacheWrite: 0 } });
		expect(result.status === "refreshed" && result.usage.cacheRead).toBe(first.usage.cacheWrite);
		expect(faux.state).toMatchObject({ callCount: 1, refreshCount: 1 });
	});

	it("does not send a refresh when caching is disabled", async () => {
		const faux = register({ models: [{ id: "c", promptCache: renewing }], refreshPromptCache: true });

		const result = await refreshPromptCache(faux.getModel(), context, { sessionId: "s", cacheRetention: "none" });

		expect(result.status).toBe("unsupported");
		expect(faux.state.refreshCount).toBe(0);
	});
});

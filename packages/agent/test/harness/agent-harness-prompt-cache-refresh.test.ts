import {
	type Context,
	fauxAssistantMessage,
	type PromptCacheMetadata,
	registerFauxProvider,
	type SimpleStreamOptions,
	streamSimple,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import type { AgentHarnessOptions } from "../../src/harness/types.ts";

const renewing: PromptCacheMetadata = {
	modes: ["explicit"],
	retention: { short: { ttlSeconds: 300 } },
	refreshesOnHit: true,
};

const registrations: Array<ReturnType<typeof registerFauxProvider>> = [];
const harnesses: AgentHarness[] = [];

afterEach(async () => {
	const closing = harnesses.splice(0);
	for (const harness of closing) harness.requestClose();
	await Promise.all(closing.map((harness) => harness.waitForClosed()));
	for (const registration of registrations.splice(0)) registration.unregister();
});

function createHarness(options: Omit<AgentHarnessOptions, "env" | "session" | "model"> = {}) {
	const refreshes: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
	const registration = registerFauxProvider({
		models: [{ id: "cache-test", promptCache: renewing, contextWindow: 100_000, maxTokens: 1000 }],
		refreshPromptCache: (context, refreshOptions) => {
			refreshes.push({ context, options: refreshOptions });
			return {
				status: "refreshed",
				usage: {
					availability: "complete",
					input: 0,
					output: 0,
					cacheRead: 42,
					cacheWrite: 0,
					totalTokens: 42,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
		},
	});
	registrations.push(registration);
	const requests: Context[] = [];
	registration.setResponses([
		(context) => {
			requests.push(context);
			return fauxAssistantMessage("first");
		},
	]);
	let credential = 0;
	const session = new Session(new InMemorySessionStorage());
	const harness = new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session,
		model: registration.getModel(),
		systemPrompt: "system prompt",
		getApiKeyAndHeaders: async () => ({ apiKey: `key-${++credential}` }),
		...options,
	});
	harnesses.push(harness);
	return { harness, session, registration, refreshes, requests };
}

describe("AgentHarness.refreshPromptCache", () => {
	it("replays the latest conversation request with a re-resolved credential", async () => {
		const { harness, registration, refreshes, requests } = createHarness();
		await harness.prompt("hello");

		const result = await harness.refreshPromptCache();

		expect(result).toMatchObject({ status: "refreshed", usage: { cacheRead: 42 } });
		expect(result.status === "refreshed" && result.model.id).toBe("cache-test");
		expect(refreshes).toHaveLength(1);
		expect(refreshes[0]!.context).toEqual(requests[0]);
		expect(refreshes[0]!.options?.apiKey).toBe("key-2");
		expect(refreshes[0]!.options?.sessionId).toBeTruthy();
		expect(registration.state).toMatchObject({ callCount: 1, refreshCount: 1 });
	});

	it("sends nothing before a conversation request", async () => {
		const { harness, registration } = createHarness();

		expect(await harness.refreshPromptCache()).toEqual({ status: "unavailable", reason: "no_request" });
		expect(registration.state.refreshCount).toBe(0);
	});

	it("is unavailable when a custom stream function has no matching refresh", async () => {
		const { harness, registration } = createHarness({ streamFn: streamSimple });
		await harness.prompt("hello");

		expect(await harness.refreshPromptCache()).toEqual({ status: "unavailable", reason: "no_refresh_function" });
		expect(registration.state.refreshCount).toBe(0);
	});

	it("sends nothing after the thinking level changes", async () => {
		const { harness, registration } = createHarness();
		await harness.prompt("hello");
		await harness.setThinkingLevel("high");

		expect(await harness.refreshPromptCache()).toEqual({ status: "unavailable", reason: "configuration_changed" });
		expect(registration.state.refreshCount).toBe(0);
	});

	it("sends nothing after compaction rewrites the branch", async () => {
		const { harness, registration } = createHarness();
		await harness.prompt("hello");
		registration.setSimpleResponses([fauxAssistantMessage("summary")]);
		await harness.compact();

		expect(await harness.refreshPromptCache()).toEqual({ status: "unavailable", reason: "branch_changed" });
		expect(registration.state.refreshCount).toBe(0);
	});

	it("appends custom entries immediately when idle and at the save point during a run", async () => {
		const { harness, session, registration } = createHarness();
		await harness.appendCustomEntry("idle-entry", { n: 1 });
		expect((await session.getEntries()).map((entry) => entry.type)).toEqual(["custom"]);

		let queued: Promise<void> | undefined;
		let visibleDuringRun = true;
		registration.setResponses([
			async () => {
				queued = harness.appendCustomEntry("run-entry", { n: 2 });
				await Promise.resolve();
				visibleDuringRun = (await session.getEntries()).some(
					(entry) => entry.type === "custom" && entry.customType === "run-entry",
				);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.prompt("hello");
		await queued;

		expect(visibleDuringRun).toBe(false);
		expect(
			(await session.getEntries()).filter((entry) => entry.type === "custom").map((entry) => entry.customType),
		).toEqual(["idle-entry", "run-entry"]);
	});

	it("stays valid while the branch only grows", async () => {
		const { harness, registration } = createHarness();
		await harness.prompt("hello");
		await harness.appendMessage({ role: "user", content: "appended later", timestamp: 2 });

		expect((await harness.refreshPromptCache()).status).toBe("refreshed");
		expect(registration.state.refreshCount).toBe(1);
	});
});

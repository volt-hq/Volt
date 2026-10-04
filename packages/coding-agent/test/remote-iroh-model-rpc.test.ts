/**
 * Model selection for paired devices on the remote profile: the `models`
 * query, the `set_model` and `set_thinking_level` intents, and the
 * `subscription_usage` query, served by a real conversation host.
 */

import type { SubscriptionUsageResult } from "@hansjm10/volt-ai";
import { createFauxProvider } from "@hansjm10/volt-ai";
import { type HostFrame, REMOTE_CAPABILITIES, type RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

const ALL: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;

describe("Iroh remote model RPC", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(
		options: HostHarnessOptions = {},
	): Promise<{ harness: HostHarness; conversation: HostedConversation }> {
		const harness = await createHostHarness({ whenUnattached: "keep", ...options });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		return { harness, conversation };
	}

	function phone(harness: HostHarness, conversation: HostedConversation): RemotePhone {
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: ALL,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		const device = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await device.close();
		});
		return device;
	}

	test("runs a device's frames only after the conversation's extension session_start bound", async () => {
		const order: string[] = [];
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		let holdSessionStart = false;
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.on("session_start", async () => {
					if (!holdSessionStart) return;
					started.resolve();
					await gate.promise;
					order.push("session_start");
				});
			},
		});
		holdSessionStart = true;
		const device = phone(harness, conversation);
		await device.hello();
		const queryId = "models-1";
		device.send({ type: "query", queryId, query: "models" });
		await started.promise;
		// The connection's lane waits for its client's extension binding: nothing is answered yet.
		expect(device.frames.some((frame) => frame.type === "result" || frame.type === "query_error")).toBe(false);
		gate.resolve();
		await device.waitFor((frame): frame is Frame<"result"> => frame.type === "result" && frame.queryId === queryId);
		order.push("models");
		expect(order).toEqual(["session_start", "models"]);
	});

	test("serves the model catalog, set_model, and set_thinking_level; cycle commands are not intents", async () => {
		const acme = createFauxProvider({
			provider: "acme",
			models: [
				{ id: "model-one", reasoning: true, input: ["text"] },
				{ id: "model-two", reasoning: true, input: ["text", "image"] },
			],
		});
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.registerProvider("acme", {
					baseUrl: acme.getModel().baseUrl,
					apiKey: "acme-key",
					api: acme.api,
					streamSimple: acme.streamSimple,
					models: acme.models.map((model) => ({
						id: model.id,
						name: model.name,
						api: model.api,
						reasoning: model.reasoning,
						input: model.input,
						cost: model.cost,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
					})),
				});
				volt.registerProvider("openai-codex", {
					baseUrl: "https://chatgpt.com/backend-api",
					apiKey: "codex-key",
					api: "openai-codex-responses",
					models: [
						{
							id: "gpt-5.6-sol",
							name: "GPT-5.6 Sol",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128_000,
							maxTokens: 16_384,
						},
					],
				});
			},
		});
		const session = conversation.session;
		const refreshFromDisk = vi.spyOn(session.modelRegistry, "refreshFromDisk");
		const setModel = vi.spyOn(session, "setModel");
		const setThinkingLevel = vi.spyOn(session, "setThinkingLevel");
		const device = phone(harness, conversation);
		await device.hello();
		await device.subscribe(conversation.id);

		const models = await device.query("models");
		const catalogLevels = ["off", "minimal", "low", "medium", "high"];
		expect(models).toMatchObject({
			type: "result",
			data: {
				models: expect.arrayContaining([
					expect.objectContaining({
						provider: "acme",
						id: "model-one",
						availableThinkingLevels: catalogLevels,
						supportsFastMode: false,
						input: ["text"],
					}),
					expect.objectContaining({
						provider: "acme",
						id: "model-two",
						availableThinkingLevels: catalogLevels,
						supportsFastMode: false,
						input: ["text", "image"],
					}),
					expect.objectContaining({ provider: "openai-codex", id: "gpt-5.6-sol", supportsFastMode: true }),
				]),
			},
		});
		expect(refreshFromDisk).toHaveBeenCalled();

		expect(await device.intent("set_model", { provider: "acme", modelId: "model-two" })).toMatchObject({
			type: "accepted",
		});
		// The conversation's model changes alone; the remote intent never persists a default.
		expect(setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "acme", id: "model-two" }), {
			persistDefault: false,
		});
		await device.waitFor(
			(frame): frame is Frame<"entry"> =>
				frame.type === "entry" &&
				frame.entry.type === "model_change" &&
				JSON.stringify(frame.entry.payload) === JSON.stringify({ provider: "acme", modelId: "model-two" }),
		);
		expect(session.model).toMatchObject({ provider: "acme", id: "model-two" });

		expect(await device.intent("set_model", { provider: "acme", modelId: "missing" })).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "Model not found: acme/missing" },
		});

		expect(await device.intent("set_thinking_level", { level: "low" })).toMatchObject({ type: "accepted" });
		expect(setThinkingLevel).toHaveBeenCalledWith("low", { persistDefault: false });
		await device.waitFor(
			(frame): frame is Frame<"entry"> =>
				frame.type === "entry" &&
				frame.entry.type === "thinking_level_change" &&
				JSON.stringify(frame.entry.payload) === JSON.stringify({ thinkingLevel: "low" }),
		);
		expect(session.thinkingLevel).toBe("low");

		// A fresh subscription's snapshot folds the branch's model and thinking level.
		const from = device.frames.length;
		await device.subscribe(conversation.id, "s2");
		const snapshot = await device.waitFor(
			(frame): frame is Frame<"snapshot"> => frame.type === "snapshot" && frame.subscriptionId === "s2",
			{ from },
		);
		expect(snapshot.state).toMatchObject({
			model: { provider: "acme", modelId: "model-two" },
			thinkingLevel: "low",
		});

		for (const type of ["cycle_model", "cycle_thinking_level"]) {
			expect(await device.intent(type)).toMatchObject({
				type: "rejected",
				reason: { code: "unknown_intent", message: `Unknown intent: ${type}` },
			});
		}
	});

	test("returns normalized subscription quota usage to authorized remote clients", async () => {
		const { harness, conversation } = await setup();
		const providerId = `remote-usage-${Date.now()}`;
		const fetchedAt = 1_800_000_000_000;
		const providerResult: SubscriptionUsageResult = {
			status: "success",
			snapshot: {
				providerId,
				fetchedAt,
				plan: "team_plan",
				limits: [
					{
						id: "weekly",
						label: "Weekly",
						usedPercent: 25,
						resetsAt: fetchedAt + 60_000,
					},
				],
			},
		};
		Object.assign(providerResult, { rawPayload: { accountId: "private-account" } });
		Object.assign(providerResult.snapshot, { accountEmail: "private@example.com" });
		Object.assign(providerResult.snapshot.limits[0], { rawProviderWindow: { secret: true } });
		const fetchSubscriptionUsage = vi.fn(async () => providerResult);
		const modelRegistry = conversation.session.modelRegistry;
		modelRegistry.authStorage.set(providerId, {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: 1_900_000_000_000,
		});
		modelRegistry.client.registerOAuthProvider({
			id: providerId,
			name: "Remote Usage",
			async login() {
				throw new Error("Not used in this test");
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
			fetchSubscriptionUsage,
		});
		const device = phone(harness, conversation);
		await device.hello();

		const results = [await device.query("subscription_usage"), await device.query("subscription_usage")];
		for (const result of results) {
			expect(result).toEqual({
				type: "result",
				queryId: result.queryId,
				data: {
					status: "providers",
					providers: [
						{
							providerId,
							result: {
								status: "success",
								snapshot: {
									providerId,
									fetchedAt,
									plan: "team_plan",
									limits: [
										{
											id: "weekly",
											label: "Weekly",
											usedPercent: 25,
											resetsAt: fetchedAt + 60_000,
										},
									],
								},
							},
						},
					],
				},
			});
		}
		const wire = JSON.stringify(device.frames);
		expect(wire).not.toContain("private@example.com");
		expect(wire).not.toContain("private-account");
		expect(wire).not.toContain("rawProviderWindow");
		expect(fetchSubscriptionUsage).toHaveBeenCalledOnce();
	});
});

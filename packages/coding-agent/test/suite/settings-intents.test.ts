/**
 * Settings by owner over the protocol: `set_settings` changes the closed set
 * of settings the host reads and applies them, the `settings` query reports
 * them to local clients only, `set_model_scope` and `set_profile` change the
 * model cycle and the active profile, and the language server and debug
 * surfaces answer local clients. Every one of them is refused remotely.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { type HostFrame, REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopbackClient, type LoopbackClient, ProtocolRejectedError } from "../../src/client/protocol-client.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../../src/core/http-dispatcher.ts";
import { type IntentContext, IntentRejectedError, intentRegistry } from "../../src/core/protocol/intents/index.ts";
import { queryRegistry } from "../../src/core/protocol/queries/index.ts";
import { createIrohRemoteRpcGrant } from "../../src/core/remote/iroh/access-grant.ts";
import { createHostHarness, type HostHarness } from "./host-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function connect(): Promise<{ harness: HostHarness; client: LoopbackClient; frames: HostFrame[] }> {
	const harness = await createHostHarness();
	cleanups.push(() => harness.cleanup());
	const conversation = await harness.openStartup();
	const frames: HostFrame[] = [];
	const client = await createLoopbackClient(harness.host, conversation, { onFrame: (frame) => frames.push(frame) });
	cleanups.push(() => client.stop());
	return { harness, client, frames };
}

async function rejection(promise: Promise<unknown>): Promise<ProtocolRejectedError["reason"]> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	if (!(error instanceof ProtocolRejectedError)) throw new Error(`Expected a rejection, got ${String(error)}`);
	return error.reason;
}

const changed = (frames: readonly HostFrame[]) =>
	frames.flatMap((frame) => (frame.type === "changed" ? [frame.catalog] : []));

describe("settings the host reads", () => {
	it("saves and applies set_settings, and reports the values to a local client", async () => {
		const { harness, client, frames } = await connect();
		const session = harness.host.list()[0]!.session;
		const model = session.model!;
		const before = await client.query("settings");
		expect(before).toMatchObject({
			profile: "",
			compactionThresholdTokens: 0,
			profiles: [],
			personality: "default",
			transport: "auto",
			reviewModel: null,
			imageAutoResize: true,
			blockImages: false,
			httpIdleTimeoutMs: DEFAULT_HTTP_IDLE_TIMEOUT_MS,
		});

		await client.intent("set_settings", {
			personality: "pragmatic",
			transport: "sse",
			reviewModel: `${model.provider}/${model.id}`,
			promptCacheKeepAlive: "off",
			imageAutoResize: false,
			blockImages: true,
			httpIdleTimeoutMs: 120_000,
			enableInstallTelemetry: false,
		});

		expect(changed(frames)).toContain("settings");
		expect(await client.query("settings")).toMatchObject({
			personality: "pragmatic",
			transport: "sse",
			reviewModel: `${model.provider}/${model.id}`,
			promptCacheKeepAlive: "off",
			imageAutoResize: false,
			blockImages: true,
			httpIdleTimeoutMs: 120_000,
			enableInstallTelemetry: false,
		});
		// Applied to the conversation at once: the system prompt follows the personality.
		expect(session.systemPrompt).toContain("pragmatic");
		await client.intent("set_settings", { promptCacheKeepAlive: 15, reviewModel: null });
		expect(await client.query("settings")).toMatchObject({ promptCacheKeepAlive: 15, reviewModel: null });
	});

	it("accepts only the closed set of keys, and only models the host knows", async () => {
		const { client } = await connect();
		expect(await rejection(client.intent("set_settings", {}))).toMatchObject({ code: "invalid_input" });
		expect(await rejection(client.intent("set_settings", { theme: "dark" }))).toMatchObject({
			code: "invalid_input",
		});
		expect(await rejection(client.intent("set_settings", { httpIdleTimeoutMs: -1 }))).toMatchObject({
			code: "invalid_input",
		});
		expect(await rejection(client.intent("set_settings", { reviewModel: "nowhere/none" }))).toMatchObject({
			code: "failed",
			message: "Model not found: nowhere/none",
		});
	});

	it("keeps host-wide settings, profiles, and the new surfaces from remote clients", async () => {
		const { harness } = await connect();
		const conversation = harness.host.list()[0]!;
		const remote: IntentContext = {
			target: { session: conversation.session, conversation, host: harness.host, client: harness.client("phone") },
			services: {},
			profile: { name: "remote", grant: createIrohRemoteRpcGrant(REMOTE_CAPABILITIES) },
		};
		const settings = await queryRegistry.run(remote, "settings", {});
		expect(Object.keys(settings).sort()).toEqual(
			["autoCompaction", "autoRetry", "followUpMode", "profile", "steeringMode"].sort(),
		);
		for (const name of [
			"set_settings",
			"set_profile",
			"set_model_scope",
			"lsp.restart",
			"lsp.set_trace",
			"auth.login",
			"auth.logout",
		] as const) {
			expect(() => intentRegistry.prepareFrame(remote, name, {}), name).toThrow(IntentRejectedError);
			expect(intentRegistry.get(name).remote, name).toBe("unsafe");
		}
		for (const name of ["lsp.status", "debug_report", "auth.providers"] as const) {
			await expect(queryRegistry.runFrame(remote, name, {}), name).rejects.toMatchObject({ code: "not_allowed" });
		}
	});
});

describe("model scope and profiles", () => {
	it("scopes the model cycle, persists it on request, and refuses models the host cannot use", async () => {
		const { harness, client, frames } = await connect();
		const session = harness.host.list()[0]!.session;
		const model = session.model!;
		await client.intent("set_model_scope", {
			models: [{ provider: model.provider, modelId: model.id, thinkingLevel: "high" }],
		});
		expect(changed(frames)).toContain("models");
		expect(session.scopedModels.map((entry) => [entry.model.id, entry.thinkingLevel])).toEqual([[model.id, "high"]]);
		expect(session.settingsManager.getEnabledModels()).toBeUndefined();

		await client.intent("set_model_scope", {
			models: [{ provider: model.provider, modelId: model.id }],
			persist: true,
		});
		expect(session.settingsManager.getEnabledModels()).toEqual([`${model.provider}/${model.id}`]);
		await client.intent("set_model_scope", { models: [], persist: true });
		expect(session.scopedModels).toEqual([]);
		expect(session.settingsManager.getEnabledModels()).toBeUndefined();

		expect(
			await rejection(client.intent("set_model_scope", { models: [{ provider: "nowhere", modelId: "none" }] })),
		).toMatchObject({ code: "failed", message: "Model not available: nowhere/none" });
	});

	it("switches to a profile it creates, reloading the conversation", async () => {
		const { harness, client, frames } = await connect();
		const session = harness.host.list()[0]!.session;
		expect(await rejection(client.intent("set_profile", { name: "work" }))).toMatchObject({
			code: "failed",
			message: 'Profile "work" is not defined',
		});

		const switched = await client.intent("set_profile", { name: "work", create: true });
		expect(switched.result).toEqual({ profile: "work", created: true, warnings: [] });
		expect(changed(frames)).toEqual(expect.arrayContaining(["settings", "models", "intents"]));
		expect(session.settingsManager.getActiveProfile()).toBe("work");
		expect(await client.query("settings")).toMatchObject({ profile: "work", profiles: ["work"] });
		// The active profile again changes nothing.
		await expect(client.intent("set_profile", { name: "work" })).resolves.toMatchObject({
			result: { profile: "work", created: false, warnings: [] },
		});
	});
});

describe("language servers and diagnostics", () => {
	it("reports language servers, traces them to a file the client names, and saves a debug report", async () => {
		const { harness, client } = await connect();
		const status = await client.query("lsp.status");
		expect(status.enabled).toBe(true);
		expect(status.servers.length).toBeGreaterThan(0);
		// A snapshot: nothing started.
		expect(status.servers.every((server) => server.state === "unused" && !server.alive)).toBe(true);
		expect(await client.intent("lsp.restart")).toMatchObject({ result: { stopped: 0 } });

		// Relative to the conversation's cwd.
		const traced = await client.intent("lsp.set_trace", { path: "trace.log" });
		expect(traced.result).toEqual({ traceFile: join(harness.tempDir, "trace.log") });
		expect((await client.query("lsp.status")).traceFile).toBe(join(harness.tempDir, "trace.log"));
		expect((await client.intent("lsp.set_trace", { path: null })).result).toEqual({});
		expect(await client.query("lsp.status")).not.toHaveProperty("traceFile");

		const report = await client.query("debug_report");
		expect(report.path).toBe(join(harness.tempDir, "debug", "tool-progress-latest.json"));
		expect(existsSync(report.path)).toBe(true);
	});
});

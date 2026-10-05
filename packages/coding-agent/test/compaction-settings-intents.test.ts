import type { Api, Model } from "@hansjm10/volt-ai";
import {
	type HostFrame,
	IntentDescriptorSchema,
	type IntentStateValue,
	LiveIntentsValueSchema,
	type QueryResult,
} from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { feedLiveState } from "../src/core/host/live-feed.ts";
import { LiveState } from "../src/core/host/live-state.ts";
import {
	type IntentContext,
	type IntentProfile,
	intentRegistry,
	intentStateOf,
	LOCAL_INTENT_PROFILE,
} from "../src/core/protocol/intents/index.ts";
import { createIrohRemotePresetAccess, createIrohRemoteRpcGrant } from "../src/core/remote/iroh/access-grant.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createHostHarness } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { createLiveRecorder } from "./utilities/live-recorder.ts";
import { connectRemotePhone } from "./utilities/remote-phone.ts";

const autoIntent = "set_auto_compaction";
const thresholdIntent = "set_compaction_threshold";
type CompactionIntent = typeof autoIntent | typeof thresholdIntent;

const model: Model<Api> = {
	id: "test-model",
	name: "Test",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const modelRef = `${model.provider}/${model.id}`;

const controlProfile: IntentProfile = {
	name: "remote",
	grant: createIrohRemoteRpcGrant(["conversation.control.v1"]),
};

function setup(global: Settings = {}, project: Settings = {}, profile?: string, projectTrusted = true) {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify(global));
	storage.withLock("project", () => JSON.stringify(project));
	const settingsManager = SettingsManager.fromStorage(storage, { profile, projectTrusted });
	const session = {
		model: { ...model } as Model<Api> | undefined,
		settingsManager,
		isStreaming: false,
		isBusy: false,
		isCompacting: false,
		sessionManager: { getOrdinal: () => 0 },
	};
	const target = { session, conversation: {}, host: {}, client: {} } as unknown as IntentContext["target"];
	// A paired device invokes the intents; tests swap its authority check to simulate a stale lease.
	const context: Mutable<IntentContext> = {
		target,
		services: {},
		profile: controlProfile,
		assertCurrent: vi.fn(),
	};
	const local: IntentContext = { target, services: {}, profile: LOCAL_INTENT_PROFILE };
	const descriptor = (name: CompactionIntent, viewProfile: IntentProfile = LOCAL_INTENT_PROFILE) =>
		intentRegistry.descriptor(intentRegistry.resolve(name)!, {
			state: intentStateOf(session as unknown as AgentSession),
			services: {},
			profile: viewProfile,
		});
	/** The model and settings profile a client sees now, which its compaction changes name. */
	const capturedTarget = () => ({
		provider: session.model?.provider ?? "",
		modelId: session.model?.id ?? "",
		expectedProfile: settingsManager.getActiveProfile() ?? "",
	});
	const invokeIntent = async (ctx: IntentContext, name: CompactionIntent, input: unknown) =>
		(await intentRegistry.invokeFrame(ctx, name, input)).outcome;
	const invoke = (name: CompactionIntent, value: boolean | number, target = capturedTarget()) =>
		invokeIntent(context, name, { ...target, [name === autoIntent ? "enabled" : "tokens"]: value });
	return { storage, settingsManager, session, context, local, descriptor, capturedTarget, invoke, invokeIntent };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe("compaction settings intents", () => {
	it("describes scalar states, presets, save scope, the target a client names, and remote safety", () => {
		const { settingsManager, descriptor } = setup({
			compaction: { modelThresholds: { [modelRef]: 123456 } },
		});
		for (const name of [autoIntent, thresholdIntent] as const) {
			const item = descriptor(name);
			expect(Compile(IntentDescriptorSchema).Check(JSON.parse(JSON.stringify(item)))).toBe(true);
			expect(item).toMatchObject({
				source: "builtin",
				enabled: true,
				remote: "safe",
				requires: ["conversation.control.v1"],
				whileBusy: "reject",
			});
			expect(item.input).toMatchObject({
				properties: {
					provider: { type: "string" },
					modelId: { type: "string" },
					expectedProfile: { type: "string" },
				},
			});
			expect(item.description).toContain("globally on the connected host");
			expect(item.description).toContain("overrides take precedence");
		}
		// A threshold always names its target; a local auto-compaction toggle may omit it.
		expect(descriptor(thresholdIntent).input.required).toEqual(
			expect.arrayContaining(["provider", "modelId", "expectedProfile"]),
		);
		expect(descriptor(autoIntent).input.required).toEqual(["enabled"]);
		expect(descriptor(autoIntent).state).toMatchObject({ type: "boolean", value: true });
		expect(descriptor(thresholdIntent).state).toMatchObject({ type: "integer", value: 123456 });
		expect(descriptor(thresholdIntent).description).toContain(modelRef);
		expect(descriptor(thresholdIntent).state?.options?.map((option) => option.value)).toEqual([
			"0",
			"100000",
			"123456",
			"150000",
			"200000",
			"250000",
			"350000",
			"500000",
			"750000",
		]);
		expect(intentRegistry.get("compact").remote).toBe("unsafe");
		const remoteView = {
			state: { isStreaming: false, isCompacting: false, model, settingsManager },
			services: {},
			profile: controlProfile,
		};
		const remoteNames = intentRegistry.descriptors(remoteView).map((item) => item.name);
		expect(remoteNames).toEqual(expect.arrayContaining([autoIntent, thresholdIntent]));
		expect(remoteNames).not.toContain("compact");
		expect(settingsManager.getCompactionThresholdTokens(modelRef)).toBe(123456);
	});

	it("saves/reloads and resets one exact model without changing other models or compaction budgets", async () => {
		const { settingsManager, invoke, descriptor } = setup({
			compaction: { reserveTokens: 10000, keepRecentTokens: 20000, modelThresholds: { "other/model": 750000 } },
		});
		await invoke(thresholdIntent, 345678);
		expect(descriptor(thresholdIntent).state).toMatchObject({ type: "integer", value: 345678 });
		await invoke(autoIntent, false);
		expect(descriptor(thresholdIntent).enabled).toBe(true);
		await settingsManager.reload();
		expect(settingsManager.getCompactionSettings(model)).toEqual({
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
			thresholdTokens: 345678,
		});
		await invoke(thresholdIntent, 0);
		await settingsManager.reload();
		expect(settingsManager.getCompactionThresholdTokens(modelRef)).toBe(0);
		expect(settingsManager.getCompactionThresholdTokens("other/model")).toBe(750000);
		await invoke(autoIntent, true);
		expect(settingsManager.getCompactionEnabled()).toBe(true);
	});

	it("saves into the client's global profile and explicitly resets an inherited threshold", async () => {
		const { settingsManager, descriptor, invoke } = setup(
			{ profiles: { work: {} }, compaction: { modelThresholds: { [modelRef]: 350000 } } },
			{},
			"work",
		);
		expect(descriptor(thresholdIntent).description).toContain('global profile "work"');
		expect(descriptor(thresholdIntent).state?.value).toBe(350000);
		await invoke(thresholdIntent, 0);
		await invoke(autoIntent, false);
		await settingsManager.reload();
		expect(settingsManager.getGlobalSettings()).toMatchObject({
			compaction: { modelThresholds: { [modelRef]: 350000 } },
			profiles: { work: { compaction: { enabled: false, modelThresholds: { [modelRef]: 0 } } } },
		});
	});

	it.each([false, true])(
		"shows effective project overrides and disables only the affected intent (profile=%s)",
		async (profile) => {
			const override = { compaction: { modelThresholds: { [modelRef]: 250000 } } };
			const { descriptor, invoke, settingsManager } = setup(
				{ profiles: { work: {} } },
				profile ? { profiles: { work: override } } : override,
				profile ? "work" : undefined,
			);
			expect(descriptor(thresholdIntent)).toMatchObject({
				enabled: false,
				state: { value: 250000 },
				reason: expect.stringContaining(profile ? 'project profile "work"' : "project settings"),
			});
			expect(descriptor(autoIntent).enabled).toBe(true);
			await expect(invoke(thresholdIntent, 350000)).rejects.toMatchObject({
				code: "unavailable",
				message: expect.stringContaining("override"),
			});
			await invoke(autoIntent, false);
			expect(settingsManager.getCompactionEnabled()).toBe(false);
			expect(settingsManager.getGlobalSettings().compaction?.modelThresholds).toBeUndefined();
		},
	);

	it("ignores untrusted overrides and does not disable unrelated-model or reserve overrides", () => {
		expect(
			setup({}, { compaction: { enabled: false, modelThresholds: { [modelRef]: 1 } } }, undefined, false).descriptor(
				autoIntent,
			),
		).toMatchObject({ enabled: true, state: { value: true } });
		const { descriptor } = setup({}, { compaction: { reserveTokens: 12345, modelThresholds: { "other/model": 5 } } });
		expect(descriptor(autoIntent).enabled).toBe(true);
		expect(descriptor(thresholdIntent).enabled).toBe(true);
		const overridden = setup({}, { compaction: { enabled: false } });
		expect(overridden.descriptor(autoIntent)).toMatchObject({ enabled: false, state: { value: false } });
		expect(overridden.descriptor(thresholdIntent).enabled).toBe(true);
	});

	it("blocks runtime overrides, explicit project default resets and null clears", () => {
		const target = setup({}, { compaction: { modelThresholds: { [modelRef]: 0 } } });
		expect(target.descriptor(thresholdIntent)).toMatchObject({ enabled: false, state: { value: 0 } });
		target.settingsManager.applyOverrides({ compaction: { enabled: false } });
		expect(target.descriptor(autoIntent).reason).toContain("runtime override");
		const clears = JSON.parse('{"compaction":null}') as Settings;
		expect(setup({}, clears).descriptor(thresholdIntent).enabled).toBe(false);
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "350000", null])(
		"rejects invalid/unsafe token count %s without saving",
		async (tokens) => {
			const { local, capturedTarget, invokeIntent, settingsManager } = setup();
			await expect(invokeIntent(local, thresholdIntent, { ...capturedTarget(), tokens })).rejects.toThrow();
			expect(settingsManager.getGlobalSettings()).toEqual({});
		},
	);

	it.each([autoIntent, thresholdIntent] as const)(
		"requires the target from a remote client and rejects model/profile/session races for %s",
		async (name) => {
			const { context, capturedTarget, invoke, invokeIntent, session, settingsManager } = setup(
				{ profiles: { work: {}, personal: {} } },
				{},
				"work",
			);
			const target = capturedTarget();
			const value = name === autoIntent ? false : 350000;
			await expect(
				invokeIntent(context, name, { [name === autoIntent ? "enabled" : "tokens"]: value }),
			).rejects.toMatchObject({ code: "invalid_input" });
			session.model = { ...model, id: "new-model" };
			await expect(invoke(name, value, target)).rejects.toThrow("target changed");
			session.model = { ...model, provider: "other-provider" };
			await expect(invoke(name, value, target)).rejects.toThrow("target changed");
			session.model = model;
			settingsManager.setActiveProfile("personal");
			await expect(invoke(name, value, target)).rejects.toThrow("target changed");
			settingsManager.setActiveProfile("work");
			context.assertCurrent = () => {
				throw new Error("stale conversation authority");
			};
			await expect(invoke(name, value, target)).rejects.toThrow("stale conversation authority");
			expect(settingsManager.getGlobalSettings()).toEqual({ profiles: { work: {}, personal: {} } });
		},
	);

	it.each(["isStreaming", "isBusy", "isCompacting"] as const)(
		"disables and rejects both intents when %s",
		async (busy) => {
			const { descriptor, invoke, session } = setup();
			session[busy] = true;
			for (const name of [autoIntent, thresholdIntent] as const) {
				expect(descriptor(name).enabled).toBe(false);
				await expect(invoke(name, name === autoIntent ? true : 0)).rejects.toMatchObject({ code: "unavailable" });
			}
			session[busy] = false;
			session.model = undefined;
			expect(descriptor(autoIntent).enabled).toBe(false);
			expect(descriptor(thresholdIntent).enabled).toBe(false);
		},
	);

	it("reports failed writes and refuses edits when the host settings failed to load", async () => {
		const { storage, invoke } = setup();
		vi.spyOn(storage, "withLock").mockImplementation(() => {
			throw new Error("disk full");
		});
		await expect(invoke(thresholdIntent, 350000)).rejects.toThrow("disk full");
		const settingsManager = SettingsManager.fromStorage(storage);
		const { session, descriptor } = setup();
		session.settingsManager = settingsManager;
		expect(descriptor(autoIntent)).toMatchObject({
			enabled: false,
			reason: expect.stringContaining("could not be loaded"),
		});
	});

	it("updates the live intents value after persistence and on profile/reload changes, then detaches", async () => {
		const { session, settingsManager, invoke, storage } = setup({
			profiles: { work: { compaction: { modelThresholds: { [modelRef]: 500000 } } } },
		});
		const live = new LiveState();
		// The feed reads nothing else of the session: it skips the values it cannot read.
		const feed = feedLiveState(
			Object.assign(session, {
				liveState: live,
				subscribe: () => () => {},
				subscribeActivity: () => () => {},
				sessionManager: { ...session.sessionManager, subscribeEntries: () => () => {} },
			}) as unknown as AgentSession,
		);
		const recorder = createLiveRecorder();
		live.attach("observer", recorder);
		const intentValues = () =>
			recorder.items().flatMap((item) => (item.type === "set" && item.value.kind === "intents" ? [item.value] : []));
		const latestState = (name: CompactionIntent): IntentStateValue | undefined =>
			intentValues()
				.at(-1)
				?.availability.find((intent) => intent.name === name)?.state;
		try {
			const delivered = intentValues().length;
			const saved = invoke(thresholdIntent, 350000);
			expect(intentValues()).toHaveLength(delivered);
			await saved;
			expect(latestState(thresholdIntent)).toMatchObject({ value: 350000 });
			for (const value of intentValues()) expect(Compile(LiveIntentsValueSchema).Check(value)).toBe(true);
			settingsManager.setActiveProfile("work");
			expect(latestState(thresholdIntent)).toMatchObject({ value: 500000 });
			storage.withLock("global", () => JSON.stringify({ profiles: { work: { compaction: { enabled: false } } } }));
			await settingsManager.reload();
			expect(latestState(autoIntent)).toMatchObject({ value: false });
			feed.close();
			const after = recorder.items().length;
			await invoke(autoIntent, true);
			expect(settingsManager.getCompactionEnabled()).toBe(true);
			expect(recorder.items()).toHaveLength(after);
		} finally {
			feed.close();
		}
	});

	it("waits for the newest accepted settings write before notifying observers", async () => {
		const { settingsManager, storage } = setup();
		const observed: Settings[] = [];
		const unsubscribe = settingsManager.subscribeCompactionSettings(() => {
			storage.withLock("global", (current) => {
				observed.push(JSON.parse(current ?? "{}") as Settings);
				return undefined;
			});
		});
		settingsManager.setCompactionEnabled(false);
		settingsManager.setCompactionThresholdTokens(modelRef, 350000);
		await settingsManager.flush();
		expect(observed).toEqual([{ compaction: { enabled: false, modelThresholds: { [modelRef]: 350000 } } }]);
		unsubscribe();
	});

	it("notifies when a project null clear changes editability without changing effective values", async () => {
		const { settingsManager, descriptor, storage } = setup();
		const listener = vi.fn();
		const unsubscribe = settingsManager.subscribeCompactionSettings(listener);
		storage.withLock("project", () => '{"compaction":null}');
		await settingsManager.reload();
		expect(descriptor(autoIntent)).toMatchObject({ enabled: false, state: { value: true } });
		expect(listener).toHaveBeenCalledOnce();
		unsubscribe();
	});
});

describe("compaction settings intents on the remote profile", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("saves through intents with durable outcomes, tells the device to refetch settings, and updates the live intent state", async () => {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: createIrohRemotePresetAccess("coding").rpcGrant,
			redaction: { workspacePath: conversation.cwd },
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await phone.close();
			await connection.close().catch(() => undefined);
		});
		await phone.hello();
		await phone.subscribe(conversation.id);
		const session = conversation.session;
		const current = session.model!;
		const ref = `${current.provider}/${current.id}`;
		// The device names the settings profile it saw in the `settings` query.
		const settings = await phone.query("settings");
		if (settings.type !== "result") throw new Error("Expected the settings");
		const target = {
			provider: current.provider,
			modelId: current.id,
			expectedProfile: (settings.data as QueryResult<"settings">).profile,
		};
		expect(target.expectedProfile).toBe("");
		const intentState = (name: string) => {
			const states = phone.frames.flatMap((frame) =>
				frame.type === "live"
					? frame.items.flatMap((item) =>
							item.type === "set" && item.value.kind === "intents"
								? item.value.availability.filter((intent) => intent.name === name)
								: [],
						)
					: [],
			);
			return states.at(-1);
		};

		const from = phone.frames.length;
		const saved = await phone.intent("set_compaction_threshold", { ...target, tokens: 350000 });
		expect(saved).toMatchObject({ type: "accepted" });
		await phone.waitFor((frame): frame is HostFrame => frame.type === "changed" && frame.catalog === "settings", {
			from,
		});
		await vi.waitFor(() =>
			expect(intentState("set_compaction_threshold")).toMatchObject({ state: { type: "integer", value: 350000 } }),
		);
		await session.settingsManager.reload();
		expect(session.settingsManager.getCompactionThresholdTokens(ref)).toBe(350000);

		// A device that saw another model saves nothing.
		expect(
			await phone.intent("set_auto_compaction", { ...target, modelId: "wrong-model", enabled: false }),
		).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: expect.stringContaining("target changed") },
		});
		expect(session.settingsManager.getCompactionEnabled()).toBe(true);

		expect(await phone.intent("set_auto_compaction", { ...target, enabled: false })).toMatchObject({
			type: "accepted",
		});
		await vi.waitFor(() => expect(intentState("set_auto_compaction")).toMatchObject({ state: { value: false } }));
		expect(await phone.query("settings")).toMatchObject({ type: "result", data: { autoCompaction: false } });
	});
});

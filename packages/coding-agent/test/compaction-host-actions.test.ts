import type { Api, Model } from "@hansjm10/volt-ai";
import { Compile } from "typebox/compile";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { BackgroundJobManager } from "../src/core/background-jobs.ts";
import {
	CONTEXT_AUTO_COMPACTION_ACTION_ID as autoAction,
	type HostActionInvocationContext,
	isRemoteSafeBuiltinHostActionId,
	BUILTIN_HOST_ACTION_REGISTRY as registry,
	CONTEXT_COMPACTION_THRESHOLD_ACTION_ID as thresholdAction,
} from "../src/core/host-actions.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { sanitizeIrohRemoteOutbound } from "../src/core/remote/iroh/outbound-filter.ts";
import { getIrohRemoteRpcFilterResult } from "../src/core/remote/iroh/rpc-command-filter.ts";
import { subscribeRpcSessionEvents } from "../src/core/rpc/background-jobs.ts";
import { RpcUiActionStateChangedEventSchema } from "../src/core/rpc/schema/events.ts";
import { UiActionDescriptorSchema } from "../src/core/rpc/schema/ui-actions.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import type { UiActionDescriptor } from "../src/core/rpc/types.ts";
import { getUiActionDescriptors } from "../src/core/rpc/ui-actions.ts";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";

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
	};
	const context: HostActionInvocationContext = {
		session,
		assertCurrent: vi.fn(),
		abortRun: async () => {},
		compactContext: async () => ({ summary: "", firstKeptEntryId: "entry", tokensBefore: 0 }),
		newSession: async () => ({ cancelled: true, seeded: false }),
		renameSession: () => {},
	};
	const descriptor = (action: string) => registry.getDescriptor(action, context)!;
	const invoke = (action: string, value: boolean | number, target = capturedTarget(descriptor(action))) =>
		registry.invoke(
			action,
			context,
			{ ...target, [action === autoAction ? "enabled" : "tokens"]: value },
			{ requireRemoteSafe: true },
		);
	return { storage, settingsManager, session, context, descriptor, invoke };
}

function capturedTarget(descriptor: UiActionDescriptor) {
	return Object.fromEntries(
		(descriptor.args ?? [])
			.filter((arg) => arg.defaultValue !== undefined)
			.map((arg) => [arg.name, arg.defaultValue]),
	);
}

describe("compaction host actions", () => {
	it("advertises scalar states, exact captured defaults, presets, scope and remote safety", () => {
		const { settingsManager, descriptor, session } = setup({
			compaction: { modelThresholds: { [modelRef]: 123456 } },
		});
		for (const action of [autoAction, thresholdAction]) {
			const item = descriptor(action);
			expect(Compile(UiActionDescriptorSchema).Check(JSON.parse(JSON.stringify(item)))).toBe(true);
			expect(item).toMatchObject({
				source: "builtin",
				enabled: true,
				remoteSafe: true,
				streamingBehavior: "disabled",
			});
			expect(capturedTarget(item)).toEqual({ provider: "openai", modelId: "test-model", expectedProfile: "" });
			for (const name of ["provider", "modelId", "expectedProfile"])
				expect(item.args).toContainEqual(expect.objectContaining({ name, type: "string", required: true }));
			expect(item.description).toContain("globally on the connected host");
			expect(item.description).toContain("overrides take precedence");
			expect(isRemoteSafeBuiltinHostActionId(action)).toBe(true);
		}
		expect(descriptor(autoAction).state).toMatchObject({ type: "boolean", value: true });
		expect(descriptor(thresholdAction).state).toMatchObject({ type: "integer", value: 123456 });
		expect(descriptor(thresholdAction).description).toContain(modelRef);
		expect(descriptor(thresholdAction).state?.options?.map((option) => option.value)).toEqual([
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
		expect(isRemoteSafeBuiltinHostActionId("context.compact")).toBe(false);
		const discovery = {
			...session,
			extensionRunner: { getRegisteredCommands: () => [] },
			promptTemplates: [],
			resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
			sessionManager: { getCwd: () => "/repo" },
		};
		expect(getUiActionDescriptors(discovery, "all", { remoteSafeOnly: true })).toContainEqual(
			descriptor(thresholdAction),
		);
		expect(settingsManager.getCompactionThresholdTokens(modelRef)).toBe(123456);
	});

	it("saves/reloads and resets one exact model without changing other models or compaction budgets", async () => {
		const { settingsManager, invoke, descriptor } = setup({
			compaction: { reserveTokens: 10000, keepRecentTokens: 20000, modelThresholds: { "other/model": 750000 } },
		});
		await expect(invoke(thresholdAction, 345678)).resolves.toMatchObject({
			status: "completed",
			state: { type: "integer", value: 345678 },
			actionsChanged: true,
			stateChanged: true,
		});
		await invoke(autoAction, false);
		expect(descriptor(thresholdAction).enabled).toBe(true);
		await settingsManager.reload();
		expect(settingsManager.getCompactionSettings(model)).toEqual({
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
			thresholdTokens: 345678,
		});
		await invoke(thresholdAction, 0);
		await settingsManager.reload();
		expect(settingsManager.getCompactionThresholdTokens(modelRef)).toBe(0);
		expect(settingsManager.getCompactionThresholdTokens("other/model")).toBe(750000);
		await invoke(autoAction, true);
		expect(settingsManager.getCompactionEnabled()).toBe(true);
	});

	it("saves into the captured global profile and explicitly resets an inherited threshold", async () => {
		const { settingsManager, descriptor, invoke } = setup(
			{ profiles: { work: {} }, compaction: { modelThresholds: { [modelRef]: 350000 } } },
			{},
			"work",
		);
		expect(capturedTarget(descriptor(thresholdAction)).expectedProfile).toBe("work");
		expect(descriptor(thresholdAction).description).toContain('global profile "work"');
		expect(descriptor(thresholdAction).state?.value).toBe(350000);
		await invoke(thresholdAction, 0);
		await invoke(autoAction, false);
		await settingsManager.reload();
		expect(settingsManager.getGlobalSettings()).toMatchObject({
			compaction: { modelThresholds: { [modelRef]: 350000 } },
			profiles: { work: { compaction: { enabled: false, modelThresholds: { [modelRef]: 0 } } } },
		});
	});

	it.each([false, true])(
		"shows effective project overrides and disables only the affected action (profile=%s)",
		async (profile) => {
			const override = { compaction: { modelThresholds: { [modelRef]: 250000 } } };
			const { descriptor, invoke, settingsManager } = setup(
				{ profiles: { work: {} } },
				profile ? { profiles: { work: override } } : override,
				profile ? "work" : undefined,
			);
			expect(descriptor(thresholdAction)).toMatchObject({
				enabled: false,
				state: { value: 250000 },
				disabledReason: expect.stringContaining(profile ? 'project profile "work"' : "project settings"),
			});
			expect(descriptor(autoAction).enabled).toBe(true);
			await expect(invoke(thresholdAction, 350000)).rejects.toThrow("override");
			await invoke(autoAction, false);
			expect(settingsManager.getCompactionEnabled()).toBe(false);
			expect(settingsManager.getGlobalSettings().compaction?.modelThresholds).toBeUndefined();
		},
	);

	it("ignores untrusted overrides and does not disable unrelated-model or reserve overrides", () => {
		expect(
			setup({}, { compaction: { enabled: false, modelThresholds: { [modelRef]: 1 } } }, undefined, false).descriptor(
				autoAction,
			),
		).toMatchObject({ enabled: true, state: { value: true } });
		const { descriptor } = setup({}, { compaction: { reserveTokens: 12345, modelThresholds: { "other/model": 5 } } });
		expect(descriptor(autoAction).enabled).toBe(true);
		expect(descriptor(thresholdAction).enabled).toBe(true);
		const overridden = setup({}, { compaction: { enabled: false } });
		expect(overridden.descriptor(autoAction)).toMatchObject({ enabled: false, state: { value: false } });
		expect(overridden.descriptor(thresholdAction).enabled).toBe(true);
	});

	it("blocks runtime overrides, explicit project default resets and null clears", () => {
		const target = setup({}, { compaction: { modelThresholds: { [modelRef]: 0 } } });
		expect(target.descriptor(thresholdAction)).toMatchObject({ enabled: false, state: { value: 0 } });
		target.settingsManager.applyOverrides({ compaction: { enabled: false } });
		expect(target.descriptor(autoAction).disabledReason).toContain("runtime override");
		const clears = JSON.parse('{"compaction":null}') as Settings;
		expect(setup({}, clears).descriptor(thresholdAction).enabled).toBe(false);
	});

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "350000", null])(
		"rejects invalid/unsafe token count %s without saving",
		async (tokens) => {
			const { descriptor, context, settingsManager } = setup();
			await expect(
				registry.invoke(thresholdAction, context, { ...capturedTarget(descriptor(thresholdAction)), tokens }),
			).rejects.toThrow();
			expect(settingsManager.getGlobalSettings()).toEqual({});
		},
	);

	it.each([autoAction, thresholdAction])(
		"requires exact target args and rejects model/profile/session races for %s",
		async (action) => {
			const { context, descriptor, invoke, session, settingsManager } = setup(
				{ profiles: { work: {}, personal: {} } },
				{},
				"work",
			);
			const target = capturedTarget(descriptor(action));
			const value = action === autoAction ? false : 350000;
			await expect(
				registry.invoke(action, context, { [action === autoAction ? "enabled" : "tokens"]: value }),
			).rejects.toThrow("Missing required");
			session.model = { ...model, id: "new-model" };
			await expect(invoke(action, value, target)).rejects.toThrow("target changed");
			session.model = { ...model, provider: "other-provider" };
			await expect(invoke(action, value, target)).rejects.toThrow("target changed");
			session.model = model;
			settingsManager.setActiveProfile("personal");
			await expect(invoke(action, value, target)).rejects.toThrow("target changed");
			settingsManager.setActiveProfile("work");
			context.assertCurrent = () => {
				throw new Error("stale conversation authority");
			};
			await expect(invoke(action, value, target)).rejects.toThrow("stale conversation authority");
			expect(settingsManager.getGlobalSettings()).toEqual({ profiles: { work: {}, personal: {} } });
		},
	);

	it.each(["isStreaming", "isBusy", "isCompacting"] as const)(
		"disables and rejects both actions when %s",
		async (busy) => {
			const { descriptor, invoke, session } = setup();
			session[busy] = true;
			for (const action of [autoAction, thresholdAction]) {
				expect(descriptor(action).enabled).toBe(false);
				await expect(invoke(action, action === autoAction ? true : 0)).rejects.toThrow("unavailable");
			}
			session[busy] = false;
			session.model = undefined;
			expect(descriptor(autoAction).enabled).toBe(false);
			expect(descriptor(thresholdAction).enabled).toBe(false);
		},
	);

	it("reports failed writes and refuses edits when the host settings failed to load", async () => {
		const { storage, invoke } = setup();
		vi.spyOn(storage, "withLock").mockImplementation(() => {
			throw new Error("disk full");
		});
		await expect(invoke(thresholdAction, 350000)).rejects.toThrow("disk full");
		const settingsManager = SettingsManager.fromStorage(storage);
		const context = setup().context;
		context.session.settingsManager = settingsManager;
		expect(registry.getDescriptor(autoAction, context)).toMatchObject({
			enabled: false,
			disabledReason: expect.stringContaining("could not be loaded"),
		});
	});

	it("emits schema-valid shared events after persistence and on profile/reload changes, then detaches", async () => {
		const { session, settingsManager, invoke, storage } = setup({ profiles: { work: {} } });
		const backgroundJobs = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
		const listener = vi.fn();
		const unsubscribe = subscribeRpcSessionEvents(
			{ ...session, backgroundJobs, subscribe: () => () => {} },
			listener,
		);
		try {
			const saved = invoke(thresholdAction, 350000);
			expect(listener).not.toHaveBeenCalled();
			await saved;
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({ action: thresholdAction, state: expect.objectContaining({ value: 350000 }) }),
			);
			for (const [event] of listener.mock.calls)
				expect(Compile(RpcUiActionStateChangedEventSchema).Check(event)).toBe(true);
			listener.mockClear();
			settingsManager.setActiveProfile("work");
			expect(listener).toHaveBeenCalledTimes(2);
			listener.mockClear();
			storage.withLock("global", () => JSON.stringify({ profiles: { work: { compaction: { enabled: false } } } }));
			await settingsManager.reload();
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({ action: autoAction, state: expect.objectContaining({ value: false }) }),
			);
			unsubscribe();
			listener.mockClear();
			await invoke(autoAction, true);
			expect(listener).not.toHaveBeenCalled();
		} finally {
			unsubscribe();
			await backgroundJobs.close();
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
		expect(descriptor(autoAction)).toMatchObject({ enabled: false, state: { value: true } });
		expect(listener).toHaveBeenCalledOnce();
		unsubscribe();
	});

	it("allows exactly the reviewed actions through Iroh and preserves captured defaults after redaction", () => {
		const grant = createIrohRemotePresetAccess("coding").rpcGrant;
		const { descriptor } = setup();
		for (const action of [autoAction, thresholdAction]) {
			expect(
				getIrohRemoteRpcFilterResult(
					JSON.stringify({
						id: "action",
						type: "invoke_ui_action",
						action,
						args: capturedTarget(descriptor(action)),
					}),
					grant,
				).allowed,
			).toBe(true);
			const response = {
				type: "response",
				command: "get_ui_actions",
				success: true,
				data: { actions: [descriptor(action)] },
			};
			expect(sanitizeIrohRemoteOutbound(response, { workspacePath: "/repo" })).toMatchObject({
				data: { actions: [expect.objectContaining({ args: descriptor(action).args })] },
			});
		}
		expect(
			getIrohRemoteRpcFilterResult(
				JSON.stringify({ id: "manual", type: "invoke_ui_action", action: "context.compact" }),
				grant,
			).allowed,
		).toBe(false);
	});
});

it("invokes compaction actions through RPC with durable replies and shared state events", async () => {
	const { session, settingsManager, descriptor } = setup();
	const backgroundJobs = new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 });
	const rpcSession = {
		...session,
		backgroundJobs,
		sessionId: "session",
		bindExtensions: async () => {},
		subscribe: () => () => {},
		subscribeRuntimeEvents: () => () => {},
		extensionRunner: { getRegisteredCommands: () => [] },
		promptTemplates: [],
		resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
		sessionManager: { flush: async () => {}, getCwd: () => "/repo" },
	};
	const runtime = {
		session: rpcSession,
		setRebindSession: () => {},
		runWithStableSession: (operation: (session: AgentSession) => Promise<unknown>) =>
			operation(rpcSession as unknown as AgentSession),
	} as unknown as AgentSessionRuntime;
	let onLine: ((line: string) => void) | undefined;
	let onClose: RpcCloseHandler | undefined;
	const writes: object[] = [];
	const transport: RpcTransport = {
		write: (value) => {
			writes.push(value);
		},
		onLine: (handler) => {
			onLine = handler;
			return () => {};
		},
		onClose: (handler) => {
			onClose = handler;
			return () => {};
		},
		close: () => {},
	};
	let ready!: () => void;
	const started = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const running = runRpcMode(runtime, {
		transport,
		onReady: ready,
		disposeRuntimeOnClose: false,
		requireRemoteSafeUiActions: true,
	});
	try {
		await started;
		onLine?.(
			JSON.stringify({
				id: "save",
				type: "invoke_ui_action",
				action: thresholdAction,
				args: { ...capturedTarget(descriptor(thresholdAction)), tokens: 350000 },
			}),
		);
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({
					id: "save",
					success: true,
					data: expect.objectContaining({ state: expect.objectContaining({ value: 350000 }) }),
				}),
			),
		);
		expect(writes).toContainEqual(
			expect.objectContaining({
				type: "ui_action_state_changed",
				action: thresholdAction,
				state: expect.objectContaining({ value: 350000 }),
			}),
		);
		await settingsManager.reload();
		expect(settingsManager.getCompactionThresholdTokens(modelRef)).toBe(350000);
		onLine?.(
			JSON.stringify({
				id: "stale",
				type: "invoke_ui_action",
				action: autoAction,
				args: { provider: "openai", modelId: "wrong-model", expectedProfile: "", enabled: false },
			}),
		);
		await vi.waitFor(() =>
			expect(writes).toContainEqual(
				expect.objectContaining({ id: "stale", success: false, error: expect.stringContaining("target changed") }),
			),
		);
	} finally {
		onClose?.();
		await running;
		await backgroundJobs.close();
	}
});

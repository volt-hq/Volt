import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	getApiProvider,
	registerApiProvider,
	unregisterApiProviders,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionCommandContext,
	ExtensionFactory,
	ExtensionMode,
	ExtensionUIContext,
} from "../../src/core/extensions/types.ts";
import { withoutExtensionWork } from "../../src/core/extensions/work-runtime.ts";
import type { ExtensionWorkTaskHandle, RequestBoundaryEvent } from "../../src/core/extensions/work-types.ts";
import { createTestExtensionsResult } from "../utilities.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		unregisterApiProviders(harness.tempDir);
		await harness.cleanupAsync();
	}
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup(options: HarnessOptions = {}, mode: ExtensionMode = "tui", withUI = true) {
	let context!: ExtensionCommandContext;
	let result: number | undefined;
	let idleInCommand: boolean | undefined;
	const factory: ExtensionFactory = (volt) => {
		volt.registerCommand("preparation", {
			handler: async (args, ctx) => {
				context = ctx;
				idleInCommand = ctx.isIdle();
				if (args) result = await ctx.requestPreparationWait(Number(args));
			},
		});
	};
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		...options,
		extensionFactories: [factory, ...(options.extensionFactories ?? [])],
	});
	harnesses.push(harness);
	harness.session.setSessionName("preparation control test");
	const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true);
	const ui: ExtensionUIContext = { ...harness.session.extensionRunner.getUIContext(), confirm };
	await harness.session.bindExtensions({ mode, ...(withUI ? { uiContext: ui } : {}) });
	await harness.session.prompt("/preparation");
	return {
		harness,
		confirm,
		ui,
		context,
		factory,
		getResult: () => result,
		getIdleInCommand: () => idleInCommand,
	};
}

describe("host-owned extension preparation controls", () => {
	it.each([undefined, 0, 100, 1000])("reports initial allowance and ceiling for SDK limit %s", async (limit) => {
		const { context, harness } = await setup({
			...(limit === undefined ? {} : { extensionWorkLimits: { firstRequestWaitMs: limit } }),
		});
		expect(context.getPreparationWait()).toEqual({ waitMs: limit ?? 0, maxWaitMs: limit ?? 1000 });
		expect(harness.session.extensionRunner.createContext()).not.toHaveProperty("getPreparationWait");
		expect(harness.session.extensionRunner.createContext()).not.toHaveProperty("requestPreparationWait");
		const snapshot = context.getPreparationWait();
		snapshot.waitMs = 999;
		expect(context.getPreparationWait().waitMs).toBe(limit ?? 0);
	});

	it("requires host confirmation for changes, including zero, without joining the command itself", async () => {
		const test = await setup();
		await test.harness.session.prompt("/preparation 250");
		expect(test.getIdleInCommand()).toBe(false);
		expect(test.getResult()).toBe(250);
		expect(test.context.getPreparationWait()).toEqual({ waitMs: 250, maxWaitMs: 1000 });
		expect(test.confirm).toHaveBeenCalledOnce();
		const [title, message] = test.confirm.mock.calls[0]!;
		expect(title).toContain("shared");
		expect(message).toContain("250 ms before initial model requests");
		expect(message).toContain("only when extensions request");
		expect(message).toContain("all extensions");
		expect(message).toContain("does not enable any extension or export");
		const other = test.harness.session.extensionRunner.createCommandContext();
		expect(other.getPreparationWait().waitMs).toBe(250);
		await expect(other.requestPreparationWait(250)).resolves.toBe(250);
		expect(test.confirm).toHaveBeenCalledOnce();
		await expect(other.requestPreparationWait(0)).resolves.toBe(0);
		expect(test.confirm).toHaveBeenCalledTimes(2);
		expect(test.context.getPreparationWait().waitMs).toBe(0);
		expect(test.harness.faux.state.callCount).toBe(0);
		expect(test.harness.session.messages).toEqual([]);
	});

	it("clamps every request to the explicit SDK ceiling, even after lowering the allowance", async () => {
		const { context, confirm } = await setup({ extensionWorkLimits: { firstRequestWaitMs: 100 } });
		await expect(context.requestPreparationWait(1000)).resolves.toBe(100);
		expect(confirm).not.toHaveBeenCalled();
		await expect(context.requestPreparationWait(0)).resolves.toBe(0);
		await expect(context.requestPreparationWait(1000)).resolves.toBe(100);
		expect(confirm.mock.calls[1]?.[1]).toContain("100 ms");
		expect(context.getPreparationWait()).toEqual({ waitMs: 100, maxWaitMs: 100 });
	});

	it("cannot bypass an explicit SDK zero", async () => {
		const { context, confirm } = await setup({ extensionWorkLimits: { firstRequestWaitMs: 0 } });
		await expect(context.requestPreparationWait(1000)).resolves.toBe(0);
		expect(context.getPreparationWait()).toEqual({ waitMs: 0, maxWaitMs: 0 });
		expect(confirm).not.toHaveBeenCalled();
	});

	it.each([-1, 0.5, 1001, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rejects invalid allowance %s", async (value) => {
		const { context, confirm } = await setup();
		await expect(context.requestPreparationWait(value)).rejects.toThrow("integer between 0 and 1000");
		expect(confirm).not.toHaveBeenCalled();
		expect(context.getPreparationWait().waitMs).toBe(0);
	});

	it.each(["print", "rpc", "json"] as const)("does not offer controls in %s, even with UI", async (mode) => {
		const { context, confirm } = await setup({}, mode);
		await expect(context.requestPreparationWait(100)).resolves.toBeUndefined();
		await expect(context.requestPreparationWait(0)).resolves.toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
		expect(context.getPreparationWait()).toEqual({ waitMs: 0, maxWaitMs: 1000 });
	});

	it("does not offer controls in a TUI binding without actual UI", async () => {
		const { context, confirm } = await setup({}, "tui", false);
		await expect(context.requestPreparationWait(100)).resolves.toBeUndefined();
		expect(confirm).not.toHaveBeenCalled();
	});

	it("keeps the allowance on cancellation or unavailable host confirmation", async () => {
		const { context, confirm } = await setup();
		confirm.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("UI closed"));
		await expect(context.requestPreparationWait(100)).resolves.toBeUndefined();
		await expect(context.requestPreparationWait(100)).resolves.toBeUndefined();
		expect(context.getPreparationWait().waitMs).toBe(0);
	});

	it("uses the captured host confirmation rather than an extension-replaced UI method", async () => {
		const { context, confirm } = await setup();
		confirm.mockResolvedValue(false);
		const replacement = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true);
		context.ui.confirm = replacement;
		await expect(context.requestPreparationWait(100)).resolves.toBeUndefined();
		expect(confirm).toHaveBeenCalledOnce();
		expect(replacement).not.toHaveBeenCalled();
	});

	it("supersedes older concurrent confirmations without allowing their callbacks to overwrite the latest choice", async () => {
		const { context, confirm } = await setup();
		const first = deferred<boolean>();
		const second = deferred<boolean>();
		const firstShown = deferred<void>();
		const secondShown = deferred<void>();
		confirm
			.mockImplementationOnce(() => {
				firstShown.resolve();
				return first.promise;
			})
			.mockImplementationOnce(() => {
				secondShown.resolve();
				return second.promise;
			});
		const old = context.requestPreparationWait(100);
		await firstShown.promise;
		const latest = context.requestPreparationWait(200);
		await secondShown.promise;
		expect(confirm.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
		second.resolve(true);
		await expect(latest).resolves.toBe(200);
		first.resolve(true);
		await expect(old).resolves.toBeUndefined();
		expect(context.getPreparationWait().waitMs).toBe(200);
	});

	it.each(["model", "profile", "tree", "reload", "binding", "policy", "retired", "disposed"] as const)(
		"rejects an approved confirmation made stale by %s changes",
		async (change) => {
			const { harness, context, confirm, factory } = await setup({ models: [{ id: "first" }, { id: "second" }] });
			const approval = deferred<boolean>();
			const shown = deferred<void>();
			confirm.mockImplementation(() => {
				shown.resolve();
				return approval.promise;
			});
			const pending = context.requestPreparationWait(100);
			await shown.promise;
			if (change === "model") {
				await harness.session.setModel(harness.models[1]!);
				await harness.session.setModel(harness.models[0]);
			} else if (change === "profile") {
				await harness.session.setAgentMode("plan");
				await harness.session.setAgentMode("build");
			} else if (change === "tree") {
				const entry = harness.sessionManager.appendMessage({
					role: "user",
					content: "branch",
					timestamp: Date.now(),
				});
				harness.sessionManager.appendMessage({ role: "user", content: "other", timestamp: Date.now() });
				await harness.session.navigateTree(entry);
			} else if (change === "reload") {
				const next = await createTestExtensionsResult([factory], harness.tempDir);
				vi.spyOn(harness.session.resourceLoader, "getExtensions").mockReturnValue(next);
				await harness.session.reload();
			} else if (change === "binding") {
				await harness.session.bindExtensions({ mode: "rpc" });
				await harness.session.bindExtensions({ mode: "tui" });
			} else if (change === "policy") {
				harness.session.registerTurnPolicy({ beforeToolCall: () => ({ block: true }) });
			} else if (change === "retired") {
				harness.sessionManager.retireConversationAuthority(new Error("retired for test"));
			} else {
				harness.session.dispose();
			}
			approval.resolve(true);
			await expect(pending).resolves.toBeUndefined();
			if (change === "reload" || change === "disposed") {
				expect(() => context.getPreparationWait()).toThrow("stale");
				expect(() => context.requestPreparationWait(100)).toThrow("stale");
			} else {
				expect(context.getPreparationWait().waitMs).toBe(0);
			}
			if (change === "retired") await harness.session.disposeForSessionReplacement();
		},
	);

	it("waits for an active turn before prompting and again before applying an approval", async () => {
		const { harness, context, confirm } = await setup();
		const entered = deferred<void>();
		const release = deferred<void>();
		harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const turn = harness.session.prompt("first");
		await entered.promise;
		const request = context.requestPreparationWait(100);
		await Promise.resolve();
		expect(confirm).not.toHaveBeenCalled();
		expect(context.getPreparationWait().waitMs).toBe(0);
		release.resolve();
		await turn;
		await expect(request).resolves.toBe(100);

		const shown = deferred<void>();
		const approval = deferred<boolean>();
		confirm.mockImplementation(() => {
			shown.resolve();
			return approval.promise;
		});
		const next = context.requestPreparationWait(200);
		await shown.promise;
		const secondEntered = deferred<void>();
		const secondRelease = deferred<void>();
		harness.setResponses([
			async () => {
				secondEntered.resolve();
				await secondRelease.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const secondTurn = harness.session.prompt("second");
		await secondEntered.promise;
		approval.resolve(true);
		await Promise.resolve();
		expect(context.getPreparationWait().waitMs).toBe(100);
		secondRelease.resolve();
		await secondTurn;
		await expect(next).resolves.toBe(200);
	});

	it("rejects asynchronous managed-task and policy lineage before either idle waits or UI", async () => {
		let context!: ExtensionCommandContext;
		let handle: ExtensionWorkTaskHandle | undefined;
		const results: Array<number | undefined> = [];
		const {
			harness,
			context: command,
			confirm,
		} = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("request_boundary", (_event, ctx) => {
						const admission = ctx.work!.tasks.start({ key: "nested", label: "nested" }, async () => {
							await Promise.resolve();
							results.push(await context.requestPreparationWait(100));
						});
						if (admission.status === "started") handle = admission.task;
					});
				},
			],
		});
		context = command;
		harness.setResponses([
			async () => {
				await handle?.wait();
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("run task");
		await withoutExtensionWork(async () => {
			await Promise.resolve();
			results.push(await context.requestPreparationWait(100));
		});
		expect(results).toEqual([undefined, undefined]);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("rejects requests from asynchronous next-action policy lineage", async () => {
		const { harness, context, confirm } = await setup();
		const results: Array<number | undefined> = [];
		harness.session.registerTurnPolicy({
			nextAction: async () => {
				await Promise.resolve();
				results.push(await context.requestPreparationWait(100));
				return undefined;
			},
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("policy");
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((result) => result === undefined)).toBe(true);
		expect(confirm).not.toHaveBeenCalled();
	});

	it("preserves allowance across resource reload, not a new runtime, and uses it only on requested first boundaries", async () => {
		let enabled = false;
		let requestWait = true;
		let release = deferred<void>();
		const boundaries: RequestBoundaryEvent[] = [];
		const effective: number[] = [];
		const requests: Context[] = [];
		const prepare: ExtensionFactory = (volt) => {
			volt.on("request_boundary", (event, ctx) => {
				boundaries.push(event);
				if (!enabled) return;
				if (requestWait) effective.push(ctx.work!.context.requestWait(1000));
				if (!event.first) return;
				ctx.work!.tasks.start({ key: "prepare", label: "prepare" }, async (task) => {
					await release.promise;
					task.context.put({ key: "prepared", text: "prepared evidence" });
				});
			});
			volt.registerTool({
				name: "checkpoint",
				label: "Checkpoint",
				description: "Checkpoint",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "checkpoint" }] }),
			});
		};
		const { harness, context, factory } = await setup({ extensionFactories: [prepare] });
		await expect(context.requestPreparationWait(500)).resolves.toBe(500);
		harness.setResponses([fauxAssistantMessage("disabled")]);
		await harness.session.prompt("disabled consumer");
		expect(effective).toEqual([]);

		const next = await createTestExtensionsResult([factory, prepare], harness.tempDir);
		vi.spyOn(harness.session.resourceLoader, "getExtensions").mockReturnValue(next);
		const provider = getApiProvider(harness.faux.api)!;
		await harness.session.reload();
		// The test loader does not re-register its faux provider after reload clears providers.
		registerApiProvider(provider, harness.tempDir);
		await harness.session.setModel(harness.getModel());
		const fresh = harness.session.extensionRunner.createCommandContext();
		expect(fresh.getPreparationWait()).toEqual({ waitMs: 500, maxWaitMs: 1000 });
		expect(() => context.getPreparationWait()).toThrow("stale");
		enabled = true;
		release.resolve();
		harness.setResponses([
			(ctx) => {
				requests.push({ ...ctx, messages: structuredClone(ctx.messages) });
				return fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" });
			},
			(ctx) => {
				requests.push({ ...ctx, messages: structuredClone(ctx.messages) });
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("prepare");
		expect(harness.session.state.errorMessage).toBeUndefined();
		expect(requests[0]?.messages.map(getMessageText).join("\n")).toContain("prepared evidence");
		expect(effective).toEqual([500, 0]);
		expect(boundaries.map((event) => event.waitAvailableMs)).toEqual([500, 500, 0]);
		expect(JSON.stringify(harness.session.messages)).not.toContain("prepared evidence");

		requestWait = false;
		release = deferred<void>();
		harness.setResponses([fauxAssistantMessage("no demand")]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			// No preparation demand: inference completes without advancing any wait timer.
			await harness.session.prompt("do not request a wait");
		} finally {
			vi.useRealTimers();
		}
		expect(harness.faux.state.callCount).toBe(4);
		release.resolve();
		const other = await setup();
		expect(other.context.getPreparationWait()).toEqual({ waitMs: 0, maxWaitMs: 1000 });
	});
});

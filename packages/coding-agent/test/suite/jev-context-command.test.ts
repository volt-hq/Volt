import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonValue } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createJevContextPreparation,
	type JevPreparationOptions,
} from "../../examples/extensions/jev-context-preparation.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
const directories: string[] = [];
const releases: Array<() => void> = [];
const stateType = "jev-context-preparation";
const callType = "jev-context-call";
const invalidStates: JsonValue[] = [null, { enabled: "true" }, { enabled: true, zeroDataRetention: true }];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.stubEnv("AI_GATEWAY_API_KEY", "");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Live network forbidden in this suite");
		}),
	);
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	vi.useRealTimers();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function setup(options: JevPreparationOptions = {}, harnessOptions: HarnessOptions = {}) {
	let api!: ExtensionAPI;
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({
			answers: { "source-1": { type: "choice", choice: "source-1" } },
		}),
	);
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionWorkLimits: { firstRequestWaitMs: 800 },
		initialActiveToolNames: ["read"],
		...harnessOptions,
		extensionFactories: [
			(volt) => {
				api = volt;
				createJevContextPreparation({ fetch, ...options })(volt);
			},
			...(harnessOptions.extensionFactories ?? []),
		],
	});
	harnesses.push(harness);
	harness.session.setSessionName("Jev command test");
	harness.authStorage.set("vercel-ai-gateway", { type: "api_key", key: "synthetic-key" });
	const auth = vi.spyOn(harness.authStorage, "getApiKey");
	const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(true);
	const select = vi.fn<ExtensionUIContext["select"]>().mockResolvedValue("Enable Jev");
	const notify = vi.fn<ExtensionUIContext["notify"]>();
	const setStatus = vi.fn<ExtensionUIContext["setStatus"]>();
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: { ...harness.session.extensionRunner.getUIContext(), confirm, select, notify, setStatus },
	});
	await writeFile(join(harness.tempDir, "example.ts"), "export const PREPARED_SOURCE = true;\n");
	return { harness, api, fetch, auth, confirm, select, notify, setStatus };
}

function savedState(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === stateType);
}

function callRecords(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === callType);
}

async function prompt(harness: Harness, text = "Explain example.ts") {
	let projected = "";
	harness.setResponses([
		(context) => {
			projected = context.messages.map(getMessageText).join("\n");
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt(text);
	return projected;
}

describe("Jev extension command and TUI status", () => {
	it("advertises a local command and shows off without credential lookup or preparation", async () => {
		const test = await setup();
		const command = test.harness.session.extensionRunner.getCommand("jev");
		expect(command).toBeDefined();
		expect(command?.remoteSafe).not.toBe(true);
		expect(await command?.getArgumentCompletions?.("o")).toEqual([
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
		]);
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("Shared allowance: 800 ms; host limit: 800 ms");
		expect(test.harness.faux.state.callCount).toBe(0);
		expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
		expect(test.fetch).not.toHaveBeenCalled();
		expect(test.auth.mock.calls.filter(([provider]) => provider === "vercel-ai-gateway")).toEqual([]);
		expect(test.api.getWorkStatus().tasks).toEqual([]);
	});

	it("enables through the panel only after consent and disables without inference", async () => {
		const test = await setup();
		await test.harness.session.prompt("/jev");
		expect(test.select).toHaveBeenCalledWith("Jev: off", ["Enable Jev", "Preparation wait: 800 ms", "Show status"]);
		expect(test.confirm.mock.lastCall?.[1]).toContain("Vercel AI Gateway / TypeSafe AI");
		expect(test.confirm.mock.lastCall?.[1]).toContain("Zero Data Retention is off");
		expect(test.confirm.mock.lastCall?.[1]).toContain("not redacted");
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on");
		expect(savedState(test.harness)).toMatchObject([{ data: { enabled: true, zeroDataRetention: false } }]);
		expect(test.harness.faux.state.callCount).toBe(0);
		expect(test.fetch).not.toHaveBeenCalled();
		expect(await prompt(test.harness)).toContain("PREPARED_SOURCE");
		expect(test.fetch).toHaveBeenCalledOnce();
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on · evaluated");
		expect(JSON.stringify(test.harness.session.messages)).not.toContain(stateType);
		test.select.mockResolvedValue("Disable Jev");
		await test.harness.session.prompt("/jev");
		expect(test.confirm).toHaveBeenCalledOnce();
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
		expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
		expect(test.fetch).toHaveBeenCalledOnce();
	});

	it.each(["panel", "confirmation"])("leaves Jev disabled after cancelling the %s", async (stage) => {
		const test = await setup();
		if (stage === "panel") test.select.mockResolvedValue(undefined);
		else test.confirm.mockResolvedValue(false);
		await test.harness.session.prompt("/jev");
		expect(savedState(test.harness)).toEqual([]);
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
		expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
		expect(test.fetch).not.toHaveBeenCalled();
	});

	it("supports status in the panel and rejects invalid arguments without inference", async () => {
		const test = await setup();
		test.select.mockResolvedValue("Show status");
		await test.harness.session.prompt("/jev");
		expect(test.notify.mock.lastCall?.[0]).toContain("Jev: off");
		await test.harness.session.prompt("/jev maybe");
		expect(test.notify).toHaveBeenLastCalledWith("Usage: /jev [on|off|status|wait|report]", "warning");
		expect(test.confirm).not.toHaveBeenCalled();
		expect(savedState(test.harness)).toEqual([]);
		expect(test.harness.faux.state.callCount).toBe(0);
	});

	it("retains CLI opt-in, with an explicit saved off taking precedence after reload", async () => {
		const test = await setup();
		test.harness.session.extensionRunner.setFlagValue(stateType, true);
		await test.harness.session.bindExtensions({ mode: "tui" });
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on");
		await test.harness.session.prompt("/jev off");
		await test.harness.session.reload();
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
		expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
		expect(test.fetch).not.toHaveBeenCalled();
	});

	it("restores the branch-local choice on reload and tree navigation", async () => {
		const test = await setup();
		const root = test.harness.sessionManager.getLeafId()!;
		await test.harness.session.prompt("/jev on");
		const enabled = test.harness.sessionManager.getLeafId()!;
		await test.harness.session.reload();
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on");
		await test.harness.session.prompt("/jev off");
		await test.harness.session.navigateTree(enabled);
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on");
		await test.harness.session.navigateTree(root);
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
		expect(test.confirm).toHaveBeenCalledOnce();
	});

	it("restores consent from the persisted session after reopening, but not in a new session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-jev-command-"));
		directories.push(directory);
		const manager = await SessionManager.create(directory, directory);
		const first = await setup({}, { sessionManager: manager, extensionWorkLimits: undefined });
		await first.harness.session.prompt("/jev on");
		const ref = manager.getSessionRef()!;
		first.harness.session.dispose();
		await first.harness.session.waitForClosed();
		const second = await setup(
			{},
			{ sessionManager: await SessionManager.open(ref), extensionWorkLimits: undefined },
		);
		expect(second.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on");
		expect(second.confirm).not.toHaveBeenCalled();
		await second.harness.session.prompt("/jev status");
		expect(second.notify.mock.lastCall?.[0]).toContain("Shared allowance: 0 ms; host limit: 1000 ms");
		const fresh = await setup();
		expect(fresh.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
	});

	it.each(invalidStates)("does not treat malformed or different-retention state as consent: %j", async (data) => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry<JsonValue>(stateType, data);
		const test = await setup({}, { sessionManager: manager });
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
		await test.harness.session.prompt("/jev on");
		expect(test.confirm).toHaveBeenCalledOnce();
	});

	it("honors explicit SDK disablement over both commands and saved consent", async () => {
		const manager = SessionManager.inMemory();
		manager.appendCustomEntry(stateType, { enabled: true, zeroDataRetention: false });
		const test = await setup({ enabled: false }, { sessionManager: manager });
		await test.harness.session.prompt("/jev on");
		expect(test.notify).toHaveBeenLastCalledWith("Jev is disabled by the SDK host.", "warning");
		expect(test.confirm).not.toHaveBeenCalled();
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
		expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
		expect(test.fetch).not.toHaveBeenCalled();
	});

	it("discloses and preserves a required ZDR policy", async () => {
		const test = await setup({ zeroDataRetention: true });
		await test.harness.session.prompt("/jev on");
		expect(test.confirm.mock.lastCall?.[1]).toContain("Zero Data Retention is required");
		expect(savedState(test.harness)).toMatchObject([{ data: { enabled: true, zeroDataRetention: true } }]);
		await prompt(test.harness);
		expect(JSON.parse(String(test.fetch.mock.calls[0][1]?.body)).providerOptions).toEqual({
			gateway: { zeroDataRetention: true },
		});
	});

	it.each(["rpc", "json", "print"] as const)("does not enable through a command in %s mode", async (mode) => {
		const test = await setup();
		await test.harness.session.bindExtensions({ mode });
		await test.harness.session.prompt("/jev on");
		expect(test.confirm).not.toHaveBeenCalled();
		expect(savedState(test.harness)).toEqual([]);
		expect(test.fetch).not.toHaveBeenCalled();
		expect(test.harness.faux.state.callCount).toBe(0);
	});

	it("shows missing-credential fallback without exposing source text or secrets", async () => {
		const test = await setup();
		await test.harness.session.prompt("/jev on");
		test.harness.authStorage.remove("vercel-ai-gateway");
		expect(await prompt(test.harness)).toContain("PREPARED_SOURCE");
		expect(test.fetch).not.toHaveBeenCalled();
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on · fallback (no credentials)");
		expect(JSON.stringify(test.setStatus.mock.calls)).not.toMatch(/PREPARED_SOURCE|synthetic-key|example\.ts/);
	});

	it("offers 800 ms with separate host consent when enabling without a startup allowance", async () => {
		const test = await setup({}, { extensionWorkLimits: undefined });
		await test.harness.session.prompt("/jev on");
		expect(test.confirm).toHaveBeenCalledTimes(2);
		expect(test.confirm.mock.calls[0][1]).toContain("Vercel AI Gateway / TypeSafe AI");
		expect(test.confirm.mock.calls[1][1]).toContain("800");
		expect(test.fetch).not.toHaveBeenCalled();
		expect(test.harness.faux.state.callCount).toBe(0);
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("Shared allowance: 800 ms; host limit: 1000 ms");
		expect(await prompt(test.harness)).toContain("PREPARED_SOURCE");
	});

	it("can accept Jev export consent while declining the suggested wait", async () => {
		const test = await setup({}, { extensionWorkLimits: undefined });
		test.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		await test.harness.session.prompt("/jev on");
		expect(test.confirm).toHaveBeenCalledTimes(2);
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on · ready-only");
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("Shared allowance: 0 ms; host limit: 1000 ms");
		expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
	});

	it("changes the shared allowance through the panel without enabling Jev or making requests", async () => {
		const test = await setup({}, { extensionWorkLimits: undefined });
		test.select.mockResolvedValueOnce("Preparation wait: 0 ms").mockResolvedValueOnce("400 ms");
		await test.harness.session.prompt("/jev");
		expect(test.select.mock.calls[1][1]).toEqual([
			"0 ms (ready-only)",
			"100 ms",
			"400 ms",
			"800 ms (recommended)",
			"1000 ms",
		]);
		expect(test.confirm).toHaveBeenCalledOnce();
		expect(test.confirm.mock.calls[0][1]).toContain("400");
		expect(test.confirm.mock.calls[0][1]).not.toContain("Vercel");
		expect(test.notify).toHaveBeenLastCalledWith("Shared preparation allowance: 400 ms; runtime only.", "info");
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
		expect(savedState(test.harness)).toEqual([]);
		expect(test.fetch).not.toHaveBeenCalled();
		expect(test.harness.faux.state.callCount).toBe(0);
		await test.harness.session.reload();
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("Shared allowance: 400 ms; host limit: 1000 ms");
		expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
	});

	it.each(["selection", "host confirmation"])("leaves the allowance unchanged on cancelled %s", async (stage) => {
		const test = await setup({}, { extensionWorkLimits: undefined });
		test.select.mockResolvedValue(stage === "selection" ? undefined : "800 ms (recommended)");
		test.confirm.mockResolvedValue(false);
		await test.harness.session.prompt("/jev wait");
		expect(test.confirm).toHaveBeenCalledTimes(stage === "selection" ? 0 : 1);
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("Shared allowance: 0 ms; host limit: 1000 ms");
		expect(savedState(test.harness)).toEqual([]);
	});

	it.each([0, 100, 333])("limits the wait selector to an explicit %i ms SDK ceiling", async (maximum) => {
		const test = await setup({}, { extensionWorkLimits: { firstRequestWaitMs: maximum } });
		test.select.mockResolvedValue(undefined);
		await test.harness.session.prompt("/jev wait");
		const offered = test.select.mock.calls[0][1].map((label) => Number.parseInt(label, 10));
		expect(offered).toContain(0);
		expect(offered).toContain(maximum);
		expect(offered.every((value) => value <= maximum)).toBe(true);
		expect(test.select.mock.calls[0][0]).toContain(`host limit: ${maximum} ms`);
	});

	it("can lower the allowance to zero without disabling Jev", async () => {
		const test = await setup();
		await test.harness.session.prompt("/jev on");
		test.select.mockResolvedValue("0 ms (ready-only)");
		await test.harness.session.prompt("/jev wait");
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on · ready-only");
		expect(test.notify).toHaveBeenLastCalledWith("Shared preparation allowance: 0 ms; runtime only.", "info");
		expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
		expect(savedState(test.harness)).toMatchObject([{ data: { enabled: true } }]);
	});

	it("does not raise an explicit zero host ceiling and reports ready-only operation", async () => {
		const test = await setup({}, { extensionWorkLimits: { firstRequestWaitMs: 0 } });
		await test.harness.session.prompt("/jev on");
		expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
		expect(test.setStatus.mock.calls.some(([, text]) => text?.includes("ready-only"))).toBe(true);
		expect(test.harness.faux.state.callCount).toBe(1);
	});

	it("waits for a running turn before applying a state change", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.push(release.resolve);
		const test = await setup(
			{},
			{
				extensionFactories: [
					(volt) => {
						volt.registerTool({
							name: "pause",
							label: "Pause",
							description: "Test synchronization",
							parameters: Type.Object({}),
							execute: async () => {
								entered.resolve();
								await release.promise;
								return { content: [{ type: "text", text: "done" }] };
							},
						});
					},
				],
			},
		);
		await test.harness.session.prompt("/jev on");
		test.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("pause", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const running = test.harness.session.prompt("Wait at the checkpoint");
		await entered.promise;
		const disabling = test.harness.session.prompt("/jev off");
		expect(savedState(test.harness)).toHaveLength(1);
		release.resolve();
		await Promise.all([running, disabling]);
		expect(savedState(test.harness)).toHaveLength(2);
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
	});

	it.each(["Thanks for the update", "Explain example.ts"])(
		"applies /jev off after a queued follow-up runs while waiting: %s",
		async (followUp) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const commandEntered = Promise.withResolvers<void>();
			releases.push(release.resolve);
			const test = await setup();
			await test.harness.session.prompt("/jev on");
			test.harness.setResponses([
				async () => {
					entered.resolve();
					await release.promise;
					return fauxAssistantMessage("done");
				},
				fauxAssistantMessage("follow-up done"),
			]);
			const running = test.harness.session.prompt("Explain example.ts");
			await entered.promise;
			await test.harness.session.followUp(followUp);
			test.setStatus.mockImplementation(() => commandEntered.resolve());
			const disabling = test.harness.session.prompt("/jev off");
			await commandEntered.promise;
			expect(savedState(test.harness)).toHaveLength(1);
			release.resolve();
			await Promise.all([running, disabling]);
			expect(test.harness.faux.state.callCount).toBe(2);
			expect(savedState(test.harness)).toMatchObject([{ data: { enabled: true } }, { data: { enabled: false } }]);
			expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
			expect(test.notify.mock.lastCall?.[0]).toContain("Jev: off; on/off saved for this session branch");
			const calls = followUp === "Explain example.ts" ? 2 : 1;
			expect(test.fetch).toHaveBeenCalledTimes(calls);
			expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
			expect(test.fetch).toHaveBeenCalledTimes(calls);
			await test.harness.session.reload();
			expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
			expect(await prompt(test.harness)).not.toContain("PREPARED_SOURCE");
			expect(test.fetch).toHaveBeenCalledTimes(calls);
		},
	);

	it("does not let an old cancelled evaluation overwrite status after toggling off and on", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const evaluated = Promise.withResolvers<void>();
		releases.push(release.resolve);
		const test = await setup(
			{ onEvaluation: () => evaluated.resolve() },
			{
				extensionWorkLimits: { firstRequestWaitMs: 0 },
				extensionFactories: [
					(volt) => {
						volt.registerTool({
							name: "checkpoint",
							label: "Checkpoint",
							description: "Wait until auxiliary HTTP has started",
							parameters: Type.Object({}),
							execute: async () => {
								await entered.promise;
								return { content: [{ type: "text", text: "done" }] };
							},
						});
					},
				],
			},
		);
		test.fetch.mockImplementation(async () => {
			entered.resolve();
			// Deliberately uncooperative transport: resolve only after cancellation and a new opt-in.
			await release.promise;
			return Response.json({ answers: { "source-1": { type: "choice", choice: "source-1" } } });
		});
		await test.harness.session.prompt("/jev on");
		test.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await test.harness.session.prompt("Explain example.ts");
		await test.harness.session.prompt("/jev off");
		await test.harness.session.prompt("/jev on");
		const statusUpdates = test.setStatus.mock.calls.length;
		release.resolve();
		await evaluated.promise;
		expect(test.setStatus).toHaveBeenCalledTimes(statusUpdates);
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: on · ready-only");
	});

	it.each(["reload", "tree navigation"])("does not apply a confirmation that outlives session %s", async (change) => {
		const entered = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<boolean>();
		releases.push(() => answer.resolve(false));
		const test = await setup();
		const root = test.harness.sessionManager.getLeafId()!;
		test.harness.session.setSessionName("Before Jev consent");
		test.confirm.mockImplementation(async () => {
			entered.resolve();
			return answer.promise;
		});
		const command = test.harness.session.prompt("/jev on");
		await entered.promise;
		if (change === "reload") await test.harness.session.reload();
		else await test.harness.session.navigateTree(root);
		answer.resolve(true);
		await command;
		expect(savedState(test.harness)).toEqual([]);
		expect(test.setStatus).toHaveBeenLastCalledWith(stateType, "Jev: off");
	});
});

describe("Jev call history", () => {
	it("counts dispatch immediately and persists a sanitized result outside model context", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.push(release.resolve);
		const test = await setup();
		test.fetch.mockImplementation(async () => {
			// Persistence waits until collection/dispatch finishes; live status includes buffered records.
			expect(callRecords(test.harness)).toEqual([]);
			entered.resolve();
			await release.promise;
			return Response.json({
				answers: { "source-1": { type: "choice", choice: "source-1" } },
				usage: { inputTokens: 100, outputTokens: 10 },
				providerMetadata: { gateway: { cost: "0.001", secret: "RAW_PROVIDER_SECRET" } },
			});
		});
		await test.harness.session.prompt("/jev on");
		const running = prompt(test.harness, "Explain example.ts REQUEST_SECRET");
		await entered.promise;
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("1 attempted, 0 finished, 0 successful; 1 via custom transport");
		expect(test.notify.mock.lastCall?.[0]).toContain("result not recorded (in flight or interrupted)");
		release.resolve();
		const projection = await running;
		expect(projection).toContain("PREPARED_SOURCE");
		expect(projection).not.toContain(callType);
		expect(JSON.stringify(test.harness.session.messages)).not.toContain(callType);
		const records = callRecords(test.harness);
		expect(records).toHaveLength(2);
		expect(records[1].data).toEqual({
			callId: expect.any(String),
			timestamp: expect.any(String),
			phase: "finished",
			status: "selected",
			elapsedMs: 0,
			requestBytes: Buffer.byteLength(String(test.fetch.mock.calls[0][1]?.body)),
			httpStatus: 200,
			inputTokens: 100,
			outputTokens: 10,
			cost: "0.001",
		});
		expect(JSON.stringify(records)).not.toMatch(
			/example\.ts|PREPARED_SOURCE|REQUEST_SECRET|RAW_PROVIDER_SECRET|synthetic-key|choices/,
		);
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("1 attempted, 1 finished, 1 successful; 1 via custom transport");
		expect(test.notify.mock.lastCall?.[0]).toContain("(custom transport); selected; HTTP 200; 0 ms");
		expect(test.harness.faux.state.callCount).toBe(1);
	});

	it("labels the default transport as Gateway without making a live request", async () => {
		const test = await setup({ fetch: undefined });
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ answers: { "source-1": { type: "choice", choice: "source-1" } } }),
		);
		vi.stubGlobal("fetch", fetch);
		await test.harness.session.prompt("/jev on");
		await prompt(test.harness);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0][0]).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
		expect(callRecords(test.harness)[0]).toMatchObject({ data: { phase: "started", transport: "gateway" } });
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("1 successful; 0 via custom transport");
		expect(test.notify.mock.lastCall?.[0]).toContain("(Gateway); selected; HTTP 200");
	});

	it.each(["disabled", "no candidates", "missing credentials"])(
		"does not count %s as an endpoint call",
		async (kind) => {
			const test = await setup();
			if (kind !== "disabled") await test.harness.session.prompt("/jev on");
			if (kind === "missing credentials") test.harness.authStorage.remove("vercel-ai-gateway");
			await prompt(test.harness, kind === "no candidates" ? "Thanks" : "Explain example.ts");
			await test.harness.session.prompt("/jev status");
			expect(test.fetch).not.toHaveBeenCalled();
			expect(callRecords(test.harness)).toEqual([]);
			expect(test.notify.mock.lastCall?.[0]).toContain("0 attempted, 0 finished, 0 successful");
			expect(test.notify.mock.lastCall?.[0]).toContain("older unlogged calls are unknown");
		},
	);

	it.each(["http", "response", "transport"])("records %s failures without raw errors", async (kind) => {
		const test = await setup();
		if (kind === "http") test.fetch.mockResolvedValue(Response.json({ error: "RAW_SECRET" }, { status: 403 }));
		if (kind === "response") test.fetch.mockResolvedValue(Response.json({ answers: { secret: "RAW_SECRET" } }));
		if (kind === "transport")
			test.fetch.mockImplementation(() => {
				throw new Error("RAW_SECRET");
			});
		await test.harness.session.prompt("/jev on");
		expect(await prompt(test.harness)).toContain("PREPARED_SOURCE");
		expect(callRecords(test.harness)).toHaveLength(2);
		expect(callRecords(test.harness)[1]).toMatchObject({
			data: { phase: "finished", status: "unavailable", reason: kind },
		});
		expect(JSON.stringify(callRecords(test.harness))).not.toContain("RAW_SECRET");
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("1 attempted, 1 finished, 0 successful");
		expect(test.notify.mock.lastCall?.[0]).toContain(`unavailable (${kind})`);
		expect(test.notify.mock.lastCall?.[0]).toContain(
			kind === "transport" ? "no HTTP status recorded" : `HTTP ${kind === "http" ? 403 : 200}`,
		);
	});

	it("records cancellation after dispatch without waking the main model", async () => {
		const entered = Promise.withResolvers<void>();
		const evaluated = Promise.withResolvers<void>();
		const test = await setup(
			{ onEvaluation: () => evaluated.resolve() },
			{ extensionWorkLimits: { firstRequestWaitMs: 0 } },
		);
		test.fetch.mockImplementation(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("RAW_SECRET")), { once: true });
					entered.resolve();
				}),
		);
		await test.harness.session.prompt("/jev on");
		test.harness.setResponses([
			async () => {
				await entered.promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Explain example.ts");
		await evaluated.promise;
		await test.harness.session.prompt("/jev off");
		expect(callRecords(test.harness)[1]).toMatchObject({
			data: { phase: "finished", status: "cancelled", reason: "aborted" },
		});
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("1 attempted, 1 finished, 0 successful");
		expect(test.notify.mock.lastCall?.[0]).toContain("cancelled (aborted)");
		expect(test.harness.faux.state.callCount).toBe(1);
	});

	it("restores branch-local history across reload, navigation, and persistent resume", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-jev-history-"));
		directories.push(directory);
		const manager = await SessionManager.create(directory, directory);
		const first = await setup({}, { sessionManager: manager });
		await first.harness.session.prompt("/jev on");
		const root = manager.getLeafId()!;
		await prompt(first.harness);
		const recorded = manager.getLeafId()!;
		await first.harness.session.reload();
		await first.harness.session.prompt("/jev status");
		expect(first.notify.mock.lastCall?.[0]).toContain("1 attempted, 1 finished, 1 successful");
		await first.harness.session.navigateTree(root);
		await first.harness.session.prompt("/jev status");
		expect(first.notify.mock.lastCall?.[0]).toContain("0 attempted, 0 finished, 0 successful");
		await first.harness.session.navigateTree(recorded);
		const ref = manager.getSessionRef()!;
		first.harness.session.dispose();
		await first.harness.session.waitForClosed();
		const second = await setup({}, { sessionManager: await SessionManager.open(ref) });
		await second.harness.session.prompt("/jev status");
		expect(second.notify.mock.lastCall?.[0]).toContain("1 attempted, 1 finished, 1 successful");
		expect(second.notify.mock.lastCall?.[0]).toContain("HTTP 200");
		expect(second.fetch).not.toHaveBeenCalled();
	});

	it("does not append late results to a navigated branch", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const evaluated = Promise.withResolvers<void>();
		releases.push(release.resolve);
		const test = await setup(
			{ onEvaluation: () => evaluated.resolve() },
			{ extensionWorkLimits: { firstRequestWaitMs: 0 } },
		);
		test.fetch.mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return Response.json({ answers: { "source-1": { type: "choice", choice: "source-1" } } });
		});
		await test.harness.session.prompt("/jev on");
		const root = test.harness.sessionManager.getLeafId()!;
		test.harness.setResponses([
			async () => {
				await entered.promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Explain example.ts");
		expect(callRecords(test.harness)).toHaveLength(1);
		const recorded = test.harness.sessionManager.getLeafId()!;
		await test.harness.session.navigateTree(root);
		release.resolve();
		await evaluated.promise;
		expect(callRecords(test.harness)).toEqual([]);
		await test.harness.session.navigateTree(recorded);
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("1 attempted, 0 finished, 0 successful");
		expect(test.notify.mock.lastCall?.[0]).toContain("result not recorded (in flight or interrupted)");
		expect(test.harness.faux.state.callCount).toBe(1);
	});

	it("ignores malformed persisted records and never renders arbitrary saved status text", async () => {
		const manager = SessionManager.inMemory();
		const callId = "11111111-1111-4111-8111-111111111111";
		manager.appendCustomEntry(callType, null);
		manager.appendCustomEntry(callType, { callId: "RAW_SECRET", phase: "started", transport: "gateway" });
		manager.appendCustomEntry(callType, {
			callId,
			phase: "started",
			transport: "gateway",
			timestamp: "2026-09-19T00:00:00.000Z",
		});
		manager.appendCustomEntry(callType, { callId, phase: "finished", status: "RAW_SECRET", reason: "RAW_SECRET" });
		const test = await setup({}, { sessionManager: manager });
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("1 attempted, 0 finished, 0 successful");
		expect(test.notify.mock.lastCall?.[0]).not.toContain("RAW_SECRET");
		expect(test.fetch).not.toHaveBeenCalled();
	});

	it("contains call-recording failures without changing preparation or inference", async () => {
		const test = await setup();
		const append = test.harness.sessionManager.appendCustomEntry.bind(test.harness.sessionManager);
		vi.spyOn(test.harness.sessionManager, "appendCustomEntry").mockImplementation((type, data) => {
			if (type === callType) throw new Error("private persistence error");
			return append(type, data);
		});
		await test.harness.session.prompt("/jev on");
		expect(await prompt(test.harness)).toContain("PREPARED_SOURCE");
		expect(test.fetch).toHaveBeenCalledOnce();
		await test.harness.session.prompt("/jev status");
		expect(test.notify.mock.lastCall?.[0]).toContain("Call recording failed; history may be incomplete");
		expect(test.notify.mock.lastCall?.[0]).not.toContain("private persistence error");
	});
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AHEAD_AUDIT_TYPE, type AheadAudit } from "../../examples/extensions/jev-ahead-of-model/audit.ts";
import {
	type AheadOptions,
	type AheadReport,
	createJevAheadOfModel,
} from "../../examples/extensions/jev-ahead-of-model/index.ts";
import { MAX_AHEAD_CYCLES } from "../../examples/extensions/jev-ahead-of-model/limits.ts";
import type { ExtensionAPI, ExtensionFactory, ExtensionUIContext } from "../../src/index.ts";
import { loadSkillsFromDir, SessionManager } from "../../src/index.ts";
import { type AheadRequest, aheadAnswers, aheadResponse } from "../fixtures/jev-ahead.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const releases: Array<() => void> = [];
const directories: string[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.stubEnv("AI_GATEWAY_API_KEY", "");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Live network forbidden");
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

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}

async function setup(
	options: AheadOptions = {},
	extra?: ExtensionFactory,
	wait = 1000,
	sessionManager?: SessionManager,
) {
	let api!: ExtensionAPI;
	let report: AheadReport | undefined;
	const completed = Array.from({ length: MAX_AHEAD_CYCLES }, () => barrier());
	const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => aheadResponse(init));
	const harness = await createHarness({
		sessionManager,
		systemPrompt: "SYSTEM_INSTRUCTIONS_MUST_NOT_BE_EXPORTED",
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionWorkLimits: { firstRequestWaitMs: wait },
		initialActiveToolNames: ["read", "find", "grep"],
		extensionFactories: [
			(volt) => {
				api = volt;
				createJevAheadOfModel({
					enabled: true,
					fetch,
					...options,
					onReport: (value) => {
						report = value;
						for (const cycle of value.cycles)
							if (["prepared", "abstained", "no readable evidence"].includes(cycle.status))
								completed[cycle.number - 1]?.resolve();
						return options.onReport?.(value);
					},
				})(volt);
			},
			...(extra ? [extra] : []),
		],
	});
	harnesses.push(harness);
	harness.authStorage.set("vercel-ai-gateway", { type: "api_key", key: "synthetic-key" });
	await mkdir(join(harness.tempDir, "src"));
	await writeFile(join(harness.tempDir, "src/session.ts"), "export const resume = 'SESSION_EVIDENCE';\n");
	await writeFile(join(harness.tempDir, "src/irrelevant.ts"), "export const IRRELEVANT_EVIDENCE = true;\n");
	await mkdir(join(harness.tempDir, "skills/resume"), { recursive: true });
	await writeFile(
		join(harness.tempDir, "skills/resume/SKILL.md"),
		"---\nname: resume\ndescription: Diagnose session restoration\n---\nSKILL_INSTRUCTIONS\n",
	);
	const skills = loadSkillsFromDir({ dir: join(harness.tempDir, "skills"), source: "user" });
	harness.session.resourceLoader.getSkills = () => skills;
	return { harness, api, fetch, completed, report: () => report };
}

function audits(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === AHEAD_AUDIT_TYPE
				? [{ id: entry.id, data: entry.data as unknown as AheadAudit }]
				: [],
		);
}

describe("Jev Ahead of Model Work integration", () => {
	it("prepares source and skill evidence before the first main request through native services", async () => {
		const test = await setup();
		let projected = "";
		test.harness.setResponses([
			(context) => {
				projected = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(projected).toContain("SESSION_EVIDENCE");
		expect(projected).toContain("SKILL_INSTRUCTIONS");
		expect(projected).not.toContain("IRRELEVANT_EVIDENCE");
		expect(test.fetch).toHaveBeenCalledTimes(3);
		expect(test.report()?.evaluations.map((item) => item.stage)).toEqual(["orient", "select", "assess"]);
		expect(test.report()?.cycles[0].publications.every((item) => item.status === "accepted")).toBe(true);
		expect(JSON.stringify(test.report())).not.toContain("SESSION_EVIDENCE");
		expect(JSON.stringify(test.harness.session.messages)).not.toContain("SESSION_EVIDENCE");
		expect(test.harness.eventsOfType("tool_execution_start")).toEqual([]);
		const requests = test.fetch.mock.calls.map(([, init]) => String(init?.body));
		expect(requests[1]).toContain("SKILL_INSTRUCTIONS");
		expect(requests[2]).toContain("SESSION_EVIDENCE");
		for (const request of requests) {
			expect(request).not.toContain("SYSTEM_INSTRUCTIONS_MUST_NOT_BE_EXPORTED");
			expect(request).not.toContain(test.harness.tempDir);
			expect(request).not.toContain("synthetic-key");
		}
	});

	it("admits preparation that misses the initial cutoff on a later turn with no renewed wait", async () => {
		const assessing = barrier();
		const finishAssessment = barrier();
		let calls = 0;
		const test = await setup({
			fetch: async (_url, init) => {
				if (++calls === 3) {
					assessing.resolve();
					await finishAssessment.promise;
				}
				return aheadResponse(init);
			},
		});
		const projections: string[] = [];
		test.harness.setResponses([
			async (context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				finishAssessment.resolve();
				await test.completed[0].promise;
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/irrelevant.ts" })], {
					stopReason: "toolUse",
				});
			},
			(context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = test.harness.session.prompt("Investigate resume");
		await assessing.promise;
		await vi.advanceTimersByTimeAsync(1000);
		await prompt;
		expect(projections[0]).not.toContain("SESSION_EVIDENCE");
		expect(projections[1]).toContain("SESSION_EVIDENCE");
		expect(test.harness.faux.state.callCount).toBe(2);
		expect(test.report()?.boundaries.map((item) => item.waitMs)).toEqual([1000, 0]);
	});

	it("continues preparing beyond three cycles without creating model turns", async () => {
		let root = "";
		let executions = 0;
		const test = await setup({}, (volt) => {
			volt.registerTool({
				name: "checkpoint",
				label: "Checkpoint",
				description: "Test control",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					await writeFile(join(root, "src/session.ts"), "export const resume = 'UPDATED_EVIDENCE';\n");
					return { content: [{ type: "text", text: `resume lookup outcome ${executions}` }] };
				},
			});
		});
		root = test.harness.tempDir;
		const projections: string[] = [];
		const checkpoint = () => fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" });
		test.harness.setResponses([
			(context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				return checkpoint();
			},
			async (context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				await test.completed[1].promise;
				return checkpoint();
			},
			async (context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				await test.completed[2].promise;
				return checkpoint();
			},
			async () => {
				await test.completed[3].promise;
				return checkpoint();
			},
			async () => {
				await test.completed[4].promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(test.harness.faux.state.callCount).toBe(5);
		expect(test.report()?.cycles).toHaveLength(5);
		expect(test.fetch).toHaveBeenCalledTimes(15);
		expect(projections[2]).toContain("UPDATED_EVIDENCE");
		const requests = test.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as AheadRequest);
		expect(requests[3].state.tools?.[0]).toMatchObject({
			name: "checkpoint",
			isError: false,
			text: "resume lookup outcome 1",
		});
		expect(test.report()?.boundaries.map((item) => item.waitMs)).toEqual([1000, 0, 0, 0, 0]);
		const saved = audits(test.harness);
		expect(saved).toHaveLength(1);
		expect(saved[0].data.evaluations).toHaveLength(15);
		expect(saved[0].data.evaluations.map((call) => call.cycle)).toEqual([
			1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5,
		]);
		expect(saved[0].data.evaluations.map((call) => call.requestBody)).toEqual(
			test.fetch.mock.calls.map(([, init]) => init?.body),
		);
	});

	it("coalesces a tool batch into one update and ignores repeated identical results", async () => {
		const test = await setup();
		const checkpoint = () =>
			fauxAssistantMessage(
				[
					fauxToolCall("read", { path: "src/irrelevant.ts" }),
					fauxToolCall("read", { path: "src/irrelevant.ts" }),
					fauxToolCall("find", { pattern: "**/*.ts" }),
				],
				{ stopReason: "toolUse" },
			);
		test.harness.setResponses([
			checkpoint(),
			async () => {
				await test.completed[1].promise;
				return checkpoint();
			},
			fauxAssistantMessage("done"),
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(test.report()?.cycles).toHaveLength(2);
		expect(test.report()?.coalescedToolResults).toBe(1);
		expect(test.report()?.duplicateToolResults).toBe(4);
		expect(test.harness.faux.state.callCount).toBe(3);
		expect(test.fetch).toHaveBeenCalledTimes(6);
	});

	it("retires prepared source after a foreground read while keeping unread evidence", async () => {
		const test = await setup();
		await writeFile(join(test.harness.tempDir, "src/second.ts"), "export const resume = 'SECOND_EVIDENCE';\n");
		const projections: string[] = [];
		test.harness.setResponses([
			(context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage(
					[fauxToolCall("read", { path: "src/session.ts" }), fauxToolCall("read", { path: "src/second.ts" })],
					{ stopReason: "toolUse" },
				);
			},
			async (context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				await test.completed[1].promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(projections[0]).toContain('Ahead of Model Work: "src/session.ts"');
		expect(projections[0]).toContain('Ahead of Model Work: "src/second.ts"');
		expect(projections[1]).not.toContain('Ahead of Model Work: "src/session.ts"');
		expect(projections[1]).not.toContain('Ahead of Model Work: "src/second.ts"');
		expect(projections[1]).toContain("SKILL_INSTRUCTIONS");
		expect(test.report()?.retired).toContainEqual(
			expect.objectContaining({ candidate: "src/session.ts", reason: "foreground_read" }),
		);
		expect(test.report()?.retired).toContainEqual(
			expect.objectContaining({ candidate: "src/second.ts", reason: "foreground_read" }),
		);
		expect(test.report()?.cycles[1].operations.filter((item) => item.service === "readText")).toEqual([]);
	});

	it("keeps an excerpt when a foreground read covers only its first line", async () => {
		const test = await setup();
		await writeFile(
			join(test.harness.tempDir, "src/session.ts"),
			"// resume\nexport function resume() {\n  return 'UNREAD_BODY';\n}\n",
		);
		let projection = "";
		test.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/session.ts", limit: 1 })], { stopReason: "toolUse" }),
			(context) => {
				projection = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(projection).toContain('Ahead of Model Work: "src/session.ts"');
		expect(projection).toContain("UNREAD_BODY");
		expect(test.report()?.retired).toEqual([]);
	});

	it("does not publish a late excerpt when the foreground has already read it", async () => {
		const assessing = barrier();
		const release = barrier();
		let calls = 0;
		const test = await setup(
			{
				fetch: async (_url, init) => {
					if (++calls === 3) {
						assessing.resolve();
						await release.promise;
					}
					return aheadResponse(init);
				},
			},
			undefined,
			0,
		);
		test.harness.setResponses([
			async () => {
				await assessing.promise;
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/session.ts" })], { stopReason: "toolUse" });
			},
			async () => {
				release.resolve();
				await test.completed[0].promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		const publications = audits(test.harness)[0].data.publications;
		expect(publications).toContainEqual(
			expect.objectContaining({
				omittedReason: "foreground_read",
				contribution: expect.objectContaining({ text: expect.stringContaining('"src/session.ts"') }),
			}),
		);
		expect(
			publications
				.filter((item) => item.contribution.text.includes('"src/session.ts"'))
				.every((item) => item.result === undefined),
		).toBe(true);
	});

	it("includes recent conversation for a follow-up and excludes private reasoning", async () => {
		const test = await setup();
		test.harness.setResponses([
			fauxAssistantMessage([
				{ type: "thinking", thinking: "PRIVATE_REASONING" },
				{ type: "text", text: "The resume path needs investigation." },
			]),
			fauxAssistantMessage("done"),
		]);
		await test.harness.session.prompt("The resume workflow is broken");
		await test.harness.session.prompt("Investigate it");
		const requests = test.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as AheadRequest);
		const followup = requests.find(
			(request) => request.questions.phase && request.state.request === "Investigate it",
		);
		expect(followup?.state.recent).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "assistant", text: "The resume path needs investigation." }),
			]),
		);
		expect(JSON.stringify(requests)).not.toContain("PRIVATE_REASONING");
		expect(JSON.stringify(followup?.state.recent)).not.toContain("SESSION_EVIDENCE");
		expect(JSON.stringify(followup?.state.recent)).not.toContain("requestBody");
	});

	it("does no work or credential lookup when loaded without consent", async () => {
		const test = await setup({ enabled: undefined });
		const key = vi.spyOn(test.harness.authStorage, "getApiKey");
		test.harness.setResponses([fauxAssistantMessage("done")]);
		await test.harness.session.prompt("Investigate resume");
		expect(test.fetch).not.toHaveBeenCalled();
		expect(key.mock.calls.filter(([provider]) => provider === "vercel-ai-gateway")).toEqual([]);
		expect(test.api.getWorkStatus().tasks).toEqual([]);
		expect(audits(test.harness)).toEqual([]);
	});

	it.each(["denied", "redacted"])("respects %s reads without exporting the hidden source", async (kind) => {
		const test = await setup({}, (volt) => {
			if (kind === "denied")
				volt.on("tool_call", (event) =>
					event.origin?.kind === "extension" && ["read", "grep"].includes(event.toolName)
						? { block: true, reason: "Test policy" }
						: undefined,
				);
			else
				volt.on("tool_result", (event) =>
					event.origin?.kind === "extension" && ["read", "grep"].includes(event.toolName)
						? { content: [{ type: "text", text: "redacted" }] }
						: undefined,
				);
		});
		let projection = "";
		test.harness.setResponses([
			(context) => {
				projection = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(projection).not.toContain("SESSION_EVIDENCE");
		expect(test.fetch.mock.calls.some(([, init]) => String(init?.body).includes("SESSION_EVIDENCE"))).toBe(false);
		expect(test.fetch.mock.calls.some(([, init]) => String(init?.body).includes("SKILL_INSTRUCTIONS"))).toBe(false);
	});

	it("cancels a pending evaluation when the foreground settles and does not wake inference", async () => {
		let signal: AbortSignal | null | undefined;
		const entered = barrier();
		const test = await setup(
			{
				fetch: async (_url, init) => {
					signal = init?.signal;
					entered.resolve();
					return new Promise<Response>((_resolve, reject) => {
						if (signal?.aborted) reject(new Error("cancelled"));
						else signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
					});
				},
			},
			undefined,
			0,
		);
		test.harness.setResponses([
			async () => {
				await entered.promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(signal?.aborted).toBe(true);
		expect(test.harness.faux.state.callCount).toBe(1);
		expect(test.report()?.cycles[0].publications).toEqual([]);
		const audit = audits(test.harness)[0].data;
		expect(audit).toMatchObject({ interrupted: true, reason: "agent_end" });
		expect(audit.evaluations).toHaveLength(1);
		expect(audit.evaluations[0].dispatchedAt).toBeDefined();
		expect(audit.evaluations[0].requestBody).toContain("Investigate resume");
		expect(audit.evaluations[0].result).toBeUndefined();
	});

	it("obtains separate content-export consent and renders the live report without inference", async () => {
		const test = await setup({ enabled: undefined });
		const confirm = vi.fn<ExtensionUIContext["confirm"]>().mockResolvedValue(false);
		const notify = vi.fn<ExtensionUIContext["notify"]>();
		await test.harness.session.bindExtensions({
			mode: "tui",
			uiContext: { ...test.harness.session.extensionRunner.getUIContext(), confirm, notify },
		});
		await test.harness.session.prompt("/ahead on");
		expect(confirm.mock.lastCall?.[1]).toContain("source excerpts, and skill instructions");
		expect(test.fetch).not.toHaveBeenCalled();
		confirm.mockResolvedValue(true);
		await test.harness.session.prompt("/ahead on");
		test.harness.setResponses([fauxAssistantMessage("done")]);
		await test.harness.session.prompt("Investigate resume");
		const count = test.fetch.mock.calls.length;
		await test.harness.session.prompt("/ahead report");
		expect(notify.mock.lastCall?.[0]).toContain("orient:");
		expect(notify.mock.lastCall?.[0]).toContain("assess:");
		expect(notify.mock.lastCall?.[0]).toContain("reasoning savings are unmeasured");
		expect(test.fetch).toHaveBeenCalledTimes(count);
		await test.harness.session.prompt("/ahead off");
		test.harness.setResponses([fauxAssistantMessage("done")]);
		await test.harness.session.prompt("Investigate resume again");
		expect(test.fetch).toHaveBeenCalledTimes(count);
		expect(audits(test.harness)).toHaveLength(1);
		expect(test.harness.sessionManager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
	});

	it("persists exact evaluation bodies, decisions and admission through SQLite close and resume", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-ahead-audit-"));
		directories.push(directory);
		const manager = await SessionManager.create(directory, directory);
		const first = await setup({ zeroDataRetention: true }, undefined, 1000, manager);
		first.harness.setResponses([fauxAssistantMessage("done")]);
		await first.harness.session.prompt("Investigate resume and src/irrelevant.ts");
		const records = audits(first.harness);
		expect(records).toHaveLength(1);
		const { id, data } = records[0];
		expect(data).toMatchObject({ sessionId: manager.getSessionId(), reason: "agent_end", interrupted: false });
		expect(data.requestId).toBeTruthy();
		expect(data.branchId).toBeTruthy();
		expect(data.runtimeId).toBeTruthy();
		expect(data.evaluations.map((call) => call.requestBody)).toEqual(
			first.fetch.mock.calls.map(([, init]) => init?.body),
		);
		for (const call of data.evaluations) {
			expect(call.dispatchedAt).toBeDefined();
			expect(call.finishedAt).toBeDefined();
			expect(call.result).toMatchObject({
				status: "ok",
				httpStatus: 200,
				inputTokens: 100,
				outputTokens: 20,
				cost: "0.0000042",
			});
			expect(call.result?.elapsedMs).toBeGreaterThanOrEqual(0);
			expect(call.result?.requestBytes).toBe(Buffer.byteLength(call.requestBody!));
			expect(call.result).toMatchObject({ answers: aheadAnswers(JSON.parse(call.requestBody!) as AheadRequest) });
			expect(JSON.parse(call.requestBody!)).toMatchObject({
				providerOptions: { gateway: { zeroDataRetention: true } },
			});
		}
		expect(data.report.cycles[0].selection).toContainEqual({
			candidate: "src/irrelevant.ts",
			score: 0,
			selected: false,
		});
		expect(data.publications).toHaveLength(2);
		expect(
			data.publications.every(
				(item) => item.result?.status === "accepted" && item.contribution.evidenceIds?.length === 1,
			),
		).toBe(true);
		expect(JSON.stringify(data.publications)).toContain("SESSION_EVIDENCE");
		expect(JSON.stringify(data.publications)).toContain("SKILL_INSTRUCTIONS");
		expect(data.report.boundaries[0].attemptId).toBeTruthy();
		expect(data.report.boundaries[0].observation?.cycle).toBe(1);
		expect(data.report.boundaries[0].observation?.contributions.every((item) => item.status === "admitted")).toBe(
			true,
		);
		expect(JSON.stringify(data)).not.toContain("synthetic-key");
		expect(JSON.stringify(data)).not.toContain("Authorization");
		expect(JSON.stringify(data)).not.toContain("SYSTEM_INSTRUCTIONS_MUST_NOT_BE_EXPORTED");
		expect(JSON.stringify(first.harness.session.messages)).not.toContain("SESSION_EVIDENCE");
		const ref = manager.getSessionRef()!;
		first.harness.session.dispose();
		await first.harness.session.waitForClosed();
		const second = await setup({ enabled: undefined }, undefined, 1000, await SessionManager.open(ref));
		expect(audits(second.harness)).toEqual(records);
		const notify = vi.fn<ExtensionUIContext["notify"]>();
		await second.harness.session.bindExtensions({
			mode: "tui",
			uiContext: { ...second.harness.session.extensionRunner.getUIContext(), notify },
		});
		await second.harness.session.prompt("/ahead history");
		expect(notify.mock.lastCall?.[0]).toContain("SQLite session");
		expect(notify.mock.lastCall?.[0]).toContain(`${id} ·`);
		await second.harness.session.prompt(`/ahead audit ${id}`);
		expect(JSON.parse(notify.mock.lastCall![0])).toEqual(data);
		await second.harness.session.prompt("/ahead audit");
		expect(JSON.parse(notify.mock.lastCall![0])).toEqual(data);
		await second.harness.session.prompt("/ahead status");
		expect(notify.mock.lastCall?.[0]).toContain("Ahead: off");
		expect(second.fetch).not.toHaveBeenCalled();
		expect(second.harness.faux.state.callCount).toBe(0);
	});

	it("records preflight and HTTP failures without credentials or raw provider errors", async () => {
		const test = await setup();
		vi.spyOn(test.harness.session.modelRegistry, "getApiKeyForProvider").mockResolvedValueOnce(undefined);
		test.harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done")]);
		await test.harness.session.prompt("Investigate resume");
		const missing = audits(test.harness)[0].data.evaluations[0];
		expect(missing.requestBody).toContain("Investigate resume");
		expect(missing.dispatchedAt).toBeUndefined();
		expect(missing.result).toMatchObject({ status: "unavailable", reason: "credentials" });
		expect(test.fetch).not.toHaveBeenCalled();
		test.fetch.mockImplementation(async () => new Response("PRIVATE_PROVIDER_ERROR", { status: 429 }));
		await test.harness.session.prompt("Investigate resume again");
		const failed = audits(test.harness)[1].data.evaluations[0];
		expect(failed.dispatchedAt).toBeDefined();
		expect(failed.result).toMatchObject({ status: "unavailable", reason: "http", httpStatus: 429 });
		expect(JSON.stringify(audits(test.harness))).not.toContain("PRIVATE_PROVIDER_ERROR");
	});

	it("seals interrupted audits and never appends a late response onto a navigated branch", async () => {
		const entered = barrier();
		const release = barrier();
		const test = await setup(
			{
				fetch: async (_url, init) => {
					entered.resolve();
					await release.promise;
					return aheadResponse(init);
				},
			},
			undefined,
			0,
		);
		test.harness.sessionManager.appendCustomEntry("branch-anchor", {});
		const root = test.harness.sessionManager.getLeafId()!;
		test.harness.setResponses([
			async () => {
				await entered.promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		const saved = JSON.stringify(audits(test.harness));
		expect(audits(test.harness)[0].data.interrupted).toBe(true);
		const recorded = test.harness.sessionManager.getLeafId()!;
		await test.harness.session.navigateTree(root);
		release.resolve();
		await vi.waitFor(() => expect(test.api.getWorkStatus().tasks[0]?.state).toBe("cancelled"));
		expect(
			test.harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === AHEAD_AUDIT_TYPE),
		).toBe(false);
		expect(JSON.stringify(audits(test.harness))).toBe(saved);
		await test.harness.session.navigateTree(recorded);
		expect(JSON.stringify(audits(test.harness))).toBe(saved);
		expect(test.harness.faux.state.callCount).toBe(1);
	});

	it("ignores malformed audits and labels in-memory history without enabling Jev", async () => {
		const test = await setup({ enabled: undefined });
		test.harness.sessionManager.appendCustomEntry(AHEAD_AUDIT_TYPE, {
			requestId: "\u001b[31mBAD_SAVED_STATUS",
			startedAt: "bad",
			interrupted: false,
			evaluations: [],
		});
		const invalid = test.harness.sessionManager.getLeafId()!;
		const notify = vi.fn<ExtensionUIContext["notify"]>();
		await test.harness.session.bindExtensions({
			mode: "tui",
			uiContext: { ...test.harness.session.extensionRunner.getUIContext(), notify },
		});
		await test.harness.session.prompt("/ahead history");
		expect(notify.mock.lastCall?.[0]).toContain("In-memory session; not durable");
		expect(notify.mock.lastCall?.[0]).toContain("No saved Ahead audits");
		expect(notify.mock.lastCall?.[0]).not.toContain("BAD_SAVED_STATUS");
		await test.harness.session.prompt(`/ahead audit ${invalid}`);
		expect(notify.mock.lastCall?.[0]).toBe("No matching Ahead audit in this session.");
		expect(test.fetch).not.toHaveBeenCalled();
		expect(test.harness.faux.state.callCount).toBe(0);
	});

	it("reports audit append failures without breaking the main response or preparation", async () => {
		const test = await setup();
		const append = test.harness.sessionManager.appendCustomEntry.bind(test.harness.sessionManager);
		vi.spyOn(test.harness.sessionManager, "appendCustomEntry").mockImplementation((type, data) => {
			if (type === AHEAD_AUDIT_TYPE) throw new Error("synthetic storage failure");
			return append(type, data);
		});
		const notify = vi.fn<ExtensionUIContext["notify"]>();
		await test.harness.session.bindExtensions({
			mode: "tui",
			uiContext: { ...test.harness.session.extensionRunner.getUIContext(), notify },
		});
		test.harness.setResponses([fauxAssistantMessage("done")]);
		await test.harness.session.prompt("Investigate resume");
		expect(test.fetch).toHaveBeenCalledTimes(3);
		expect(test.report()?.cycles[0].status).toBe("prepared");
		expect(notify).toHaveBeenCalledWith("Ahead audit could not be appended to the session.", "warning");
		await test.harness.session.prompt("/ahead report");
		expect(notify.mock.lastCall?.[0]).toContain("Audit: failed");
		expect(audits(test.harness)).toEqual([]);
		expect(test.harness.faux.state.callCount).toBe(1);
	});
});

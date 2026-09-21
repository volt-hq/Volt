import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AheadOptions,
	type AheadReport,
	createJevAheadOfModel,
} from "../../examples/extensions/jev-ahead-of-model/index.ts";
import type { ExtensionAPI, ExtensionFactory, ExtensionUIContext } from "../../src/index.ts";
import { loadSkillsFromDir } from "../../src/index.ts";
import { type AheadRequest, aheadResponse } from "../fixtures/jev-ahead.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const releases: Array<() => void> = [];
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

async function setup(options: AheadOptions = {}, extra?: ExtensionFactory, wait = 1000) {
	let api!: ExtensionAPI;
	let report: AheadReport | undefined;
	const completed = [barrier(), barrier(), barrier()];
	const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => aheadResponse(init));
	const harness = await createHarness({
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

	it("repeats after tool results with fresh source and bounded cycles, without creating model turns", async () => {
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
			fauxAssistantMessage("done"),
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(test.harness.faux.state.callCount).toBe(4);
		expect(test.report()?.cycles).toHaveLength(3);
		expect(test.fetch).toHaveBeenCalledTimes(9);
		expect(projections[2]).toContain("UPDATED_EVIDENCE");
		const requests = test.fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as AheadRequest);
		expect(requests[3].state.tools?.[0]).toMatchObject({
			name: "checkpoint",
			isError: false,
			text: "resume lookup outcome 1",
		});
		expect(test.report()?.boundaries.map((item) => item.waitMs)).toEqual([1000, 0, 0, 0]);
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
	});

	it("does no work or credential lookup when loaded without consent", async () => {
		const test = await setup({ enabled: undefined });
		const key = vi.spyOn(test.harness.authStorage, "getApiKey");
		test.harness.setResponses([fauxAssistantMessage("done")]);
		await test.harness.session.prompt("Investigate resume");
		expect(test.fetch).not.toHaveBeenCalled();
		expect(key.mock.calls.filter(([provider]) => provider === "vercel-ai-gateway")).toEqual([]);
		expect(test.api.getWorkStatus().tasks).toEqual([]);
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
		expect(test.harness.sessionManager.getBranch().filter((entry) => entry.type === "custom")).toEqual([]);
	});
});

import { existsSync } from "node:fs";
import { glob, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import * as findTools from "../../src/core/tools/find.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	ExtensionOperationEvent,
	ExtensionUIContext,
	ExtensionWorkLimits,
} from "../../src/index.ts";
import { loadSkillsFromDir, SessionManager } from "../../src/index.ts";
import { type AheadRequest, aheadAnswers, aheadResponse } from "../fixtures/jev-ahead.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const releases: Array<() => void> = [];
const directories: string[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.stubEnv("AI_GATEWAY_API_KEY", "");
	// Keep the native find observation/policy path, using fixture files rather than
	// depending on an installed fd binary or permitting a tool download in this suite.
	const createFind = findTools.createFindToolDefinition;
	vi.spyOn(findTools, "createFindToolDefinition").mockImplementation((cwd) =>
		createFind(cwd, {
			operations: {
				exists: existsSync,
				glob: async (pattern, directory, options) => {
					const paths: string[] = [];
					for await (const path of glob(pattern, { cwd: directory })) {
						paths.push(join(directory, path));
						if (paths.length >= options.limit) break;
					}
					return paths;
				},
			},
		}),
	);
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
	limits?: Partial<ExtensionWorkLimits>,
) {
	let api!: ExtensionAPI;
	let report: AheadReport | undefined;
	const completed = Array.from({ length: MAX_AHEAD_CYCLES }, () => barrier());
	const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => aheadResponse(init));
	const harness = await createHarness({
		sessionManager,
		systemPrompt: "SYSTEM_INSTRUCTIONS_MUST_NOT_BE_EXPORTED",
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionWorkLimits: { firstRequestWaitMs: wait, ...limits },
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
							if (
								[
									"prepared",
									"abstained",
									"no readable evidence",
									"native budget reached",
									"no candidates",
								].includes(cycle.status)
							)
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
	it.each(["recovered", "exhausted"])("seals once after %s foreground retries", async (outcome) => {
		vi.useRealTimers();
		const atEnd: number[] = [];
		const test = await setup({}, (volt) => {
			volt.on("agent_end", () => {
				atEnd.push(audits(test.harness).length);
			});
		});
		test.harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
		test.harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
			() => {
				expect(audits(test.harness)).toEqual([]);
				return outcome === "recovered"
					? fauxAssistantMessage([fauxToolCall("read", { path: "src/irrelevant.ts" })], { stopReason: "toolUse" })
					: fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });
			},
			async () => {
				await test.completed[1].promise;
				return fauxAssistantMessage("done after retry and tools");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(atEnd).toEqual([0, 0]);
		const records = audits(test.harness);
		expect(records).toHaveLength(1);
		expect(records[0].data.reason).toBe("agent_settled");
		expect(records[0].data.report.boundaries.map((item) => item.cause)).toEqual(
			outcome === "recovered" ? ["input", "retry", "tools"] : ["input", "retry"],
		);
		if (outcome === "recovered") expect(records[0].data.evaluations.some((call) => call.cycle === 2)).toBe(true);
		expect(test.harness.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each(["steer", "followUp"] as const)(
		"buffers superseded %s audits without invalidating collection",
		async (delivery) => {
			const test = await setup();
			const projections: string[] = [];
			test.harness.setResponses([
				async (context) => {
					projections.push(context.messages.map(getMessageText).join("\n"));
					await test.harness.session.prompt("Investigate resume again", { streamingBehavior: delivery });
					return fauxAssistantMessage("first answer");
				},
				(context) => {
					expect(audits(test.harness)).toEqual([]);
					projections.push(context.messages.map(getMessageText).join("\n"));
					return fauxAssistantMessage("second answer");
				},
			]);
			await test.harness.session.prompt("Investigate resume");
			const records = audits(test.harness);
			expect(records.map(({ data }) => data.reason)).toEqual(["superseded", "agent_settled"]);
			expect(new Set(records.map(({ data }) => data.requestId)).size).toBe(2);
			for (const projection of projections) {
				expect(projection).toContain("SESSION_EVIDENCE");
				expect(projection).not.toContain("requestBody");
			}
			for (const { data } of records) {
				expect(data.report.boundaries).toHaveLength(1);
				for (const call of data.evaluations) expect(call.requestBody).not.toContain("requestBody");
			}
		},
	);

	it("seals the current audit after aborting foreground retry backoff", async () => {
		vi.useRealTimers();
		const test = await setup();
		test.harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } });
		const retry = barrier();
		test.harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retry.resolve();
		});
		test.harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" })]);
		const prompt = test.harness.session.prompt("Investigate resume");
		await retry.promise;
		expect(audits(test.harness)).toEqual([]);
		await test.harness.session.abort();
		await prompt;
		expect(audits(test.harness).map(({ data }) => data.reason)).toEqual(["agent_settled"]);
		expect(test.harness.faux.state.callCount).toBe(1);
	});

	it("discovers children through the native find observation after directory normalization", async () => {
		const test = await setup();
		await rm(join(test.harness.tempDir, "skills"), { recursive: true });
		test.harness.session.resourceLoader.getSkills = () => ({ skills: [], diagnostics: [] });
		await mkdir(join(test.harness.tempDir, "src/resume"));
		await writeFile(
			join(test.harness.tempDir, "src/resume/index.ts"),
			"export const implementation = 'DIRECTORY_EVIDENCE';\n",
		);
		let projection = "";
		test.harness.setResponses([
			(context) => {
				projection = context.messages.map(getMessageText).join("\n");
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(test.report()?.cycles[0].operations).toContainEqual(
			expect.objectContaining({ service: "findPaths", candidate: "src/resume", status: "ok" }),
		);
		expect(projection).toContain("DIRECTORY_EVIDENCE");
	});

	it("preserves native grep hit locations and search terms when the input is a file", async () => {
		const test = await setup();
		await writeFile(
			join(test.harness.tempDir, "src/deep.ts"),
			`${"// setup\n".repeat(1700)}export function settleAfterRetry() { return true; }\n`,
		);
		test.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { path: "src/deep.ts", pattern: "settleAfterRetry" })], {
				stopReason: "toolUse",
			}),
			async () => {
				await test.completed[1].promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate src/session.ts");
		const orient = audits(test.harness)[0].data.evaluations.find(
			(call) => call.cycle === 2 && call.stage === "orient",
		)!;
		const state = JSON.parse(orient.requestBody!).state;
		expect(state.paths).toContainEqual({ path: "src/deep.ts", line: 1701, origin: "tool" });
		expect(state.tools).toContainEqual(expect.objectContaining({ name: "grep", query: "settleAfterRetry" }));
		expect(test.report()?.cycles[1].publications).toContainEqual(
			expect.objectContaining({ candidate: "src/deep.ts", startLine: 1701 }),
		);
	});

	it("bounds repeated validation and admits newly discovered evidence after seventy foreground requests", async () => {
		const operations: ExtensionOperationEvent[] = [];
		const test = await setup({}, (volt) => {
			volt.on("extension_operation", (event) => {
				operations.push(event);
			});
		});
		await writeFile(join(test.harness.tempDir, "src/late.ts"), "export const late = 'LATE_EVIDENCE';\n");
		const projections: string[] = [];
		test.harness.setResponses(
			Array.from({ length: 76 }, (_, i) => async (context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				if (i === 1) await test.completed[1].promise;
				if (i === 73) await test.completed[2].promise;
				return i === 75
					? fauxAssistantMessage("done")
					: fauxAssistantMessage(
							[
								i === 72
									? fauxToolCall("find", { path: "src", pattern: "late.ts" })
									: fauxToolCall("read", { path: "src/irrelevant.ts" }),
							],
							{ stopReason: "toolUse" },
						);
			}),
		);
		await test.harness.session.prompt("Investigate src/session.ts");
		expect(projections.filter((text) => text.includes("SESSION_EVIDENCE"))).toHaveLength(2);
		expect(projections[74]).toContain("LATE_EVIDENCE");
		expect(test.harness.faux.state.callCount).toBe(76);
		expect(operations.filter((event) => event.ownerKind === "validation").length).toBeLessThanOrEqual(8);
		expect(operations.every((event) => event.status !== "limit_exceeded")).toBe(true);
		expect(test.report()?.retired).toContainEqual(
			expect.objectContaining({ candidate: "src/session.ts", reason: "offer_limit" }),
		);
	});

	it("caches skill reads and directory checks across read-only foreground turns", async () => {
		const operations: ExtensionOperationEvent[] = [];
		const test = await setup({}, (volt) => {
			volt.on("extension_operation", (event) => {
				operations.push(event);
			});
		});
		test.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/irrelevant.ts", limit: 1 })], {
				stopReason: "toolUse",
			}),
			async () => {
				await test.completed[1].promise;
				return fauxAssistantMessage([fauxToolCall("find", { path: "src", pattern: "*.ts" })], {
					stopReason: "toolUse",
				});
			},
			async () => {
				await test.completed[2].promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate src/session.ts");
		expect(operations.filter((event) => event.ownerKind === "task" && event.service === "readSkill")).toHaveLength(1);
		expect(operations.filter((event) => event.ownerKind === "task" && event.service === "findPaths")).toHaveLength(1);
		expect(operations.some((event) => event.ownerKind === "validation" && event.service === "readSkill")).toBe(true);
		const saved = audits(test.harness)[0].data;
		expect(saved.report.native.cacheHits).toBeGreaterThanOrEqual(2);
		expect(saved.report.native.validationReservations).toBe(
			operations.filter((event) => event.ownerKind === "validation").length,
		);
	});

	it("revalidates offered skill evidence after external edits and then retires the packet", async () => {
		const test = await setup();
		const projections: string[] = [];
		test.harness.setResponses([
			async () => {
				await writeFile(join(test.harness.tempDir, "skills/resume/SKILL.md"), "UPDATED_SKILL_INSTRUCTIONS\n");
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/irrelevant.ts", limit: 1 })], {
					stopReason: "toolUse",
				});
			},
			async (context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				await test.completed[1].promise;
				return fauxAssistantMessage([fauxToolCall("find", { path: "src", pattern: "*.ts" })], {
					stopReason: "toolUse",
				});
			},
			async (context) => {
				projections.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate src/session.ts");
		expect(projections[0]).not.toContain("SKILL_INSTRUCTIONS");
		expect(projections[0]).toContain("SESSION_EVIDENCE");
		expect(test.report()?.boundaries[1]?.observation?.contributions).toContainEqual(
			expect.objectContaining({ status: "omitted", reason: "source_unverified" }),
		);
		expect(projections[1]).not.toContain("SESSION_EVIDENCE");
		expect(projections[1]).not.toContain("SKILL_INSTRUCTIONS");
	});

	it("leaves native capacity for evidence admission and stops Jev calls before exhausting the host", async () => {
		let checkpoints = 0;
		const operations: ExtensionOperationEvent[] = [];
		const test = await setup({}, (volt) => {
			volt.on("extension_operation", (event) => {
				operations.push(event);
			});
			volt.registerTool({
				name: "checkpoint",
				label: "Checkpoint",
				description: "Advance the fixture",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: `resume checkpoint ${++checkpoints}` }] }),
			});
		});
		const stoppedCounts: number[] = [];
		test.harness.setResponses(
			Array.from({ length: 13 }, (_, i) => async () => {
				await vi.waitFor(() => expect(test.report()?.status).not.toBe("preparing"));
				if (test.report()?.status === "native budget reached") stoppedCounts.push(test.fetch.mock.calls.length);
				return i === 12
					? fauxAssistantMessage("done")
					: fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" });
			}),
		);
		await test.harness.session.prompt("Investigate resume");
		expect(stoppedCounts.length).toBeGreaterThan(1);
		expect(new Set(stoppedCounts).size).toBe(1);
		expect(operations.every((event) => event.status !== "limit_exceeded")).toBe(true);
		expect(operations.length).toBeLessThanOrEqual(64);
		expect(test.harness.faux.state.callCount).toBe(13);
		expect(test.report()?.boundaries.at(-1)?.observation?.contributions).toEqual([]);
		expect(test.report()?.native.validationReservations).toBeGreaterThan(0);
	});

	it("stops further evaluations after a lower host limit blocks repository work", async () => {
		const test = await setup({}, undefined, 1000, undefined, { scopeOperations: 2 });
		let count = 0;
		test.harness.setResponses([
			async () => {
				await test.completed[0].promise;
				count = test.fetch.mock.calls.length;
				return fauxAssistantMessage([fauxToolCall("read", { path: "src/irrelevant.ts" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(test.report()?.status).toBe("native budget reached");
		expect(test.fetch).toHaveBeenCalledTimes(count);
		expect(test.report()?.cycles).toHaveLength(1);
		expect(test.report()?.cycles[0].operations).toContainEqual(
			expect.objectContaining({ status: "limit_exceeded", reason: "operation_budget" }),
		);
	});

	it("retires an excerpt covered by the visible portion of a truncated foreground read", async () => {
		const test = await setup();
		await writeFile(join(test.harness.tempDir, "src/session.ts"), `// resume\n${"// visible source\n".repeat(2100)}`);
		let projection = "";
		test.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/session.ts" })], { stopReason: "toolUse" }),
			async (context) => {
				projection = context.messages.map(getMessageText).join("\n");
				await test.completed[1].promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate src/session.ts");
		expect(projection).not.toContain('Ahead of Model Work: "src/session.ts"');
		expect(test.report()?.retired).toContainEqual(expect.objectContaining({ candidate: "src/session.ts" }));
		const saved = audits(test.harness)[0].data;
		const orient = saved.evaluations.find((item) => item.cycle === 2 && item.stage === "orient")!;
		expect(JSON.parse(orient.requestBody!).state.reads).toContainEqual({
			path: "src/session.ts",
			startLine: 1,
			endLine: 2000,
		});
		expect(
			saved.publications.filter((item) => item.cycle === 2 && item.contribution.text.includes('"src/session.ts"')),
		).toEqual([]);
	});

	it.each([502, 503, 504])(
		"retries HTTP %s selection failure within the same cycle and audits each attempt",
		async (status) => {
			let calls = 0;
			const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
				++calls === 2 ? new Response("PRIVATE_UNAVAILABLE", { status }) : aheadResponse(init),
			);
			const test = await setup({ fetch, zeroDataRetention: true });
			let projection = "";
			test.harness.setResponses([
				(context) => {
					projection = context.messages.map(getMessageText).join("\n");
					return fauxAssistantMessage("done");
				},
			]);
			await test.harness.session.prompt("Investigate resume");
			expect(projection).toContain("SESSION_EVIDENCE");
			expect(test.report()?.cycles).toHaveLength(1);
			expect(test.harness.faux.state.callCount).toBe(1);
			const saved = audits(test.harness)[0].data;
			expect(saved.evaluations.map((item) => [item.stage, item.attempt, item.result?.httpStatus])).toEqual([
				["orient", 1, 200],
				["select", 1, status],
				["select", 2, 200],
				["assess", 1, 200],
			]);
			expect(saved.evaluations[1].requestBody).toBe(saved.evaluations[2].requestBody);
			expect(JSON.parse(saved.evaluations[2].requestBody!)).toMatchObject({
				providerOptions: { gateway: { zeroDataRetention: true } },
			});
			expect(JSON.stringify(saved)).not.toContain("PRIVATE_UNAVAILABLE");
		},
	);

	it("bounds persistent failure to one retry and recovers on the next foreground update", async () => {
		let calls = 0;
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
			++calls <= 2 ? new Response(null, { status: 503 }) : aheadResponse(init),
		);
		const test = await setup({ fetch });
		test.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/irrelevant.ts" })], { stopReason: "toolUse" }),
			async () => {
				await test.completed[1].promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		expect(fetch).toHaveBeenCalledTimes(5);
		expect(test.report()?.cycles.map((item) => item.status)).toEqual(["orient: http", "prepared"]);
		expect(test.report()?.boundaries.map((item) => item.waitMs)).toEqual([1000, 0]);
		expect(test.report()?.cycles[1].publications).not.toHaveLength(0);
	});

	it("shares one retry across stages instead of retrying every failed stage", async () => {
		let calls = 0;
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
			[2, 4].includes(++calls) ? new Response(null, { status: 503 }) : aheadResponse(init),
		);
		const test = await setup({ fetch });
		test.harness.setResponses([fauxAssistantMessage("done")]);
		await test.harness.session.prompt("Investigate resume");
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(test.report()?.cycles[0].status).toBe("assess: http");
		expect(audits(test.harness)[0].data.publications).toEqual([]);
	});

	it("cancels a pending retry when the foreground finishes", async () => {
		const failed = barrier();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 503 }));
		const test = await setup(
			{
				fetch,
				onReport: (report) => {
					if (report.evaluations.length) failed.resolve();
				},
			},
			undefined,
			0,
		);
		test.harness.setResponses([
			async () => {
				await failed.promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		await vi.waitFor(() => expect(test.api.getWorkStatus().tasks[0]?.state).toBe("cancelled"));
		expect(fetch).toHaveBeenCalledOnce();
		expect(audits(test.harness)[0].data.evaluations).toHaveLength(1);
	});

	it("keeps imports relative to the foreground source file and ignores fixture strings", async () => {
		const test = await setup();
		await mkdir(join(test.harness.tempDir, "packages/jev"), { recursive: true });
		await writeFile(
			join(test.harness.tempDir, "packages/jev/index.ts"),
			'import { resume } from "./client.ts";\nconst fixture = "src/nonexistent.ts";\n',
		);
		await writeFile(
			join(test.harness.tempDir, "packages/jev/client.ts"),
			"export const resume = 'CLIENT_IMPLEMENTATION';\n",
		);
		test.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "packages/jev/index.ts" })], { stopReason: "toolUse" }),
			async () => {
				await test.completed[1].promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate packages/jev/index.ts");
		const saved = audits(test.harness)[0].data;
		const selection = saved.evaluations.find((item) => item.cycle === 2 && item.stage === "select")!;
		const candidates = (JSON.parse(selection.requestBody!) as AheadRequest).state.candidates!.map(
			(item) => item.path,
		);
		expect(candidates).toContain("packages/jev/client.ts");
		expect(candidates).not.toContain("client.ts");
		expect(candidates).not.toContain("src/nonexistent.ts");
		expect(candidates.every((path) => existsSync(join(test.harness.tempDir, path)))).toBe(true);
		expect(saved.publications.some((item) => item.contribution.text.includes("CLIENT_IMPLEMENTATION"))).toBe(true);
		expect(
			saved.report.cycles[1].operations.some(
				(item) => item.candidate === "client.ts" || item.candidate.includes("nonexistent"),
			),
		).toBe(false);
	});

	it("resolves foreground find output relative to its search directory", async () => {
		const test = await setup();
		test.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("find", { path: "src", pattern: "*.ts" })], { stopReason: "toolUse" }),
			async () => {
				await test.completed[1].promise;
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Investigate resume");
		const selection = audits(test.harness)[0].data.evaluations.find(
			(item) => item.cycle === 2 && item.stage === "select",
		)!;
		const candidates = (JSON.parse(selection.requestBody!) as AheadRequest).state.candidates!.map(
			(item) => item.path,
		);
		expect(candidates).toContain("src/irrelevant.ts");
		expect(JSON.parse(selection.requestBody!).state.paths).toEqual(
			expect.arrayContaining([
				{ path: "src/session.ts", line: 1, origin: "tool" },
				{ path: "src/irrelevant.ts", line: 1, origin: "tool" },
			]),
		);
		expect(candidates).not.toContain("session.ts");
		expect(candidates).not.toContain("irrelevant.ts");
	});

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
		expect(test.fetch).toHaveBeenCalledTimes(5);
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
		expect(test.report()?.retired.filter((item) => item.reason === "foreground_read")).toEqual([]);
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
		expect(audit).toMatchObject({ interrupted: true, reason: "agent_settled" });
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
		expect(data).toMatchObject({ sessionId: manager.getSessionId(), reason: "agent_settled", interrupted: false });
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

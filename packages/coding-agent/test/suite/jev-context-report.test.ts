import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJevContextPreparation } from "../../examples/extensions/jev-context-preparation.ts";
import { type ExtensionAPI, type ExtensionUIContext, loadSkillsFromDir } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

const harnesses: Harness[] = [];
const releases: Array<() => void> = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
	vi.stubEnv("AI_GATEWAY_API_KEY", "");
	vi.stubGlobal("fetch", () => {
		throw new Error("Live network forbidden");
	});
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	vi.useRealTimers();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function setup(options: HarnessOptions = {}, enabled = true) {
	let api!: ExtensionAPI;
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json({ answers: { "source-1": { type: "choice", choice: "source-1" } } }),
	);
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false } },
		extensionWorkLimits: { firstRequestWaitMs: 800 },
		initialActiveToolNames: ["read"],
		...options,
		extensionFactories: [
			(volt) => {
				api = volt;
				createJevContextPreparation({ enabled, fetch })(volt);
			},
			...(options.extensionFactories ?? []),
		],
	});
	harnesses.push(harness);
	harness.session.setSessionName("Jev report test");
	harness.authStorage.set("vercel-ai-gateway", { type: "api_key", key: "SECRET_KEY" });
	const notify = vi.fn<ExtensionUIContext["notify"]>();
	await harness.session.bindExtensions({
		mode: "tui",
		uiContext: { ...harness.session.extensionRunner.getUIContext(), notify },
	});
	await writeFile(join(harness.tempDir, "example.ts"), "export const SOURCE_SECRET = true;\n");
	return {
		harness,
		api,
		fetch,
		async report() {
			await harness.session.prompt("/jev report");
			return notify.mock.lastCall?.[0] ?? "";
		},
	};
}

async function addSkills(harness: Harness) {
	const root = join(harness.tempDir, "skills");
	for (const name of ["alpha", "beta"]) {
		const directory = join(root, name);
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "SKILL.md"),
			`---\nname: ${name}\ndescription: Specialized workflow\n---\nSKILL_BODY_SECRET_${name}\n`,
		);
	}
	const skills = loadSkillsFromDir({ dir: root, source: "user" });
	harness.session.resourceLoader.getSkills = () => skills;
}

async function prompt(harness: Harness, observe = true, text = "Explain example.ts REQUEST_SECRET") {
	let projected = "";
	harness.setResponses([
		async (context, options, _state, model) => {
			// Faux streams omit onPayload by default. Exercise the real provider hook when requested.
			if (observe) await options?.onPayload?.({ messages: context.messages }, model);
			projected = context.messages.map(getMessageText).join("\n");
			return fauxAssistantMessage("done");
		},
	]);
	await harness.session.prompt(text);
	return projected;
}

describe("Live Jev evaluation report", () => {
	it("distinguishes evaluation, accepted evidence, host admission, and unmeasured usefulness", async () => {
		const test = await setup();
		expect(await prompt(test.harness)).toContain("SOURCE_SECRET");
		const entries = test.harness.sessionManager.getBranch().length;
		const report = await test.report();
		expect(report).toContain("Evaluated: selected (valid response)");
		expect(report).toContain("Candidates offered: skills=0, sources=1");
		expect(report).toContain("Choices: source-1=source-1");
		expect(report).toContain("Decision application: applied");
		expect(report).toContain("readText source-1: ok; empty=false; truncated=false");
		expect(report).toContain("put source-1: accepted");
		expect(report).toContain("Evidence prepared: 1 accepted publications; 0 rejected; 0 removed");
		expect(report).toContain("Preparation task: completed");
		expect(report).toContain("#1 input, allowance 800 ms: payload hook observed");
		expect(report).toContain("source-1 admitted");
		expect(report).toContain("Useful to the task: unmeasured");
		expect(report).toContain("not proof of final payload delivery");
		expect(report).not.toMatch(/SOURCE_SECRET|REQUEST_SECRET|SECRET_KEY|example\.ts/);
		expect(report).not.toContain(test.harness.tempDir);
		expect(test.fetch).toHaveBeenCalledOnce();
		expect(test.harness.faux.state.callCount).toBe(1);
		expect(test.harness.sessionManager.getBranch()).toHaveLength(entries);
		expect(JSON.stringify(test.harness.session.messages)).not.toContain("Jev evaluation report");
		const command = test.harness.session.extensionRunner.getCommand("jev");
		expect(command?.getArgumentCompletions?.("rep")).toEqual([{ value: "report", label: "report" }]);
	});

	it("distinguishes an explicit skill abstention from failed preparation", async () => {
		const test = await setup();
		await addSkills(test.harness);
		test.fetch.mockResolvedValue(Response.json({ answers: { skill: { type: "choice", choice: "none" } } }));
		expect(await prompt(test.harness, true, "Thanks for the update")).not.toContain("SKILL_BODY_SECRET");
		const report = await test.report();
		expect(report).toContain("Evaluated: abstained (valid response)");
		expect(report).toContain("Candidates offered: skills=2, sources=0");
		expect(report).toContain("Choices: skill=none");
		expect(report).toContain("Decision application: applied");
		expect(report).toContain("Preparation operations (not host validation):\n  none observed");
		expect(report).toContain("0 accepted publications; 0 rejected; 0 removed");
		expect(report).toContain("preceding conversation is not included");
		expect(test.fetch).toHaveBeenCalledOnce();
	});

	it.each(["ok", "denied", "redacted"])("reports a Jev-selected skill with an %s read outcome", async (outcome) => {
		const test = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("tool_call", (event) => {
						if (outcome === "denied" && event.origin?.kind === "extension")
							return { block: true, reason: "PRIVATE_POLICY_ERROR" };
					});
					volt.on("tool_result", (event) => {
						if (outcome === "redacted" && event.origin?.kind === "extension")
							return { content: [{ type: "text", text: "PRIVATE_REDACTION" }] };
					});
				},
			],
		});
		await addSkills(test.harness);
		test.fetch.mockResolvedValue(Response.json({ answers: { skill: { type: "choice", choice: "skill-2" } } }));
		const projection = await prompt(test.harness, true, "Help with the task");
		const report = await test.report();
		expect(report).toContain('Choices: skill=skill-2 ("beta")');
		expect(report).toContain(
			`readSkill skill-2 ("beta"): ${outcome === "ok" ? "ok; empty=false; truncated=false" : outcome === "denied" ? "denied (extension_gate)" : "unavailable (transformed_result)"}`,
		);
		if (outcome === "ok") {
			expect(projection).toContain("SKILL_BODY_SECRET_beta");
			expect(report).toContain("put skill: accepted");
		} else {
			expect(projection).not.toContain("SKILL_BODY_SECRET");
			expect(report).toContain("0 accepted publications; 0 rejected; 0 removed");
			expect(report).not.toContain("put skill:");
		}
		expect(report).not.toMatch(/SKILL_BODY_SECRET|PRIVATE_POLICY_ERROR|PRIVATE_REDACTION|SKILL\.md/);
		expect(report).not.toContain(test.harness.tempDir);
		const history = test.harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "jev-context-call");
		expect(JSON.stringify(history)).not.toMatch(/skill-2|beta|choices|operations/);
	});

	it("distinguishes empty source reads from rejected publications", async () => {
		const test = await setup();
		await writeFile(join(test.harness.tempDir, "example.ts"), "   \n");
		await prompt(test.harness);
		const report = await test.report();
		expect(report).toContain("Choices: source-1=source-1");
		expect(report).toContain("readText source-1: ok; empty=true");
		expect(report).toContain("0 accepted publications; 0 rejected");
		expect(report).not.toContain("put source-1:");
	});

	it("separates fallback reads from a changed Jev skill selection", async () => {
		const test = await setup();
		await addSkills(test.harness);
		test.fetch.mockResolvedValue(Response.json({ answers: { skill: { type: "choice", choice: "skill-2" } } }));
		const projection = await prompt(test.harness, true, "Use alpha");
		expect(projection).not.toContain("SKILL_BODY_SECRET_alpha");
		expect(projection).toContain("SKILL_BODY_SECRET_beta");
		const report = await test.report();
		expect(report).toContain('Choices: skill=skill-2 ("beta")');
		expect(report).toContain('readSkill skill-1 ("alpha"): ok');
		expect(report).toContain('readSkill skill-2 ("beta"): ok');
		expect(report).toContain("remove skill: Jev selected a different skill");
		expect(report).toContain("2 accepted publications; 0 rejected; 1 removed");
	});

	it("reports pending work during an active request without waiting or starting inference", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.push(release.resolve);
		const test = await setup();
		test.fetch.mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return Response.json({ answers: { "source-1": { type: "choice", choice: "source-1" } } });
		});
		const running = prompt(test.harness);
		await entered.promise;
		const report = await test.report();
		expect(report).toContain("Evaluated: pending");
		expect(report).toContain("Choices: pending");
		expect(report).toContain("Decision application: pending");
		expect(report).toContain("provider admission unobserved");
		expect(test.fetch).toHaveBeenCalledOnce();
		expect(test.harness.faux.state.callCount).toBe(0);
		release.resolve();
		expect(await running).toContain("SOURCE_SECRET");
		expect(await test.report()).toContain("Evaluated: selected (valid response)");
		expect(test.harness.faux.state.callCount).toBe(1);
	});

	it.each(["stale", "denied", "timeout"])("reports prepared evidence omitted during %s validation", async (kind) => {
		const validation = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.push(release.resolve);
		let file = "";
		const test = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("tool_result", async (event) => {
						if (kind === "stale" && event.origin?.kind === "extension" && event.origin.ownerKind === "task")
							await writeFile(file, "changed\n");
					});
					volt.on("tool_call", async (event) => {
						if (event.origin?.kind !== "extension" || event.origin.ownerKind !== "validation") return;
						if (kind === "denied") return { block: true };
						if (kind === "timeout") {
							validation.resolve();
							await release.promise;
						}
					});
				},
			],
		});
		file = join(test.harness.tempDir, "example.ts");
		const running = prompt(test.harness);
		if (kind === "timeout") {
			await validation.promise;
			await vi.advanceTimersByTimeAsync(25);
			release.resolve();
		}
		expect(await running).not.toContain("SOURCE_SECRET");
		const report = await test.report();
		expect(report).toContain("Evaluated: selected (valid response)");
		expect(report).toContain("Evidence prepared: 1 accepted publications");
		expect(report).toContain("source-1 omitted (source_unverified)");
		expect(report).not.toContain("source-1 admitted");
	});

	it("does not count successful reads as prepared when the host rejects the contribution", async () => {
		const test = await setup({ extensionWorkLimits: { firstRequestWaitMs: 800, contributionBytes: 0 } });
		expect(await prompt(test.harness)).not.toContain("SOURCE_SECRET");
		const report = await test.report();
		expect(report).toContain("Evidence prepared: 0 accepted publications; 1 rejected");
		expect(report).toContain("readText source-1: ok; empty=false");
		expect(report).toContain("put source-1: limit_exceeded (contribution_budget)");
		expect(report).toContain("Host admission snapshot: no contributions");
	});

	it("keeps fallback admission separate from a missing-credential evaluation", async () => {
		const test = await setup();
		test.harness.authStorage.remove("vercel-ai-gateway");
		expect(await prompt(test.harness)).toContain("SOURCE_SECRET");
		const report = await test.report();
		expect(report).toContain("Evaluated: unavailable (credentials)");
		expect(report).toContain("Choices: unavailable (no valid decision)");
		expect(report).toContain("Decision application: deterministic fallback (no valid decision)");
		expect(report).toContain("source-1 admitted");
		expect(test.fetch).not.toHaveBeenCalled();
	});

	it("does not infer provider admission when the stream supplies no payload observation", async () => {
		const test = await setup();
		expect(await prompt(test.harness, false)).toContain("SOURCE_SECRET");
		const report = await test.report();
		expect(report).toContain("provider admission unobserved");
		expect(report).not.toContain("source-1 admitted");
		expect(report).toContain("Unobserved does not mean omitted");
	});

	it("preserves first-request fallback observations when a late evaluation prunes the next request", async () => {
		const prepared = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releases.push(release.resolve);
		const test = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("extension_operation", (event) => {
						if (event.ownerKind === "task") prepared.resolve();
					});
					volt.registerTool({
						name: "checkpoint",
						label: "Checkpoint",
						description: "Wait for preparation to settle",
						parameters: Type.Object({}),
						execute: async () => {
							release.resolve();
							await taskSettled;
							return { content: [{ type: "text", text: "done" }] };
						},
					});
				},
			],
		});
		// Register an observer after the consumer; retain only its admitted task's wait promise.
		let taskSettled: Promise<unknown> | undefined;
		const started = Promise.withResolvers<void>();
		test.api.on("request_boundary", (event, ctx) => {
			if (!event.first || !ctx.work) return;
			const existing = ctx.work.tasks.start({ key: "prepare-context", label: "Existing task" }, async () => {});
			if (existing.status === "already_running") taskSettled = existing.task.wait();
			started.resolve();
		});
		test.fetch.mockImplementation(async () => {
			await release.promise;
			return Response.json({ answers: { "source-1": { type: "choice", choice: "none" } } });
		});
		const projections: string[] = [];
		test.harness.setResponses([
			async (context, options, _state, model) => {
				await options?.onPayload?.({ messages: context.messages }, model);
				projections.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" });
			},
			async (context, options, _state, model) => {
				await options?.onPayload?.({ messages: context.messages }, model);
				projections.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("done");
			},
		]);
		const running = test.harness.session.prompt("Explain example.ts");
		await started.promise;
		await prepared.promise;
		await vi.advanceTimersByTimeAsync(800);
		await running;
		expect(projections[0]).toContain("SOURCE_SECRET");
		expect(projections[1]).not.toContain("SOURCE_SECRET");
		const report = await test.report();
		expect(report).toContain("Evaluated: abstained (valid response); 800 ms");
		expect(report).toContain("Choices: source-1=none");
		expect(report).toContain("remove source-1: Jev chose none");
		expect(report).toContain("Choices at observation: pending; decision application: pending");
		expect(report).toContain("Choices at observation: source-1=none; decision application: applied");
		expect(report).toContain("0 rejected; 1 removed");
		expect(report).toContain("#1 input, allowance 800 ms: payload hook observed; evaluation pending; 1 prepared");
		expect(report).toContain("source-1 admitted");
		expect(report).toContain("#2 tools, allowance 0 ms: payload hook observed; evaluation abstained");
		expect(report).toContain("Host admission snapshot: no contributions");
		expect(test.fetch).toHaveBeenCalledOnce();
		expect(test.harness.faux.state.callCount).toBe(2);
	});

	it.each(["reload", "navigation", "new input"])("does not inherit stale report data after %s", async (change) => {
		const test = await setup();
		const root = test.harness.sessionManager.getLeafId()!;
		await prompt(test.harness);
		if (change === "reload") await test.harness.session.reload();
		else if (change === "navigation") await test.harness.session.navigateTree(root);
		else await prompt(test.harness, true, "Thanks for the update");
		const report = await test.report();
		expect(report).not.toContain("source-1 admitted");
		if (change === "new input") {
			expect(report).toContain("Evaluated: not started (no candidates)");
			expect(report).toContain("Choices: not evaluated");
			expect(report).toContain("Preparation operations (not host validation):\n  none observed");
			expect(report).toContain("Evidence prepared: 0 accepted publications");
		} else expect(report).toContain("No Jev evaluation report");
	});

	it("bounds retained request observations without renewing the wait or evaluation", async () => {
		const test = await setup({
			extensionFactories: [
				(volt) => {
					volt.registerTool({
						name: "checkpoint",
						label: "Checkpoint",
						description: "Continue the test",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "done" }] }),
					});
				},
			],
		});
		test.harness.setResponses(
			Array.from({ length: 10 }, (_, index) => async (context, options, _state, model) => {
				await options?.onPayload?.({ messages: context.messages }, model);
				return index < 9
					? fauxAssistantMessage([fauxToolCall("checkpoint", {})], { stopReason: "toolUse" })
					: fauxAssistantMessage("done");
			}),
		);
		await test.harness.session.prompt("Explain example.ts");
		const report = await test.report();
		expect(report).toContain("10 boundaries; showing the last 8");
		expect(report).not.toContain("#1 input");
		expect(report).not.toContain("#2 tools");
		expect(report).toContain("#3 tools, allowance 0 ms");
		expect(report).toContain("#10 tools, allowance 0 ms");
		expect(test.fetch).toHaveBeenCalledOnce();
		expect(test.harness.faux.state.callCount).toBe(10);
	});

	it("keeps diagnostic failures observational and omits private exception text", async () => {
		const test = await setup();
		vi.spyOn(test.api, "getWorkStatus").mockImplementation(() => {
			throw new Error("PRIVATE_DIAGNOSTIC_ERROR");
		});
		expect(await prompt(test.harness)).toContain("SOURCE_SECRET");
		const report = await test.report();
		expect(report).toContain("provider admission unobserved");
		expect(report).not.toContain("PRIVATE_DIAGNOSTIC_ERROR");
		expect(test.harness.faux.state.callCount).toBe(1);
	});

	it("does not claim final delivery when a later payload hook removes admitted evidence", async () => {
		const test = await setup({
			extensionFactories: [(volt) => volt.on("before_provider_request", () => ({ messages: [] }))],
		});
		let payload: unknown;
		test.harness.setResponses([
			async (context, options, _state, model) => {
				payload = await options?.onPayload?.({ messages: context.messages }, model);
				return fauxAssistantMessage("done");
			},
		]);
		await test.harness.session.prompt("Explain example.ts");
		expect(payload).toEqual({ messages: [] });
		const report = await test.report();
		expect(report).toContain("source-1 admitted");
		expect(report).toContain("trusted payload hooks may remove evidence");
		expect(report).toContain("Useful to the task: unmeasured");
	});

	it("does not enable preparation or make requests when inspected while disabled", async () => {
		const test = await setup({}, false);
		expect(await test.report()).toContain("No Jev evaluation report");
		expect(test.fetch).not.toHaveBeenCalled();
		expect(test.harness.faux.state.callCount).toBe(0);
		expect(test.api.getWorkStatus()).toEqual({ tasks: [], contributions: [] });
	});
});

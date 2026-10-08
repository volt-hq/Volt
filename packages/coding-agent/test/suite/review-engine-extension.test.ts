/**
 * A review engine an extension registers: it is kept under `ext:<manifest id>/<name>`, `/review` runs it with
 * its parameters checked against what it declared, and the run's record names it.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient } from "../../src/client/protocol-client.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { ReviewEngineContext } from "../../src/core/review-engine.ts";
import { getReviewRun } from "../../src/core/review-state.ts";
import { createHostHarness, type HostHarness } from "./host-harness.ts";

const ENGINE = "ext:test-extension/swarm";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function initializeRepository(cwd: string): void {
	const git = (...args: string[]): void => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	};
	mkdirSync(join(cwd, "src"), { recursive: true });
	git("init", "--initial-branch=main");
	git("config", "user.email", "review@example.com");
	git("config", "user.name", "Review Test");
	// The harness keeps its session database in the working directory.
	writeFileSync(join(cwd, ".gitignore"), "sessions/\n");
	writeFileSync(join(cwd, "src", "value.ts"), "export const value = 1;\nexport const other = 2;\n");
	git("add", ".");
	git("commit", "-m", "initial");
	writeFileSync(join(cwd, "src", "value.ts"), "export const value = 1;\nexport const other = 3;\n");
}

interface Fixture {
	harness: HostHarness;
	source: HostedConversation;
	client: LoopbackClient;
	/** The context of each run of the engine, in start order. */
	runs: ReviewEngineContext[];
	/** What registering engines threw inside the extension. */
	registrationErrors: string[];
}

async function setup(): Promise<Fixture> {
	const runs: ReviewEngineContext[] = [];
	const registrationErrors: string[] = [];
	const harness = await createHostHarness({
		whenUnattached: "keep",
		extension: (volt) => {
			volt.registerReviewEngine("swarm", {
				label: "Swarm",
				description: "Many reviewers.",
				cost: "Much slower than standard.",
				targets: ["uncommitted"],
				remoteSafe: false,
				parameters: {
					type: "object",
					properties: {
						workers: { type: "integer", minimum: 1, maximum: 32, default: 30 },
						thinking: { type: "string", enum: ["low", "high"], default: "high" },
						exec: { type: "boolean", default: false },
					},
				},
				localOnly: ["exec"],
				async run(ctx) {
					runs.push(ctx);
					ctx.progress({ text: "Wave 1" });
					const hunks = ctx.changedFiles().flatMap((file) => file.hunks.map((hunk) => hunk.id));
					ctx.pass().diff(hunks, 64 * 1024);
					await ctx.submit({
						candidates: { summary: "Nothing found.", candidates: [], limitations: [] },
						verification: {
							summary: "Nothing to verify.",
							assessment: "complete",
							decisions: [],
							priorFindingDecisions: [],
							limitations: [],
						},
					});
				},
			});
			for (const [name, engine] of [
				["Swarm", { label: "x", description: "x", targets: ["commit"], run: async () => {} }],
				["swarm", { label: "x", description: "x", targets: ["commit"], run: async () => {} }],
				["bad", { label: "x", description: "x", targets: ["nowhere"], run: async () => {} }],
				[
					"shadow",
					{
						label: "x",
						description: "x",
						targets: ["commit"],
						parameters: { type: "object", properties: { focus: { type: "string" } } },
						run: async () => {},
					},
				],
			] as const) {
				try {
					volt.registerReviewEngine(name, engine as never);
				} catch (error) {
					registrationErrors.push(error instanceof Error ? error.message : String(error));
				}
			}
		},
	});
	cleanups.push(() => harness.cleanup());
	const source = await harness.openStartup();
	initializeRepository(source.cwd);
	const client = await createLoopbackClient(harness.host, source, { anchor: false });
	cleanups.push(() => client.stop());
	return { harness, source, client, runs, registrationErrors };
}

describe("a review engine an extension registers", () => {
	test("is kept under the extension's id, and what its author gets wrong is thrown at the call", async () => {
		const { source, registrationErrors } = await setup();
		expect(source.session.reviewEngines.list().map((engine) => engine.id)).toEqual([ENGINE]);
		expect(source.session.reviewEngines.get(ENGINE)).toMatchObject({
			label: "Swarm",
			cost: "Much slower than standard.",
			targets: ["uncommitted"],
			localOnly: ["exec"],
		});
		expect(registrationErrors).toEqual([
			expect.stringContaining('Invalid review engine name "Swarm"'),
			"Review engine swarm is already registered",
			expect.stringContaining("targets must list review targets"),
			expect.stringContaining("named like a review option: focus"),
		]);
	});

	test("runs from the review intent with its parameters checked, defaults filled in, and its run recorded", async () => {
		const { source, client, runs } = await setup();
		const started = await client.intent("review", {
			target: "uncommitted",
			engine: ENGINE,
			engineParams: { workers: 4, exec: true },
		});
		const workId = (started as { result: { workId: string } }).result.workId;
		await vi.waitFor(() => expect(getReviewRun(source.session.sessionManager, workId)?.status).toBeDefined());

		expect(runs).toHaveLength(1);
		expect(runs[0]!.workId).toBe(workId);
		expect(runs[0]!.params).toEqual({ workers: 4, thinking: "high", exec: true });
		expect(Object.isFrozen(runs[0]!.params)).toBe(true);
		const list = await client.query("review.runs", {});
		expect(list.runs[0]).toMatchObject({ runId: workId, engine: ENGINE, completionStatus: "complete" });

		// Without options the engine runs on its defaults.
		const plain = await client.intent("review", { target: "uncommitted", engine: ENGINE });
		const plainId = (plain as { result: { workId: string } }).result.workId;
		await vi.waitFor(() => expect(getReviewRun(source.session.sessionManager, plainId)?.status).toBe("completed"));
		expect(runs[1]!.params).toEqual({ workers: 30, thinking: "high", exec: false });
	});

	test.each([
		[
			"a parameter the engine does not declare",
			{ engineParams: { colour: "red" } },
			"colour is not a parameter of the Swarm engine",
		],
		["a value out of bounds", { engineParams: { workers: 99 } }, "workers must be at most 32"],
		["a value of the wrong type", { engineParams: { workers: "many" } }, "workers must be an integer"],
		[
			"options for the built-in pipeline",
			{ engine: "standard", engineParams: { workers: 4 } },
			"Engine options need an engine other than standard",
		],
		[
			"options with no engine",
			{ engine: undefined, engineParams: { workers: 4 } },
			"Engine options need an engine other than standard",
		],
	])("refuses %s before anything starts", async (_name, input, message) => {
		const { client, runs, source } = await setup();
		await expect(
			client.intent("review", { target: "uncommitted", engine: ENGINE, ...input } as never),
		).rejects.toMatchObject({
			reason: { code: "invalid_input", message },
		});
		expect(runs).toEqual([]);
		expect(source.session.work.list().filter((item) => item.kind === "review")).toEqual([]);
	});

	test("ends with the extension: disabling cancels its running review and removes its engine, and enabling registers it anew", async () => {
		const entered = Promise.withResolvers<void>();
		let instances = 0;
		const harness = await createHostHarness({
			whenUnattached: "keep",
			extensions: [
				{
					manifest: { id: "engine-ext", displayName: "Engine ext" },
					factory: (volt) => {
						instances++;
						volt.registerReviewEngine("slow", {
							label: "Slow",
							description: "Runs until cancelled.",
							targets: ["uncommitted"],
							async run(ctx) {
								entered.resolve();
								await new Promise<void>((resolve) =>
									ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
								);
							},
						});
					},
				},
			],
		});
		cleanups.push(() => harness.cleanup());
		const source = await harness.openStartup();
		initializeRepository(source.cwd);
		const client = await createLoopbackClient(harness.host, source, { anchor: false });
		cleanups.push(() => client.stop());
		const id = "ext:engine-ext/slow";
		expect(source.session.reviewEngines.get(id)).toBeDefined();

		const started = await client.intent("review", { target: "uncommitted", engine: id });
		const workId = (started as { result: { workId: string } }).result.workId;
		await entered.promise;
		expect(source.session.work.get(workId)).toMatchObject({ state: "running" });

		await client.intent("set_extension_enabled", { id: "engine-ext", enabled: false, scope: "global" });
		await source.session.extensionRegistry.settled();
		expect(source.session.reviewEngines.get(id)).toBeUndefined();
		expect(source.session.extensionRunner.getReviewEngines()).toEqual([]);
		expect(source.session.work.get(workId)).toMatchObject({ outcome: "cancelled" });
		expect(getReviewRun(source.session.sessionManager, workId)).toMatchObject({ status: "cancelled", engine: id });
		await expect(client.intent("review", { target: "uncommitted", engine: id })).rejects.toMatchObject({
			reason: { code: "invalid_input", message: `Unknown review engine: ${id}` },
		});

		await client.intent("set_extension_enabled", { id: "engine-ext", enabled: true, scope: "global" });
		expect(instances).toBe(2);
		expect(source.session.reviewEngines.get(id)).toBeDefined();
	});
});

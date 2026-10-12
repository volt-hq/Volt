/**
 * Extension reviews (`ctx.reviews`): an extension with the `exec` permission starts a review as the
 * conversation's `review` work, on the standard engine or a registered one, and learns how it ended from the
 * run's record. It cancels only its own reviews, and disabling it cancels those still running.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createLoopbackClient, type LoopbackClient } from "../../src/client/protocol-client.ts";
import type { ExtensionContext, ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { ReviewEngineContext } from "../../src/core/review-engine.ts";
import { createHostHarness } from "./host-harness.ts";

const PROBE = "ext:reviewer/probe";
const SLOW = "ext:reviewer/slow";
const DECIDER = "ext:reviewer/decider";

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

const CANDIDATE = {
	candidateId: "c1",
	title: "Other changed",
	body: "The constant changed from 2 to 3.",
	trigger: "Read other.",
	impact: "Callers see 3.",
	category: "correctness",
	rootCauseKey: "other-changed",
	priority: 1 as const,
	confidence: 0.9,
	changeLocation: { path: "src/value.ts", side: "head" as const, startLine: 2, endLine: 2 },
	evidenceLocations: [],
};

/**
 * How the decider engine settles the previous findings it is given: all `fixed` (reporting nothing), or the first
 * still `open` and reported again by its candidate.
 */
type Decide = "open" | "fixed";

/** An engine that follows an earlier run: it decides each previous finding as `decide` says. */
function decider(decide: () => Decide, seen: ReviewEngineContext["previousFindings"][]) {
	return async (ctx: ReviewEngineContext): Promise<void> => {
		seen.push(ctx.previousFindings);
		const hunks = ctx.changedFiles().flatMap((file) => file.hunks.map((hunk) => hunk.id));
		ctx.pass().diff(hunks, 64 * 1024);
		const open = decide() === "open";
		await ctx.submit({
			candidates: { summary: "Decided.", limitations: [], candidates: open ? [CANDIDATE] : [] },
			verification: {
				summary: "Decided.",
				assessment: "complete",
				decisions: open
					? [{ candidateId: "c1", outcome: "accept", method: "Read it.", rationale: "It is 3.", confidence: 0.9 }]
					: [],
				priorFindingDecisions: ctx.previousFindings.map((finding) => ({
					findingId: finding.id,
					outcome: open ? ("open" as const) : ("fixed" as const),
					...(open ? { candidateId: "c1" } : {}),
					method: "Read the head.",
					rationale: open ? "Still 3." : "Back to 2.",
					confidence: 0.9,
				})),
				limitations: [],
			},
		});
	};
}

/** An engine that reviews every hunk and reports one finding on the changed line. */
async function probe(ctx: ReviewEngineContext): Promise<void> {
	const hunks = ctx.changedFiles().flatMap((file) => file.hunks.map((hunk) => hunk.id));
	ctx.pass().diff(hunks, 64 * 1024);
	await ctx.submit({
		candidates: {
			summary: "One defect.",
			limitations: [],
			candidates: [
				{
					candidateId: "c1",
					title: "Other changed",
					body: "The constant changed from 2 to 3.",
					trigger: "Read other.",
					impact: "Callers see 3.",
					category: "correctness",
					rootCauseKey: "other-changed",
					priority: 1,
					confidence: 0.9,
					changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
					evidenceLocations: [],
				},
			],
		},
		verification: {
			summary: "Confirmed.",
			assessment: "complete",
			decisions: [
				{ candidateId: "c1", outcome: "accept", method: "Read it.", rationale: "It is 3.", confidence: 0.9 },
			],
			priorFindingDecisions: [],
			limitations: [],
		},
		commandsRun: ["npm test"],
	});
}

interface Fixture {
	conversation: HostedConversation;
	client: LoopbackClient;
	/** The `reviewer` extension's context, which has `exec`. */
	reviewer: ExtensionContext;
	/** The `bystander` extension's context, which does not. */
	bystander: ExtensionContext;
	/** Resolves once the slow engine's run started; its run ends when cancelled. */
	slowStarted: Promise<void>;
	/** How the decider engine settles previous findings next. */
	decide: { next: Decide };
	/** The previous findings each run of the decider engine was given. */
	decided: ReviewEngineContext["previousFindings"][];
}

async function setup(): Promise<Fixture> {
	const contexts = new Map<string, ExtensionContext>();
	const slowStarted = Promise.withResolvers<void>();
	const decide: { next: Decide } = { next: "open" };
	const decided: ReviewEngineContext["previousFindings"][] = [];
	const recordContext =
		(id: string): ExtensionFactory =>
		(volt) => {
			volt.on("session_start", (_event, ctx) => {
				contexts.set(id, ctx);
			});
		};
	const harness = await createHostHarness({
		whenUnattached: "keep",
		extensions: [
			{
				manifest: { id: "reviewer", displayName: "Reviewer", permissions: ["exec"] },
				factory: (volt) => {
					recordContext("reviewer")(volt);
					volt.registerWorkKind("loop", {});
					volt.registerReviewEngine("probe", {
						label: "Probe",
						description: "Reports one finding.",
						cost: "Cheap.",
						targets: ["uncommitted"],
						parameters: {
							type: "object",
							properties: { depth: { type: "integer", minimum: 1, maximum: 3, default: 1 } },
						},
						run: probe,
					});
					volt.registerReviewEngine("decider", {
						label: "Decider",
						description: "Decides the findings of the run it follows.",
						targets: ["uncommitted", "commit"],
						run: decider(() => decide.next, decided),
					});
					volt.registerReviewEngine("slow", {
						label: "Slow",
						description: "Runs until cancelled.",
						targets: ["uncommitted"],
						async run(ctx) {
							slowStarted.resolve();
							await new Promise<void>((resolve) =>
								ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
							);
						},
					});
				},
			},
			{ manifest: { id: "bystander", displayName: "Bystander" }, factory: recordContext("bystander") },
		],
	});
	cleanups.push(() => harness.cleanup());
	const conversation = await harness.openStartup();
	initializeRepository(conversation.cwd);
	// The extensions start once a client attaches.
	const client = await createLoopbackClient(harness.host, conversation, { anchor: false });
	cleanups.push(() => client.stop());
	const reviewer = contexts.get("reviewer");
	const bystander = contexts.get("bystander");
	if (!reviewer || !bystander) throw new Error("The extensions did not start");
	return { conversation, client, reviewer, bystander, slowStarted: slowStarted.promise, decide, decided };
}

describe("ctx.reviews", () => {
	test("lists the standard review first, then the engines the conversation's extensions registered", async () => {
		const { reviewer } = await setup();
		expect(reviewer.reviews.engines()).toEqual([
			expect.objectContaining({ id: "standard", label: "Standard", targets: expect.arrayContaining(["pr"]) }),
			{ id: PROBE, label: "Probe", description: "Reports one finding.", cost: "Cheap.", targets: ["uncommitted"] },
			{
				id: DECIDER,
				label: "Decider",
				description: "Decides the findings of the run it follows.",
				targets: ["uncommitted", "commit"],
			},
			{ id: SLOW, label: "Slow", description: "Runs until cancelled.", targets: ["uncommitted"] },
		]);
	});

	test("starts a review on an engine as review work, and resolves with its run once it ends", async () => {
		const { conversation, reviewer } = await setup();
		const review = await reviewer.reviews.start({
			target: { kind: "uncommitted" },
			engine: PROBE,
			params: { depth: 2 },
			focus: "constants",
		});
		expect(conversation.session.work.get(review.id)).toMatchObject({ kind: "review" });

		const end = await review.ended;
		expect(end.status).toBe("completed");
		expect(end.run).toMatchObject({
			runId: review.id,
			engine: PROBE,
			status: "completed",
			completionStatus: "complete",
			options: { focus: "constants", scopeMode: "full" },
			findings: [
				{
					title: "Other changed",
					priority: 1,
					status: "open",
					changeLocation: { path: "src/value.ts", side: "head", startLine: 2, endLine: 2 },
				},
			],
			coverage: { commandsRun: ["npm test"] },
		});
		expect(await reviewer.reviews.result(review.id)).toEqual(end.run);
		expect(await reviewer.reviews.result("no-such-run")).toBeUndefined();
	});

	test("starts the standard review, always full, and records how it ended", async () => {
		const { conversation, reviewer } = await setup();
		const review = await reviewer.reviews.start({ target: { kind: "uncommitted" }, effort: "low" });
		expect(conversation.session.work.get(review.id)).toMatchObject({ kind: "review" });
		// The faux model answers with text, never a report, so the review fails; it still ends with its record.
		const end = await review.ended;
		expect(end.status).toBe("failed");
		expect(end.run).toMatchObject({
			runId: review.id,
			engine: "standard",
			status: "failed",
			options: { effort: "low", scopeMode: "full" },
		});
	});

	test("needs the exec permission", async () => {
		const { bystander, conversation } = await setup();
		await expect(bystander.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE })).rejects.toThrow(/exec/);
		expect(conversation.session.work.list().filter((item) => item.kind === "review")).toEqual([]);
	});

	test.each([
		["an unknown target", { target: { kind: "nowhere" } }, /target.kind must be one of/],
		["a pull request without a number", { target: { kind: "pr" } }, /target.number must be a pull request number/],
		["a commit without a ref", { target: { kind: "commit" } }, /target.ref must name the commit/],
		["an unknown engine", { target: { kind: "uncommitted" }, engine: "ext:nobody/none" }, /Unknown review engine/],
		[
			"parameters for the standard review",
			{ target: { kind: "uncommitted" }, params: { depth: 2 } },
			/params need an engine/,
		],
		[
			"an engine parameter out of bounds",
			{ target: { kind: "uncommitted" }, engine: PROBE, params: { depth: 9 } },
			/depth must be at most 3/,
		],
		[
			"tools for an engine's review",
			{ target: { kind: "uncommitted" }, engine: PROBE, tools: ["bash"] },
			/tools apply to the standard review only/,
		],
		[
			"an earlier run it does not have",
			{ target: { kind: "uncommitted" }, previousRunId: "review:nowhere" },
			/Unknown review run/,
		],
		["a workspace file tool", { target: { kind: "uncommitted" }, tools: ["read"] }, /not available to reviews: read/],
		["a tool the conversation does not have", { target: { kind: "uncommitted" }, tools: ["teleport"] }, /teleport/],
		["an effort it does not know", { target: { kind: "uncommitted" }, effort: "max" }, /effort must be one of/],
		["parent work it does not own", { target: { kind: "uncommitted" }, parentWorkId: "work-1" }, /parentWorkId/],
	])("refuses %s before anything starts", async (_name, options, message) => {
		const { reviewer, conversation } = await setup();
		await expect(reviewer.reviews.start(options as never)).rejects.toThrow(message);
		expect(conversation.session.work.list().filter((item) => item.kind === "review")).toEqual([]);
	});

	test("shows a review it starts from its own work under that work", async () => {
		const { conversation, reviewer } = await setup();
		const started = Promise.withResolvers<string>();
		const { workId } = await reviewer.startWork("loop", { title: "Loop" }, async (work) => {
			const review = await reviewer.reviews.start({
				target: { kind: "uncommitted" },
				engine: PROBE,
				parentWorkId: work.workId,
			});
			started.resolve(review.id);
			await review.ended;
			return { outcome: "completed" };
		});
		const reviewId = await started.promise;
		expect(conversation.session.work.get(reviewId)).toMatchObject({ kind: "review", parentWorkId: workId });
	});

	test("follows the previous round: a finding still open keeps its id, and one found fixed closes where it was found", async () => {
		const { reviewer, decide, decided } = await setup();
		const first = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE });
		const found = (await first.ended).run?.findings?.[0];
		if (!found) throw new Error("Expected a finding");

		// The next round keeps it open: the finding that reports it now has its id.
		decide.next = "open";
		const second = await reviewer.reviews.start({
			target: { kind: "uncommitted" },
			engine: DECIDER,
			previousRunId: first.id,
		});
		const kept = (await second.ended).run;
		expect(decided.at(-1)?.map((finding) => finding.id)).toEqual([found.id]);
		expect(kept).toMatchObject({
			parentRunId: first.id,
			options: { scopeMode: "full" },
			findings: [{ id: found.id, status: "open", title: "Other changed" }],
		});

		// The round after finds it fixed: it closes in both earlier rounds.
		decide.next = "fixed";
		const third = await reviewer.reviews.start({
			target: { kind: "uncommitted" },
			engine: DECIDER,
			previousRunId: second.id,
		});
		expect((await third.ended).run).toMatchObject({ completionStatus: "complete", findings: [] });
		for (const round of [first.id, second.id]) {
			expect((await reviewer.reviews.result(round))?.findings).toEqual([
				expect.objectContaining({ id: found.id, status: "fixed" }),
			]);
		}

		// A review follows only a review of its own target.
		await expect(
			reviewer.reviews.start({ target: { kind: "commit", ref: "HEAD" }, engine: DECIDER, previousRunId: first.id }),
		).rejects.toThrow(/reviewed another target/);
	});

	test("records what became of the findings of its own reviews", async () => {
		const { reviewer, bystander } = await setup();
		const review = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE });
		const finding = (await review.ended).run?.findings?.[0];
		if (!finding) throw new Error("Expected a finding");

		await expect(reviewer.reviews.recordOutcome(review.id, finding.id, { status: "dismissed" })).rejects.toThrow(
			/require an explicit reason/,
		);
		await expect(bystander.reviews.recordOutcome(review.id, finding.id, { status: "fixed" })).rejects.toThrow(/exec/);
		await expect(reviewer.reviews.recordOutcome(review.id, "no-such-finding", { status: "fixed" })).rejects.toThrow(
			/Unknown finding/,
		);

		await reviewer.reviews.recordOutcome(review.id, finding.id, { status: "fixed", note: "Fixed in abc123." });
		expect((await reviewer.reviews.result(review.id))?.findings?.[0]).toMatchObject({
			id: finding.id,
			status: "fixed",
		});
	});

	test("posts only its own complete pull request reviews", async () => {
		const { reviewer } = await setup();
		await expect(reviewer.reviews.publish("review:other")).rejects.toThrow(/posts only the reviews it started/);
		const review = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE });
		await review.ended;
		await expect(reviewer.reviews.publish(review.id, { trailer: "" })).rejects.toThrow(/trailer must be text/);
		await expect(reviewer.reviews.publish(review.id, { command: [] })).rejects.toThrow(/command must be a list/);
		// What is posted is a pull request's review.
		await expect(reviewer.reviews.publish(review.id)).rejects.toThrow(/Only pull request reviews can be published/);
	});

	test("cancels only its own reviews, and disabling it cancels those still running", async () => {
		const { conversation, client, reviewer, bystander, slowStarted } = await setup();
		const first = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: SLOW });
		await slowStarted;
		await expect(bystander.reviews.cancel(first.id)).rejects.toThrow(/cancels only the reviews it started/);
		await reviewer.reviews.cancel(first.id);
		expect(await first.ended).toMatchObject({ status: "cancelled", run: { engine: SLOW, status: "cancelled" } });
		// Cancelling one that ended does nothing.
		await reviewer.reviews.cancel(first.id);

		const second = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE });
		await second.ended;
		const third = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: SLOW });
		await client.intent("set_extension_enabled", { id: "reviewer", enabled: false, scope: "global" });
		await conversation.session.extensionRegistry.settled();
		expect((await third.ended).status).toBe("cancelled");
		expect(conversation.session.work.get(second.id)).toMatchObject({ outcome: "completed" });
	});
});

/**
 * Extension reviews (`ctx.reviews`): an extension with the `exec` permission starts a review as the
 * conversation's `review` work, on the standard engine or a registered one, and learns how it ended from the
 * run's record. It cancels only its own reviews, disabling it cancels those still running, and reloading the
 * extensions cancels those still starting. Every engine gets the tools and checkout setup the review grants, and
 * the host decides the earlier findings an engine leaves undecided, so review rounds converge on any engine.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxProvider, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient } from "../../src/client/protocol-client.ts";
import type { ExtensionContext, ExtensionFactory } from "../../src/core/extensions/index.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { ReviewEngineContext } from "../../src/core/review-engine.ts";
import { createHostHarness } from "./host-harness.ts";

const PROBE = "ext:reviewer/probe";
const SLOW = "ext:reviewer/slow";
const DECIDER = "ext:reviewer/decider";
const RUNNER = "ext:reviewer/runner";

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
 * How the decider engine settles the previous findings it is given: all `fixed` (reporting nothing), the first
 * still `open` and reported again by its candidate, or none of them (`skip`, reporting nothing), as an engine that
 * cannot decide earlier findings does.
 */
type Decide = "open" | "fixed" | "skip";

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
				priorFindingDecisions: (decide() === "skip" ? [] : ctx.previousFindings).map((finding) => ({
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

/**
 * An engine that reviews every hunk and reports one finding on the changed line, and, when the review collects
 * them, a follow-up in a file the change does not touch and one in no file at all.
 */
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
			followUps: [
				{
					followUpId: "f1",
					title: "Sessions ignored by hand",
					body: ".gitignore lists sessions/ by hand.",
					category: "maintainability",
					rootCauseKey: "manual-ignore",
					priority: 3,
					location: { path: ".gitignore", side: "head", startLine: 1, endLine: 1 },
				},
				{
					followUpId: "f2",
					title: "Nowhere",
					body: "A file that does not exist.",
					category: "correctness",
					rootCauseKey: "nowhere",
					priority: 2,
					location: { path: "src/missing.ts", side: "head", startLine: 1, endLine: 1 },
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
			followUpDecisions: [
				{ followUpId: "f1", outcome: "accept", method: "Read it.", rationale: "It is there.", confidence: 0.7 },
				{ followUpId: "f2", outcome: "accept", method: "Guessed.", rationale: "Maybe.", confidence: 0.5 },
			],
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
	/** The extensions' latest contexts, by id: a reload replaces them. */
	contexts: ReadonlyMap<string, ExtensionContext>;
	/** Resolves once the slow engine's run started; its run ends when cancelled. */
	slowStarted: Promise<void>;
	/** How the decider engine settles previous findings next. */
	decide: { next: Decide };
	/** The previous findings each run of the decider engine was given. */
	decided: ReviewEngineContext["previousFindings"][];
	/** What each run of the runner engine was granted, and what the setup left in the checkout it asked for. */
	ran: Array<{ tools: readonly string[]; marker: string | undefined }>;
	/** The conversation's model, which the host's own verification passes run on. */
	faux: FauxProvider;
}

async function setup(): Promise<Fixture> {
	const contexts = new Map<string, ExtensionContext>();
	const slowStarted = Promise.withResolvers<void>();
	const decide: { next: Decide } = { next: "open" };
	const decided: ReviewEngineContext["previousFindings"][] = [];
	const ran: Fixture["ran"] = [];
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
					volt.registerReviewEngine("runner", {
						label: "Runner",
						description: "Runs commands in a checkout, then reports as the probe does.",
						targets: ["uncommitted"],
						async run(ctx) {
							const checkout = await ctx.checkout();
							const marker = join(checkout, "setup-marker");
							ran.push({
								tools: ctx.tools,
								marker: existsSync(marker) ? readFileSync(marker, "utf8") : undefined,
							});
							await probe(ctx);
						},
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
	return {
		conversation,
		client,
		reviewer,
		bystander,
		contexts,
		slowStarted: slowStarted.promise,
		decide,
		decided,
		ran,
		faux: harness.faux,
	};
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
			{
				id: RUNNER,
				label: "Runner",
				description: "Runs commands in a checkout, then reports as the probe does.",
				targets: ["uncommitted"],
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
		// A review that does not collect follow-ups has none, whatever the engine reported.
		expect(end.run).not.toHaveProperty("followUps");
	});

	test("collects follow-ups when asked: the valid ones the engine accepted, apart from the findings", async () => {
		const { reviewer } = await setup();
		const review = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE, followUps: true });
		const run = (await review.ended).run;
		expect(run?.findings).toHaveLength(1);
		expect(run?.followUps).toEqual([
			{
				id: expect.any(String),
				fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
				title: "Sessions ignored by hand",
				body: ".gitignore lists sessions/ by hand.",
				category: "maintainability",
				priority: 3,
				location: { path: ".gitignore", side: "head", startLine: 1, endLine: 1 },
				verification: { method: "Read it.", rationale: "It is there.", confidence: 0.7 },
			},
		]);
		expect(await reviewer.reviews.result(review.id)).toEqual(run);
		await expect(
			reviewer.reviews.start({ target: { kind: "uncommitted" }, followUps: "yes" as never }),
		).rejects.toThrow(/followUps must be true or false/);
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
			"an earlier run it does not have",
			{ target: { kind: "uncommitted" }, previousRunId: "review:nowhere" },
			/Unknown review run/,
		],
		["a workspace file tool", { target: { kind: "uncommitted" }, tools: ["read"] }, /not available to reviews: read/],
		[
			"a setup with no tools to run in its checkout",
			{ target: { kind: "uncommitted" }, setup: { command: "npm ci" } },
			/setup applies to a review whose passes run tools/,
		],
		[
			"a setup without a command",
			{ target: { kind: "uncommitted" }, tools: ["bash"], setup: { command: " " } },
			/setup.command must be a shell command/,
		],
		[
			"a setup that may run for days",
			{ target: { kind: "uncommitted" }, tools: ["bash"], setup: { command: "npm ci", timeoutMs: 86_400_000 } },
			/setup.timeoutMs must be a positive number/,
		],
		["a tool the conversation does not have", { target: { kind: "uncommitted" }, tools: ["teleport"] }, /teleport/],
		["an effort it does not know", { target: { kind: "uncommitted" }, effort: "max" }, /effort must be one of/],
		["parent work it does not own", { target: { kind: "uncommitted" }, parentWorkId: "work-1" }, /parentWorkId/],
	])("refuses %s before anything starts", async (_name, options, message) => {
		const { reviewer, conversation } = await setup();
		await expect(reviewer.reviews.start(options as never)).rejects.toThrow(message);
		expect(conversation.session.work.list().filter((item) => item.kind === "review")).toEqual([]);
	});

	test("sets up the checkout its standard review runs commands in, and a failed setup fails the review with why", async () => {
		const { reviewer } = await setup();
		const review = await reviewer.reviews.start({
			target: { kind: "uncommitted" },
			tools: ["bash"],
			setup: { command: "echo cannot-install >&2; exit 7" },
		});
		expect(await review.ended).toMatchObject({
			status: "failed",
			error: "The review checkout's setup failed (exit 7): cannot-install",
			run: {
				engine: "standard",
				status: "failed",
				errorMessage: "The review checkout's setup failed (exit 7): cannot-install",
			},
		});
	});

	test("grants an engine's review its tools, and sets up each checkout the engine asks for", async () => {
		const { reviewer, ran } = await setup();
		const granted = await reviewer.reviews.start({
			target: { kind: "uncommitted" },
			engine: RUNNER,
			tools: ["bash"],
			setup: { command: "printf ready > setup-marker" },
		});
		expect(await granted.ended).toMatchObject({ status: "completed" });
		const plain = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: RUNNER });
		expect(await plain.ended).toMatchObject({ status: "completed" });
		expect(ran).toEqual([
			{ tools: ["bash"], marker: "ready" },
			{ tools: [], marker: undefined },
		]);

		// A setup that fails rejects the checkout, and the engine's review with it.
		const failing = await reviewer.reviews.start({
			target: { kind: "uncommitted" },
			engine: RUNNER,
			tools: ["bash"],
			setup: { command: "echo no-registry >&2; exit 3" },
		});
		expect(await failing.ended).toMatchObject({
			status: "failed",
			error: "The review checkout's setup failed (exit 3): no-registry",
		});
	});

	test("decides the earlier findings an engine leaves undecided, so the next round converges", async () => {
		const { reviewer, decide, faux } = await setup();
		const first = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE });
		const found = (await first.ended).run?.findings?.[0];
		if (!found) throw new Error("Expected a finding");

		// The engine decides nothing; the host's verifier finds the earlier finding fixed.
		decide.next = "skip";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("report_review_verification", {
					summary: "The earlier finding is gone.",
					assessment: "complete",
					decisions: [],
					priorFindingDecisions: [
						{
							findingId: found.id,
							outcome: "fixed",
							method: "Read the head.",
							rationale: "Back to 2.",
							confidence: 0.9,
						},
					],
					limitations: [],
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const second = await reviewer.reviews.start({
			target: { kind: "uncommitted" },
			engine: DECIDER,
			previousRunId: first.id,
		});
		expect((await second.ended).run).toMatchObject({
			completionStatus: "complete",
			overallCorrectness: "correct",
			findings: [],
		});
		expect((await reviewer.reviews.result(first.id))?.findings).toEqual([
			expect.objectContaining({ id: found.id, status: "fixed" }),
		]);
	});

	test("leaves a round incomplete, not wrong, when it cannot decide what the engine left undecided", async () => {
		const { reviewer, decide, faux } = await setup();
		const first = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE });
		const found = (await first.ended).run?.findings?.[0];
		if (!found) throw new Error("Expected a finding");

		// The host's verifier never reports: the earlier finding is uncertain, and stays open where it was found.
		decide.next = "skip";
		faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("No report.")));
		const second = await reviewer.reviews.start({
			target: { kind: "uncommitted" },
			engine: DECIDER,
			previousRunId: first.id,
		});
		expect((await second.ended).run).toMatchObject({
			status: "incomplete",
			completionStatus: "incomplete",
			findings: [expect.objectContaining({ id: found.id, status: "uncertain" })],
		});
		expect((await reviewer.reviews.result(first.id))?.findings).toEqual([
			expect.objectContaining({ id: found.id, status: "open" }),
		]);
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

	test("does not report again a finding dismissed rounds ago", async () => {
		const { reviewer, decide } = await setup();
		const first = await reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE });
		const found = (await first.ended).run?.findings?.[0];
		if (!found) throw new Error("Expected a finding");
		await reviewer.reviews.recordOutcome(first.id, found.id, { status: "dismissed", reason: "intentional" });

		// Every later round reports the defect again; each leaves it out, the rounds after the next one too.
		decide.next = "open";
		let previousRunId = first.id;
		for (let round = 2; round <= 3; round++) {
			const review = await reviewer.reviews.start({
				target: { kind: "uncommitted" },
				engine: DECIDER,
				previousRunId,
			});
			expect((await review.ended).run).toMatchObject({
				parentRunId: previousRunId,
				completionStatus: "complete",
				findings: [],
			});
			previousRunId = review.id;
		}
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

	test("reloading the extensions cancels a review still starting, which no active work held back", async () => {
		const { conversation, reviewer, contexts } = await setup();
		const work = conversation.session.work;
		const start = work.start.bind(work);
		const reloaded = Promise.withResolvers<void>();
		// The review's start is still under way, as one resolving a pull request is, until the reload removed its
		// engine, or until the reload ended, had it not waited for the start.
		vi.spyOn(work, "start").mockImplementation(async (kind, input, execute, options) => {
			if (kind === "review") {
				await Promise.race([
					vi.waitFor(() => expect(conversation.session.reviewEngines.get(SLOW)).toBeUndefined(), {
						timeout: 5_000,
						interval: 1,
					}),
					reloaded.promise,
				]);
			}
			return await start(kind, input, execute, options);
		});
		const starting = reviewer.reviews.start({ target: { kind: "uncommitted" }, engine: SLOW });
		const refused = expect(starting).rejects.toThrow(/was disabled or reloaded while the review started/);

		await conversation.session.reload();
		reloaded.resolve();
		await refused;
		expect(work.list().filter((item) => item.kind === "review")).toEqual([
			expect.objectContaining({ outcome: "cancelled" }),
		]);
		expect(work.running()).toEqual([]);

		// The reloaded extension starts reviews as before.
		const restarted = contexts.get("reviewer");
		if (!restarted || restarted === reviewer) throw new Error("The reviewer did not start again");
		const again = await restarted.reviews.start({ target: { kind: "uncommitted" }, engine: PROBE });
		expect((await again.ended).status).toBe("completed");
	});
});

/**
 * The reviews extensions start (`ctx.reviews`), on a host whose review starts wait until the test lets them:
 * disabling an extension cancels its reviews still starting as well as those running and waits for them to stop,
 * reloading the extensions does so for every extension and starts none until the reloaded ones are bound,
 * cancelling a review that ends meanwhile leaves it alone, and a finding discussion starts none.
 */

import { Conversation, InMemoryConversationLog, type StreamFn } from "@hansjm10/volt-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionReviewStartOptions } from "../src/core/extensions/types.ts";
import { LiveState } from "../src/core/host/live-state.ts";
import { REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE } from "../src/core/review-discussion-policy.ts";
import { ReviewEngineRegistry } from "../src/core/review-engine.ts";
import { reviewWorkInput, reviewWorkKind } from "../src/core/review-work.ts";
import { ExtensionReviewRuns, type ExtensionReviewRunsHost } from "../src/core/session/extension-reviews.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type WorkContext, WorkError, type WorkExecution, WorkRegistry } from "../src/core/work/registry.ts";

const OWNER = "reviewer";
const UNCOMMITTED: ExtensionReviewStartOptions = { target: { kind: "uncommitted" } };

const noTurns: StreamFn = () => {
	throw new Error("No turn runs in this test");
};

const opened: Conversation[] = [];

afterEach(async () => {
	for (const conversation of opened.splice(0)) await conversation.close().catch(() => undefined);
});

/** How a review stops once cancelled: at once, a while later, or not before it is let finish. */
type Stopping = "at_once" | "slowly" | "never";

async function setup() {
	const conversation = await Conversation.open({
		log: new InMemoryConversationLog("extension-review-runs"),
		stream: noTurns,
		resolveModel: () => undefined,
	});
	opened.push(conversation);
	const liveState = new LiveState({ head: () => conversation.state.ordinal });
	const work = new WorkRegistry({
		conversationId: () => conversation.conversationId,
		work: () => conversation.work,
		state: () => conversation.state,
		live: () => liveState,
		turnId: () => undefined,
	});
	const sessionManager = SessionManager.inMemory();
	work.register(reviewWorkKind(() => sessionManager));
	await work.reconcile();
	const fixture = {
		/** What each review start waits for before its review starts, as resolving what is reviewed does. */
		preflight: Promise.resolve(),
		stopping: "at_once" as Stopping,
		/** Lets every review finish. */
		finish: Promise.withResolvers<void>(),
	};
	const execute = async (ctx: WorkContext): Promise<WorkExecution> => {
		const stopping = fixture.stopping;
		const cancelled = new Promise<void>((resolve) =>
			ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		await Promise.race([fixture.finish.promise, ...(stopping === "never" ? [] : [cancelled])]);
		if (ctx.signal.aborted && stopping === "slowly") await new Promise((resolve) => setTimeout(resolve, 50));
		return { outcome: ctx.signal.aborted ? "cancelled" : "completed" };
	};
	const startReview = vi.fn<ExtensionReviewRunsHost["startReview"]>(async () => {
		await fixture.preflight;
		const record = await work.start("review", reviewWorkInput("review.uncommitted", "changes"), execute);
		return { workId: record.workId };
	});
	const runs = new ExtensionReviewRuns({
		sessionManager,
		sessionWriter: () => {
			throw new Error("Nothing is recorded in this test");
		},
		work: () => work,
		reviewEngines: () => new ReviewEngineRegistry(),
		toolNames: () => [],
		ownsKindWork: () => false,
		startReview,
	});
	return { fixture, work, sessionManager, runs, startReview };
}

describe("extension review runs", () => {
	it("cancels a review still starting when its extension is disabled, waits for it, and starts again once enabled", async () => {
		const { fixture, work, runs } = await setup();
		const preflight = Promise.withResolvers<void>();
		fixture.preflight = preflight.promise;
		fixture.stopping = "slowly";
		const starting = runs.start(OWNER, UNCOMMITTED);
		const refused = expect(starting).rejects.toThrow(
			`extension ${OWNER} was disabled or reloaded while the review started`,
		);

		let retired = false;
		const retiring = runs.retire(OWNER).then(() => {
			retired = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		// It waits for the start under way.
		expect(retired).toBe(false);

		preflight.resolve();
		await retiring;
		await refused;
		const [review] = work.list();
		expect(review).toMatchObject({ kind: "review", outcome: "cancelled" });
		expect(work.running()).toEqual([]);
		expect(runs.owns(OWNER, review?.workId ?? "")).toBe(false);

		// Enabled again, the extension starts reviews as before.
		const again = await runs.start(OWNER, UNCOMMITTED);
		expect(runs.owns(OWNER, again.id)).toBe(true);
		expect(work.get(again.id)?.state).toBe("running");
		fixture.finish.resolve();
		await again.ended;
		expect(work.get(again.id)?.outcome).toBe("completed");
	});

	it("stops waiting for a start that outlasts the grace, which still cancels its review once it started", async () => {
		const { fixture, work, runs } = await setup();
		const preflight = Promise.withResolvers<void>();
		fixture.preflight = preflight.promise;
		const starting = runs.start(OWNER, UNCOMMITTED);
		const refused = expect(starting).rejects.toThrow(
			`extension ${OWNER} was disabled or reloaded while the review started`,
		);

		const began = Date.now();
		await runs.retire(OWNER, 50);
		expect(Date.now() - began).toBeLessThan(2_000);
		expect(work.list()).toEqual([]);

		preflight.resolve();
		await refused;
		const [review] = work.list();
		if (!review) throw new Error("Expected the review the start began");
		await work.settled(review.workId);
		expect(work.get(review.workId)?.outcome).toBe("cancelled");
		expect(runs.owns(OWNER, review.workId)).toBe(false);
	});

	it("cancels the running reviews of a disabled extension and waits for them to stop, leaving the others running", async () => {
		const { fixture, work, runs } = await setup();
		fixture.stopping = "slowly";
		const mine = await runs.start(OWNER, UNCOMMITTED);
		const theirs = await runs.start("other", UNCOMMITTED);

		await runs.retire(OWNER);
		expect(work.get(mine.id)?.outcome).toBe("cancelled");
		expect(work.get(theirs.id)?.state).toBe("running");
		expect((await mine.ended).status).toBe("cancelled");
		// It still owns the review it started.
		expect(runs.owns(OWNER, mine.id)).toBe(true);

		fixture.finish.resolve();
		await theirs.ended;
		expect(work.get(theirs.id)?.outcome).toBe("completed");
	});

	it("cancels every extension's reviews still starting or running when the extensions reload, and waits for them", async () => {
		const { fixture, work, runs } = await setup();
		fixture.stopping = "slowly";
		const running = await runs.start(OWNER, UNCOMMITTED);
		const preflight = Promise.withResolvers<void>();
		fixture.preflight = preflight.promise;
		const mine = runs.start(OWNER, UNCOMMITTED);
		const theirs = runs.start("other", UNCOMMITTED);
		const refused = Promise.all([
			expect(mine).rejects.toThrow(`extension ${OWNER} was disabled or reloaded while the review started`),
			expect(theirs).rejects.toThrow("extension other was disabled or reloaded while the review started"),
		]);

		let cleared = false;
		const clearing = runs.clear().then(() => {
			cleared = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		// It waits for the starts under way.
		expect(cleared).toBe(false);

		preflight.resolve();
		await clearing;
		await refused;
		expect((await running.ended).status).toBe("cancelled");
		expect(work.list().map((review) => review.outcome)).toEqual(["cancelled", "cancelled", "cancelled"]);
		expect(work.running()).toEqual([]);

		// The reloaded extensions start reviews as before.
		fixture.preflight = Promise.resolve();
		runs.open();
		const again = await runs.start(OWNER, UNCOMMITTED);
		expect(work.get(again.id)?.state).toBe("running");
		fixture.finish.resolve();
		await again.ended;
		expect(work.get(again.id)?.outcome).toBe("completed");
	});

	it("starts no review from the replaced extensions until the reloaded ones are bound", async () => {
		const { fixture, work, runs, startReview } = await setup();
		fixture.stopping = "slowly";
		const running = await runs.start(OWNER, UNCOMMITTED);
		const clearing = runs.clear();
		// While the reload waits for the reviews it cancelled, and after, until the next generation is bound.
		const refusal = `ctx.reviews.start: extension ${OWNER} is reloading; no review starts`;
		await expect(runs.start(OWNER, UNCOMMITTED)).rejects.toThrow(refusal);
		await clearing;
		await expect(runs.start(OWNER, UNCOMMITTED)).rejects.toThrow(refusal);
		expect(startReview).toHaveBeenCalledOnce();
		expect(work.list().map((review) => review.workId)).toEqual([running.id]);

		runs.open();
		const again = await runs.start(OWNER, UNCOMMITTED);
		expect(work.get(again.id)?.state).toBe("running");
		fixture.finish.resolve();
		await again.ended;
	});

	it("stops waiting for a review that ignores its cancellation once the grace has passed", async () => {
		const { fixture, work, runs } = await setup();
		fixture.stopping = "never";
		const review = await runs.start(OWNER, UNCOMMITTED);
		const started = Date.now();
		await runs.retire(OWNER, 50);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(work.get(review.id)?.outcome).toBeUndefined();
		fixture.finish.resolve();
		await review.ended;
	});

	it("leaves alone a review that ends while it is being cancelled, and reports other failures to cancel", async () => {
		const { fixture, work, runs } = await setup();
		const review = await runs.start(OWNER, UNCOMMITTED);

		vi.spyOn(work, "cancel").mockRejectedValueOnce(new WorkError("closed", "The conversation closed"));
		await expect(runs.cancel(OWNER, review.id)).rejects.toThrow("The conversation closed");
		expect(work.get(review.id)?.state).toBe("running");

		const cancel = work.cancel.bind(work);
		vi.spyOn(work, "cancel").mockImplementationOnce(async (workId) => {
			// The review finishes before the registry finds it open.
			fixture.finish.resolve();
			await work.settled(workId);
			return await cancel(workId);
		});
		await expect(runs.cancel(OWNER, review.id)).resolves.toBeUndefined();
		expect(work.get(review.id)?.outcome).toBe("completed");
	});

	it("starts no review in a finding discussion, whose outcomes belong to its source review", async () => {
		const { sessionManager, work, runs, startReview } = await setup();
		vi.spyOn(sessionManager, "getReviewDiscussion").mockReturnValue({
			discussionId: "discussion-1",
			runId: "review:source",
			findingId: "finding-1",
			source: { sessionId: "source", sessionGeneration: "1" },
			contextSnapshot: null,
		});
		await expect(runs.start(OWNER, UNCOMMITTED)).rejects.toThrow(
			`ctx.reviews.start: ${REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE}`,
		);
		expect(startReview).not.toHaveBeenCalled();
		expect(work.list()).toEqual([]);
	});
});

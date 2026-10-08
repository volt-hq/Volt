/**
 * The review engines extensions register: how they are kept in a session's registry, what their reports
 * reach clients as, and that their reviews end with them.
 */

import { Conversation, InMemoryConversationLog, type StreamFn } from "@hansjm10/volt-agent-core";
import type { UiNode, WorkProgress } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { LiveState } from "../src/core/host/live-state.ts";
import type { ReviewEngineContext, ReviewEngineDeclaration } from "../src/core/review-engine.ts";
import { ReviewEngineRegistry, validateReviewEngine } from "../src/core/review-engine.ts";
import { type DeclaredReviewEngine, ExtensionReviewEngines } from "../src/core/review-engine-extensions.ts";
import { reviewWorkInput, reviewWorkKind } from "../src/core/review-work.ts";
import type { SessionManager } from "../src/core/session-manager.ts";
import { WorkRegistry } from "../src/core/work/registry.ts";

const noTurns: StreamFn = () => {
	throw new Error("No turn runs in this test");
};

const opened: Conversation[] = [];

afterEach(async () => {
	for (const conversation of opened.splice(0)) await conversation.close().catch(() => undefined);
});

async function setup() {
	const conversation = await Conversation.open({
		log: new InMemoryConversationLog("review-engine-extensions"),
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
	work.register(reviewWorkKind(() => undefined as unknown as SessionManager));
	await work.reconcile();
	const registry = new ReviewEngineRegistry();
	return { work, registry, engines: new ExtensionReviewEngines(registry, () => work) };
}

const SWARM = "swarm-review";

function declared(
	extensionId: string,
	name: string,
	run: ReviewEngineDeclaration["run"] = async () => {},
): DeclaredReviewEngine {
	return {
		extensionId,
		name,
		engine: validateReviewEngine({
			id: `ext:${extensionId}/${name}`,
			label: name,
			description: "An engine.",
			targets: ["uncommitted"],
			remoteSafe: false,
			run,
		}),
	};
}

interface Reported {
	progress: WorkProgress;
	detail?: UiNode;
}

/** The context the host hands an engine, recording what it reports. */
function fakeContext(workId: string, signal: AbortSignal = new AbortController().signal) {
	const reported: Reported[] = [];
	const outputs: string[] = [];
	const channel = (progress: WorkProgress, detail?: UiNode): void => {
		reported.push({ progress, ...(detail === undefined ? {} : { detail }) });
	};
	const ctx = {
		workId,
		params: {},
		signal,
		progress: channel,
		checkpoint: channel,
		output: (text: string) => outputs.push(text),
	} as unknown as ReviewEngineContext;
	return { ctx, reported, outputs };
}

describe("extension review engines", () => {
	it("keeps each engine under its id, and refuses one the registry already has, once", async () => {
		const { registry, engines } = await setup();
		expect(engines.bind([declared(SWARM, "swarm"), declared("other", "deep")])).toEqual([]);
		expect(registry.list().map((engine) => engine.id)).toEqual(["ext:swarm-review/swarm", "ext:other/deep"]);

		// A second engine under an id the registry holds is refused, and reported once however often it is synced.
		const taken = new ReviewEngineRegistry();
		taken.register(declared(SWARM, "swarm").engine);
		const clashing = new ExtensionReviewEngines(taken, () => undefined as never);
		const refusals = clashing.sync([declared(SWARM, "swarm")]);
		expect(refusals).toEqual([{ extensionId: SWARM, error: expect.stringContaining("already registered") }]);
		expect(clashing.sync([declared(SWARM, "swarm")])).toEqual([]);
	});

	it("passes what an engine reports on as bounded data under the extension's action policy", async () => {
		const { registry, engines } = await setup();
		const { ctx, reported, outputs } = fakeContext("review:1");
		engines.bind([
			declared(SWARM, "swarm", async (inner) => {
				inner.progress({ text: "\u001b[32mWave 1\u001b[0m", value: 1, max: 4 }, {
					type: "card",
					key: "wave",
					title: "\u001b[32mWave 1\u001b[0m",
					actions: [
						{ id: "cancel", label: "Cancel", intent: { type: "cancel_work", input: { workId: "review:1" } } },
						{
							id: "elsewhere",
							label: "Elsewhere",
							intent: { type: "cancel_work", input: { workId: "review:2" } },
						},
						{ id: "prompt", label: "Prompt", intent: { type: "prompt", input: { text: "steal" } } },
					],
				} as UiNode);
				// Progress that is not data a client can render is not passed on; its detail goes with it.
				inner.progress("not progress" as never, { type: "card", key: "x", title: "x" } as UiNode);
				// Detail that is not valid UI data is dropped; the progress stays.
				inner.checkpoint({ text: "Verifying" }, { type: "nonsense" } as unknown as UiNode);
				inner.checkpoint({ text: "Done" }, { type: "card", key: "big", title: "x".repeat(300_000) } as UiNode);
				inner.output("report\n");
				inner.output(7 as never);
			}),
		]);
		await registry.get("ext:swarm-review/swarm")!.run(ctx);

		expect(reported).toEqual([
			{
				progress: { text: "Wave 1", value: 1, max: 4 },
				detail: {
					type: "card",
					key: "wave",
					title: [{ text: "Wave 1", token: "success" }],
					actions: [
						{ id: "cancel", label: "Cancel", intent: { type: "cancel_work", input: { workId: "review:1" } } },
					],
				},
			},
			{ progress: { text: "Verifying" } },
			{ progress: { text: "Done" } },
		]);
		expect(outputs).toEqual(["report\n"]);
	});

	it("owns a review exactly while its engine runs it", async () => {
		const { registry, engines } = await setup();
		const release = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		engines.bind([
			declared(SWARM, "swarm", async () => {
				entered.resolve();
				await release.promise;
			}),
		]);
		const { ctx } = fakeContext("review:1");
		const running = registry.get("ext:swarm-review/swarm")!.run(ctx);
		await entered.promise;
		expect(engines.owns(SWARM, "review:1")).toBe(true);
		expect(engines.owns("other", "review:1")).toBe(false);
		expect(engines.owns(SWARM, "review:2")).toBe(false);
		release.resolve();
		await running;
		expect(engines.owns(SWARM, "review:1")).toBe(false);
	});

	it("ends an extension's reviews with it when it is disabled, and leaves the others running", async () => {
		const { work, registry, engines } = await setup();
		const release = Promise.withResolvers<void>();
		const start = async (extensionId: string, name: string, workId: string) => {
			const engine = registry.get(`ext:${extensionId}/${name}`)!;
			await work.start(
				"review",
				reviewWorkInput("review.uncommitted", "changes"),
				async (ctx) => {
					const { ctx: engineContext } = fakeContext(workId, ctx.signal);
					await engine.run({ ...engineContext, signal: ctx.signal });
					return ctx.signal.aborted ? { outcome: "cancelled" } : { outcome: "completed" };
				},
				{ workId },
			);
		};
		engines.bind([
			declared(SWARM, "swarm", async (ctx) => {
				await Promise.race([
					release.promise,
					new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true })),
				]);
			}),
			declared("other", "deep", async () => {
				await release.promise;
			}),
		]);
		await start(SWARM, "swarm", "review:swarm");
		await start("other", "deep", "review:other");

		await engines.retire(SWARM);
		expect(registry.get("ext:swarm-review/swarm")).toBeUndefined();
		expect(registry.get("ext:other/deep")).toBeDefined();
		expect(work.get("review:swarm")?.outcome).toBe("cancelled");
		expect(work.get("review:other")?.state).toBe("running");

		release.resolve();
		await work.settled("review:other");
		expect(work.get("review:other")?.outcome).toBe("completed");
	});

	it("clearing the engines cancels every review they run, and the next generation registers them anew", async () => {
		const { work, registry, engines } = await setup();
		engines.bind([
			declared(SWARM, "swarm", async (ctx) => {
				await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
			}),
		]);
		const engine = registry.get("ext:swarm-review/swarm")!;
		await work.start(
			"review",
			reviewWorkInput("review.uncommitted", "changes"),
			async (ctx) => {
				await engine.run({ ...fakeContext("review:1", ctx.signal).ctx, signal: ctx.signal });
				return { outcome: "cancelled" };
			},
			{ workId: "review:1" },
		);
		await engines.clear();
		expect(registry.list()).toEqual([]);
		expect(work.get("review:1")?.outcome).toBe("cancelled");
		expect(engines.bind([declared(SWARM, "swarm")])).toEqual([]);
		expect(registry.get("ext:swarm-review/swarm")).toBeDefined();
	});

	it("stops waiting for a review that ignores its cancellation once the grace has passed", async () => {
		const { work, registry, engines } = await setup();
		const release = Promise.withResolvers<void>();
		engines.bind([declared(SWARM, "swarm", async () => release.promise)]);
		const engine = registry.get("ext:swarm-review/swarm")!;
		await work.start(
			"review",
			reviewWorkInput("review.uncommitted", "changes"),
			async (ctx) => {
				await engine.run({ ...fakeContext("review:1", ctx.signal).ctx, signal: ctx.signal });
				return { outcome: "completed" };
			},
			{ workId: "review:1" },
		);
		const started = Date.now();
		await engines.retire(SWARM, 50);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(registry.get("ext:swarm-review/swarm")).toBeUndefined();
		release.resolve();
		await work.settled("review:1");
	});
});

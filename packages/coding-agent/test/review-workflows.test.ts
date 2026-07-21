import { describe, expect, test } from "vitest";
import type { ExecuteReviewWorkflowResult } from "../src/core/review.ts";
import {
	MAX_ACTIVE_REVIEW_WORKFLOWS,
	MAX_RETAINED_REVIEW_RAW_CHARS,
	MAX_RETAINED_REVIEW_RESULTS,
	type ReviewWorkflowExecuteHooks,
	ReviewWorkflowManager,
} from "../src/core/review-workflows.ts";

const resolution = {
	description: "uncommitted changes",
	diffCommand: "git diff HEAD",
	diff: "diff",
	truncated: false,
};

function prepared(workflowId: string) {
	return { workflowId, action: "review.uncommitted", resolution };
}

function completed(overrides: Partial<Extract<ExecuteReviewWorkflowResult, { status: "completed" }>> = {}) {
	return {
		status: "completed" as const,
		raw: "raw reviewer output",
		parsed: { findings: [{ title: "Finding", body: "Body" }] },
		findingsCount: 1,
		...overrides,
	};
}

describe("ReviewWorkflowManager", () => {
	test("does not execute until launch, then reaches a terminal result with a workflow_end event", async () => {
		const published: Array<Record<string, unknown>> = [];
		const sunk: Array<Record<string, unknown>> = [];
		const manager = new ReviewWorkflowManager({ publishEvent: (event) => published.push(event) });
		manager.attachSink((event) => sunk.push(event));

		let executed = false;
		const { descriptor, launch } = manager.start({
			prepared: prepared("review:one"),
			execute: async (hooks: ReviewWorkflowExecuteHooks) => {
				executed = true;
				hooks.onEvent({
					type: "workflow_start",
					workflowId: "review:one",
					kind: "review",
					action: "review.uncommitted",
					title: "Review",
					message: "Reviewing uncommitted changes.",
					status: "running",
				});
				return completed();
			},
		});
		expect(descriptor).toMatchObject({ workflowId: "review:one", status: "running" });
		expect(executed).toBe(false);
		expect(manager.hasActiveWorkflows).toBe(true);

		launch();
		launch(); // idempotent
		await manager.waitForIdle();

		expect(executed).toBe(true);
		expect(manager.hasActiveWorkflows).toBe(false);
		const record = manager.get("review:one");
		expect(record).toMatchObject({
			workflowId: "review:one",
			status: "completed",
			findingsCount: 1,
			target: { description: "uncommitted changes", diffCommand: "git diff HEAD" },
		});
		expect(record?.parsed?.findings).toEqual([{ title: "Finding", body: "Body" }]);
		// Raw text is retained only when there is no parsed findings payload.
		expect(record?.raw).toBeUndefined();
		const end = published.at(-1);
		expect(end).toMatchObject({ type: "workflow_end", workflowId: "review:one", status: "completed" });
		expect(sunk.at(-1)).toEqual(end);
	});

	test("retains the sanitized workflow description instead of richer reviewer-only metadata", async () => {
		const manager = new ReviewWorkflowManager();
		const { descriptor, launch } = manager.start({
			prepared: {
				...prepared("review:pr"),
				action: "review.pr",
				resolution: {
					...resolution,
					description: "PR #42 (private title)",
					workflowDescription: "PR #42",
					diffCommand: "gh pr diff 42",
				},
			},
			execute: async () => completed(),
		});
		expect(descriptor.target).toEqual({ description: "PR #42", diffCommand: "gh pr diff 42" });
		launch();
		await manager.waitForIdle();
		expect(manager.get("review:pr")?.target.description).toBe("PR #42");
	});

	test("retains bounded raw text when the report had no parseable findings", async () => {
		const manager = new ReviewWorkflowManager();
		const { launch } = manager.start({
			prepared: prepared("review:raw"),
			execute: async () =>
				completed({
					parsed: undefined,
					findingsCount: undefined,
					raw: "x".repeat(MAX_RETAINED_REVIEW_RAW_CHARS + 100),
				}),
		});
		launch();
		await manager.waitForIdle();
		const record = manager.get("review:raw");
		expect(record?.parsed).toBeUndefined();
		expect(record?.raw).toHaveLength(MAX_RETAINED_REVIEW_RAW_CHARS);
	});

	test("records failures, including executions that throw", async () => {
		const events: Array<Record<string, unknown>> = [];
		const manager = new ReviewWorkflowManager({ publishEvent: (event) => events.push(event) });
		const { launch } = manager.start({
			prepared: prepared("review:boom"),
			execute: async () => {
				throw new Error("provider exploded");
			},
		});
		launch();
		await manager.waitForIdle();
		expect(manager.get("review:boom")).toMatchObject({
			status: "failed",
			errorMessage: "provider exploded",
		});
		expect(events.at(-1)).toMatchObject({
			type: "workflow_end",
			workflowId: "review:boom",
			status: "failed",
			message: "Review failed: provider exploded",
		});
	});

	test("cancel aborts a running execution and rejects unknown workflows", async () => {
		const manager = new ReviewWorkflowManager();
		const { launch } = manager.start({
			prepared: prepared("review:slow"),
			execute: (hooks) =>
				new Promise((resolve) => {
					hooks.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
				}),
		});
		launch();
		manager.cancel("review:slow");
		await manager.waitForIdle();
		expect(manager.get("review:slow")).toMatchObject({ status: "cancelled" });
		expect(() => manager.cancel("review:slow")).toThrow("No running review workflow: review:slow");
		expect(() => manager.cancel("review:none")).toThrow("No running review workflow: review:none");
	});

	test("a cancel result wins even when the execution finishes after the abort", async () => {
		const manager = new ReviewWorkflowManager();
		let releaseExecution: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});
		const { launch } = manager.start({
			prepared: prepared("review:race"),
			execute: async () => {
				await gate;
				return completed();
			},
		});
		launch();
		manager.cancel("review:race");
		releaseExecution();
		await manager.waitForIdle();
		expect(manager.get("review:race")).toMatchObject({ status: "cancelled" });
	});

	test("consume drops a retained terminal result but never a running workflow", async () => {
		const manager = new ReviewWorkflowManager();
		const { launch } = manager.start({ prepared: prepared("review:done"), execute: async () => completed() });
		launch();
		await manager.waitForIdle();
		manager
			.start({
				prepared: prepared("review:running"),
				execute: (hooks) =>
					new Promise((resolve) => {
						hooks.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
					}),
			})
			.launch();

		manager.consume("review:done");
		expect(manager.get("review:done")).toBeUndefined();
		expect(manager.list().map((descriptor) => descriptor.workflowId)).toEqual(["review:running"]);

		// Only the retained terminal ring is consumable: a running workflow
		// stays active and cancellable.
		manager.consume("review:running");
		expect(manager.get("review:running")).toMatchObject({ status: "running" });
		expect(manager.hasActiveWorkflows).toBe(true);

		// Already-consumed and unknown ids are a no-op.
		manager.consume("review:done");
		manager.consume("review:none");

		await manager.abortAll();
		expect(manager.get("review:running")).toMatchObject({ status: "cancelled" });
	});

	test("caps concurrent workflows and rejects duplicates", async () => {
		const manager = new ReviewWorkflowManager();
		const launches: Array<() => void> = [];
		for (let index = 0; index < MAX_ACTIVE_REVIEW_WORKFLOWS; index++) {
			launches.push(
				manager.start({
					prepared: prepared(`review:cap-${index}`),
					execute: (hooks) =>
						new Promise((resolve) => {
							hooks.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
						}),
				}).launch,
			);
		}
		expect(() => manager.start({ prepared: prepared("review:overflow"), execute: async () => completed() })).toThrow(
			"Too many running reviews",
		);

		for (const launch of launches) {
			launch();
		}
		await manager.abortAll();
		expect(manager.hasActiveWorkflows).toBe(false);
		expect(() => manager.start({ prepared: prepared("review:cap-0"), execute: async () => completed() })).toThrow(
			"Review workflow already exists: review:cap-0",
		);
	});

	test("evicts the oldest retained results beyond the retention bound", async () => {
		const manager = new ReviewWorkflowManager();
		for (let index = 0; index < MAX_RETAINED_REVIEW_RESULTS + 2; index++) {
			const { launch } = manager.start({
				prepared: prepared(`review:ring-${index}`),
				execute: async () => completed(),
			});
			launch();
			await manager.waitForIdle();
		}
		expect(manager.get("review:ring-0")).toBeUndefined();
		expect(manager.get("review:ring-1")).toBeUndefined();
		expect(manager.get(`review:ring-${MAX_RETAINED_REVIEW_RESULTS + 1}`)).toBeDefined();
		expect(manager.list()).toHaveLength(MAX_RETAINED_REVIEW_RESULTS);
	});

	test("abortAll cancels registered-but-unlaunched workflows", async () => {
		const events: Array<Record<string, unknown>> = [];
		const manager = new ReviewWorkflowManager({ publishEvent: (event) => events.push(event) });
		manager.start({
			prepared: prepared("review:pending"),
			execute: async () => completed(),
		});
		await manager.abortAll();
		expect(manager.get("review:pending")).toMatchObject({ status: "cancelled" });
		expect(events.at(-1)).toMatchObject({
			type: "workflow_end",
			workflowId: "review:pending",
			status: "cancelled",
		});
	});

	test("sink and publish failures do not break the workflow or other sinks", async () => {
		const seen: string[] = [];
		const manager = new ReviewWorkflowManager({
			publishEvent: () => {
				throw new Error("feed disposed");
			},
		});
		manager.attachSink(() => {
			throw new Error("bad observer");
		});
		manager.attachSink((event) => {
			seen.push(event.type);
		});
		const { launch } = manager.start({ prepared: prepared("review:sink"), execute: async () => completed() });
		launch();
		await manager.waitForIdle();
		expect(manager.get("review:sink")).toMatchObject({ status: "completed" });
		expect(seen).toContain("workflow_end");
	});
});

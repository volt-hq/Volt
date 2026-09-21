import { describe, expect, it, vi } from "vitest";
import { evaluateAhead, type JevQuestion, type JevResult } from "../examples/extensions/jev-ahead-of-model/client.ts";
import {
	type AheadCycle,
	type AheadStage,
	prepareAhead,
	workspacePath,
} from "../examples/extensions/jev-ahead-of-model/pipeline.ts";
import type {
	ExtensionWorkContribution,
	ExtensionWorkReadResult,
	ExtensionWorkTaskContext,
	JsonValue,
} from "../src/index.ts";
import { type AheadRequest, aheadAnswers } from "./fixtures/jev-ahead.ts";

const questions: Record<string, JevQuestion> = {
	route: { type: "choice", instructions: "Route", criteria: { read: "Read", none: "None" } },
	fit: { type: "boolean", instructions: "Fits?" },
	value: { type: "score", instructions: "Value", criteria: ["low", "high"] },
};
const answers = {
	route: { type: "choice", choice: "read", probabilities: { read: 0.8, none: 0.2 } },
	fit: { type: "boolean", probability: 0.9 },
	value: { type: "score", score: 0.75, probabilities: { "0": 0.25, "1": 0.75 } },
};

describe("Ahead Jev HTTP adapter", () => {
	it("uses the public API and retains typed probability distributions and bounded usage", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({
				answers,
				usage: { inputTokens: 10, outputTokens: 4 },
				providerMetadata: { gateway: { cost: "0.00000042", private: "discard" } },
			}),
		);
		const result = await evaluateAhead(
			{ request: "synthetic" },
			questions,
			async () => "test-key",
			new AbortController().signal,
			{ fetch, zeroDataRetention: true },
		);
		expect(result).toMatchObject({ status: "ok", answers, inputTokens: 10, outputTokens: 4, cost: "0.00000042" });
		expect(fetch.mock.calls[0][0]).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
		expect(fetch.mock.calls[0][1]).toMatchObject({
			redirect: "error",
			headers: { Authorization: "Bearer test-key" },
		});
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
			model: "typesafe-ai/jev",
			providerOptions: { gateway: { zeroDataRetention: true } },
		});
		expect(JSON.stringify(result)).not.toContain("discard");
	});

	it.each([
		{ ...answers, extra: answers.fit },
		{ ...answers, route: { ...answers.route, choice: "../invented.ts" } },
		{ ...answers, route: { ...answers.route, probabilities: { read: 1 } } },
		{ ...answers, route: { ...answers.route, probabilities: { read: 1, invented: 0 } } },
		{ ...answers, route: { ...answers.route, probabilities: { read: 2, none: -1 } } },
		{ ...answers, fit: { type: "boolean", probability: "1" } },
		{ ...answers, value: { ...answers.value, score: 2 } },
		{ ...answers, value: { ...answers.value, probabilities: { "0": 0.5, "2": 0.5 } } },
	])("rejects malformed batches atomically (%#)", async (invalid) => {
		const result = await evaluateAhead({}, questions, async () => "key", new AbortController().signal, {
			fetch: async () => Response.json({ answers: invalid }),
		});
		expect(result).toMatchObject({ status: "unavailable", reason: "response" });
		expect(result).not.toHaveProperty("answers");
	});

	it("rejects oversized input before resolving credentials", async () => {
		const key = vi.fn(async () => "key");
		const fetch = vi.fn<typeof globalThis.fetch>();
		expect(
			await evaluateAhead("界".repeat(30_000), questions, key, new AbortController().signal, { fetch }),
		).toMatchObject({ status: "unavailable", reason: "size" });
		expect(key).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("contains upstream failures and never retries or weakens ZDR", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("private error", { status: 429 }));
		const result = await evaluateAhead({}, questions, async () => "key", new AbortController().signal, {
			fetch,
			zeroDataRetention: true,
		});
		expect(result).toMatchObject({ status: "unavailable", reason: "http", httpStatus: 429 });
		expect(JSON.stringify(result)).not.toContain("private");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("cancels a stalled response body even with a custom transport", async () => {
		const abort = new AbortController();
		const cancel = vi.fn();
		let entered!: () => void;
		const reading = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const running = evaluateAhead({}, questions, async () => "key", abort.signal, {
			fetch: async () =>
				new Response(
					new ReadableStream({
						pull: () => {
							entered();
						},
						cancel,
					}),
				),
		});
		await reading;
		abort.abort();
		expect(await running).toMatchObject({ status: "cancelled", reason: "aborted" });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("bounds response bytes and avoids requests without credentials", async () => {
		const cancel = vi.fn();
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(70_000));
						},
						cancel,
					}),
				),
		);
		expect(
			await evaluateAhead({}, questions, async () => undefined, new AbortController().signal, { fetch }),
		).toMatchObject({ status: "unavailable", reason: "credentials" });
		expect(fetch).not.toHaveBeenCalled();
		expect(
			await evaluateAhead({}, questions, async () => "key", new AbortController().signal, { fetch }),
		).toMatchObject({ status: "unavailable", reason: "size" });
		expect(cancel).toHaveBeenCalledOnce();
	});
});

function pipeline() {
	const controller = new AbortController();
	const read = (path: string, text: string): ExtensionWorkReadResult => ({
		status: "ok",
		text,
		truncated: false,
		evidence: { id: `evidence:${path}`, path, startLine: 1, endLine: 2, observedAt: 1 },
	});
	const task: ExtensionWorkTaskContext = {
		snapshot: {
			scopeId: "scope",
			branchId: "branch",
			runtimeId: "runtime",
			revision: 1,
			cwd: "/repo",
			mode: "build",
			inputs: [{ text: "Investigate resume", kind: "prompt" }],
			services: ["findPaths", "searchText", "readText", "readSkill", "symbols", "definition", "references"],
			skills: [
				{
					resourceId: "resource-a",
					name: "resume",
					description: "Diagnose session restoration",
					scope: "project",
					origin: "top-level",
				},
				{
					resourceId: "resource-b",
					name: "other",
					description: "General debugging",
					scope: "project",
					origin: "top-level",
				},
			],
			skillsTruncated: false,
		},
		signal: controller.signal,
		deadline: Date.now() + 8000,
		repository: {
			findPaths: vi.fn<ExtensionWorkTaskContext["repository"]["findPaths"]>(async () => ({
				status: "ok",
				paths: ["src/session.ts", "src/irrelevant.ts", "../private.ts"],
				truncated: false,
			})),
			searchText: vi.fn<ExtensionWorkTaskContext["repository"]["searchText"]>(async () => ({
				status: "ok",
				matches: [{ path: "/repo/src/session.ts", line: 1, text: "resume" }],
				truncated: false,
			})),
			readSkill: vi.fn(async ({ resourceId }) => read(`/skills/${resourceId}/SKILL.md`, `SKILL_BODY_${resourceId}`)),
			readText: vi.fn(async ({ path }) =>
				read(`/repo/${path}`, path.includes("dependency") ? "RELATED_BODY" : "SESSION_BODY"),
			),
			symbols: vi.fn<ExtensionWorkTaskContext["repository"]["symbols"]>(async () => ({
				status: "ok",
				symbols: [
					{
						path: "/repo/src/session.ts",
						name: "resume",
						kind: 12,
						startLine: 1,
						endLine: 2,
						startColumn: 1,
						endColumn: 2,
					},
				],
				truncated: false,
				coverage: "unknown",
				observedAt: 1,
			})),
			definition: vi.fn<ExtensionWorkTaskContext["repository"]["definition"]>(async () => ({
				status: "ok",
				locations: [{ path: "/repo/src/dependency.ts", startLine: 1, endLine: 2, startColumn: 1, endColumn: 2 }],
				truncated: false,
				coverage: "unknown",
				observedAt: 1,
			})),
			references: vi.fn<ExtensionWorkTaskContext["repository"]["references"]>(async () => ({
				status: "ok",
				locations: [],
				truncated: false,
				coverage: "unknown",
				observedAt: 1,
			})),
		},
		context: {
			put: vi.fn<ExtensionWorkTaskContext["context"]["put"]>(() => ({ status: "accepted" })),
			remove: vi.fn(),
		},
	};
	const calls: Array<{ stage: AheadStage; request: AheadRequest }> = [];
	const cycle: AheadCycle = {
		number: 1,
		trigger: "request",
		status: "starting",
		operations: [],
		selection: [],
		publications: [],
	};
	const evaluate = vi.fn(
		async (stage: AheadStage, state: JsonValue, questions: Record<string, JevQuestion>): Promise<JevResult> => {
			const request = { model: "typesafe-ai/jev", state, questions } as AheadRequest;
			calls.push({ stage, request });
			return { status: "ok", answers: aheadAnswers(request), elapsedMs: 1, requestBytes: 100 };
		},
	);
	const publish = vi.fn(async (_items: ExtensionWorkContribution[]) => {});
	const run = () =>
		prepareAhead(
			task,
			{ request: "Investigate resume", recent: [], tools: [], truncated: false },
			cycle,
			evaluate,
			publish,
		);
	return { task, calls, cycle, evaluate, publish, run, controller };
}

describe("Ahead preparation strategy", () => {
	it("uses four Jev stages to select files, inspect skills, follow symbols, and publish assessed evidence", async () => {
		const test = pipeline();
		await test.run();
		expect(test.calls.map((call) => call.stage)).toEqual(["orient", "select", "assess", "refine"]);
		expect(JSON.stringify(test.calls[1].request.state)).toContain("SKILL_BODY_resource-a");
		expect(JSON.stringify(test.calls[2].request.state)).toContain("SESSION_BODY");
		expect(JSON.stringify(test.calls[3].request.state)).toContain("RELATED_BODY");
		expect(test.task.repository.readText).toHaveBeenCalledTimes(2);
		expect(test.task.repository.definition).toHaveBeenCalledWith({
			path: "src/session.ts",
			symbol: "resume",
			line: 1,
		});
		expect(test.task.repository.references).not.toHaveBeenCalled();
		const publications = test.publish.mock.calls[0][0];
		expect(publications).toHaveLength(3);
		expect(publications.every((item) => item.dependency === "sources" && item.evidenceIds?.length === 1)).toBe(true);
		expect(JSON.stringify(publications)).toContain("RELATED_BODY");
		expect(JSON.stringify(test.calls)).not.toContain("private.ts");
		expect(test.cycle.status).toBe("prepared");
	});

	it("abstains before repository work when Jev finds no preparation useful", async () => {
		const test = pipeline();
		test.evaluate.mockResolvedValue({
			status: "ok",
			answers: {
				phase: { type: "choice", choice: "conversation", probabilities: { conversation: 1 } },
				repository: { type: "boolean", probability: 0 },
				skill: { type: "choice", choice: "none", probabilities: { none: 1 } },
			},
			elapsedMs: 0,
			requestBytes: 0,
		});
		await test.run();
		expect(test.cycle.status).toBe("abstained");
		expect(test.task.repository.findPaths).not.toHaveBeenCalled();
		expect(test.task.repository.readSkill).not.toHaveBeenCalled();
		expect(test.publish).not.toHaveBeenCalled();
	});

	it("omits unavailable native reads instead of substituting another source", async () => {
		const test = pipeline();
		test.task.repository.readSkill = vi.fn<ExtensionWorkTaskContext["repository"]["readSkill"]>(async () => ({
			status: "denied",
			reason: "policy",
		}));
		test.task.repository.readText = vi.fn<ExtensionWorkTaskContext["repository"]["readText"]>(async () => ({
			status: "unavailable",
			reason: "transformed_result",
		}));
		await test.run();
		expect(test.cycle.status).toBe("no readable evidence");
		expect(test.publish).not.toHaveBeenCalled();
		expect(test.calls).toHaveLength(2);
	});

	it("contains a rejected native read without publishing a partial unassessed packet", async () => {
		const test = pipeline();
		vi.spyOn(test.task.repository, "readText").mockRejectedValue(new Error("read failed"));
		await test.run();
		expect(test.cycle.status).toBe("reads failed");
		expect(test.calls).toHaveLength(2);
		expect(test.publish).not.toHaveBeenCalled();
	});

	it("stops before semantic navigation when cancelled during assessment", async () => {
		const test = pipeline();
		const evaluate = test.evaluate.getMockImplementation()!;
		test.evaluate.mockImplementation(async (...args) => {
			const result = await evaluate(...args);
			if (args[0] === "assess") test.controller.abort();
			return result;
		});
		await test.run();
		expect(test.cycle.status).toBe("cancelled");
		expect(test.task.repository.definition).not.toHaveBeenCalled();
		expect(test.publish).not.toHaveBeenCalled();
	});

	it.each([
		"../secret.ts",
		"/elsewhere/private.ts",
		"src/../../secret.ts",
		"node_modules/lib.ts",
		".env",
		".git/config",
		"src/evil\n.ts",
	])("rejects unsupported candidate paths: %s", (path) => {
		expect(workspacePath("/repo", path)).toBeUndefined();
	});
});

import { describe, expect, it, vi } from "vitest";
import { type PreparationPlan, selectPreparation } from "../examples/extensions/context-preparation.ts";
import { evaluateJev } from "../examples/extensions/jev-context-preparation.ts";
import type { ExtensionWorkSnapshot } from "../src/index.ts";

const plan: PreparationPlan = {
	prompt: "Extract invoice tables from src/invoice.ts:2",
	skills: [
		{
			resourceId: "private-host-resource",
			name: "invoice",
			description: "Extract invoice tables",
			scope: "user",
			origin: "top-level",
		},
	],
	sources: [
		{ path: "src/invoice.ts", line: 2 },
		{ path: "src/mail.ts", symbol: "send" },
	],
};
const answers = {
	skill: { type: "choice", choice: "skill-1" },
	"source-1": { type: "choice", choice: "source-1" },
	"source-2": { type: "choice", choice: "none" },
};
function setup(response: () => Promise<Response> = async () => Response.json({ answers })) {
	const fetch = vi.fn<typeof globalThis.fetch>(response);
	const key = vi.fn(async (): Promise<string | undefined> => "synthetic-key");
	const controller = new AbortController();
	return {
		fetch,
		key,
		controller,
		run: (input = plan, zeroDataRetention = false) =>
			evaluateJev(input, key, controller.signal, { fetch, zeroDataRetention }),
	};
}

function snapshot(prompt: string): ExtensionWorkSnapshot {
	return {
		scopeId: "scope",
		branchId: "branch",
		runtimeId: "runtime",
		revision: 1,
		cwd: "/repo",
		mode: "build",
		inputs: [{ text: prompt, kind: "prompt" }],
		services: ["readText", "readSkill"],
		skills: plan.skills,
		skillsTruncated: false,
	};
}

describe("Jev catalog selection", () => {
	it.each(["Fix the bug", "Thanks", "Fix the bug without changing the API", "Do not use invoice for src/invoice.ts"])(
		"offers loaded skills without lexical or negative-cue gating: %s",
		(prompt) => {
			const result = selectPreparation(snapshot(prompt), "catalog");
			expect(result).toEqual({ prompt, skill: undefined, skills: plan.skills, sources: [] });
		},
	);

	it.each(["/skill:invoice", '<skill name="invoice">private skill body</skill>'])(
		"does not re-evaluate an explicit skill invocation: %s",
		(prompt) => {
			expect(selectPreparation(snapshot(prompt), "catalog")).toBeUndefined();
		},
	);

	it.each(["truncated", "unavailable"])("retains the %s catalog guard", (kind) => {
		const input = snapshot("Fix the bug");
		if (kind === "truncated") input.skillsTruncated = true;
		else input.services = ["readText"];
		expect(selectPreparation(input, "catalog")?.skills).toEqual([]);
	});

	it("offers the full bounded catalog rather than an eight-skill shortlist", async () => {
		const input = snapshot("Help me with this task");
		input.skills = Array.from({ length: 128 }, (_, index) => ({
			...plan.skills[0],
			resourceId: `private-${index}`,
			name: `skill-${index}`,
		}));
		const selected = selectPreparation(input, "catalog")!;
		expect(selected.skills).toEqual(input.skills);
		expect(selected.skill).toBeUndefined();
		const test = setup(async () => Response.json({ answers: { skill: { type: "choice", choice: "skill-128" } } }));
		expect(await test.run(selected)).toMatchObject({ status: "selected", choices: { skill: "skill-128" } });
		const request = JSON.parse(String(test.fetch.mock.calls[0][1]?.body));
		expect(Object.keys(request.questions.skill.criteria)).toHaveLength(129);
		expect(request.questions.skill.criteria["skill-128"].name).toBe("skill-127");
	});
});

describe("Jev evaluation adapter (no live network)", () => {
	it("uses the verified Gateway evaluation contract and validates finite choices", async () => {
		const test = setup();
		const result = await test.run();
		expect(result).toMatchObject({
			status: "selected",
			choices: { skill: "skill-1", "source-1": "source-1", "source-2": "none" },
			httpStatus: 200,
		});
		expect(test.key).toHaveBeenCalledOnce();
		expect(test.fetch).toHaveBeenCalledOnce();
		const [url, request] = test.fetch.mock.calls[0];
		expect(url).toBe("https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
		expect(request).toMatchObject({
			method: "POST",
			redirect: "error",
			signal: test.controller.signal,
			headers: {
				Authorization: "Bearer synthetic-key",
				"Content-Type": "application/json",
				"ai-gateway-protocol-version": "0.0.1",
				"ai-gateway-auth-method": "api-key",
				"ai-evaluation-model-specification-version": "4",
				"ai-model-id": "typesafe-ai/jev",
			},
		});
		const body = JSON.parse(String(request?.body));
		expect(body.state).toEqual({ request: plan.prompt });
		expect(Object.keys(body.questions)).toEqual(["skill", "source-1", "source-2"]);
		expect(body.questions.skill.criteria).toEqual({
			none: "No clearly useful skill",
			"skill-1": { name: "invoice", description: "Extract invoice tables" },
		});
		expect(body.questions["source-2"].criteria["source-2"]).toEqual({ path: "src/mail.ts", symbol: "send" });
		expect(body.providerOptions).toBeUndefined();
		expect(String(request?.body)).not.toContain("private-host-resource");
		expect(result.requestBytes).toBe(Buffer.byteLength(String(request?.body)));
	});

	it("requests ZDR only when configured, without retrying a rejection", async () => {
		const test = setup(async () => Response.json({ error: "sensitive provider message" }, { status: 403 }));
		expect(await test.run(plan, true)).toMatchObject({ status: "unavailable", reason: "http", httpStatus: 403 });
		expect(JSON.parse(String(test.fetch.mock.calls[0][1]?.body)).providerOptions).toEqual({
			gateway: { zeroDataRetention: true },
		});
		expect(test.fetch).toHaveBeenCalledOnce();
	});

	it.each([
		null,
		{ answers: [] },
		{ answers: {} },
		{ answers: { ...answers, extra: answers.skill } },
		{ answers: { ...answers, skill: { type: "choice", choice: "../invented-path" } } },
		{ answers: { ...answers, skill: { type: "choice", choice: "toString" } } },
		{ answers: { ...answers, skill: { type: "choice", choice: "private-host-resource" } } },
		{ answers: { ...answers, "source-1": { type: "choice", choice: "source-2" } } },
		{ answers: { ...answers, "source-1": { type: "boolean", probability: 1 } } },
		{ answers: { ...answers, "source-2": { type: "choice", choice: 1 } } },
	])("rejects malformed or unauthorized answers %# atomically", async (response) => {
		const test = setup(async () => Response.json(response));
		expect(await test.run()).toMatchObject({ status: "unavailable", reason: "response" });
	});

	it("allows complete abstention and does not use probability as authority", async () => {
		const test = setup(async () =>
			Response.json({
				answers: Object.fromEntries(
					Object.keys(answers).map((id) => [
						id,
						{ type: "choice", choice: "none", probabilities: { invented: 1 } },
					]),
				),
			}),
		);
		expect(await test.run()).toMatchObject({
			status: "selected",
			choices: { skill: "none", "source-1": "none", "source-2": "none" },
		});
	});

	it("reports bounded numeric usage and cost, never provider diagnostics", async () => {
		const test = setup(async () =>
			Response.json({
				answers,
				usage: { inputTokens: 425, outputTokens: 44 },
				providerMetadata: { gateway: { cost: "0", sensitive: "synthetic-key" } },
			}),
		);
		const result = await test.run();
		expect(result).toMatchObject({ inputTokens: 425, outputTokens: 44, cost: "0" });
		expect(JSON.stringify(result)).not.toContain("synthetic-key");
	});

	it("omits invalid usage/cost metadata", async () => {
		const test = setup(async () =>
			Response.json({
				answers,
				usage: { inputTokens: -1, outputTokens: "44" },
				providerMetadata: { gateway: { cost: "private detail" } },
			}),
		);
		const result = await test.run();
		expect(result).toMatchObject({ status: "selected" });
		expect(result).not.toHaveProperty("inputTokens");
		expect(result).not.toHaveProperty("outputTokens");
		expect(result).not.toHaveProperty("cost");
	});

	it("does not resolve credentials or fetch without candidates or with oversized state", async () => {
		const test = setup();
		expect(await test.run({ ...plan, sources: [], skills: [] })).toMatchObject({ status: "unavailable" });
		expect(await test.run({ ...plan, prompt: "x".repeat(65_536) })).toMatchObject({
			status: "unavailable",
			reason: "size",
		});
		expect(test.key).not.toHaveBeenCalled();
		expect(test.fetch).not.toHaveBeenCalled();
	});

	it("bounds exported skill metadata", async () => {
		const test = setup();
		await test.run({
			...plan,
			skills: [{ ...plan.skills[0], name: "n".repeat(100), description: "d".repeat(2000) }],
		});
		const criteria = JSON.parse(String(test.fetch.mock.calls[0][1]?.body)).questions.skill.criteria;
		expect(criteria["skill-1"]).toEqual({ name: "n".repeat(64), description: "d".repeat(256) });
	});

	it("omits inference without credentials", async () => {
		const test = setup();
		test.key.mockResolvedValue(undefined);
		expect(await test.run()).toMatchObject({ status: "unavailable", reason: "credentials" });
		expect(test.fetch).not.toHaveBeenCalled();
	});

	it.each(["auth", "fetch", "json"])("contains %s failures without raw errors or retries", async (stage) => {
		const test = setup();
		if (stage === "auth") test.key.mockRejectedValue(new Error("synthetic-key"));
		if (stage === "fetch") test.fetch.mockRejectedValue(new Error("synthetic-key"));
		if (stage === "json") test.fetch.mockResolvedValue(new Response("synthetic-key"));
		const result = await test.run();
		expect(result).toMatchObject({ status: "unavailable" });
		expect(JSON.stringify(result)).not.toContain("synthetic-key");
		expect(test.fetch.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it("cancels and bounds a chunked oversized response", async () => {
		const cancel = vi.fn();
		const test = setup(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(40_000));
							controller.enqueue(new Uint8Array(40_000));
						},
						cancel,
					}),
				),
		);
		expect(await test.run()).toMatchObject({ status: "unavailable", reason: "size" });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("cancels an error body without reading or logging it", async () => {
		const cancel = vi.fn();
		const test = setup(async () => new Response(new ReadableStream({ cancel }), { status: 429 }));
		expect(await test.run()).toMatchObject({ status: "unavailable", reason: "http", httpStatus: 429 });
		expect(cancel).toHaveBeenCalledOnce();
		expect(test.fetch).toHaveBeenCalledOnce();
	});

	it.each(["before", "auth", "headers", "body"])("fences abort at %s", async (stage) => {
		const test = setup();
		if (stage === "before") test.controller.abort();
		if (stage === "auth")
			test.key.mockImplementation(async () => {
				test.controller.abort();
				return "synthetic-key";
			});
		if (stage === "headers")
			test.fetch.mockImplementation(async () => {
				test.controller.abort();
				return Response.json({ answers });
			});
		if (stage === "body")
			test.fetch.mockImplementation(
				async () =>
					new Response(
						new ReadableStream({
							pull(controller) {
								controller.enqueue(new TextEncoder().encode(JSON.stringify({ answers })));
								controller.close();
								test.controller.abort();
							},
						}),
					),
			);
		expect(await test.run()).toMatchObject({ status: "cancelled", reason: "aborted" });
		if (stage === "before") expect(test.key).not.toHaveBeenCalled();
		if (stage === "auth" || stage === "before") expect(test.fetch).not.toHaveBeenCalled();
	});
});

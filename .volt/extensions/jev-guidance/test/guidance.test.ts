import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import { type Choice, evaluateSnapshot, JevError, type Judgment, QUESTIONS, retryAfterMs } from "../client.ts";
import { adviceText, GuidanceController } from "../controller.ts";
import { buildSnapshot, MAX_SNAPSHOT_BYTES, redact } from "../snapshot.ts";

const key = "vck_synthetic_credential_123456789";
const user = (text: string, timestamp = 1): AgentMessage => ({ role: "user", content: text, timestamp });
function assistant(text: string, timestamp = 2): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		stopReason: "stop",
		timestamp,
		usage: {
			input: 0,
			output: 0,
			totalTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
const discussion = [user("Discuss the approach. Do not implement yet.")];
const judgment: Judgment = {
	choice: "discussion_boundary",
	probability: 0.97,
	inputTokens: 200,
	outputTokens: 20,
	costUsd: 0.00001,
};
function response(choice: Choice = "discussion_boundary"): Response {
	return Response.json({
		answers: {
			reminder: {
				type: "choice",
				choice,
				probabilities: Object.fromEntries(
					Object.keys(QUESTIONS.reminder.criteria).map((name) => [name, name === choice ? 1 : 0]),
				),
			},
		},
		usage: { inputTokens: 200, outputTokens: 20 },
		providerMetadata: { gateway: { cost: "0.00001" } },
	});
}

test("snapshot preserves earlier approval and the latest side question without copying private tool content", () => {
	const action = assistant("Continuing the approved fix.");
	action.content.push(
		{ type: "thinking", thinking: "PRIVATE_REASONING" },
		{
			type: "toolCall",
			id: "edit1",
			name: "edit",
			arguments: { path: "src/search.ts", edits: [{ oldText: "PRIVATE_CODE", newText: "NEW_PRIVATE_CODE" }] },
		},
	);
	const messages: AgentMessage[] = [
		user("Implement search."),
		...Array.from({ length: 13 }, (_, index) => assistant(`Research ${index}`)),
		user("Why SQLite?", 20),
		action,
		{
			role: "toolResult",
			toolName: "read",
			toolCallId: "read1",
			content: [{ type: "text", text: "RAW_PRIVATE_FILE" }],
			isError: false,
			timestamp: 21,
		},
		{ role: "custom", customType: "jev-guidance", content: "PREVIOUS_GUIDANCE", display: false, timestamp: 22 },
		{
			role: "bashExecution",
			command: "PRIVATE_SHELL",
			output: "PRIVATE_OUTPUT",
			excludeFromContext: true,
			cancelled: false,
			truncated: false,
			timestamp: 23,
		},
	];
	const { state } = buildSnapshot(messages);
	const serialized = JSON.stringify(state);
	assert.equal(state.latestUserRequest?.text, "Why SQLite?");
	assert.ok(serialized.includes("Implement search."));
	assert.ok(serialized.includes("src/search.ts"));
	for (const omitted of [
		"PRIVATE_REASONING",
		"PRIVATE_CODE",
		"RAW_PRIVATE_FILE",
		"PREVIOUS_GUIDANCE",
		"PRIVATE_SHELL",
		"PRIVATE_OUTPUT",
	])
		assert.ok(!serialized.includes(omitted));
	assert.equal(state.historyIncomplete, true);
});

test("snapshot redacts common secrets and stays byte bounded with multibyte input", () => {
	const messages = Array.from({ length: 40 }, (_, index) =>
		user(`Bearer confidential-token api_key=other-secret ${"漢".repeat(5_000)}`, index),
	);
	const state = buildSnapshot(messages).state;
	const serialized = JSON.stringify(state);
	assert.ok(Buffer.byteLength(serialized) <= MAX_SNAPSHOT_BYTES);
	assert.ok(!serialized.includes("confidential-token"));
	assert.ok(!serialized.includes("other-secret"));
	assert.ok(state.latestUserRequest);
	assert.equal(state.historyIncomplete, true);
	assert.equal(redact(`prefix ${key}`, key), "prefix [redacted]");
	assert.ok(!redact("-----BEGIN PRIVATE KEY-----\nconfidential\n-----END PRIVATE KEY-----").includes("confidential"));
});

test("SDK request uses Gateway credential only as auth, sends bounded state, and reports usage", async () => {
	let calls = 0;
	const state = buildSnapshot([user(`Discuss this literal ${key}`)]).state;
	const result = await evaluateSnapshot(
		state,
		async () => key,
		new AbortController().signal,
		async (input, init) => {
			calls++;
			assert.equal(new URL(String(input)).hostname, "ai-gateway.vercel.sh");
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
			assert.equal(init?.redirect, "error");
			assert.ok(!String(init?.body).includes(key));
			const body = JSON.parse(String(init?.body));
			assert.deepEqual(body.questions, QUESTIONS);
			assert.equal(body.providerOptions?.gateway?.zeroDataRetention, undefined);
			return response();
		},
	);
	assert.equal(calls, 1);
	assert.equal(result.choice, "discussion_boundary");
	assert.equal(result.costUsd, 0.00001);
	assert.equal(result.inputTokens, 200);
});

test("SDK 429 is not retried and preserves Retry-After without leaking provider error text", async () => {
	let calls = 0;
	await assert.rejects(
		evaluateSnapshot(
			buildSnapshot(discussion).state,
			async () => key,
			new AbortController().signal,
			async () => {
				calls++;
				return Response.json(
					{ error: { message: `sensitive response ${key}` } },
					{ status: 429, headers: { "retry-after": "120" } },
				);
			},
		),
		(error: unknown) => {
			assert.ok(error instanceof JevError);
			assert.equal(error.status, 429);
			assert.equal(error.retryAfterMs, 120_000);
			assert.ok(!String(error).includes(key));
			return true;
		},
	);
	assert.equal(calls, 1);
	assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:30 GMT", 10_000), 20_000);
	assert.equal(retryAfterMs("nonsense"), undefined);
});

test("missing auth never reaches the network and malformed choices never become advice", async () => {
	const noNetwork: typeof fetch = async () => {
		throw new Error("Network must not be called");
	};
	await assert.rejects(
		evaluateSnapshot(buildSnapshot(discussion).state, async () => undefined, new AbortController().signal, noNetwork),
		(error: unknown) => error instanceof JevError && error.status === 401,
	);
	await assert.rejects(
		evaluateSnapshot(
			buildSnapshot(discussion).state,
			async () => key,
			new AbortController().signal,
			async () => Response.json({ answers: { reminder: { type: "choice", choice: "execute_shell" } } }),
		),
		JevError,
	);
});

test("off and observe never steer; advise injects at most once per reminder per user message", async () => {
	let now = 0;
	let calls = 0;
	const controller = new GuidanceController({
		now: () => now,
		evaluate: async () => {
			calls++;
			return judgment;
		},
	});
	assert.equal((await controller.inspect(discussion, async () => key)).kind, "skipped");
	assert.equal(calls, 0);
	controller.setMode("observe");
	const observed = await controller.inspect(discussion, async () => key);
	assert.equal(observed.kind, "judgment");
	if (observed.kind === "judgment") assert.equal(adviceText(observed), undefined);
	now += 16_000;
	controller.setMode("advise");
	const advised = await controller.inspect(discussion, async () => key);
	assert.equal(advised.kind, "judgment");
	if (advised.kind === "judgment") {
		assert.equal(advised.advised, true);
		assert.match(adviceText(advised) ?? "", /not user authorization/);
	}
	now += 16_000;
	assert.deepEqual(await controller.inspect(discussion, async () => key), { kind: "skipped", reason: "unchanged" });
	const duplicate = await controller.inspect([...discussion, assistant("I will keep discussing.")], async () => key);
	assert.equal(duplicate.kind, "judgment");
	if (duplicate.kind === "judgment") assert.equal(duplicate.advised, false);
	now += 16_000;
	const nextUser = await controller.inspect(
		[...discussion, user("Keep discussing the alternatives.", 40)],
		async () => key,
	);
	if (nextUser.kind === "judgment") assert.equal(nextUser.advised, true);
	else assert.fail("Expected another judgment");
	assert.equal(controller.stats.advised, 2);
	assert.equal(controller.stats.costSamples, 4);
});

test("low probability, absent probability, none, and insufficient context never inject", async () => {
	for (const result of [
		{ ...judgment, probability: 0.5 },
		{ choice: "discussion_boundary" as const },
		{ choice: "none" as const, probability: 1 },
		{ choice: "insufficient_context" as const, probability: 1 },
	]) {
		const controller = new GuidanceController({ evaluate: async () => result });
		controller.setMode("advise");
		const outcome = await controller.inspect(discussion, async () => key);
		assert.equal(outcome.kind, "judgment");
		if (outcome.kind === "judgment") assert.equal(outcome.advised, false);
	}
});

test("rate cooldown honors long Retry-After and is not bypassed by mode or branch changes", async () => {
	let now = 0;
	let calls = 0;
	const controller = new GuidanceController({
		now: () => now,
		evaluate: async () => {
			calls++;
			throw new JevError(429, 600_000);
		},
	});
	controller.setMode("advise");
	const result = await controller.inspect(discussion, async () => key);
	assert.equal(result.kind, "error");
	assert.equal(controller.waitMs, 600_000);
	controller.setMode("off");
	controller.setMode("observe");
	controller.invalidate();
	now = 599_000;
	assert.equal((await controller.inspect(discussion, async () => key)).kind, "skipped");
	assert.equal(calls, 1);
	now = 600_001;
	await controller.inspect(discussion, async () => key);
	assert.equal(calls, 2);
});

test("fallback cooldown grows, and credential failures wait for explicit re-enabling", async () => {
	let now = 0;
	let status = 429;
	const controller = new GuidanceController({
		now: () => now,
		evaluate: async () => {
			throw new JevError(status);
		},
	});
	controller.setMode("observe");
	await controller.inspect(discussion, async () => key);
	assert.equal(controller.waitMs, 60_000);
	now = 60_001;
	await controller.inspect(discussion, async () => key);
	assert.equal(controller.waitMs, 120_000);
	now = 180_002;
	status = 401;
	await controller.inspect(discussion, async () => key);
	now += 1_000_000;
	assert.deepEqual(await controller.inspect(discussion, async () => key), { kind: "skipped", reason: "credentials" });
	controller.setMode("observe");
	assert.equal((await controller.inspect(discussion, async () => key)).kind, "error");
});

test("single-flight, cancellation, and invalidation discard late results without steering", async () => {
	const pending = Promise.withResolvers<Judgment>();
	let signal: AbortSignal | undefined;
	const controller = new GuidanceController({
		evaluate: async (_state, _key, requestSignal) => {
			signal = requestSignal;
			return pending.promise;
		},
	});
	controller.setMode("advise");
	const first = controller.inspect(discussion, async () => key);
	assert.deepEqual(await controller.inspect(discussion, async () => key), { kind: "skipped", reason: "in_flight" });
	controller.invalidate();
	assert.equal(signal?.aborted, true);
	assert.equal((await first).kind, "skipped");
	pending.resolve(judgment);
	await pending.promise;
	assert.equal(controller.stats.advised, 0);
});

test("timeout bounds a non-cooperative evaluator and retains its in-flight slot", async () => {
	const pending = Promise.withResolvers<Judgment>();
	const controller = new GuidanceController({ timeoutMs: 10, evaluate: async () => pending.promise });
	controller.setMode("advise");
	const outcome = await controller.inspect(discussion, async () => key);
	assert.equal(outcome.kind, "error");
	if (outcome.kind === "error") assert.equal(outcome.reason, "timeout");
	assert.deepEqual(await controller.inspect(discussion, async () => key), { kind: "skipped", reason: "in_flight" });
	pending.resolve(judgment);
	await pending.promise;
	assert.equal(controller.stats.advised, 0);
});

test("queued user input and parent cancellation suppress stale advice", async () => {
	let current = true;
	const controller = new GuidanceController({
		evaluate: async () => {
			current = false;
			return judgment;
		},
	});
	controller.setMode("advise");
	const outcome = await controller.inspect(
		discussion,
		async () => key,
		undefined,
		() => current,
	);
	if (outcome.kind === "judgment") assert.equal(outcome.advised, false);
	else assert.fail("Expected observed judgment");
	const parent = new AbortController();
	parent.abort();
	assert.equal((await controller.inspect(discussion, async () => key, parent.signal)).kind, "skipped");
});

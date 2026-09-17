import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { ExtensionAPI, ExtensionContext, PromptRouteResult, RegisteredCommand } from "@hansjm10/volt-coding-agent";
import { QUESTIONS } from "../client.ts";
import jevGuidance from "../index.ts";

function harness(mode: ExtensionContext["mode"] = "tui", flag = "off") {
	const handlers = new Map<string, unknown>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const entries: unknown[] = [];
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	let authLookups = 0;
	const api: Pick<ExtensionAPI, "on" | "registerFlag" | "getFlag" | "registerCommand" | "appendEntry"> = {
		on: (name: string, handler: unknown) => {
			handlers.set(name, handler);
		},
		registerFlag: () => {},
		getFlag: (name) => (name === "jev" ? flag : "mock/worker"),
		registerCommand: (name, command) => {
			commands.set(name, command);
		},
		appendEntry: (_name, entry) => {
			entries.push(entry);
		},
	};
	// Deliberately partial doubles: unexpected runtime APIs fail instead of doing real work.
	const ctx = {
		mode,
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
		},
		model: { provider: "mock", id: "primary" },
		sessionManager: { getBranch: () => [] },
		modelRegistry: {
			getAvailable: () => [
				{ provider: "mock", id: "primary" },
				{ provider: "mock", id: "worker" },
			],
			getApiKeyForProvider: async (provider: string) => {
				assert.equal(provider, "vercel-ai-gateway");
				authLookups++;
				return "synthetic-key";
			},
		},
		signal: new AbortController().signal,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	jevGuidance(api as ExtensionAPI);
	async function fire(name: string, event: unknown) {
		const handler = handlers.get(name) as (event: unknown, ctx: ExtensionContext) => unknown;
		return await handler(event, ctx);
	}
	return {
		entries,
		notifications,
		statuses,
		commands,
		get authLookups() {
			return authLookups;
		},
		fire,
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		route: async (prompt = "Create a PR for the verified committed changes", signal = new AbortController().signal) =>
			(await fire("prompt_route", {
				type: "prompt_route",
				prompt,
				signal,
				agents: [{ name: "general", description: "General worker" }],
			})) as PromptRouteResult | undefined,
		context: async (messages: AgentMessage[]) =>
			(await fire("context", { type: "context", messages })) as { messages?: AgentMessage[] } | undefined,
		command: async (args: string) => {
			const command = commands.get("jev");
			assert.ok(command);
			await command.handler(args, ctx as Parameters<typeof command.handler>[1]);
		},
	};
}

const userPrompt = "Discuss this design. Do not implement yet.";
const messages: AgentMessage[] = [{ role: "user", content: userPrompt, timestamp: 1 }];
function mockResponse(): Response {
	return Response.json({
		answers: {
			reminder: {
				type: "choice",
				choice: "discussion_boundary",
				probabilities: Object.fromEntries(
					Object.keys(QUESTIONS.reminder.criteria).map((choice) => [
						choice,
						choice === "discussion_boundary" ? 1 : 0,
					]),
				),
			},
		},
		usage: { inputTokens: 50, outputTokens: 20 },
		providerMetadata: { gateway: { cost: "0.0000021" } },
	});
}

test("off is the default and non-TUI sessions never resolve credentials or call Jev", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		assert.fail("No network allowed");
	});
	const local = harness();
	await local.start();
	assert.equal(await local.context(messages), undefined);
	assert.equal(local.authLookups, 0);
	for (const mode of ["rpc", "json", "print"] as const) {
		const host = harness(mode, "advise");
		await host.start();
		await host.command("advise");
		assert.equal(await host.context(messages), undefined);
		assert.equal(host.authLookups, 0);
		assert.equal(host.commands.get("jev")?.remoteSafe, false);
	}
});

test("observe records a compact judgment and reports it without changing model context", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return mockResponse();
	});
	const host = harness();
	await host.start();
	await host.command("observe");
	assert.equal(await host.context(messages), undefined);
	assert.equal(calls, 1);
	assert.equal(host.entries.length, 1);
	const saved = JSON.stringify(host.entries);
	assert.ok(saved.includes("discussion_boundary"));
	assert.ok(!saved.includes(userPrompt));
	assert.ok(!saved.includes("synthetic-key"));
	assert.ok(host.statuses.some((status) => status?.includes("Jev observe")));
	await host.command("status");
	assert.ok(host.notifications.some((text) => text.includes("$0.000002")));
});

test("advise appends only transient advisory context and off stops future evaluation", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return mockResponse();
	});
	const host = harness();
	await host.start();
	await host.command("advise");
	const before = structuredClone(messages);
	const result = await host.context(messages);
	assert.deepEqual(messages, before);
	assert.equal(result?.messages?.length, messages.length + 1);
	const advice = result?.messages?.at(-1);
	assert.equal(advice?.role, "custom");
	if (advice?.role === "custom") assert.match(String(advice.content), /not user authorization/);
	assert.equal(host.entries.length, 1);
	await host.command("off");
	assert.equal(await host.context(messages), undefined);
	assert.equal(calls, 1);
	assert.equal(host.statuses.at(-1), undefined);
});

function routingResponse(choice = "pr_worker", probability: number | undefined = 0.99): Response {
	return Response.json({
		answers: {
			reminder: {
				type: "choice",
				choice,
				...(probability === undefined
					? {}
					: {
							probabilities: {
								pr_worker: choice === "pr_worker" ? probability : 0,
								none: choice === "none" ? probability : choice === "pr_worker" ? 1 - probability : 0,
								insufficient_context: choice === "insufficient_context" ? probability : 0,
							},
						}),
			},
		},
		usage: { inputTokens: 40, outputTokens: 0 },
	});
}

test("routing is separately opt-in, selects the configured worker, and makes no guidance requests", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
		calls++;
		const body = JSON.parse(String(init?.body));
		assert.ok(body.questions.reminder.criteria.pr_worker);
		assert.ok(!String(init?.body).includes("synthetic-key"));
		return routingResponse();
	});
	const host = harness();
	await host.start();
	assert.equal(await host.route(), undefined);
	assert.equal(calls, 0);
	await host.command("route mock/worker");
	assert.equal(await host.context(messages), undefined);
	const result = await host.route();
	assert.equal(result?.agent, "general");
	assert.equal(result?.model, "mock/worker");
	assert.match(result?.task ?? "", /existing committed branch only/);
	assert.match(result?.task ?? "", /Create a PR for the verified committed changes/);
	assert.equal(calls, 1);
	assert.equal(host.entries.length, 1);
	assert.ok(!JSON.stringify(host.entries).includes("Create a PR"));
	await host.command("status");
	assert.ok(host.notifications.some((text) => text.includes("1 route nominations")));
});

test("routing ignores non-PR and oversized requests without resolving credentials", async (t) => {
	t.mock.method(globalThis, "fetch", async () => assert.fail("No request expected"));
	const host = harness("tui", "route");
	await host.start();
	assert.equal(await host.route("Explain this implementation"), undefined);
	assert.equal(await host.route(`Create a PR ${"a".repeat(3_000)} and fix authentication`), undefined);
	assert.equal(host.authLookups, 0);
});

test("routing refuses unconfigured and same-as-primary models", async (t) => {
	t.mock.method(globalThis, "fetch", async () => assert.fail("No request expected"));
	const host = harness();
	await host.start();
	await host.command("route missing/model");
	assert.equal(await host.route(), undefined);
	await host.command("route mock/primary");
	assert.equal(await host.route(), undefined);
	assert.equal(host.authLookups, 0);
	assert.ok(host.notifications.some((text) => text.includes("different from the primary")));
});

test("uncertain, abstaining, malformed, or failed routing never nominates a worker", async (t) => {
	for (const result of [
		routingResponse("pr_worker", 0.94),
		routingResponse("none", 1),
		routingResponse("insufficient_context", 1),
		Response.json({ answers: { reminder: { type: "choice", choice: "pr_worker" } }, usage: {} }),
		Response.json({ answers: { reminder: { type: "choice", choice: "run_shell" } } }),
		Response.json({ error: "Synthetic outage" }, { status: 503 }),
	]) {
		const mock = t.mock.method(globalThis, "fetch", async () => result);
		const host = harness("tui", "route");
		await host.start();
		assert.equal(await host.route(), undefined);
		assert.equal(mock.mock.callCount(), 1);
		mock.mock.restore();
	}
});

test("turning routing off aborts classification and suppresses late nominations", async (t) => {
	const started = Promise.withResolvers<AbortSignal>();
	t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
		const signal = init?.signal;
		assert.ok(signal);
		started.resolve(signal);
		return await new Promise<Response>((_resolve, reject) =>
			signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
		);
	});
	const host = harness("tui", "route");
	await host.start();
	const nomination = host.route();
	const signal = await started.promise;
	await host.command("off");
	assert.equal(await nomination, undefined);
	assert.equal(signal.aborted, true);
	assert.equal(host.entries.length, 0);
});

test("non-TUI routing flags never resolve credentials", async (t) => {
	t.mock.method(globalThis, "fetch", async () => assert.fail("No request expected"));
	for (const mode of ["rpc", "json", "print"] as const) {
		const host = harness(mode, "route");
		await host.start();
		await host.command("route mock/worker");
		assert.equal(await host.route(), undefined);
		assert.equal(host.authLookups, 0);
	}
});

test("shutdown aborts pending fetch and prevents late records or model context changes", async (t) => {
	const started = Promise.withResolvers<void>();
	let requestSignal: AbortSignal | null | undefined;
	t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
		requestSignal = init?.signal;
		started.resolve();
		return await new Promise<Response>((_resolve, reject) =>
			requestSignal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
		);
	});
	const host = harness("tui", "advise");
	await host.start();
	const result = host.context(messages);
	await started.promise;
	await host.fire("session_shutdown", { type: "session_shutdown", reason: "reload" });
	assert.equal(await result, undefined);
	assert.equal(requestSignal?.aborted, true);
	assert.equal(host.entries.length, 0);
});

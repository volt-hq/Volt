import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRpcSessionState } from "../../../src/core/rpc/session-state.ts";
import { createHarness, getUserTexts, type Harness, type HarnessOptions } from "../harness.ts";

const harnesses: Harness[] = [];
const releases: Array<() => void> = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}

function usage(input: number) {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

async function setup(options: HarnessOptions = {}) {
	const harness = await createHarness({
		tools: [],
		settings: {
			compaction: { enabled: false },
			retry: { enabled: false },
			lsp: { enabled: false },
		},
		...options,
	});
	harnesses.push(harness);
	await harness.session.setSessionName("Operation timing regression");
	return harness;
}

function observe(harness: Harness) {
	const states: Array<{ type: string; startedAt?: number; isStreaming: boolean; timing?: { startedAt: number } }> = [];
	harness.session.subscribe((event) => {
		if (
			![
				"agent_start",
				"agent_end",
				"agent_settled",
				"compaction_start",
				"compaction_end",
				"auto_retry_start",
			].includes(event.type)
		)
			return;
		const state = buildRpcSessionState(harness.session);
		states.push({
			type: event.type,
			isStreaming: state.isStreaming,
			...(event.type === "agent_start" ? { startedAt: event.startedAt } : {}),
			...(state.activeAgentRun ? { timing: state.activeAgentRun } : {}),
		});
	});
	return states;
}

function expectSettled(harness: Harness) {
	expect(harness.session.activeAgentRun).toBeUndefined();
	expect(harness.session.isStreaming).toBe(false);
	expect(buildRpcSessionState(harness.session).activeAgentRun).toBeUndefined();
}

function expectOneOperation(harness: Harness, states: ReturnType<typeof observe>, runs: number) {
	const starts = harness.eventsOfType("agent_start");
	expect(starts).toHaveLength(runs);
	const timing = { startedAt: starts[0]!.startedAt };
	for (const state of states) {
		if (state.type === "agent_settled") {
			expect(state.timing).toBeUndefined();
			expect(state.isStreaming).toBe(false);
		} else {
			expect(state.timing).toEqual(timing);
			expect(state.isStreaming).toBe(true);
			if (state.type === "agent_start") expect(state.startedAt).toBe(timing.startedAt);
		}
	}
	expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
	expectSettled(harness);
}

const echo: AgentTool = {
	name: "echo",
	label: "Echo",
	description: "Return a small result",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	vi.useRealTimers();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("#421 operation elapsed timing", () => {
	it.each(["overflow", "threshold", "repeated-tools"] as const)(
		"retains timing through %s compaction and resets on new work",
		async (kind) => {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const compacting = deferred();
			const release = deferred();
			const harness = await setup({
				tools: [echo],
				settings: {
					compaction: { enabled: true, keepRecentTokens: 1 },
					retry: { enabled: false },
				},
				extensionFactories: [
					(volt) => {
						volt.on("session_before_compact", async (event) => {
							compacting.resolve();
							await release.promise;
							now += 10_000;
							return {
								compaction: {
									summary: "Continue the task",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			const states = observe(harness);
			expectSettled(harness);
			harness.setResponses([
				() =>
					kind === "overflow"
						? fauxAssistantMessage("", {
								stopReason: "error",
								error: { kind: "context_overflow", retryable: false, message: "prompt is too long" },
							})
						: kind === "threshold"
							? fauxAssistantMessage("", { stopReason: "length", usage: usage(190_000) })
							: fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse", usage: usage(190_000) }),
				...(kind === "repeated-tools"
					? [
							() =>
								fauxAssistantMessage(fauxToolCall("echo", {}), {
									stopReason: "toolUse",
									usage: usage(190_000),
								}),
						]
					: []),
				() => fauxAssistantMessage("finished", { usage: usage(10) }),
			]);
			const prompt = harness.session.prompt("Work through compaction");
			await compacting.promise;
			const original = harness.session.activeAgentRun;
			expect(original).toBeDefined();
			expect(buildRpcSessionState(harness.session)).toMatchObject({
				activeAgentRun: original,
				isStreaming: true,
				isCompacting: true,
			});
			let idleResolved = false;
			const idle = harness.session.waitForIdle().then(() => {
				idleResolved = true;
			});
			await Promise.resolve();
			expect(idleResolved).toBe(false);
			release.resolve();
			await prompt;
			await idle;
			expectOneOperation(harness, states, kind === "repeated-tools" ? 3 : 2);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(kind === "repeated-tools" ? 2 : 1);
			now += 10_000;
			harness.setResponses([fauxAssistantMessage("new operation", { usage: usage(10) })]);
			await harness.session.prompt("New task");
			expect(harness.eventsOfType("agent_start").at(-1)!.startedAt).toBe(now);
			expect(now).toBeGreaterThan(original!.startedAt);
			expectSettled(harness);
		},
	);

	it.each(["success", "exhaustion"] as const)(
		"retains timing through repeated retry backoff until %s",
		async (outcome) => {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const harness = await setup({
				settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			});
			const states = observe(harness);
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") now += 10_000;
			});
			const error = () =>
				fauxAssistantMessage("", {
					stopReason: "error",
					error: { kind: "overloaded", retryable: true, message: "overloaded_error" },
				});
			harness.setResponses([error, error, outcome === "success" ? fauxAssistantMessage("recovered") : error]);
			await harness.session.prompt("Retry this operation");
			expectOneOperation(harness, states, 3);
			expect(harness.eventsOfType("auto_retry_start")).toHaveLength(2);
		},
	);

	it("keeps a queued continuation in the same operation", async () => {
		const harness = await setup();
		const states = observe(harness);
		harness.setResponses([
			async () => {
				// Queued while the turn runs: the turn delivers it before it ends.
				await harness.control.queueFollowUp({ role: "user", content: "Follow up", timestamp: Date.now() });
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		await harness.session.prompt("Begin");
		expect(harness.getPendingResponseCount()).toBe(0);
		expectOneOperation(harness, states, 1);
	});

	it.each(["abort", "dispose"] as const)("clears timing on %s during retry backoff", async (action) => {
		const harness = await setup({
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 60_000 } },
		});
		const retry = deferred();
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retry.resolve();
		});
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "overloaded", retryable: true, message: "overloaded_error" },
			}),
		]);
		const prompt = harness.session.prompt("Start");
		await retry.promise;
		expect(harness.session.activeAgentRun).toBeDefined();
		if (action === "dispose") {
			harness.session.dispose();
			expect(harness.session.activeAgentRun).toBeUndefined();
			expect(harness.session.isStreaming).toBe(false);
			await harness.session.waitForClosed();
		} else {
			await harness.session.abort();
			expectSettled(harness);
		}
		await prompt;
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each(["abort", "fail"] as const)("clears timing when automatic compaction must %s", async (action) => {
		const compacting = deferred();
		const release = deferred();
		const harness = await setup({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 }, retry: { enabled: false } },
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => {
						compacting.resolve();
						event.signal.addEventListener("abort", release.resolve, { once: true });
						await release.promise;
						return { cancel: true };
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "context_overflow", retryable: false, message: "prompt is too long" },
			}),
		]);
		const prompt = harness.session.prompt("Start");
		const result = prompt.then(
			() => undefined,
			(error: unknown) => error,
		);
		await compacting.promise;
		expect(harness.session.activeAgentRun).toBeDefined();
		if (action === "abort") await harness.session.abort();
		else release.resolve();
		const error = await result;
		if (action === "fail") expect(error).toBeInstanceOf(Error);
		expectSettled(harness);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("does not invent timing for failed preflight or standalone manual compaction", async () => {
		const harness = await setup({
			withConfiguredAuth: false,
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		await expect(harness.session.prompt("No credentials")).rejects.toThrow();
		expect(harness.eventsOfType("agent_start")).toEqual([]);
		await harness.session.sessionWriter.appendMessage({ role: "user", content: "old task", timestamp: Date.now() });
		await harness.session.sessionWriter.appendMessage(fauxAssistantMessage("old answer"));
		const states = observe(harness);
		await harness.session.compact();
		for (const state of states) {
			expect(state.timing).toBeUndefined();
			expect(state.isStreaming).toBe(false);
		}
		expectSettled(harness);
	});

	it.each([false, true])(
		"runs pre-prompt recovery inside the prompt's operation (preflight fails=%s)",
		async (failPreflight) => {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const harness = await setup({
				settings: {
					compaction: { enabled: true, keepRecentTokens: 1 },
					retry: { enabled: true, maxRetries: 1, baseDelayMs: 60_000 },
				},
				extensionFactories: [
					(volt) => {
						volt.on("session_before_compact", (event) => ({
							compaction: {
								summary: "summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						}));
					},
				],
			});
			await harness.session.sessionWriter.appendMessage({
				role: "user",
				content: "previous task",
				timestamp: now - 1,
			});
			await harness.session.sessionWriter.appendMessage(
				fauxAssistantMessage("", {
					stopReason: "error",
					error: { kind: "context_overflow", retryable: false, message: "prompt is too long" },
				}),
			);
			const states = observe(harness);
			harness.session.subscribe((event) => {
				if (event.type === "agent_start" || event.type === "compaction_end") now += 10_000;
			});
			if (failPreflight)
				vi.spyOn(harness.session.extensionRunner, "emitBeforeAgentStart").mockRejectedValue(
					new Error("preflight failed"),
				);
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					error: { kind: "overloaded", retryable: true, message: "overloaded_error" },
				}),
				fauxAssistantMessage("new response", { usage: usage(10) }),
			]);
			const error = await harness.session.prompt("new input").then(
				() => undefined,
				(error: unknown) => error,
			);
			await harness.session.waitForIdle();
			if (failPreflight) {
				// Input that fails preflight starts no operation; recovery waits for the next admitted input.
				expect(error).toMatchObject({ message: "preflight failed" });
				expect(harness.eventsOfType("agent_start")).toEqual([]);
				expect(harness.eventsOfType("compaction_start")).toEqual([]);
				expect(harness.getPendingResponseCount()).toBe(2);
				expectSettled(harness);
				return;
			}
			// Recovery compacts and retries the overflowed request once; the pending prompt then runs
			// instead of a backoff retry, all within one operation.
			expect(error).toBeUndefined();
			expect(harness.eventsOfType("compaction_start")).toMatchObject([{ reason: "overflow" }]);
			expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(0);
			expect(getUserTexts(harness)).toContain("new input");
			const starts = harness.eventsOfType("agent_start");
			expect(starts.length).toBeGreaterThan(1);
			expectOneOperation(harness, states, starts.length);
		},
	);
});

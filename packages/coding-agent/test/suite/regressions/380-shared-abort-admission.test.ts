import { setImmediate } from "node:timers/promises";
import { AgentHarnessAdmissionGate, type AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundJobManager } from "../../../src/core/background-jobs.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const message = { customType: "abort-admission", content: "must not start", display: true };
const harnesses: Harness[] = [];
const finishes: Array<() => void> = [];

function tool(harness: Harness, name: string): AgentTool {
	const found = harness.session.state.tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`Missing native ${name} tool`);
	return found;
}

async function setup(options: HarnessOptions = {}) {
	const started = deferred();
	const finish = deferred();
	finishes.push(finish.resolve);
	let signal: AbortSignal | undefined;
	const operations: BashOperations = {
		exec: vi.fn(async (_command, _cwd, options) => {
			signal = options.signal;
			started.resolve();
			await finish.promise;
			if (signal?.aborted) throw new Error("cancelled after cleanup");
			return { exitCode: 0 };
		}),
	};
	// Native entry wrappers and the job manager remain real. No shell or child runtime is started.
	const subagentExecute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "child result" }] }));
	const createDefinitions = nativeTools.createAllToolDefinitions;
	vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) => ({
		...createDefinitions(cwd, { ...options, bash: { ...options?.bash, operations } }),
		subagent: {
			name: "subagent",
			label: "Subagent",
			description: "Controlled native subagent backend",
			parameters: Type.Object({ agent: Type.String(), task: Type.String(), confirm: Type.Optional(Type.String()) }),
			execute: subagentExecute,
		},
	}));
	const harness = await createHarness({
		initialActiveToolNames: ["bash", "subagent", "jobs"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
		...options,
	});
	harnesses.push(harness);
	harness.session.setSessionName("Shared abort admission regression");
	await tool(harness, "bash").execute("original-job", { command: "controlled work", background: true });
	await started.promise;
	if (!signal) throw new Error("Missing background cancellation signal");
	return { harness, finish, signal, operations, subagentExecute };
}

afterEach(async () => {
	for (const finish of finishes.splice(0)) finish();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

const starts: Array<{ name: string; start(harness: Harness, operations: BashOperations): Promise<unknown> }> = [
	{ name: "prompt", start: (harness) => harness.session.prompt("must not start") },
	{
		name: "queued prompt",
		start: (harness) => harness.session.prompt("must not start", { streamingBehavior: "followUp" }),
	},
	{ name: "user message", start: (harness) => harness.session.sendUserMessage("must not start") },
	{ name: "custom message", start: (harness) => harness.session.sendCustomMessage(message, { triggerTurn: true }) },
	{
		name: "replacement-context custom message",
		start: (harness) => harness.session.createReplacedSessionContext().sendMessage(message, { triggerTurn: true }),
	},
	{
		name: "low-level run",
		start: (harness) => harness.control.run({ role: "user", content: "must not start", timestamp: 1 }),
	},
	{ name: "low-level continuation", start: (harness) => harness.control.continue() },
	{ name: "compaction", start: (harness) => harness.session.compact() },
	{ name: "recovered input", start: (harness) => harness.session.resumeRecoveredClientInputs() },
	{
		name: "foreground Bash tool",
		start: (harness) => tool(harness, "bash").execute("denied", { command: "must not start" }),
	},
	{
		name: "background Bash tool",
		start: (harness) => tool(harness, "bash").execute("denied", { command: "must not start", background: true }),
	},
	{
		name: "subagent preflight",
		start: (harness) =>
			tool(harness, "subagent").execute("denied", { agent: "general", task: "must not start", background: true }),
	},
	{
		name: "foreground subagent",
		start: (harness) =>
			tool(harness, "subagent").execute("denied", { agent: "general", task: "must not start", confirm: "token" }),
	},
	{
		name: "background subagent",
		start: (harness) =>
			tool(harness, "subagent").execute("denied", {
				agent: "general",
				task: "must not start",
				confirm: "token",
				background: true,
			}),
	},
	{
		name: "host Bash",
		start: (harness, operations) => harness.session.executeBash("must not start", undefined, { operations }),
	},
];

describe("PR #380: shared session abort admission", () => {
	it.each(starts)("rejects $name in a synchronous cancellation callback and throughout cleanup", async ({ start }) => {
		const { harness, signal, finish, operations, subagentExecute } = await setup();
		const before = harness.session.messages;
		const attempts: Promise<unknown>[] = [];
		let reentrantAbort: Promise<void> | undefined;
		signal.addEventListener(
			"abort",
			() => {
				attempts.push(start(harness, operations));
				void attempts[0].catch(() => undefined);
				reentrantAbort = harness.session.abort("host_action");
			},
			{ once: true },
		);
		let settled = false;
		const abort = harness.session.abort("remote_request");
		const joined = abort.then(() => {
			settled = true;
		});
		try {
			expect(attempts).toHaveLength(1);
			expect(reentrantAbort).toBe(abort);
			expect(harness.session.abort("keyboard_interrupt")).toBe(abort);
			await expect(attempts[0]).rejects.toThrow(/admission|already processing/i);
			await expect(start(harness, operations)).rejects.toThrow(/admission|already processing/i);
			await setImmediate();
			expect(settled).toBe(false);
			expect(harness.session.isBusy).toBe(false);
			expect(harness.session.isStreaming).toBe(false);
			expect(harness.session.messages).toEqual(before);
			expect(harness.eventsOfType("agent_start")).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
			expect(operations.exec).toHaveBeenCalledTimes(1);
			expect(subagentExecute).not.toHaveBeenCalled();
			expect(await tool(harness, "jobs").execute("inspect", { action: "list" })).toMatchObject({
				details: { jobs: [{ status: "cancelling" }] },
			});
		} finally {
			finish.resolve();
			await joined;
		}
		expect(harness.session.hasBackgroundJobs).toBe(false);
		harness.setResponses([fauxAssistantMessage("admission reopened")]);
		await harness.session.sendCustomMessage({ ...message, content: "allowed after abort" }, { triggerTurn: true });
		expect(harness.session.getLastAssistantText()).toBe("admission reopened");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("contains extension sendMessage rejection without starting a turn", async () => {
		let api!: ExtensionAPI;
		const { harness, signal, finish } = await setup({
			extensionFactories: [
				(value) => {
					api = value;
				},
			],
		});
		const reported = vi.fn();
		const unsubscribe = harness.session.extensionRunner.onError(reported);
		signal.addEventListener("abort", () => api.sendMessage(message, { triggerTurn: true }), { once: true });
		const abort = harness.session.abort();
		try {
			await vi.waitFor(() =>
				expect(reported).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "send_message",
						error: "Operation admission is suspended",
					}),
				),
			);
			expect(harness.session.messages).toEqual([]);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			finish.resolve();
			await abort;
			unsubscribe();
		}
	});

	it.each([1, 2])("keeps admission closed through cleanup after %s cancellation failures", async (count) => {
		const { harness, finish } = await setup();
		const first = new Error("retry cancellation failed");
		const second = new Error("compaction cancellation failed");
		vi.spyOn(harness.session, "abortRetry").mockImplementationOnce(() => {
			throw first;
		});
		if (count === 2)
			vi.spyOn(harness.session, "abortCompaction").mockImplementationOnce(() => {
				throw second;
			});
		const abort = harness.session.abort();
		const rejected =
			count === 1
				? expect(abort).rejects.toBe(first)
				: expect(abort).rejects.toMatchObject({ errors: [first, second] });
		try {
			expect(harness.session.abort()).toBe(abort);
			await expect(harness.session.sendCustomMessage(message, { triggerTurn: true })).rejects.toThrow(
				"admission is suspended",
			);
			await expect(tool(harness, "bash").execute("denied", { command: "denied", background: true })).rejects.toThrow(
				"admission is suspended",
			);
			expect(harness.session.hasBackgroundJobs).toBe(true);
		} finally {
			finish.resolve();
			await rejected;
		}
		harness.setResponses([fauxAssistantMessage("recovered after failure")]);
		await harness.session.sendCustomMessage(message, { triggerTurn: true });
		expect(harness.session.getLastAssistantText()).toBe("recovered after failure");
		await harness.session.abort();
	});

	it("does not reopen a disposed session when an overlapping abort finishes", async () => {
		const { harness, finish } = await setup();
		const bash = tool(harness, "bash");
		const abort = harness.session.abort();
		harness.session.dispose();
		const closed = harness.session.waitForClosed();
		finish.resolve();
		await Promise.all([abort, closed]);
		await expect(harness.session.sendCustomMessage(message, { triggerTurn: true })).rejects.toThrow(/disposed/);
		await expect(harness.control.run({ role: "user", content: "denied", timestamp: 1 })).rejects.toThrow(/disposed/);
		await expect(bash.execute("denied", { command: "denied", background: true })).rejects.toThrow(/stale|disposed/);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("preserves queues and non-triggering messages while abort drains", async () => {
		const { harness, finish } = await setup();
		await harness.session.steer("retained steering");
		await harness.session.followUp("retained follow-up");
		const abort = harness.session.abort();
		try {
			await harness.session.sendCustomMessage({ ...message, content: "cleanup note" });
			await harness.session.sendCustomMessage(
				{ ...message, content: "next-turn context" },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			expect(harness.session.pendingMessageCount).toBe(2);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			finish.resolve();
			await abort;
		}
		const received: string[] = [];
		harness.setResponses(
			Array.from({ length: 3 }, () => (context) => {
				received.push(...context.messages.map(getMessageText));
				return fauxAssistantMessage("resumed");
			}),
		);
		await harness.session.prompt("resume retained work");
		expect(received).toEqual(
			expect.arrayContaining(["cleanup note", "next-turn context", "retained steering", "retained follow-up"]),
		);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it.each(["input", "before_agent_start"] as const)(
		"does not revive %s preflight after abort finishes",
		async (boundary) => {
			const reached = deferred();
			const release = deferred();
			finishes.push(release.resolve);
			let hold = true;
			const harness = await createHarness({
				settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
				extensionFactories: [
					(api) => {
						const preflight = async () => {
							if (!hold) return;
							reached.resolve();
							await release.promise;
						};
						if (boundary === "input") api.on("input", preflight);
						else api.on("before_agent_start", preflight);
					},
				],
			});
			harnesses.push(harness);
			harness.session.setSessionName("Preflight gate regression");
			const prompt = harness.session.prompt("old preflight");
			const rejected = expect(prompt).rejects.toThrow(/aborted/);
			await reached.promise;
			await harness.session.abort();
			hold = false;
			release.resolve();
			await rejected;
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.session.messages).toEqual([]);
			harness.setResponses([fauxAssistantMessage("new generation")]);
			await harness.session.prompt("fresh prompt");
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	it("cancels a pending compaction successor without invoking its hooks or provider", async () => {
		const reached = deferred();
		const release = deferred();
		finishes.push(release.resolve);
		const compacted = vi.fn();
		const harness = await createHarness({
			settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [
				(api) => {
					api.on("session_before_compact", compacted);
				},
			],
		});
		harnesses.push(harness);
		harness.session.setSessionName("Successor gate regression");
		harness.setResponses([
			async () => {
				reached.resolve();
				await release.promise;
				return fauxAssistantMessage("aborted turn");
			},
		]);
		const prompt = harness.session.prompt("active work");
		await reached.promise;
		const compaction = harness.session.compact();
		const rejected = expect(compaction).rejects.toThrow(/reservation was cancelled/);
		const abort = harness.session.abort();
		release.resolve();
		await Promise.all([prompt, abort, rejected]);
		expect(compacted).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.isBusy).toBe(false);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		harness.setResponses([fauxAssistantMessage("successor cancelled cleanly")]);
		await harness.session.prompt("fresh work");
		expect(harness.faux.state.callCount).toBe(2);
	});
});

describe("shared admission at background manager dispatch", () => {
	it.each(["bash", "subagent"] as const)(
		"rejects new %s jobs and invalidates pre-dispatch work across reopening",
		async (toolName) => {
			const gate = new AgentHarnessAdmissionGate();
			const manager = new BackgroundJobManager({
				admissionGate: gate,
				isToolAllowed: () => true,
				getGeneration: () => 0,
			});
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }] }));
			const work = { toolName, toolCallId: "test", label: "test", execute };
			const old = manager.start(work);
			const release = gate.suspend();
			try {
				expect(() => manager.start(work)).toThrow("admission is suspended");
				expect(manager.list()).toHaveLength(1);
				expect(manager.get(old.id).status).toBe("running");
			} finally {
				release();
			}
			await manager.waitForIdle();
			expect(manager.get(old.id).status).toBe("cancelled");
			expect(execute).not.toHaveBeenCalled();
			const next = manager.start(work);
			await manager.waitForIdle();
			expect(manager.get(next.id).status).toBe("completed");
			expect(execute).toHaveBeenCalledTimes(1);
			await manager.close();
		},
	);
});

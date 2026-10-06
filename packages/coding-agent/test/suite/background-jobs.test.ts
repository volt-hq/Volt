/**
 * Background jobs (RFC §7.2 `job` work): native bash and subagent calls with
 * `background: true` run as work items of the conversation. A completed or
 * failed job queues a notice that wakes an idle conversation, unless a
 * `jobs wait` returned its result, a `jobs read` took it first, or the turn
 * that started it stopped on a final response, a policy, or a tool. Jobs run
 * under their tool grant, block structural changes while they run, and are
 * cancelled by an abort and interrupted when the session closes.
 */

import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { WORK_NOTICE_CUSTOM_TYPE } from "@hansjm10/volt-protocol";
import { setKeybindings, TuiMainScreen } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { ExtensionAPI, ToolResultEvent } from "../../src/core/extensions/index.ts";
import type { ConversationHost } from "../../src/core/host/conversation-host.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { type IntentContext, intentRegistry, LOCAL_INTENT_PROFILE } from "../../src/core/protocol/intents/index.ts";
import { stopThemeWatcher } from "../../src/core/theme/runtime.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import * as nativeTools from "../../src/core/tools/index.ts";
import { type JobSnapshot, type JobSummary, jobOfDetails } from "../../src/core/tools/jobs.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { TuiHost } from "../../src/modes/interactive/host/tui-host.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createFakeConversation } from "../utilities/fake-conversation-host.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Replace only the shell backend; definitions, grants, wrappers, and policies stay native. */
function controlledBash(holdAbortCleanup = false, exitCode = 0) {
	const started = deferred();
	const aborted = deferred();
	const finish = deferred();
	let signal: AbortSignal | undefined;
	const commands: string[] = [];
	const operations: BashOperations = {
		exec: vi.fn(async (command, _cwd, options) => {
			commands.push(command);
			signal = options.signal;
			const onAbort = () => {
				aborted.resolve();
				if (!holdAbortCleanup) finish.resolve();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			options.onData(Buffer.from("worker output: untrusted payload\n"));
			started.resolve();
			try {
				await finish.promise;
				if (signal?.aborted) throw new Error("aborted");
				return { exitCode };
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		}),
	};
	const createDefinitions = nativeTools.createAllToolDefinitions;
	vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
		createDefinitions(cwd, { ...options, bash: { ...options?.bash, operations } }),
	);
	return {
		started,
		aborted,
		finish,
		operations,
		commands,
		get signal() {
			return signal;
		},
	};
}

function jobOf(result: unknown): JobSummary {
	const job = jobOfDetails((result as { details?: unknown } | undefined)?.details);
	if (!job) throw new Error(`Expected a background job result: ${JSON.stringify(result)}`);
	return job;
}

function jobsTool(harness: Harness): AgentTool {
	const tool = harness.session.state.tools.find((tool) => tool.name === "jobs");
	if (!tool) throw new Error("Expected native jobs tool");
	return tool;
}

function notices(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === WORK_NOTICE_CUSTOM_TYPE,
	);
}

/** Host inputs the conversation queued for finished work, by state. */
function noticeInputs(harness: Harness) {
	return [...harness.session.sessionManager.getConversationState().clientInputs.inputs.values()].filter(
		(input) => input.origin === "host",
	);
}

async function startJob(harness: Harness, command = "controlled work"): Promise<JobSummary> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command, background: true }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Parent can continue independently."),
	]);
	await harness.session.prompt("Start independent work");
	const result = harness.session.messages
		.reverse()
		.find((message) => message.role === "toolResult" && message.toolName === "bash");
	return jobOf(result);
}

/** The job once every executor stopped: its result is recorded by then. */
async function settled(harness: Harness, id: string): Promise<JobSnapshot> {
	await harness.session.work.waitForIdle();
	return harness.session.jobs.get(id);
}

describe("AgentSession background jobs", () => {
	const harnesses: Harness[] = [];
	const modes: InteractiveMode[] = [];

	function setupInteractive(harness: Harness) {
		vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.tempDir);
		// The TUI shows the harness session; nothing here connects it to a host, so its in-process intents act
		// as a client of its own.
		const tuiHost = TuiHost.start({
			host: {} as ConversationHost,
			conversation: createFakeConversation(harness.session).conversation,
		});
		vi.spyOn(tuiHost, "hostClient", "get").mockReturnValue({
			id: "tui",
			move: { kind: "in_place", onMoved: () => {} },
		});
		const mode = new InteractiveMode(tuiHost);
		modes.push(mode);
		const control = mode as unknown as {
			renderer: TuiMainScreen;
			defaultEditor: CustomEditor;
			isInitialized: boolean;
			setupKeyHandlers(): void;
			setupEditorSubmitHandler(): void;
			shutdown(): Promise<void>;
			showWarning(message: string): void;
			showError(message: string): void;
			showStatus(message: string): void;
		};
		control.renderer = new TuiMainScreen(new VirtualTerminal(120, 36), false, harness.tempDir);
		control.setupKeyHandlers();
		control.setupEditorSubmitHandler();
		control.renderer.addChild(control.defaultEditor);
		control.renderer.setFocus(control.defaultEditor);
		control.renderer.start();
		control.isInitialized = true;
		vi.spyOn(control, "shutdown").mockResolvedValue();
		vi.spyOn(control, "showWarning");
		vi.spyOn(control, "showError");
		vi.spyOn(control, "showStatus");
		return control;
	}

	async function setup(options: HarnessOptions = {}) {
		const harness = await createHarness({
			initialActiveToolNames: ["bash", "jobs"],
			settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
			...options,
		});
		await harness.session.setSessionName("Background jobs test");
		harnesses.push(harness);
		return harness;
	}

	afterEach(async () => {
		while (modes.length) modes.pop()!.stop("resume-hint");
		stopThemeWatcher();
		while (harnesses.length) await harnesses.pop()!.cleanupAsync();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		setKeybindings(new KeybindingsManager());
	});

	it("lets the parent finish while Bash lives, then wakes the idle conversation with a notice", async () => {
		const backend = controlledBash();
		const harness = await setup();
		expect(harness.session.work.busy()).toBe(false);
		const job = await startJob(harness);
		await backend.started.promise;
		expect(job).toMatchObject({ tool: "bash", status: "running", label: "controlled work" });
		expect(harness.session.isBusy).toBe(false);
		await harness.session.waitForIdle();
		expect(harness.session.work.busy()).toBe(true);
		expect(harness.session.getLastAssistantText()).toBe("Parent can continue independently.");
		expect(backend.signal?.aborted).toBe(false);
		expect(harness.session.work.get(job.id)).toMatchObject({ kind: "job", toolCallId: job.toolCallId });

		harness.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).toContain(`(job ${job.id}) completed.`);
				return fauxAssistantMessage(fauxToolCall("jobs", { action: "read", id: job.id }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const result = context.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "jobs",
				);
				expect(getMessageText(result)).toContain("worker output");
				return fauxAssistantMessage("Collected the result.");
			},
		]);
		backend.finish.resolve();
		await vi.waitFor(() => expect(harness.session.getLastAssistantText()).toBe("Collected the result."));
		await harness.session.waitForIdle();
		expect(harness.session.work.busy()).toBe(false);
		expect(harness.session.jobs.get(job.id)).toMatchObject({ status: "completed" });
		expect(notices(harness)).toHaveLength(1);
		expect(notices(harness)[0]).toMatchObject({ details: { workId: job.id, kind: "job", outcome: "completed" } });
		expect(JSON.stringify(notices(harness)[0])).not.toContain("untrusted payload");
		harness.setResponses([fauxAssistantMessage("Still done.")]);
		await harness.session.prompt("Anything else?");
		expect(notices(harness)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(5);
	});

	it("returns a job that finishes into an active jobs wait without queueing a notice", async () => {
		const backend = controlledBash();
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
				stopReason: "toolUse",
			}),
			async () => {
				const job = jobOf(
					harness.session.messages.find((message) => message.role === "toolResult" && message.toolName === "bash"),
				);
				return fauxAssistantMessage(fauxToolCall("jobs", { action: "wait", ids: [job.id] }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const result = context.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "jobs",
				);
				expect(getMessageText(result)).toContain("terminal");
				expect(getMessageText(result)).toContain("worker output");
				return fauxAssistantMessage("Waited for the result.");
			},
		]);
		const prompt = harness.session.prompt("Run and wait");
		await backend.started.promise;
		await vi.waitFor(() => expect(harness.session.jobs.listWaits()).toHaveLength(1));
		backend.finish.resolve();
		await prompt;
		await harness.session.waitForIdle();
		expect(harness.session.getLastAssistantText()).toBe("Waited for the result.");
		expect(notices(harness)).toHaveLength(0);
		expect(noticeInputs(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(3);
	});

	it("withdraws a queued notice when the model reads the finished job first", async () => {
		const backend = controlledBash();
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
				stopReason: "toolUse",
			}),
			async () => {
				const job = jobOf(
					harness.session.messages.find((message) => message.role === "toolResult" && message.toolName === "bash"),
				);
				backend.finish.resolve();
				await settled(harness, job.id);
				// The notice waits for this turn's next request.
				expect(noticeInputs(harness)).toMatchObject([{ state: "accepted" }]);
				return fauxAssistantMessage(fauxToolCall("jobs", { action: "read", id: job.id }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).not.toContain("(job ");
				return fauxAssistantMessage("Read it.");
			},
		]);
		await harness.session.prompt("Run and read");
		expect(harness.session.getLastAssistantText()).toBe("Read it.");
		expect(notices(harness)).toHaveLength(0);
		expect(noticeInputs(harness)).toMatchObject([{ state: "withdrawn" }]);
	});

	it("delivers a notice at the next provider boundary, never during the current response", async () => {
		const backend = controlledBash();
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
				stopReason: "toolUse",
			}),
			async () => {
				const job = jobOf(
					harness.session.messages.find((message) => message.role === "toolResult" && message.toolName === "bash"),
				);
				backend.finish.resolve();
				await settled(harness, job.id);
				expect(notices(harness)).toHaveLength(0);
				return fauxAssistantMessage(fauxToolCall("jobs", { action: "list" }), { stopReason: "toolUse" });
			},
			(context) => {
				expect(notices(harness)).toHaveLength(1);
				expect(context.messages.map(getMessageText).join("\n")).toContain("(job ");
				return fauxAssistantMessage("Noticed.");
			},
		]);
		await harness.session.prompt("Run independent work");
		const messages = harness.session.messages;
		const noticeIndex = messages.findIndex((message) => message.role === "custom");
		expect(messages[noticeIndex - 1]).toMatchObject({ role: "toolResult", toolName: "jobs" });
	});

	it("ends a wait for user steering, but not for another job's notice", async () => {
		const backend = controlledBash();
		const other = deferred();
		const harness = await setup();
		const first = await startJob(harness, "first work");
		const exec = backend.operations.exec as ReturnType<typeof vi.fn>;
		const original = exec.getMockImplementation()!;
		exec.mockImplementationOnce(async (_command, _cwd, options) => {
			options.onData(Buffer.from("other output\n"));
			await other.promise;
			return { exitCode: 0 };
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "second work", background: true }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Started the second."),
		]);
		await harness.session.prompt("Start more work");
		const second = harness.session.jobs.list().find((job) => job.label === "second work")!;
		expect(second.status).toBe("running");
		exec.mockImplementation(original);

		const waited = vi.fn();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("jobs", { action: "wait", ids: [first.id] }), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.findLast(
					(message) => message.role === "toolResult" && message.toolName === "jobs",
				);
				waited(getMessageText(result));
				return fauxAssistantMessage("Handled the steering.");
			},
		]);
		const prompt = harness.session.prompt("Wait for the first job");
		await vi.waitFor(() => expect(harness.session.jobs.listWaits()).toHaveLength(1));
		// Another job's notice queues as host steering; the wait goes on.
		other.resolve();
		await vi.waitFor(() => expect(noticeInputs(harness)).toMatchObject([{ state: "accepted" }]));
		expect(harness.session.jobs.listWaits()).toHaveLength(1);
		await harness.session.steer("Stop waiting and look at this");
		await prompt;
		await harness.session.waitForIdle();
		expect(waited).toHaveBeenCalledWith(expect.stringContaining("steered"));
		expect(harness.session.jobs.get(first.id).status).toBe("running");
		backend.finish.resolve();
		harness.appendResponses([fauxAssistantMessage("First done.")]);
		await settled(harness, first.id);
		await harness.session.waitForIdle();
		expect(harness.session.jobs.get(first.id).status).toBe("completed");
	});

	it.each(["final_response", "stop"] as const)(
		"fences the notices of the work a turn started when a tool result asks to %s",
		async (disposition) => {
			const backend = controlledBash();
			const harness = await setup();
			const unregister = harness.control.onToolResult((event) =>
				event.toolName === "bash" ? { disposition } : undefined,
			);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Final report."),
			]);
			await harness.session.prompt("Run and report");
			unregister();
			const job = harness.session.jobs.list()[0]!;
			const calls = harness.faux.state.callCount;
			backend.finish.resolve();
			expect((await settled(harness, job.id)).status).toBe("completed");
			await harness.session.waitForIdle();
			expect(harness.faux.state.callCount).toBe(calls);
			expect(noticeInputs(harness)).toEqual([]);
			harness.setResponses([fauxAssistantMessage("Next user turn.")]);
			await harness.session.prompt("Continue");
			expect(notices(harness)).toHaveLength(0);
		},
	);

	it("fences the notices of the work a turn started when a policy stops it", async () => {
		const backend = controlledBash();
		const harness = await setup();
		let stop = false;
		const unregister = harness.session.registerTurnPolicy({
			nextAction: () => (stop ? { type: "stop" } : undefined),
		});
		harness.setResponses([
			async () => {
				stop = true;
				return fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
					stopReason: "toolUse",
				});
			},
		]);
		await harness.session.prompt("Start, then stop");
		unregister();
		const job = harness.session.jobs.list()[0]!;
		backend.finish.resolve();
		expect((await settled(harness, job.id)).status).toBe("completed");
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(1);
		expect(noticeInputs(harness)).toEqual([]);
	});

	it("offers a non-cancelling SDK join separate from foreground idle", async () => {
		const backend = controlledBash();
		const harness = await setup();
		await startJob(harness);
		const joined = vi.fn();
		const joining = harness.session.work.waitForIdle().then(joined);
		try {
			await harness.session.waitForIdle();
			expect(joined).not.toHaveBeenCalled();
			expect(harness.session.work.busy()).toBe(true);
			expect(backend.signal?.aborted).toBe(false);
		} finally {
			harness.appendResponses([fauxAssistantMessage("Noticed.")]);
			backend.finish.resolve();
		}
		await joining;
		expect(harness.session.work.busy()).toBe(false);
	});

	it("runs native result hooks once at completion, preserves call policy, and supplies the job signal", async () => {
		const backend = controlledBash();
		const results: ToolResultEvent[] = [];
		const calls: unknown[] = [];
		let resultSignal: AbortSignal | undefined;
		const harness = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("tool_call", (event) => {
						if (event.toolName === "bash") calls.push(event.input);
					});
					volt.on("tool_result", (event, ctx) => {
						if (event.toolName !== "bash") return;
						results.push(event);
						resultSignal = ctx.signal;
						return { content: [{ type: "text", text: "policy-redacted output" }] };
					});
				},
			],
		});
		const job = await startJob(harness);
		expect(results).toHaveLength(0);
		expect(calls).toEqual([{ command: "controlled work", background: true }]);
		expect(backend.commands).toEqual(["controlled work"]);
		harness.appendResponses([fauxAssistantMessage("Noticed.")]);
		backend.finish.resolve();
		expect((await settled(harness, job.id)).output).toBe("policy-redacted output");
		expect(harness.session.work.get(job.id)?.result?.output?.text).toBe("policy-redacted output");
		expect(results).toHaveLength(1);
		expect(results[0]?.input).toEqual({ command: "controlled work" });
		expect(resultSignal).toBeDefined();
		expect(resultSignal?.aborted).toBe(false);
		expect(results[0]?.content.map((part) => (part.type === "text" ? part.text : "")).join("")).toContain(
			"worker output",
		);
		await harness.session.waitForIdle();
	});

	it("rejects noncanonical completion-hook output instead of retaining it", async () => {
		const backend = controlledBash();
		const harness = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("tool_result", (event) => {
						if (event.toolName === "bash") return { details: { invalid: Number.NaN } };
					});
				},
			],
		});
		const job = await startJob(harness);
		harness.appendResponses([fauxAssistantMessage("Noticed the failure.")]);
		backend.finish.resolve();
		const result = await settled(harness, job.id);
		expect(result.status).toBe("failed");
		expect(result.output).toMatch(/finite|NaN|canonical/i);
		await harness.session.waitForIdle();
	});

	it("aborting cancels running jobs, joins their cleanup, and runs no late result hooks", async () => {
		const backend = controlledBash(true);
		const completed = vi.fn();
		const harness = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("tool_result", (event) => {
						if (event.toolName === "bash") completed();
					});
				},
			],
		});
		const job = await startJob(harness);
		let aborted = false;
		const abort = harness.session.abort().then(() => {
			aborted = true;
		});
		try {
			await backend.aborted.promise;
			expect(aborted).toBe(false);
			expect(harness.session.work.busy()).toBe(true);
			expect(jobOf(await jobsTool(harness).execute("read-cancelling", { action: "read", id: job.id })).status).toBe(
				"cancelling",
			);
		} finally {
			backend.finish.resolve();
		}
		await abort;
		expect(harness.session.work.busy()).toBe(false);
		expect(harness.session.jobs.get(job.id).status).toBe("cancelled");
		expect(completed).not.toHaveBeenCalled();
		expect(noticeInputs(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it.each(["background", "foreground"] as const)(
		"fences native starts before %s abort listeners and shares the reentrant drain",
		async (source) => {
			const backend = controlledBash(true);
			const harness = await setup();
			const job = await startJob(harness);
			await backend.started.promise;
			const bash = harness.session.state.tools.find((tool) => tool.name === "bash")!;
			const foregroundStarted = deferred();
			const finishForeground = deferred();
			let foreground: Promise<void> | undefined;
			if (source === "foreground") {
				harness.setResponses([
					async () => {
						foregroundStarted.resolve();
						await finishForeground.promise;
						return fauxAssistantMessage("Interrupted foreground response.");
					},
				]);
				foreground = harness.session.prompt("Start a foreground turn");
				await foregroundStarted.promise;
			}
			const signal = source === "foreground" ? harness.session.signal : backend.signal;
			if (!signal) throw new Error("Expected a live cancellation signal");
			let attemptedStart: ReturnType<AgentTool["execute"]> | undefined;
			let reentrantAbort: Promise<void> | undefined;
			const listener = vi.fn(() => {
				attemptedStart = bash.execute("reentrant-start", { command: "must not run", background: true });
				void attemptedStart.catch(() => undefined);
				reentrantAbort = harness.session.abort("host_action");
			});
			signal.addEventListener("abort", listener, { once: true });
			const settledAbort = vi.fn();
			const abort = harness.session.abort("remote_request");
			const joined = abort.then(settledAbort);
			try {
				await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
				expect(reentrantAbort).toBe(abort);
				expect(harness.session.abort("keyboard_interrupt")).toBe(abort);
				await vi.waitFor(() => expect(backend.signal?.aborted).toBe(true));
				await expect(attemptedStart).rejects.toThrow("Operation admission is suspended");
				expect(settledAbort).not.toHaveBeenCalled();
				expect(harness.session.work.busy()).toBe(true);
				expect(await jobsTool(harness).execute("list-during-abort", { action: "list" })).toMatchObject({
					details: { jobs: [{ id: job.id, status: "cancelling" }] },
				});
			} finally {
				backend.finish.resolve();
				finishForeground.resolve();
				await Promise.all([joined, reentrantAbort, foreground]);
			}
			expect(harness.session.work.busy()).toBe(false);
			expect(harness.session.jobs.get(job.id).status).toBe("cancelled");
			expect(backend.operations.exec).toHaveBeenCalledTimes(1);
			if (source === "foreground") {
				const last = harness.session.messages.at(-1);
				expect(last).toMatchObject({
					role: "assistant",
					diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "remote_request" } })],
				});
			}
			// The drain releases admission rather than permanently closing the runtime.
			const next = jobOf(await bash.execute("after-abort", { command: "later work", background: true }));
			harness.appendResponses([fauxAssistantMessage("Noticed.")]);
			expect((await settled(harness, next.id)).status).toBe("completed");
			await harness.session.waitForIdle();
		},
	);

	it("keeps abort fenced through cleanup when a cancellation participant throws", async () => {
		const backend = controlledBash(true);
		const harness = await setup();
		const job = await startJob(harness);
		const failure = new Error("retry cancellation failed");
		const retry = vi.spyOn(harness.session, "abortRetry").mockImplementationOnce(() => {
			throw failure;
		});
		const bash = harness.session.state.tools.find((tool) => tool.name === "bash")!;
		const abort = harness.session.abort();
		const rejected = expect(abort).rejects.toBe(failure);
		try {
			await vi.waitFor(() => expect(backend.signal?.aborted).toBe(true));
			expect(harness.session.abort()).toBe(abort);
			await expect(bash.execute("during-error", { command: "must not run", background: true })).rejects.toThrow(
				"Operation admission is suspended",
			);
		} finally {
			backend.finish.resolve();
			await rejected;
			retry.mockRestore();
		}
		expect((await settled(harness, job.id)).status).toBe("cancelled");
		await expect(harness.session.abort()).resolves.toBeUndefined();
		const next = jobOf(await bash.execute("after-error", { command: "later work", background: true }));
		harness.appendResponses([fauxAssistantMessage("Noticed.")]);
		expect((await settled(harness, next.id)).status).toBe("completed");
		await harness.session.waitForIdle();
	});

	it("interrupts running jobs when the session closes and waits for their cleanup", async () => {
		const backend = controlledBash(true);
		const harness = await setup();
		const job = await startJob(harness);
		const bash = harness.session.state.tools.find((tool) => tool.name === "bash")!;
		let closed = false;
		harness.session.dispose();
		const closing = harness.session.waitForClosed().then(() => {
			closed = true;
		});
		try {
			expect(backend.signal?.aborted).toBe(true);
			await backend.aborted.promise;
			expect(closed).toBe(false);
			await expect(bash.execute("stale", { command: "must not run", background: true })).rejects.toThrow(
				/stale|disposed/i,
			);
		} finally {
			backend.finish.resolve();
		}
		await closing;
		expect(backend.operations.exec).toHaveBeenCalledTimes(1);
		const finished = harness.sessionManager.committedEntriesAfter(0).find((entry) => entry.type === "work_finished");
		expect(finished).toMatchObject({ workId: job.id, outcome: "interrupted" });
		harnesses.splice(harnesses.indexOf(harness), 1);
	});

	it.each(["bash", "jobs"])("cancels jobs when the %s grant is removed", async (revoked) => {
		const backend = controlledBash();
		const harness = await setup();
		const job = await startJob(harness);
		harness.session.setActiveToolsByName(["bash", "jobs"].filter((name) => name !== revoked));
		await vi.waitFor(() => expect(backend.signal?.aborted).toBe(true));
		expect((await settled(harness, job.id)).status).toBe("cancelled");
		harness.session.setActiveToolsByName(["bash", "jobs"]);
		expect(await jobsTool(harness).execute("list", { action: "list" })).toMatchObject({
			details: { jobs: [{ id: job.id, status: "cancelled" }] },
		});
		expect(noticeInputs(harness)).toEqual([]);
	});

	it("cancels native work when an extension replaces its active tool name", async () => {
		const backend = controlledBash();
		let api!: ExtensionAPI;
		const harness = await setup({
			extensionFactories: [
				(volt) => {
					api = volt;
				},
			],
		});
		const job = await startJob(harness);
		api.registerTool({
			name: "bash",
			label: "replacement",
			description: "replacement",
			parameters: Type.Object({ command: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "custom result" }] }),
		});
		expect(harness.session.getActiveToolNames()).toContain("bash");
		await vi.waitFor(() => expect(backend.signal?.aborted).toBe(true));
		expect((await settled(harness, job.id)).status).toBe("cancelled");
	});

	it("blocks reload, tree navigation, and Plan entry until jobs settle", async () => {
		controlledBash();
		const harness = await setup();
		await startJob(harness);
		const target = harness.session.getUserMessagesForForking()[0]!.entryId;
		await expect(harness.session.reload()).rejects.toThrow(/abort or wait/);
		await expect(harness.session.navigateTree(target)).rejects.toThrow(/abort or wait/);
		await expect(harness.session.setAgentMode("plan")).rejects.toThrow(/abort or wait/);
		expect(harness.session.agentMode).toBe("build");
		await harness.session.abort();
		await expect(harness.session.setAgentMode("plan")).resolves.toMatchObject({ mode: "plan" });
		await expect(harness.session.navigateTree(target)).resolves.toMatchObject({ cancelled: false });
		await expect(harness.session.reload()).resolves.toBeUndefined();
	});

	it("keeps a finished job's result readable after branch navigation", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const job = await startJob(harness);
		harness.appendResponses([fauxAssistantMessage("Noticed.")]);
		backend.finish.resolve();
		await settled(harness, job.id);
		await harness.session.waitForIdle();
		const target = harness.session.getUserMessagesForForking()[0]!.entryId;
		await harness.session.navigateTree(target);
		const read = await jobsTool(harness).execute("read", { action: "read", id: job.id });
		expect(jobOf(read).status).toBe("completed");
		expect(getMessageText(read)).toContain("worker output");
	});

	it("keeps running jobs accessible across compaction", async () => {
		const backend = controlledBash();
		const harness = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", (event) => ({
						compaction: {
							summary: "The parent started independent work.",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		const job = await startJob(harness);
		const generation = harness.session.conversationGenerationRevision;
		await harness.session.compact();
		expect(harness.session.conversationGenerationRevision).toBe(generation);
		expect(backend.signal?.aborted).toBe(false);
		expect(jobOf(await jobsTool(harness).execute("read", { action: "read", id: job.id })).status).toBe("running");
		harness.appendResponses([fauxAssistantMessage("Noticed.")]);
		backend.finish.resolve();
		expect((await settled(harness, job.id)).status).toBe("completed");
		await harness.session.waitForIdle();
	});

	it("does not wrap extension or host Bash overrides", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "custom foreground result" }] }));
		const definition = {
			name: "bash",
			label: "custom bash",
			description: "custom execution",
			parameters: Type.Object({ command: Type.String(), background: Type.Optional(Type.Boolean()) }),
			execute,
		};
		const extensionHarness = await setup({
			extensionFactories: [
				(volt) => {
					volt.registerTool(definition);
				},
			],
		});
		const hostHarness = await setup({ tools: [definition] });
		for (const harness of [extensionHarness, hostHarness]) {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "custom", background: true }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Done."),
			]);
			await harness.session.prompt("Run host override");
			expect(harness.session.messages.find((message) => message.role === "toolResult")).toMatchObject({
				content: [{ type: "text", text: "custom foreground result" }],
			});
			expect(notices(harness)).toHaveLength(0);
		}
		expect(execute).toHaveBeenCalledTimes(2);
		expect(await jobsTool(extensionHarness).execute("list", { action: "list" })).toMatchObject({
			details: { jobs: [] },
		});
	});

	it("does not admit background work without jobs or after a tool-call policy block", async () => {
		const backend = controlledBash();
		const harness = await setup({ allowedToolNames: ["bash"] });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Cannot start."),
		]);
		await harness.session.prompt("Start work");
		expect(getMessageText(harness.session.messages.find((message) => message.role === "toolResult"))).toContain(
			"both bash and jobs",
		);
		const blocked = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("tool_call", () => ({ block: true, reason: "Host policy denied this call" }));
				},
			],
		});
		blocked.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Denied."),
		]);
		await blocked.session.prompt("Start work");
		expect(backend.operations.exec).not.toHaveBeenCalled();
		expect(harness.session.work.list()).toEqual([]);
	});

	it("keeps Ctrl+C as editor clearing while an idle background job runs", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const control = setupInteractive(harness);
		await startJob(harness);
		control.defaultEditor.setText("unsent draft");

		control.defaultEditor.handleInput("\x03");

		expect(control.defaultEditor.getText()).toBe("");
		expect(backend.signal?.aborted).toBe(false);
		expect(harness.session.work.busy()).toBe(true);
	});

	it("refuses Plan mode while a background job runs, without stopping the job", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const job = await startJob(harness);
		const planning = harness.session.planningState;
		const abort = vi.spyOn(harness.session, "abort");
		// What `/plan` sends: the conversation's set_agent_mode intent, as a local client.
		const { conversation } = createFakeConversation(harness.session);
		const context: IntentContext = {
			target: {
				session: harness.session,
				conversation,
				host: {} as ConversationHost,
				client: { id: "tui", move: { kind: "in_place", onMoved: () => {} } },
			},
			services: {},
			profile: LOCAL_INTENT_PROFILE,
		};

		await expect(intentRegistry.invoke(context, "set_agent_mode", { mode: "plan" })).rejects.toThrow(/abort or wait/);
		expect(abort).not.toHaveBeenCalled();
		expect(harness.session.planningState).toEqual(planning);
		expect(harness.session.agentMode).toBe("build");
		expect(harness.session.isBusy).toBe(false);
		expect(harness.session.work.busy()).toBe(true);
		expect(backend.signal?.aborted).toBe(false);
		harness.appendResponses([fauxAssistantMessage("Noticed.")]);
		backend.finish.resolve();
		expect((await settled(harness, job.id)).status).toBe("completed");
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(3);

		await intentRegistry.invoke(context, "set_agent_mode", { mode: "plan" });
		expect(harness.session.agentMode).toBe("plan");
	});
});

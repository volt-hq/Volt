import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { setKeybindings, TuiMainScreen } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import {
	BACKGROUND_JOB_NOTIFICATION_TYPE,
	BackgroundJobManager,
	type BackgroundJobSnapshot,
} from "../../src/core/background-jobs.ts";
import type { ExtensionAPI, ToolResultEvent } from "../../src/core/extensions/index.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { stopThemeWatcher } from "../../src/core/theme/runtime.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import * as nativeTools from "../../src/core/tools/index.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Replace only the shell backend; definitions, grants, wrappers, and policies stay native. */
function controlledBash(holdAbortCleanup = false) {
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
				return { exitCode: 0 };
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

function jobSnapshot(result: unknown): BackgroundJobSnapshot {
	const snapshot = (result as { details?: { backgroundJob?: BackgroundJobSnapshot } }).details?.backgroundJob;
	if (!snapshot) throw new Error(`Expected background job result: ${JSON.stringify(result)}`);
	return snapshot;
}

function jobsTool(harness: Harness): AgentTool {
	const tool = harness.session.state.tools.find((tool) => tool.name === "jobs");
	if (!tool) throw new Error("Expected native jobs tool");
	return tool;
}

function notices(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === BACKGROUND_JOB_NOTIFICATION_TYPE,
	);
}

async function startJob(harness: Harness): Promise<BackgroundJobSnapshot> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("Parent can continue independently."),
	]);
	await harness.session.prompt("Start independent work");
	const result = harness.session.messages.find(
		(message) => message.role === "toolResult" && message.toolName === "bash",
	);
	return jobSnapshot(result);
}

async function waitJob(harness: Harness, id: string): Promise<BackgroundJobSnapshot> {
	return jobSnapshot(await jobsTool(harness).execute("host-wait", { action: "wait", id, timeoutMs: 30_000 }));
}

describe("AgentSession background jobs", () => {
	const harnesses: Harness[] = [];
	const modes: InteractiveMode[] = [];

	function setupInteractive(harness: Harness) {
		vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.tempDir);
		const mode = new InteractiveMode({
			session: harness.session,
			setBeforeSessionInvalidate: () => undefined,
			setRebindSession: () => undefined,
		} as unknown as AgentSessionRuntime);
		modes.push(mode);
		const control = mode as unknown as {
			renderer: TuiMainScreen;
			defaultEditor: CustomEditor;
			isInitialized: boolean;
			setupKeyHandlers(): void;
			setupEditorSubmitHandler(): void;
			subscribeToAgent(session: Harness["session"]): void;
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
		control.subscribeToAgent(harness.session);
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
		harness.session.setSessionName("Background jobs test");
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

	it("lets the parent finish while Bash lives, retrieves completion, and does not start idle inference", async () => {
		const backend = controlledBash();
		const harness = await setup();
		expect(harness.session.hasBackgroundJobs).toBe(false);
		const job = await startJob(harness);
		await backend.started.promise;
		expect(job.status).toBe("running");
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isBusy).toBe(false);
		await harness.session.waitForIdle();
		expect(harness.session.hasBackgroundJobs).toBe(true);
		expect(harness.session.getLastAssistantText()).toBe("Parent can continue independently.");
		expect(backend.signal?.aborted).toBe(false);
		backend.finish.resolve();
		const completed = await waitJob(harness, job.id);
		expect(completed.status).toBe("completed");
		expect(harness.session.hasBackgroundJobs).toBe(false);
		expect(completed.output).toContain("worker output");
		expect(harness.faux.state.callCount).toBe(2);
		expect(notices(harness)).toHaveLength(0);

		harness.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText).join("\n")).toContain(`${job.id}: completed (bash)`);
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
		await harness.session.prompt("Collect the result");
		expect(notices(harness)).toHaveLength(1);
		const { output: _output, outputTruncated: _truncated, lastOutputAt: _lastOutputAt, ...summary } = completed;
		expect(notices(harness)[0]).toMatchObject({ details: { jobIds: [job.id], jobs: [summary] } });
		expect(JSON.stringify(notices(harness)[0])).not.toContain("untrusted payload");
		harness.setResponses([fauxAssistantMessage("Still done.")]);
		await harness.session.prompt("Anything else?");
		expect(notices(harness)).toHaveLength(1);
	});

	it("offers a non-cancelling SDK join separate from foreground idle", async () => {
		const backend = controlledBash();
		const harness = await setup();
		await startJob(harness);
		const settled = vi.fn();
		const joining = harness.session.waitForBackgroundJobs().then(settled);
		try {
			await harness.session.waitForIdle();
			expect(settled).not.toHaveBeenCalled();
			expect(harness.session.hasBackgroundJobs).toBe(true);
			expect(backend.signal?.aborted).toBe(false);
		} finally {
			backend.finish.resolve();
		}
		await joining;
		expect(harness.session.hasBackgroundJobs).toBe(false);
	});

	it.each(["", "unsubmitted draft", "!keep this command draft"])(
		"cancels an idle background job through onEscape and preserves queues and draft %j",
		async (draft) => {
			const backend = controlledBash();
			const harness = await setup();
			const control = setupInteractive(harness);
			const job = await startJob(harness);
			await harness.session.steer("queued steering");
			await harness.session.followUp("queued follow-up");
			control.defaultEditor.setText(draft);
			const abort = vi.spyOn(harness.session, "abort");

			control.defaultEditor.onEscape!();

			await vi.waitFor(() => expect(abort).toHaveBeenCalledExactlyOnceWith("keyboard_interrupt"));
			expect((await waitJob(harness, job.id)).status).toBe("cancelled");
			expect(backend.signal?.aborted).toBe(true);
			expect(harness.session.hasBackgroundJobs).toBe(false);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(control.defaultEditor.getText()).toBe(
				["queued steering", "queued follow-up", draft].filter(Boolean).join("\n\n"),
			);
			expect(harness.faux.state.callCount).toBe(2);
		},
	);

	it("keeps Ctrl+C as editor clearing while an idle background job runs", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const control = setupInteractive(harness);
		await startJob(harness);
		control.defaultEditor.setText("unsent draft");

		control.defaultEditor.handleInput("\x03");

		expect(control.defaultEditor.getText()).toBe("");
		expect(backend.signal?.aborted).toBe(false);
		expect(harness.session.hasBackgroundJobs).toBe(true);
	});

	it.each(["onSubmit", "Enter"])("handles rejected /plan through %s without stopping jobs", async (entryPoint) => {
		const backend = controlledBash();
		const harness = await setup();
		const control = setupInteractive(harness);
		const job = await startJob(harness);
		const planning = harness.session.planningState;
		const abort = vi.spyOn(harness.session, "abort");

		if (entryPoint === "onSubmit") {
			await expect(control.defaultEditor.onSubmit!("/plan")).resolves.toBeUndefined();
		} else {
			const terminal = control.renderer.terminal as VirtualTerminal;
			terminal.sendInput("/plan");
			terminal.sendInput("\r");
		}

		await vi.waitFor(() =>
			expect(control.showError).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/abort or wait/)),
		);
		expect(control.showStatus).not.toHaveBeenCalled();
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(harness.session.planningState).toEqual(planning);
		expect(harness.session.agentMode).toBe("build");
		expect(harness.session.isBusy).toBe(false);
		expect(harness.session.hasBackgroundJobs).toBe(true);
		expect(backend.signal?.aborted).toBe(false);
		expect(control.defaultEditor.getText()).toBe("");
		backend.finish.resolve();
		expect((await waitJob(harness, job.id)).status).toBe("completed");
		expect(harness.faux.state.callCount).toBe(2);

		await expect(control.defaultEditor.onSubmit!("/plan")).resolves.toBeUndefined();
		expect(harness.session.agentMode).toBe("plan");
		expect(control.showStatus).toHaveBeenLastCalledWith("Plan mode: agent tools are read-only");
		await expect(control.defaultEditor.onSubmit!("/build")).resolves.toBeUndefined();
		expect(harness.session.agentMode).toBe("build");
		expect(control.showStatus).toHaveBeenLastCalledWith("Build mode");
		expect(control.showError).toHaveBeenCalledTimes(1);
	});

	it.each(["/quit", "Ctrl+D"])("requires confirmation for %s after the foreground finishes", async (entryPoint) => {
		const backend = controlledBash();
		const harness = await setup();
		const control = setupInteractive(harness);
		const terminal = control.renderer.terminal as VirtualTerminal;
		await startJob(harness);
		const abort = vi.spyOn(harness.session, "abort");
		const dispose = vi.spyOn(harness.session, "dispose");
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const quit = () => {
			if (entryPoint === "/quit") {
				terminal.sendInput("/quit");
				terminal.sendInput("\r");
			} else {
				terminal.sendInput("\x04");
			}
		};

		expect(harness.session.isBusy).toBe(false);
		quit();
		expect(control.showWarning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Work is active"));
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(dispose).not.toHaveBeenCalled();
		expect(backend.signal?.aborted).toBe(false);
		expect(harness.session.hasBackgroundJobs).toBe(true);

		now += 2999;
		quit();
		expect(control.shutdown).toHaveBeenCalledTimes(1);
		expect(control.showWarning).toHaveBeenCalledTimes(1);
		expect(control.showError).not.toHaveBeenCalled();
	});

	it("protects cancelling background work until cleanup settles", async () => {
		const backend = controlledBash(true);
		const harness = await setup();
		const control = setupInteractive(harness);
		const terminal = control.renderer.terminal as VirtualTerminal;
		const job = await startJob(harness);
		const abort = vi.spyOn(harness.session, "abort");
		const dispose = vi.spyOn(harness.session, "dispose");
		try {
			expect(
				jobSnapshot(await jobsTool(harness).execute("cancel-job", { action: "cancel", id: job.id })).status,
			).toBe("cancelling");
			expect(harness.session.isBusy).toBe(false);
			expect(harness.session.hasBackgroundJobs).toBe(true);
			terminal.sendInput("\x04");
			expect(control.showWarning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Work is active"));
			expect(control.shutdown).not.toHaveBeenCalled();
			expect(abort).not.toHaveBeenCalled();
			expect(dispose).not.toHaveBeenCalled();

			await control.defaultEditor.onSubmit!("/quit");
			expect(control.shutdown).toHaveBeenCalledTimes(1);
		} finally {
			backend.finish.resolve();
		}
		expect((await waitJob(harness, job.id)).status).toBe("cancelled");
	});

	it("expires a background-work quit warning at three seconds", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const control = setupInteractive(harness);
		await startJob(harness);
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await control.defaultEditor.onSubmit!("/quit");
		now += 3000;
		await control.defaultEditor.onSubmit!("/quit");
		expect(control.showWarning).toHaveBeenCalledTimes(2);
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(backend.signal?.aborted).toBe(false);
		expect(harness.session.hasBackgroundJobs).toBe(true);

		now += 1;
		await control.defaultEditor.onSubmit!("/quit");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not reuse a background-work quit warning after new foreground work", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const control = setupInteractive(harness);
		const terminal = control.renderer.terminal as VirtualTerminal;
		await startJob(harness);
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		terminal.sendInput("\x04");
		expect(control.showWarning).toHaveBeenCalledTimes(1);

		harness.setResponses([fauxAssistantMessage("Foreground work completed.")]);
		await harness.session.prompt("Continue foreground work");
		expect(harness.session.isBusy).toBe(false);
		expect(harness.session.hasBackgroundJobs).toBe(true);
		expect(backend.signal?.aborted).toBe(false);

		terminal.sendInput("\x04");
		expect(control.showWarning).toHaveBeenCalledTimes(2);
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(backend.signal?.aborted).toBe(false);
		terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("interrupts foreground Bash before idle background jobs", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const control = setupInteractive(harness);
		const job = await startJob(harness);
		const shellStarted = deferred();
		const shellFinished = deferred();
		const shell = harness.session.executeBash("foreground command", undefined, {
			operations: {
				exec: async (_command, _cwd, { signal }) => {
					signal?.addEventListener("abort", shellFinished.resolve, { once: true });
					shellStarted.resolve();
					await shellFinished.promise;
					return { exitCode: 0 };
				},
			},
		});
		try {
			await shellStarted.promise;
			control.defaultEditor.onEscape!();
			await shell;
			expect(harness.session.isBashRunning).toBe(false);
			expect(backend.signal?.aborted).toBe(false);
			expect(harness.session.hasBackgroundJobs).toBe(true);

			control.defaultEditor.onEscape!();
			await vi.waitFor(() => expect(backend.signal?.aborted).toBe(true));
			expect((await waitJob(harness, job.id)).status).toBe("cancelled");
		} finally {
			shellFinished.resolve();
			await shell;
		}
	});

	it("delivers completion at the next provider boundary, never during the current response", async () => {
		const backend = controlledBash();
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
				stopReason: "toolUse",
			}),
			async () => {
				const result = harness.session.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "bash",
				);
				const job = jobSnapshot(result);
				backend.finish.resolve();
				await waitJob(harness, job.id);
				expect(notices(harness)).toHaveLength(0);
				return fauxAssistantMessage(fauxToolCall("jobs", { action: "read", id: job.id }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(notices(harness)).toHaveLength(1);
				expect(context.messages.map(getMessageText).join("\n")).toContain("Background job completion notice");
				return fauxAssistantMessage("Collected.");
			},
		]);
		await harness.session.prompt("Run independent work");
		const messages = harness.session.messages;
		const noticeIndex = messages.findIndex((message) => message.role === "custom");
		expect(messages[noticeIndex - 1]).toMatchObject({ role: "toolResult", toolName: "jobs" });
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
		backend.finish.resolve();
		expect((await waitJob(harness, job.id)).output).toBe("policy-redacted output");
		expect(results).toHaveLength(1);
		expect(results[0]?.input).toEqual({ command: "controlled work" });
		expect(resultSignal).toBeDefined();
		expect(resultSignal?.aborted).toBe(false);
		expect(results[0]?.content.map((part) => (part.type === "text" ? part.text : "")).join("")).toContain(
			"worker output",
		);
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
		backend.finish.resolve();
		const result = await waitJob(harness, job.id);
		expect(result.status).toBe("failed");
		expect(result.output).toMatch(/finite|NaN|canonical/i);
	});

	it("synchronously aborts idle jobs and joins their cleanup without invoking late result hooks", async () => {
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
		let settled = false;
		const abort = harness.session.abort().then(() => {
			settled = true;
		});
		try {
			expect(backend.signal?.aborted).toBe(true);
			await backend.aborted.promise;
			expect(settled).toBe(false);
			expect(harness.session.hasBackgroundJobs).toBe(true);
			expect(
				jobSnapshot(await jobsTool(harness).execute("read-cancelling", { action: "read", id: job.id })).status,
			).toBe("cancelling");
		} finally {
			backend.finish.resolve();
		}
		await abort;
		expect(harness.session.hasBackgroundJobs).toBe(false);
		expect((await waitJob(harness, job.id)).status).toBe("cancelled");
		expect(completed).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(2);
	});

	it.each(["background", "foreground"] as const)(
		"fences native starts before %s abort listeners and shares the reentrant drain",
		async (source) => {
			const backend = controlledBash(true);
			const harness = await setup();
			const job = await startJob(harness);
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
			const settled = vi.fn();
			const abort = harness.session.abort("remote_request");
			const joined = abort.then(settled);
			try {
				expect(listener).toHaveBeenCalledTimes(1);
				expect(reentrantAbort).toBe(abort);
				expect(harness.session.abort("keyboard_interrupt")).toBe(abort);
				expect(backend.signal?.aborted).toBe(true);
				await expect(attemptedStart).rejects.toThrow(/during a session mutation or abort/);
				expect(settled).not.toHaveBeenCalled();
				expect(harness.session.hasBackgroundJobs).toBe(true);
				expect(await jobsTool(harness).execute("list-during-abort", { action: "list" })).toMatchObject({
					details: { jobs: [{ id: job.id, status: "cancelling" }] },
				});
			} finally {
				backend.finish.resolve();
				finishForeground.resolve();
				await Promise.all([joined, reentrantAbort, foreground]);
			}
			expect(harness.session.hasBackgroundJobs).toBe(false);
			expect((await waitJob(harness, job.id)).status).toBe("cancelled");
			expect(backend.operations.exec).toHaveBeenCalledTimes(1);
			if (source === "foreground") {
				const last = harness.session.messages.at(-1);
				expect(last).toMatchObject({
					role: "assistant",
					diagnostics: [expect.objectContaining({ type: "runtime_abort", details: { source: "remote_request" } })],
				});
			}
			// The drain releases admission rather than permanently closing the runtime.
			const next = jobSnapshot(await bash.execute("after-abort", { command: "later work", background: true }));
			expect((await waitJob(harness, next.id)).status).toBe("completed");
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
			expect(backend.signal?.aborted).toBe(true);
			expect(harness.session.abort()).toBe(abort);
			await expect(bash.execute("during-error", { command: "must not run", background: true })).rejects.toThrow(
				/during a session mutation or abort/,
			);
		} finally {
			backend.finish.resolve();
			await rejected;
			retry.mockRestore();
		}
		expect((await waitJob(harness, job.id)).status).toBe("cancelled");
		await expect(harness.session.abort()).resolves.toBeUndefined();
		const next = jobSnapshot(await bash.execute("after-error", { command: "later work", background: true }));
		expect((await waitJob(harness, next.id)).status).toBe("completed");
	});

	it("synchronously closes jobs on dispose and waits for background cleanup", async () => {
		const backend = controlledBash(true);
		const harness = await setup();
		await startJob(harness);
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
	});

	it.each(["bash", "jobs"])("cancels jobs synchronously when the %s grant is removed", async (revoked) => {
		const backend = controlledBash();
		const harness = await setup();
		const job = await startJob(harness);
		const controls = jobsTool(harness);
		harness.session.setActiveToolsByName(["bash", "jobs"].filter((name) => name !== revoked));
		expect(backend.signal?.aborted).toBe(true);
		expect(await controls.execute("list-hidden", { action: "list" })).toMatchObject({ details: { jobs: [] } });
		await expect(controls.execute("read-hidden", { action: "read", id: job.id })).rejects.toThrow(/inaccessible/);
		await harness.session.abort();
		harness.session.setActiveToolsByName(["bash", "jobs"]);
		expect((await waitJob(harness, job.id)).status).toBe("cancelled");
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
		await startJob(harness);
		api.registerTool({
			name: "bash",
			label: "replacement",
			description: "replacement",
			parameters: Type.Object({ command: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "custom result" }] }),
		});
		expect(harness.session.getActiveToolNames()).toContain("bash");
		expect(backend.signal?.aborted).toBe(true);
		expect(await jobsTool(harness).execute("list", { action: "list" })).toMatchObject({ details: { jobs: [] } });
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

	it("hides older jobs and undelivered notices after branch navigation", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const job = await startJob(harness);
		backend.finish.resolve();
		await waitJob(harness, job.id);
		const target = harness.session.getUserMessagesForForking()[0]!.entryId;
		await harness.session.navigateTree(target);
		expect(await jobsTool(harness).execute("list", { action: "list" })).toMatchObject({ details: { jobs: [] } });
		await expect(jobsTool(harness).execute("read", { action: "read", id: job.id })).rejects.toThrow(/inaccessible/);
		harness.setResponses([fauxAssistantMessage("New branch.")]);
		await harness.session.prompt("Start a different branch");
		expect(notices(harness)).toHaveLength(0);
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
		expect(jobSnapshot(await jobsTool(harness).execute("read", { action: "read", id: job.id })).status).toBe(
			"running",
		);
		backend.finish.resolve();
		expect((await waitJob(harness, job.id)).status).toBe("completed");
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
	});

	it("acknowledges notifications only after the canonical delivery durability barrier", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const job = await startJob(harness);
		backend.finish.resolve();
		await waitJob(harness, job.id);
		const acknowledge = vi.spyOn(BackgroundJobManager.prototype, "acknowledgeNotifications");
		const durabilityReached = deferred();
		const releaseDurability = deferred();
		const flush = harness.sessionManager.flush.bind(harness.sessionManager);
		const flushSpy = vi.spyOn(harness.sessionManager, "flush").mockImplementation(async () => {
			if (notices(harness).length > 0) {
				durabilityReached.resolve();
				await releaseDurability.promise;
			}
			await flush();
		});
		harness.setResponses([fauxAssistantMessage("Notice received.")]);
		const prompt = harness.session.prompt("Collect the completion");
		try {
			await durabilityReached.promise;
			expect(acknowledge).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(2);
		} finally {
			releaseDurability.resolve();
			await prompt.finally(() => flushSpy.mockRestore());
		}
		expect(acknowledge).toHaveBeenCalledExactlyOnceWith([job.id]);
	});

	it("defers notices across forced final_response without authorizing another tool turn", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const unregister = harness.control.onToolResult((event) =>
			event.toolName === "jobs" ? { disposition: "final_response" } : undefined,
		);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "controlled work", background: true }), {
				stopReason: "toolUse",
			}),
			async () => {
				const result = harness.session.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "bash",
				);
				const job = jobSnapshot(result);
				backend.finish.resolve();
				await waitJob(harness, job.id);
				return fauxAssistantMessage(fauxToolCall("jobs", { action: "read", id: job.id }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				expect(context.tools ?? []).toHaveLength(0);
				expect(notices(harness)).toHaveLength(0);
				return fauxAssistantMessage("Final report.");
			},
		]);
		await harness.session.prompt("Run and report");
		expect(harness.faux.state.callCount).toBe(3);
		expect(notices(harness)).toHaveLength(0);
		unregister();
		harness.setResponses([fauxAssistantMessage("Next user turn.")]);
		await harness.session.prompt("Continue");
		expect(notices(harness)).toHaveLength(1);
	});

	it("retains notices when a later stop policy suppresses delivery", async () => {
		const backend = controlledBash();
		const harness = await setup();
		const job = await startJob(harness);
		backend.finish.resolve();
		await waitJob(harness, job.id);
		const unregister = harness.session.registerTurnPolicy({ nextAction: () => ({ type: "stop" }) });
		await harness.session.prompt("Do not infer");
		expect(harness.faux.state.callCount).toBe(2);
		expect(notices(harness)).toHaveLength(0);
		unregister();
		harness.setResponses([fauxAssistantMessage("Now collect.")]);
		await harness.control.continue();
		expect(notices(harness)).toHaveLength(1);
	});
});

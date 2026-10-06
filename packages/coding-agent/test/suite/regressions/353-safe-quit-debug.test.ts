import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Text, type TUI } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../../src/core/slash-commands.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { createTuiHarness, type TuiHarness, type TuiModeFixture } from "../tui-harness.ts";

interface ModeControl {
	ui: TUI;
	defaultEditor: CustomEditor;
	keybindings: KeybindingsManager;
	handleDebugCommand(): Promise<void>;
	switchTuiMode(mode: "regular" | "fullscreen"): boolean;
	shutdown(): Promise<void>;
	showWarning(message: string): void;
	showError(message: string): void;
	showSessionSelector(): void;
	handleHotkeysCommand(): void;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * The TUI asks before it quits while work runs, as its store shows the
 * conversation's phase and work, and captures diagnostics without stopping
 * the work.
 */
describe("regression #353: active quit protection and safe diagnostics", () => {
	let harness: TuiHarness;
	let tui: TuiModeFixture;
	let session: AgentSession;
	let control: ModeControl;
	let terminal: VirtualTerminal;
	let pending: Promise<void> | undefined;
	let finish: (() => void) | undefined;
	let toolEntered: ReturnType<typeof deferred>;
	let toolCompleted: ReturnType<typeof deferred>;
	let runExtensionCommand: () => Promise<void>;

	beforeEach(async () => {
		toolEntered = deferred();
		toolCompleted = deferred();
		runExtensionCommand = async () => undefined;
		harness = await createTuiHarness({
			globalSettings: { theme: "dark", quietStartup: true, lsp: { enabled: false }, retry: { enabled: false } },
			extension: (volt) => {
				volt.registerTool({
					name: "hold",
					label: "Hold",
					description: "Wait for this offline test",
					parameters: Type.Object({}),
					execute: async () => {
						toolEntered.resolve();
						await toolCompleted.promise;
						return { content: [{ type: "text", text: "Done" }], details: {} };
					},
				});
				volt.registerCommand("offline-hold", {
					description: "Wait for this offline test",
					handler: () => runExtensionCommand(),
				});
			},
		});
		tui = await harness.startMode({ columns: 120, rows: 36 });
		session = harness.startup.session;
		control = tui.mode as unknown as ModeControl;
		terminal = tui.terminal;
		vi.spyOn(control, "shutdown").mockResolvedValue();
		vi.spyOn(control, "showWarning");
		vi.spyOn(control, "showError");
		// The capture is the host's debug report (tui-commands.test.ts): here, what runs it.
		vi.spyOn(control, "handleDebugCommand").mockResolvedValue();
	});

	afterEach(async () => {
		finish?.();
		await pending;
		pending = undefined;
		finish = undefined;
		await harness.cleanup();
		vi.restoreAllMocks();
	});

	/** The store shows the conversation busy, or idle. */
	async function storeBusy(busy: boolean): Promise<void> {
		await vi.waitFor(() => expect(tui.store.phase?.busy === true).toBe(busy));
	}

	async function startGeneration(): Promise<void> {
		const entered = deferred();
		const completed = deferred();
		finish = completed.resolve;
		harness.faux.setResponses([
			async () => {
				entered.resolve();
				await completed.promise;
				return fauxAssistantMessage("Completed safely");
			},
		]);
		pending = session.prompt("Continue working");
		await entered.promise;
		expect(session.isBusy).toBe(true);
		await storeBusy(true);
	}

	/** Phones the daemon relays into the conversation, as its live `presence` shows them. */
	async function attachPhones(count: number): Promise<void> {
		harness.startup.liveState.set("presence", { kind: "presence", remote: count });
		await vi.waitFor(() => expect(tui.store.value("presence")).toMatchObject({ remote: count }));
	}

	it.each([0, 1])("exits idle on raw Ctrl+D with %i attached phones", async (phoneCount) => {
		await attachPhones(phoneCount);
		terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
		expect(control.showWarning).not.toHaveBeenCalled();
	});

	it.each([0, 1])("requires a second Ctrl+D during generation with %i attached phones", async (phoneCount) => {
		await attachPhones(phoneCount);
		await startGeneration();
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).toHaveBeenCalledWith(expect.stringContaining("Work is active"));
		expect(session.isBusy).toBe(true);
		terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("protects actual tool execution after model generation has completed", async () => {
		finish = toolCompleted.resolve;
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Completed safely"),
		]);
		pending = session.prompt("Use the offline tool");
		await toolEntered.promise;
		expect(session.messages.some((message) => message.role === "assistant")).toBe(true);
		await storeBusy(true);
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("keeps Ctrl+D as forward delete in a nonempty editor", async () => {
		await startGeneration();
		control.defaultEditor.setText("draft");
		terminal.sendInput("\x01");
		terminal.sendInput("\x04");
		expect(control.defaultEditor.getText()).toBe("raft");
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).not.toHaveBeenCalled();
	});

	it.each(["draft", "/other", "/quit"])(
		"clears a new %s draft after a quit warning without exiting",
		async (draft) => {
			await startGeneration();
			terminal.sendInput("\x04");
			terminal.sendInput(draft);
			terminal.sendInput("\x03");
			expect(control.shutdown).not.toHaveBeenCalled();
			expect(control.defaultEditor.getText()).toBe("");
			terminal.sendInput("\x04");
			expect(control.shutdown).not.toHaveBeenCalled();
			expect(control.showWarning).toHaveBeenCalledTimes(2);
		},
	);

	it.each(["draft", "/quit"])("disarms quit confirmation when a %s draft is typed and then deleted", async (draft) => {
		await startGeneration();
		terminal.sendInput("\x04");
		terminal.sendInput(draft);
		for (const _character of draft) terminal.sendInput("\x7f");
		expect(control.defaultEditor.getText()).toBe("");
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).toHaveBeenCalledTimes(2);
	});

	it("withdraws quit intent when the entire /quit draft is deleted with Ctrl+U", async () => {
		await startGeneration();
		terminal.sendInput("\x04");
		terminal.sendInput("/quit");
		terminal.sendInput("\x15");
		expect(control.defaultEditor.getText()).toBe("");
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).toHaveBeenCalledTimes(2);
	});

	it("protects a standalone shell command when no model response is streaming", async () => {
		const entered = deferred();
		const completed = deferred();
		finish = completed.resolve;
		pending = session
			.executeBash("offline operation", undefined, {
				operations: {
					exec: async () => {
						entered.resolve();
						await completed.promise;
						return { exitCode: 0 };
					},
				},
			})
			.then(() => undefined);
		await entered.promise;
		expect(session.isStreaming).toBe(false);
		expect(session.isBusy).toBe(true);
		await storeBusy(true);
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it.each(["bash", "extension command", "reload", "failed reload"])(
		"does not reuse a quit warning across standalone %s operations",
		async (kind) => {
			let operationNumber = 0;
			async function startOperation(): Promise<void> {
				const currentKind = operationNumber++ > 0 && kind === "failed reload" ? "bash" : kind;
				const entered = deferred();
				const completed = deferred();
				finish = completed.resolve;
				const hold = async () => {
					entered.resolve();
					await completed.promise;
				};
				let operation: Promise<unknown>;
				if (currentKind === "bash") {
					operation = session.executeBash("offline", undefined, {
						operations: {
							exec: async () => {
								await hold();
								return { exitCode: 0 };
							},
						},
					});
				} else if (currentKind === "extension command") {
					runExtensionCommand = hold;
					operation = session.prompt("/offline-hold");
				} else {
					vi.spyOn(session.resourceLoader, "reload").mockImplementationOnce(async () => {
						await hold();
						if (currentKind === "failed reload") throw new Error("offline reload failure");
					});
					operation = session.reload();
				}
				pending =
					currentKind === "failed reload"
						? expect(operation).rejects.toThrow("offline reload failure")
						: operation.then(() => undefined);
				await entered.promise;
				expect(session.isBusy).toBe(true);
				await storeBusy(true);
			}
			await startOperation();
			terminal.sendInput("\x04");
			expect(control.showWarning).toHaveBeenCalledTimes(1);
			finish?.();
			await pending;
			expect(session.isBusy).toBe(false);
			await storeBusy(false);
			await startOperation();
			terminal.sendInput("\x04");
			expect(control.shutdown).not.toHaveBeenCalled();
			expect(control.showWarning).toHaveBeenCalledTimes(2);
			terminal.sendInput("\x04");
			expect(control.shutdown).toHaveBeenCalledTimes(1);
		},
	);

	it("requires active-work confirmation after double Ctrl+C and allows time to read it", async () => {
		await startGeneration();
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		terminal.sendInput("\x03");
		now += 100;
		terminal.sendInput("\x03");
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).toHaveBeenCalledTimes(1);
		now += 1500;
		terminal.sendInput("\x03");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("preserves ordinary idle double Ctrl+C exit", () => {
		terminal.sendInput("\x03");
		expect(control.shutdown).not.toHaveBeenCalled();
		terminal.sendInput("\x03");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("expires confirmation at three seconds", async () => {
		await startGeneration();
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		terminal.sendInput("\x04");
		now += 3000;
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).toHaveBeenCalledTimes(2);
		now += 100;
		terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not reuse confirmation for a new generation", async () => {
		await startGeneration();
		terminal.sendInput("\x04");
		finish?.();
		await pending;
		await storeBusy(false);
		await startGeneration();
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).toHaveBeenCalledTimes(2);
	});

	it("does not treat encoded key repeats or releases as deliberate quit presses", async () => {
		await startGeneration();
		terminal.sendInput("\x1b[100;5u");
		terminal.sendInput("\x1b[100;5:2u");
		terminal.sendInput("\x1b[100;5:3u");
		terminal.sendInput("\x1b[99;5:2u");
		expect(control.shutdown).not.toHaveBeenCalled();
		terminal.sendInput("\x1b[100;5u");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])("does not bind encoded Ctrl+Shift+D by default (active=%s)", async (active) => {
		if (active) await startGeneration();
		terminal.sendInput("\x1b[100;6u");
		terminal.sendInput("\x1b[27;6;100~");
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.handleDebugCommand).not.toHaveBeenCalled();
		expect(control.defaultEditor.getText()).toBe("");
	});

	it("captures diagnostics with F12 and /debug without stopping or queueing a turn", async () => {
		await startGeneration();
		terminal.sendInput("\x04");
		control.defaultEditor.setText("draft");
		terminal.sendInput("\x1b[24~");
		expect(control.handleDebugCommand).toHaveBeenCalledTimes(1);
		expect(control.defaultEditor.getText()).toBe("draft");
		await control.defaultEditor.onSubmit?.("/debug");
		expect(control.handleDebugCommand).toHaveBeenCalledTimes(2);
		expect(session.pendingMessageCount).toBe(0);
		expect(session.isBusy).toBe(true);
		expect(control.shutdown).not.toHaveBeenCalled();
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		finish?.();
		await pending;
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("honors rebinding and disabling debug globally with overlay focus", async () => {
		await startGeneration();
		const overlay = new Text("An overlay", 0, 0);
		control.ui.showOverlay(overlay);
		control.keybindings.setUserBindings({ "app.debug": "ctrl+shift+d" });
		terminal.sendInput("\x1b[24~");
		expect(control.handleDebugCommand).not.toHaveBeenCalled();
		terminal.sendInput("\x1b[100;6u");
		expect(control.handleDebugCommand).toHaveBeenCalledTimes(1);
		expect(control.ui.getFocusedComponent()).toBe(overlay);
		expect(control.shutdown).not.toHaveBeenCalled();
		control.keybindings.setUserBindings({ "app.debug": [] });
		terminal.sendInput("\x1b[24~");
		terminal.sendInput("\x1b[100;6u");
		expect(control.handleDebugCommand).toHaveBeenCalledTimes(1);
	});

	it("keeps debug global after renderer changes and ignores repeat/release events", async () => {
		control.switchTuiMode("fullscreen");
		control.switchTuiMode("regular");
		terminal.sendInput("\x1b[24;1:2~");
		terminal.sendInput("\x1b[24;1:3~");
		expect(control.handleDebugCommand).not.toHaveBeenCalled();
		terminal.sendInput("\x1b[24~");
		expect(control.handleDebugCommand).toHaveBeenCalledTimes(1);
		expect(control.shutdown).not.toHaveBeenCalled();
	});

	it("guards /quit through the same active-work confirmation", async () => {
		await startGeneration();
		await control.defaultEditor.onSubmit?.("/quit");
		expect(control.shutdown).not.toHaveBeenCalled();
		await control.defaultEditor.onSubmit?.("/quit");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("allows deliberately typing and submitting /quit twice to confirm", async () => {
		await startGeneration();
		terminal.sendInput("/quit");
		terminal.sendInput("\r");
		expect(control.showWarning).toHaveBeenCalledTimes(1);
		expect(control.shutdown).not.toHaveBeenCalled();
		terminal.sendInput("/quit");
		terminal.sendInput("\r");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it.each(["enter", "tab"])("confirms repeated /quit through %s autocomplete", async (completion) => {
		await startGeneration();
		for (let attempt = 0; attempt < 2; attempt++) {
			terminal.sendInput("/q");
			await vi.waitFor(() => expect(control.defaultEditor.isShowingAutocomplete()).toBe(true));
			if (completion === "tab") terminal.sendInput("\t");
			terminal.sendInput("\r");
		}
		expect(control.shutdown).toHaveBeenCalledTimes(1);
		expect(control.showWarning).toHaveBeenCalledTimes(1);
	});

	it("confirms a completed /quit using a customized submit binding", async () => {
		await startGeneration();
		control.keybindings.setUserBindings({ "tui.input.submit": "f10" });
		for (let attempt = 0; attempt < 2; attempt++) {
			terminal.sendInput("/q");
			await vi.waitFor(() => expect(control.defaultEditor.isShowingAutocomplete()).toBe(true));
			terminal.sendInput("\t");
			terminal.sendInput("\x1b[21~");
		}
		expect(control.shutdown).toHaveBeenCalledTimes(1);
		expect(control.showWarning).toHaveBeenCalledTimes(1);
	});

	it.each(["\x03", "\x15", "\x7f"])("disarms a completed /quit when cleared or edited with %j", async (key) => {
		await startGeneration();
		terminal.sendInput("\x04");
		terminal.sendInput("/q");
		await vi.waitFor(() => expect(control.defaultEditor.isShowingAutocomplete()).toBe(true));
		terminal.sendInput("\t");
		terminal.sendInput(key);
		if (key === "\x7f") {
			// Removing even completion whitespace withdraws the prior intent.
			terminal.sendInput(" ");
			terminal.sendInput("\r");
		} else {
			expect(control.defaultEditor.getText()).toBe("");
			terminal.sendInput("\x04");
		}
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).toHaveBeenCalledTimes(2);
	});

	it("guards the session selector quit callback and restores the conversation to show its warning", async () => {
		await startGeneration();
		control.showSessionSelector();
		const selector = control.ui.getFocusedComponent() as unknown as { sessionList: { onExit(): void } };
		selector.sessionList.onExit();
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).toHaveBeenCalledTimes(1);
		expect(control.ui.getFocusedComponent()).toBe(control.defaultEditor);
		terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("lists /debug in command completion and the configurable shortcut in /hotkeys", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "debug")?.description).toContain(
			"without interrupting",
		);
		control.keybindings.setUserBindings({ "app.debug": "f10" });
		control.handleHotkeysCommand();
		terminal.sendInput("\x1b[6~");
		terminal.sendInput("\x1b[6~");
		const output = control.ui.render(120).lines.join("\n");
		expect(output).toContain("F10 / /debug");
		expect(output).toContain("Capture diagnostics");
	});
});

/**
 * Work that runs in the background, after the foreground settled, is active
 * work too: the TUI's store shows it from the live `work` value its executor
 * holds, until the work's cleanup settles.
 */
describe("regression #353: quit protection for background work", () => {
	let harness: TuiHarness;
	let tui: TuiModeFixture;
	let control: ModeControl;
	let release: (() => void) | undefined;
	let holdCleanup = false;

	beforeEach(async () => {
		release = undefined;
		holdCleanup = false;
		harness = await createTuiHarness({
			globalSettings: { theme: "dark", quietStartup: true, lsp: { enabled: false }, retry: { enabled: false } },
			responses: ["Foreground work completed."],
			extension: (volt) => {
				volt.registerWorkKind("job");
				volt.registerCommand("start-job", {
					description: "Start a job that runs until it is released or cancelled",
					handler: async (_args, ctx) => {
						await ctx.startWork("job", { title: "Background job" }, async ({ signal }) => {
							const done = Promise.withResolvers<void>();
							release = () => done.resolve();
							// A cancelled job whose cleanup is held stays active until it is released.
							signal.addEventListener("abort", () => (holdCleanup ? undefined : done.resolve()), {
								once: true,
							});
							await done.promise;
							return { outcome: signal.aborted ? "cancelled" : "completed" };
						});
					},
				});
			},
		});
		tui = await harness.startMode({ columns: 120, rows: 36 });
		control = tui.mode as unknown as ModeControl;
		vi.spyOn(control, "shutdown").mockResolvedValue();
		vi.spyOn(control, "showWarning");
		vi.spyOn(control, "showError");
	});

	afterEach(async () => {
		release?.();
		await harness.cleanup();
		vi.restoreAllMocks();
	});

	/** The id of the job the store shows running, once it shows one. */
	async function startJob(): Promise<string> {
		tui.terminal.sendInput("/start-job");
		tui.terminal.sendInput("\r");
		let workId = "";
		await vi.waitFor(() => {
			const work = [...tui.store.live.values.values()].find((value) => value.kind === "work");
			expect(work).toBeDefined();
			workId = work?.kind === "work" ? work.workId : "";
		});
		await vi.waitFor(() => expect(tui.store.phase?.busy).toBe(false));
		return workId;
	}

	it.each(["/quit", "Ctrl+D"])("requires confirmation for %s while background work runs", async (entryPoint) => {
		await startJob();
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const quit = () => {
			if (entryPoint === "/quit") {
				tui.terminal.sendInput("/quit");
				tui.terminal.sendInput("\r");
			} else {
				tui.terminal.sendInput("\x04");
			}
		};

		quit();
		expect(control.showWarning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Work is active"));
		expect(control.shutdown).not.toHaveBeenCalled();

		now += 2999;
		quit();
		expect(control.shutdown).toHaveBeenCalledTimes(1);
		expect(control.showWarning).toHaveBeenCalledTimes(1);
		expect(control.showError).not.toHaveBeenCalled();
	});

	it("protects cancelling background work until its cleanup settles", async () => {
		holdCleanup = true;
		const workId = await startJob();
		await tui.store.client.intent("cancel_work", { workId });
		await vi.waitFor(() => expect(tui.store.state.work.get(workId)?.state).toBe("cancelling"));

		tui.terminal.sendInput("\x04");
		expect(control.showWarning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Work is active"));
		expect(control.shutdown).not.toHaveBeenCalled();
		tui.terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);

		release?.();
		await vi.waitFor(() => expect(tui.store.state.work.get(workId)?.outcome).toBe("cancelled"));
	});

	it("expires a background-work quit warning at three seconds", async () => {
		await startJob();
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await control.defaultEditor.onSubmit?.("/quit");
		now += 3000;
		await control.defaultEditor.onSubmit?.("/quit");
		expect(control.showWarning).toHaveBeenCalledTimes(2);
		expect(control.shutdown).not.toHaveBeenCalled();

		now += 1;
		await control.defaultEditor.onSubmit?.("/quit");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("does not reuse a background-work quit warning after new foreground work", async () => {
		await startJob();
		vi.spyOn(Date, "now").mockReturnValue(Date.now());
		tui.terminal.sendInput("\x04");
		expect(control.showWarning).toHaveBeenCalledTimes(1);

		await harness.startup.session.prompt("Continue foreground work");
		await vi.waitFor(() => expect(tui.store.phase?.busy).toBe(false));
		await vi.waitFor(() => expect(tui.store.transcript().length).toBeGreaterThan(1));

		tui.terminal.sendInput("\x04");
		expect(control.showWarning).toHaveBeenCalledTimes(2);
		expect(control.shutdown).not.toHaveBeenCalled();
		tui.terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});
});

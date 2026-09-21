import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { setKeybindings, Text, type TUI, type TuiAltScreen, TuiMainScreen } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../../src/core/slash-commands.ts";
import { stopThemeWatcher } from "../../../src/core/theme/runtime.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

interface ModeControl {
	renderer: TuiMainScreen | TuiAltScreen;
	ui: TUI;
	defaultEditor: CustomEditor;
	keybindings: KeybindingsManager;
	isInitialized: boolean;
	activeInteractiveReview: boolean;
	daemonAttach: { relayCount(): number };
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	setupAutocompleteProvider(): void;
	subscribeToAgent(session: Harness["session"]): void;
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

describe("regression #353: active quit protection and safe diagnostics", () => {
	let harness: Harness;
	let mode: InteractiveMode;
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
		const tool: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Wait for this offline test",
			parameters: Type.Object({}),
			execute: async () => {
				toolEntered.resolve();
				await toolCompleted.promise;
				return { content: [{ type: "text", text: "Done" }], details: {} };
			},
		};
		runExtensionCommand = async () => undefined;
		harness = await createHarness({
			tools: [tool],
			settings: { theme: "dark", retry: { enabled: false } },
			extensionFactories: [
				(volt) => {
					volt.registerCommand("offline-hold", {
						description: "Wait for this offline test",
						handler: () => runExtensionCommand(),
					});
				},
			],
		});
		vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.tempDir);
		const runtimeHost = {
			session: harness.session,
			setBeforeSessionInvalidate: () => undefined,
			setRebindSession: () => undefined,
		} as unknown as AgentSessionRuntime;
		mode = new InteractiveMode(runtimeHost);
		control = mode as unknown as ModeControl;
		terminal = new VirtualTerminal(120, 36);
		control.renderer = new TuiMainScreen(terminal, false, harness.tempDir);
		control.setupKeyHandlers();
		control.setupEditorSubmitHandler();
		control.setupAutocompleteProvider();
		control.renderer.addChild(control.defaultEditor);
		control.renderer.setFocus(control.defaultEditor);
		control.renderer.start();
		control.isInitialized = true;
		control.subscribeToAgent(harness.session);
		vi.spyOn(control, "shutdown").mockResolvedValue();
		vi.spyOn(control, "showWarning");
		vi.spyOn(control, "showError");
	});

	afterEach(async () => {
		finish?.();
		await pending;
		pending = undefined;
		finish = undefined;
		mode.stop("resume-hint");
		stopThemeWatcher();
		await harness.cleanupAsync();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		setKeybindings(new KeybindingsManager());
	});

	async function startGeneration(): Promise<void> {
		const entered = deferred();
		const completed = deferred();
		finish = completed.resolve;
		harness.setResponses([
			async () => {
				entered.resolve();
				await completed.promise;
				return fauxAssistantMessage("Completed safely");
			},
		]);
		pending = harness.session.prompt("Continue working");
		await entered.promise;
		expect(harness.session.isBusy).toBe(true);
	}

	function getCapturePath(): string {
		return join(harness.tempDir, "debug", "tool-progress-latest.json");
	}

	it.each([0, 1])("exits idle on raw Ctrl+D with %i attached phones", (phoneCount) => {
		vi.spyOn(control.daemonAttach, "relayCount").mockReturnValue(phoneCount);
		terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
		expect(control.showWarning).not.toHaveBeenCalled();
	});

	it.each([0, 1])("requires a second Ctrl+D during generation with %i attached phones", async (phoneCount) => {
		vi.spyOn(control.daemonAttach, "relayCount").mockReturnValue(phoneCount);
		await startGeneration();
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		expect(control.showWarning).toHaveBeenCalledWith(expect.stringContaining("Work is active"));
		expect(harness.session.isBusy).toBe(true);
		terminal.sendInput("\x04");
		expect(control.shutdown).toHaveBeenCalledTimes(1);
	});

	it("protects actual tool execution after model generation has completed", async () => {
		finish = toolCompleted.resolve;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Completed safely"),
		]);
		pending = harness.session.prompt("Use the offline tool");
		await toolEntered.promise;
		expect(harness.eventsOfType("message_end").some((event) => event.message.role === "assistant")).toBe(true);
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
		pending = harness.session
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
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isBusy).toBe(true);
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
					operation = harness.session.executeBash("offline", undefined, {
						operations: {
							exec: async () => {
								await hold();
								return { exitCode: 0 };
							},
						},
					});
				} else if (currentKind === "extension command") {
					runExtensionCommand = hold;
					operation = harness.session.prompt("/offline-hold");
				} else {
					vi.spyOn(harness.session.resourceLoader, "reload").mockImplementationOnce(async () => {
						await hold();
						if (currentKind === "failed reload") throw new Error("offline reload failure");
					});
					operation = harness.session.reload();
				}
				pending =
					currentKind === "failed reload"
						? expect(operation).rejects.toThrow("offline reload failure")
						: operation.then(() => undefined);
				await entered.promise;
				expect(harness.session.isBusy).toBe(true);
			}
			await startOperation();
			terminal.sendInput("\x04");
			expect(control.showWarning).toHaveBeenCalledTimes(1);
			finish?.();
			await pending;
			expect(harness.session.isBusy).toBe(false);
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
		expect(existsSync(getCapturePath())).toBe(false);
		expect(control.defaultEditor.getText()).toBe("");
	});

	it("captures real diagnostics with F12 and /debug without stopping or queueing a turn", async () => {
		await startGeneration();
		terminal.sendInput("\x04");
		control.defaultEditor.setText("draft");
		terminal.sendInput("\x1b[24~");
		await harness.session.waitForToolProgressDiagnostics();
		expect(JSON.parse(readFileSync(getCapturePath(), "utf8"))).toMatchObject({ reason: "manual", calls: [] });
		expect(control.defaultEditor.getText()).toBe("draft");
		await control.defaultEditor.onSubmit?.("/debug");
		await harness.session.waitForToolProgressDiagnostics();
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.isBusy).toBe(true);
		expect(control.shutdown).not.toHaveBeenCalled();
		terminal.sendInput("\x04");
		expect(control.shutdown).not.toHaveBeenCalled();
		finish?.();
		await pending;
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("honors rebinding and disabling debug globally with overlay focus", async () => {
		await startGeneration();
		const overlay = new Text("An overlay", 0, 0);
		control.ui.showOverlay(overlay);
		control.keybindings.setUserBindings({ "app.debug": "ctrl+shift+d" });
		terminal.sendInput("\x1b[24~");
		expect(existsSync(getCapturePath())).toBe(false);
		terminal.sendInput("\x1b[100;6u");
		await harness.session.waitForToolProgressDiagnostics();
		expect(existsSync(getCapturePath())).toBe(true);
		expect(control.ui.getFocusedComponent()).toBe(overlay);
		expect(control.shutdown).not.toHaveBeenCalled();
		control.keybindings.setUserBindings({ "app.debug": [] });
		const capture = vi.spyOn(harness.session, "captureToolProgressDiagnostics");
		terminal.sendInput("\x1b[24~");
		terminal.sendInput("\x1b[100;6u");
		expect(capture).not.toHaveBeenCalled();
	});

	it("keeps debug global after renderer changes and ignores repeat/release events", async () => {
		control.switchTuiMode("fullscreen");
		control.switchTuiMode("regular");
		terminal.sendInput("\x1b[24;1:2~");
		terminal.sendInput("\x1b[24;1:3~");
		expect(existsSync(getCapturePath())).toBe(false);
		terminal.sendInput("\x1b[24~");
		await harness.session.waitForToolProgressDiagnostics();
		expect(existsSync(getCapturePath())).toBe(true);
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

	it.each(["shortcut", "command"])(
		"contains asynchronous diagnostic capture failures via the %s",
		async (entryPoint) => {
			await startGeneration();
			const capture = vi
				.spyOn(harness.session, "captureToolProgressDiagnostics")
				.mockRejectedValueOnce(new Error("fixture capture failure"));
			if (entryPoint === "shortcut") terminal.sendInput("\x1b[24~");
			else await control.defaultEditor.onSubmit?.("/debug");
			await vi.waitFor(() =>
				expect(control.showError).toHaveBeenCalledWith("Failed to write debug log: fixture capture failure"),
			);
			expect(harness.session.isBusy).toBe(true);
			expect(control.shutdown).not.toHaveBeenCalled();
			capture.mockRestore();
		},
	);
});
